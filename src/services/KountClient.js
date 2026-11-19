// Kount Payments Fraud v2 HTTP client.
//
// - OAuth client_credentials token, cached per credential until shortly
//   before expiry, with concurrent refreshes coalesced.
// - Every call (token, evaluate, data-only, update) runs under one p-retry
//   loop: exponential backoff with jitter, KOUNT_MAX_RETRIES extra attempts,
//   a per-attempt timeout and one total deadline that covers token refreshes
//   and sleeps. The token fetch runs inside the attempt, so retries are never
//   nested or multiplied.
// - Retries: network errors, timeouts, 408, 429, 5xx, and one token refresh
//   on Commerce 401. Permanent 4xx and bad token credentials are not retried.
// - Retry-After is honoured; if it does not fit in the remaining deadline the
//   operation stops instead of retrying early.
import pRetry from 'p-retry'
import {
  KOUNT_ATTEMPT_TIMEOUT_MS,
  KOUNT_BACKOFF_MAX_MS,
  KOUNT_BACKOFF_MIN_MS,
  KOUNT_OPERATION_DEADLINE_MS,
  KOUNT_TOKEN_SCOPE,
} from '../config/kount.js'
import { parseEvaluationResponse, parseRetryAfter } from '../lib/kountPayload.js'

const TOKEN_REFRESH_MARGIN_MS = 60_000

export class KountApiError extends Error {
  /**
   * @param {string} message
   * @param {{kind: string, status?: number, retryable?: boolean, phase?: string, correlationId?: string, retryAfterMs?: number}} info
   */
  constructor(message, info) {
    super(message)
    this.name = 'KountApiError'
    Object.assign(this, info)
  }
}

// Per-isolate token cache: key -> { token, expiresAt, inflight }
const tokenCache = new Map()

/** Test hook. */
export function clearKountTokenCache() {
  tokenCache.clear()
}

function cacheKey(config) {
  return `${config.tokenUrl}|${config.clientId}|${config.apiKey.length}:${config.apiKey.slice(-6)}`
}

function correlationIdOf(response, body) {
  return response?.headers?.get?.('x-correlation-id') || body?.correlationId || undefined
}

const KEY_FIELDS = ['publicKey', 'public_key', 'key', 'pem', 'value']

function keysFrom(value) {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(keysFrom)
  if (value && typeof value === 'object') {
    for (const field of KEY_FIELDS) {
      if (typeof value[field] === 'string') return [value[field]]
    }
  }
  return []
}

/**
 * Pull public key(s) out of the ENS response. The reference implementation
 * expects { publicKey, validUntil }; a live Sandbox response did not match
 * that, so other likely shapes are accepted: the fields above at top level
 * or under data / keys / publicKeys, an array of keys, or a bare PEM /
 * base64 text body.
 */
function extractPublicKeys(res) {
  const body = res.body
  let keys = []
  let validUntil = null
  if (body && typeof body === 'object') {
    for (const container of [body, body.data, body.result]) {
      if (!container) continue
      keys = keysFrom(container)
      if (keys.length === 0) {
        for (const listField of ['keys', 'publicKeys', 'public_keys', 'items']) {
          keys = keysFrom(container[listField])
          if (keys.length) break
        }
      }
      if (keys.length) {
        validUntil = container.validUntil || container.valid_until || container.expiresAt || null
        break
      }
    }
  } else if (typeof res.text === 'string' && /^[\sA-Za-z0-9+/=-]+$/.test(res.text) && res.text.replace(/\s|-----[^-]+-----/g, '').length > 100) {
    keys = [res.text]
  }
  return { keys: keys.filter((k) => typeof k === 'string' && k.trim().length > 100), validUntil }
}

/** Describe a response's shape without logging any values. */
function describeShape(res) {
  const body = res.body
  if (Array.isArray(body)) return `json array(${body.length})${body[0] && typeof body[0] === 'object' ? ` of {${Object.keys(body[0]).join(',')}}` : ''}`
  if (body && typeof body === 'object') {
    return `json {${Object.entries(body).map(([k, v]) => `${k}:${Array.isArray(v) ? `array(${v.length})` : typeof v}`).join(', ')}}`
  }
  return `${res.contentType || 'unknown type'}, text length ${String(res.text || '').length}`
}

export class KountClient {
  /**
   * @param {ReturnType<import('../config/kount.js').buildKountConfig>} config
   * @param {{fetchImpl?: typeof fetch, now?: () => number, deadlineMs?: number, attemptTimeoutMs?: number, minBackoffMs?: number, maxBackoffMs?: number, sleep?: (ms: number) => Promise<void>}} [deps]
   */
  constructor(config, deps = {}) {
    this.config = config
    this.fetch = deps.fetchImpl || ((...args) => fetch(...args))
    this.now = deps.now || (() => Date.now())
    this.deadlineMs = deps.deadlineMs ?? KOUNT_OPERATION_DEADLINE_MS
    this.attemptTimeoutMs = deps.attemptTimeoutMs ?? KOUNT_ATTEMPT_TIMEOUT_MS
    this.minBackoffMs = deps.minBackoffMs ?? KOUNT_BACKOFF_MIN_MS
    this.maxBackoffMs = deps.maxBackoffMs ?? KOUNT_BACKOFF_MAX_MS
    this.sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /** Fetch with a timeout bounded by the attempt limit and the remaining budget. */
  async timedFetch(url, init, deadline) {
    const remaining = deadline - this.now()
    if (remaining <= 0) {
      throw new KountApiError('Kount operation deadline exceeded', { kind: 'deadline', retryable: false, phase: 'before_send' })
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.min(this.attemptTimeoutMs, remaining))
    try {
      return await this.fetch(url, { ...init, signal: controller.signal })
    } catch (error) {
      const timedOut = controller.signal.aborted
      throw new KountApiError(timedOut ? 'Kount request timed out' : 'Kount network error', {
        kind: timedOut ? 'timeout' : 'network',
        retryable: true,
        // The request may have reached Kount; a POST could have created an order.
        phase: 'awaiting_response',
        cause: error,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  async fetchToken(deadline) {
    const response = await this.timedFetch(this.config.tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${this.config.apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: KOUNT_TOKEN_SCOPE }).toString(),
    }, deadline)

    if (!response.ok) {
      const status = response.status
      const retryable = status === 408 || status === 429 || status >= 500
      throw new KountApiError(`Kount token request failed (${status})`, {
        kind: retryable ? 'token_transient' : 'token_rejected',
        status,
        retryable,
        phase: 'before_send',
        retryAfterMs: parseRetryAfter(response.headers?.get?.('retry-after'), this.now()),
      })
    }

    let body
    try {
      body = await response.json()
    } catch {
      body = null
    }
    if (!body?.access_token) {
      throw new KountApiError('Kount token response had no access_token', { kind: 'token_malformed', retryable: false, phase: 'before_send' })
    }
    const ttlMs = Math.max(0, Number(body.expires_in || 0) * 1000)
    return { token: body.access_token, expiresAt: this.now() + ttlMs }
  }

  /** Cached bearer token; refreshes shortly before expiry, coalescing concurrent refreshes. */
  async getToken(deadline, { forceRefresh = false } = {}) {
    const key = cacheKey(this.config)
    const entry = tokenCache.get(key)
    if (!forceRefresh && entry?.token && entry.expiresAt - TOKEN_REFRESH_MARGIN_MS > this.now()) {
      return entry.token
    }
    if (entry?.inflight) return entry.inflight

    const inflight = this.fetchToken(deadline)
      .then(({ token, expiresAt }) => {
        tokenCache.set(key, { token, expiresAt })
        return token
      })
      .catch((error) => {
        tokenCache.delete(key)
        throw error
      })
    tokenCache.set(key, { ...(entry || {}), inflight })
    return inflight
  }

  invalidateToken() {
    tokenCache.delete(cacheKey(this.config))
  }

  /**
   * Run one Commerce API operation under the shared retry policy.
   * @returns {Promise<{status: number, body: any, jsonParsed: boolean, correlationId?: string, attempts: number, possibleDuplicate: boolean}>}
   */
  async request(operation, { method, path, query, body }) {
    const started = this.now()
    const deadline = started + this.deadlineMs
    const url = new URL(/^https:\/\//.test(path) ? path : `${this.config.apiBaseUrl}${path}`)
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v))

    let attempts = 0
    let forceRefresh = false
    let ambiguousWrite = false

    const attempt = async () => {
      attempts += 1
      const token = await this.getToken(deadline, { forceRefresh })
      forceRefresh = false

      const response = await this.timedFetch(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }, deadline).catch((error) => {
        if (method === 'POST' && error.phase === 'awaiting_response') ambiguousWrite = true
        throw error
      })

      let parsed = null
      let jsonParsed = false
      let text = ''
      try {
        text = await response.text()
        if (text) {
          parsed = JSON.parse(text)
          jsonParsed = true
        }
      } catch {
        jsonParsed = false
      }
      const correlationId = correlationIdOf(response, parsed)

      if (response.ok) {
        return { status: response.status, body: parsed, jsonParsed, correlationId, text, contentType: response.headers?.get?.('content-type') || null }
      }

      const status = response.status
      if (status === 401) {
        // Expired or revoked token: refresh once within the same budget.
        this.invalidateToken()
        forceRefresh = true
        throw new KountApiError('Kount rejected the bearer token (401)', { kind: 'unauthorized', status, retryable: true, phase: 'response_received', correlationId })
      }
      const retryable = status === 408 || status === 429 || status >= 500
      if (retryable && method === 'POST' && status !== 429) ambiguousWrite = true
      throw new KountApiError(`Kount ${operation} failed (${status})`, {
        kind: retryable ? 'transient_http' : 'rejected',
        status,
        retryable,
        phase: 'response_received',
        correlationId,
        retryAfterMs: parseRetryAfter(response.headers?.get?.('retry-after'), this.now()),
      })
    }

    let lastError
    try {
      const result = await pRetry(attempt, {
        retries: this.config.maxRetries,
        factor: 2,
        minTimeout: this.minBackoffMs,
        maxTimeout: this.maxBackoffMs,
        randomize: true,
        maxRetryTime: this.deadlineMs,
        shouldRetry: ({ error }) => Boolean(error?.retryable) && this.now() < deadline,
        onFailedAttempt: async ({ error, retriesLeft, retryDelay }) => {
          lastError = error
          if (!error?.retryable || retriesLeft <= 0) return
          if (error.retryAfterMs !== undefined) {
            const remaining = deadline - this.now()
            if (error.retryAfterMs > remaining) {
              // Never retry earlier than the server asked; stop instead.
              error.retryable = false
              error.kind = 'retry_after_exceeds_deadline'
              return
            }
            const extra = error.retryAfterMs - (retryDelay || 0)
            if (extra > 0) await this.sleep(extra)
          }
        },
      })
      return { ...result, attempts, possibleDuplicate: ambiguousWrite && attempts > 1 }
    } catch (error) {
      const err = error instanceof KountApiError
        ? error
        : new KountApiError(error?.message || 'Kount request failed', { kind: 'unexpected', retryable: false, cause: error })
      err.attempts = attempts
      err.operation = operation
      err.possibleDuplicate = ambiguousWrite
      err.outcomeUnknown = ambiguousWrite
      if (!err.correlationId && lastError?.correlationId) err.correlationId = lastError.correlationId
      throw err
    }
  }

  /**
   * Kount's currently published webhook public key (ENS), as used by the
   * k360pf reference implementation. Returns { publicKey, validUntil }.
   */
  async fetchWebhookPublicKey() {
    const url = `${this.config.ensBaseUrl}/api/developer/ens/client/${encodeURIComponent(this.config.clientId)}/public-key`
    const res = await this.request('get_webhook_public_key', { method: 'GET', path: url })
    const { keys, validUntil } = extractPublicKeys(res)
    if (keys.length === 0) {
      throw new KountApiError(`Kount public key response not recognised (${describeShape(res)})`, { kind: 'malformed', retryable: false, shape: describeShape(res) })
    }
    return { publicKeys: keys, publicKey: keys[0], validUntil }
  }

  evaluateOrder(payload) {
    return this.request('evaluate_order', { method: 'POST', path: '/commerce/v2/orders', query: { riskInquiry: true }, body: payload })
  }

  sendDataOnlyOrder(payload) {
    return this.request('data_only_order', { method: 'POST', path: '/commerce/v2/orders', query: { riskInquiry: false }, body: payload })
  }

  updateOrder(kountOrderId, payload) {
    return this.request('update_order', { method: 'PATCH', path: `/commerce/v2/orders/${encodeURIComponent(kountOrderId)}`, body: payload })
  }

  /**
   * Evaluate an order and always come back with a decision.
   *
   * A Kount decision (APPROVE / DECLINE / REVIEW) is returned as
   * decisionSource 'kount'. When the bounded retry policy ends without a
   * usable decision, the configured KOUNT_FALLBACK_DECISION is returned with
   * decisionSource 'fallback' and the reason. REVIEW never triggers fallback.
   */
  async evaluateWithFallback(payload) {
    const base = { evaluatedAt: new Date(this.now()).toISOString() }
    let result
    try {
      result = await this.evaluateOrder(payload)
    } catch (error) {
      return {
        ...base,
        decision: this.config.fallbackDecision,
        decisionSource: 'fallback',
        fallbackReason: error.kind || 'error',
        httpStatus: error.status,
        attempts: error.attempts ?? 1,
        correlationId: error.correlationId,
        possibleDuplicate: Boolean(error.possibleDuplicate),
      }
    }

    const parsed = result.jsonParsed ? parseEvaluationResponse(result.body) : { status: 'malformed_response', shapeConflict: false }
    const ids = {
      attempts: result.attempts,
      correlationId: result.correlationId,
      kountOrderId: parsed.kountOrderId,
      kountTransactionId: parsed.kountTransactionId,
      possibleDuplicate: result.possibleDuplicate,
      shapeConflict: parsed.shapeConflict || undefined,
    }
    if (parsed.status === 'usable') {
      return { ...base, ...ids, decision: parsed.decision, decisionSource: 'kount', omniscore: parsed.omniscore, deviceId: parsed.deviceId }
    }
    return { ...base, ...ids, decision: this.config.fallbackDecision, decisionSource: 'fallback', fallbackReason: parsed.status }
  }
}
