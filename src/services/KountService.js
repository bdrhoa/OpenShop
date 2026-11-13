// Kount Payments Fraud v2 API client (Sandbox).
//
// - Bearer tokens come from the client_credentials grant, sent with the
//   portal API key as the Basic credential, and are cached per isolate until
//   shortly before expiry. Concurrent callers share one in-flight refresh.
// - Evaluate Order is a write. It is retried only when Kount explicitly did
//   not process the request (429/503) or the token was rejected (401).
//   Timeouts and other failures surface as KountError with `uncertain: true`
//   so callers reconcile instead of re-submitting.
import {
  KOUNT_SANDBOX,
  KOUNT_TOKEN_SCOPE,
  KOUNT_TOKEN_REFRESH_SKEW_MS,
  KOUNT_REQUEST_TIMEOUT_MS,
  KOUNT_MAX_ATTEMPTS,
  KOUNT_BACKOFF_BASE_MS,
  KOUNT_BACKOFF_MAX_MS,
} from '../config/kount.js'
import { parseEvaluateResponse } from '../lib/kountOrder.js'

export class KountError extends Error {
  constructor(message, { status = null, uncertain = false, correlationId = null } = {}) {
    super(message)
    this.name = 'KountError'
    this.status = status
    this.uncertain = uncertain
    this.correlationId = correlationId
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function backoffDelay(attempt, retryAfterHeader) {
  const retryAfter = Number(retryAfterHeader)
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.min(retryAfter * 1000, KOUNT_BACKOFF_MAX_MS)
  }
  return Math.min(KOUNT_BACKOFF_BASE_MS * 2 ** attempt, KOUNT_BACKOFF_MAX_MS)
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
   * @param {typeof fetch} [opts.fetchImpl]
   * @param {(ms:number)=>Promise<void>} [opts.sleepImpl]
   */
  constructor({ clientId, apiKey, fetchImpl, sleepImpl } = {}) {
    this.clientId = clientId
    this.apiKey = normalizeApiKey(apiKey)
    this.fetch = fetchImpl || ((...args) => fetch(...args))
    this.sleep = sleepImpl || sleep
    this.config = KOUNT_SANDBOX
  }

  get isConfigured() {
    return isKountConfigured(this.clientId, this.apiKey)
  }

  async #fetchWithTimeout(url, init) {
    return this.fetch(url, { ...init, signal: AbortSignal.timeout(KOUNT_REQUEST_TIMEOUT_MS) })
  }

  async #requestToken() {
    let lastError
    for (let attempt = 0; attempt < KOUNT_MAX_ATTEMPTS; attempt++) {
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
        // Token requests are safe to retry.
        lastError = new KountError(`Kount token request failed: ${error.name || 'network error'}`)
        await this.sleep(backoffDelay(attempt))
        continue
      }

      if (response.ok) {
        const body = await response.json().catch(() => ({}))
        if (!body.access_token) throw new KountError('Kount token response missing access_token', { status: response.status })
        const expiresInMs = (Number(body.expires_in) || 300) * 1000
        return { token: body.access_token, expiresAt: Date.now() + expiresInMs }
      }

      lastError = new KountError(`Kount token request returned ${response.status}`, { status: response.status })
      // 400/401/403 are credential problems — retrying will not help.
      if (response.status !== 429 && response.status < 500) throw lastError
      await this.sleep(backoffDelay(attempt, response.headers.get('Retry-After')))
    }
    throw lastError
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
   * Authenticated JSON request. Retries 401 once with a fresh token and
   * 429/503 with bounded backoff. Any other failure is returned to the caller.
   */
  async #apiRequest(method, path, body) {
    const url = `${this.config.apiBaseUrl}${path}`
    let refreshed = false

    for (let attempt = 0; attempt < KOUNT_MAX_ATTEMPTS; attempt++) {
      const token = await this.getAccessToken()
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
        // The request may have reached Kount. Do not retry a write.
        throw new KountError(`Kount ${method} ${path} did not complete: ${error.name || 'network error'}`, { uncertain: true })
      }

      const correlationId = response.headers.get('X-Correlation-Id')

      if (response.ok) {
        return { body: await response.json().catch(() => ({})), correlationId }
      }

      if (response.status === 401 && !refreshed) {
        // A 401 means the request was rejected before processing; refresh
        // the token once and resend.
        refreshed = true
        await this.getAccessToken({ forceRefresh: true })
        continue
      }

      if ((response.status === 429 || response.status === 503) && attempt < KOUNT_MAX_ATTEMPTS - 1) {
        await this.sleep(backoffDelay(attempt, response.headers.get('Retry-After')))
        continue
      }

      // 500 and other statuses: the outcome is unknown for writes.
      throw new KountError(`Kount ${method} ${path} returned ${response.status}`, {
        status: response.status,
        uncertain: response.status >= 500,
        correlationId,
      })
    }
    throw new KountError(`Kount ${method} ${path} exhausted retries`, { uncertain: false })
  }

  /** POST /commerce/v2/orders?riskInquiry=true */
  async evaluateOrder(orderBody) {
    const { body, correlationId } = await this.#apiRequest('POST', '/commerce/v2/orders?riskInquiry=true', orderBody)
    return { ...parseEvaluateResponse(body), correlationId }
  }

  /** PATCH /commerce/v2/orders/{orderId} — does not trigger a new risk inquiry. */
  async updateOrder(kountOrderId, patchBody) {
    if (!kountOrderId) throw new KountError('Kount order id is required for updates')
    const { body } = await this.#apiRequest('PATCH', `/commerce/v2/orders/${encodeURIComponent(kountOrderId)}`, patchBody)
    return body
  }
}
