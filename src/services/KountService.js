// Kount Payments Fraud v2 API client (Sandbox).
//
// - Bearer tokens come from the client_credentials grant, sent with the
//   portal API key as the Basic credential, and are cached per isolate until
//   shortly before expiry. Concurrent callers share one in-flight refresh.
// - Errors reaching Kount (network errors, timeouts, 408, 429, 5xx) are
//   retried with exponential backoff and full jitter (exponential-backoff),
//   up to `maxRetries` retries. A 401 refreshes the token and retries. Other
//   4xx responses are not retried. Retrying an order write after a timeout
//   or 5xx can create a duplicate order in Kount if the first one landed.
// - When retries run out the last KountError is thrown with
//   `exhausted: true`; callers decide what to do (see FraudReviewService).
import { backOff } from 'exponential-backoff'
import {
  KOUNT_SANDBOX,
  KOUNT_TOKEN_SCOPE,
  KOUNT_TOKEN_REFRESH_SKEW_MS,
  KOUNT_REQUEST_TIMEOUT_MS,
  KOUNT_DEFAULT_MAX_RETRIES,
  KOUNT_BACKOFF_BASE_MS,
  KOUNT_BACKOFF_MAX_MS,
} from '../config/kount.js'
import { parseEvaluateResponse } from '../lib/kountOrder.js'

export class KountError extends Error {
  constructor(message, { status = null, uncertain = false, retryable = false, correlationId = null } = {}) {
    super(message)
    this.name = 'KountError'
    this.status = status
    // Kount may have processed the request (timeout or 5xx on a write).
    this.uncertain = uncertain
    // An error reaching Kount that is worth retrying.
    this.retryable = retryable
    this.correlationId = correlationId
    // Set when thrown after retries: how many attempts were made, and
    // whether the retry budget ran out.
    this.attempts = 1
    this.exhausted = false
  }
}

/** Kount is enabled when both API credentials are present. */
export function isKountConfigured(clientId, apiKey) {
  return typeof clientId === 'string' && clientId.trim() !== ''
    && typeof apiKey === 'string' && apiKey.trim() !== ''
}

// Per-isolate token cache keyed by API key.
const tokenCache = new Map()

/** Test hook. */
export function resetKountTokenCache() {
  tokenCache.clear()
}

/** HTTP statuses that mean Kount was not reached or could not answer. */
function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500
}

/** Clamp a configured retry count to a sane integer. */
export function normalizeMaxRetries(value) {
  const n = Number.parseInt(value, 10)
  return Number.isInteger(n) && n >= 0 ? n : KOUNT_DEFAULT_MAX_RETRIES
}

/**
 * Normalize the portal API key: it is sent verbatim after "Basic", so strip
 * an accidental "Basic " prefix, surrounding quotes, and whitespace.
 */
export function normalizeApiKey(apiKey) {
  return String(apiKey || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/^Basic\s+/i, '')
    .replace(/\s+/g, '')
}

export class KountService {
  /**
   * @param {object} opts
   * @param {string} opts.clientId
   * @param {string} opts.apiKey
   * @param {number} [opts.maxRetries] - Retries after the first attempt (default 3)
   * @param {typeof fetch} [opts.fetchImpl]
   * @param {object} [opts.backoffOptions] - exponential-backoff overrides (tests)
   */
  constructor({ clientId, apiKey, maxRetries = KOUNT_DEFAULT_MAX_RETRIES, fetchImpl, backoffOptions } = {}) {
    this.clientId = clientId
    this.apiKey = normalizeApiKey(apiKey)
    this.maxRetries = normalizeMaxRetries(maxRetries)
    this.fetch = fetchImpl || ((...args) => fetch(...args))
    this.backoffOptions = backoffOptions || {}
    this.config = KOUNT_SANDBOX
  }

  get isConfigured() {
    return isKountConfigured(this.clientId, this.apiKey)
  }

  async #fetchWithTimeout(url, init) {
    return this.fetch(url, { ...init, signal: AbortSignal.timeout(KOUNT_REQUEST_TIMEOUT_MS) })
  }

  /**
   * Run `attempt` with exponential backoff and full jitter. Retries only
   * KountErrors marked retryable. The error that ends the loop carries the
   * attempt count and whether the retry budget was exhausted.
   */
  async #withRetry(attempt) {
    const numOfAttempts = this.maxRetries + 1
    let attempts = 0
    try {
      return await backOff(async () => {
        attempts++
        return attempt(attempts)
      }, {
        numOfAttempts,
        startingDelay: KOUNT_BACKOFF_BASE_MS,
        timeMultiple: 2,
        maxDelay: KOUNT_BACKOFF_MAX_MS,
        jitter: 'full',
        ...this.backoffOptions,
        retry: (error) => error instanceof KountError && error.retryable,
      })
    } catch (error) {
      const kountError = error instanceof KountError
        ? error
        : new KountError(`Kount request failed: ${error?.message || error}`)
      kountError.attempts = Math.max(kountError.attempts, attempts)
      kountError.exhausted = kountError.exhausted || (kountError.retryable && attempts >= numOfAttempts)
      throw kountError
    }
  }

  async #requestToken() {
    return this.#withRetry(async () => {
      let response
      try {
        response = await this.#fetchWithTimeout(this.config.tokenUrl, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${this.apiKey}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ grant_type: 'client_credentials', scope: KOUNT_TOKEN_SCOPE }).toString(),
        })
      } catch (error) {
        throw new KountError(`Kount token request failed: ${error.name || 'network error'}`, { retryable: true })
      }

      if (response.ok) {
        const body = await response.json().catch(() => ({}))
        if (!body.access_token) throw new KountError('Kount token response missing access_token', { status: response.status })
        const expiresInMs = (Number(body.expires_in) || 300) * 1000
        return { token: body.access_token, expiresAt: Date.now() + expiresInMs }
      }

      // 400/401/403 are credential problems — retrying will not help.
      throw new KountError(`Kount token request returned ${response.status}`, {
        status: response.status,
        retryable: isRetryableStatus(response.status),
      })
    })
  }

  /** Get a cached bearer token, refreshing shortly before expiry. */
  async getAccessToken({ forceRefresh = false } = {}) {
    if (!this.isConfigured) throw new KountError('Kount is not configured')
    const cacheKey = this.apiKey
    const entry = tokenCache.get(cacheKey)
    const now = Date.now()

    if (!forceRefresh && entry?.token && now < entry.expiresAt - KOUNT_TOKEN_REFRESH_SKEW_MS) {
      return entry.token
    }
    if (entry?.inflight) return entry.inflight

    const inflight = this.#requestToken()
      .then(({ token, expiresAt }) => {
        tokenCache.set(cacheKey, { token, expiresAt })
        return token
      })
      .catch((error) => {
        // Drop the failed refresh so the next caller retries; keep nothing stale.
        tokenCache.delete(cacheKey)
        throw error
      })
    tokenCache.set(cacheKey, { ...(entry || {}), inflight })
    return inflight
  }

  /**
   * Authenticated JSON request, retried with backoff on errors reaching
   * Kount. A 401 refreshes the token before the next attempt.
   */
  async #apiRequest(method, path, body) {
    const url = `${this.config.apiBaseUrl}${path}`
    let refreshToken = false

    return this.#withRetry(async () => {
      let token
      try {
        token = await this.getAccessToken({ forceRefresh: refreshToken })
      } catch (error) {
        // Token requests already ran their own retries; don't multiply them.
        if (error instanceof KountError) error.retryable = false
        throw error
      }
      refreshToken = false
      let response
      try {
        response = await this.#fetchWithTimeout(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
      } catch (error) {
        // The request may have reached Kount, so the outcome is uncertain.
        throw new KountError(`Kount ${method} ${path} did not complete: ${error.name || 'network error'}`, {
          uncertain: true,
          retryable: true,
        })
      }

      const correlationId = response.headers.get('X-Correlation-Id')
      if (response.ok) {
        return { body: await response.json().catch(() => ({})), correlationId }
      }

      if (response.status === 401) {
        // Rejected before processing: refresh the token and try again.
        refreshToken = true
        throw new KountError(`Kount ${method} ${path} returned 401`, { status: 401, retryable: true, correlationId })
      }

      throw new KountError(`Kount ${method} ${path} returned ${response.status}`, {
        status: response.status,
        uncertain: response.status >= 500,
        retryable: isRetryableStatus(response.status),
        correlationId,
      })
    })
  }

  /** POST /commerce/v2/orders?riskInquiry=true */
  async evaluateOrder(orderBody) {
    const { body, correlationId } = await this.#apiRequest('POST', '/commerce/v2/orders?riskInquiry=true', orderBody)
    return { ...parseEvaluateResponse(body), correlationId }
  }

  /**
   * POST /commerce/v2/orders?riskInquiry=false — records an order with Kount
   * without asking for a decision (used for declined authorization attempts).
   */
  async submitOrder(orderBody) {
    const { body, correlationId } = await this.#apiRequest('POST', '/commerce/v2/orders?riskInquiry=false', orderBody)
    return { kountOrderId: body?.order?.orderId || null, correlationId }
  }

  /** PATCH /commerce/v2/orders/{orderId} — does not trigger a new risk inquiry. */
  async updateOrder(kountOrderId, patchBody) {
    if (!kountOrderId) throw new KountError('Kount order id is required for updates')
    const { body } = await this.#apiRequest('PATCH', `/commerce/v2/orders/${encodeURIComponent(kountOrderId)}`, patchBody)
    return body
  }
}
