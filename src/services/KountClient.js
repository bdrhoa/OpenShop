// Kount Commerce API transport: OAuth token cache + bounded retries.
//
// One logical operation (evaluate, data-only POST, PATCH) shares a single
// retry budget that covers token acquisition, the request itself and the
// backoff sleeps. Retries use p-retry (exponential backoff with jitter).
//
//   retried:     network failures, timeouts, 408, 429, 5xx, Commerce 401
//                (after invalidating the cached token)
//   not retried: token 400/401/403 (bad credentials), other 4xx
//
// Retry-After is honored; if the wait would overrun the operation deadline
// the operation stops rather than retrying early.
import pRetry, { AbortError } from 'p-retry'

export class KountApiError extends Error {
  /**
   * @param {string} message  sanitized; never contains response bodies
   * @param {object} info
   */
  constructor(message, info = {}) {
    super(message)
    this.name = 'KountApiError'
    this.status = info.status ?? null
    // before_send | awaiting_response | response_received
    this.phase = info.phase ?? 'response_received'
    this.retryable = Boolean(info.retryable)
    this.retryAfterMs = info.retryAfterMs ?? null
    this.correlationId = info.correlationId ?? null
    this.operation = info.operation ?? null
    this.attempts = info.attempts ?? null
    this.possibleDuplicate = Boolean(info.possibleDuplicate)
  }
}

// Token cache per isolate, keyed by client ID (not a secret).
const tokenCache = new Map()

export function clearKountTokenCache() {
  tokenCache.clear()
}

/** Parse Retry-After (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value, nowMs = Date.now()) {
  if (!value) return null
  const text = String(value).trim()
  if (/^\d+$/.test(text)) return Number(text) * 1000
  const at = Date.parse(text)
  if (Number.isNaN(at)) return null
  return Math.max(0, at - nowMs)
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500
}

export class KountClient {
  /**
   * @param {ReturnType<import('../config/kount.js').parseKountConfig>} config
   * @param {{ fetchImpl?: typeof fetch, now?: () => number, minTimeout?: number, maxTimeout?: number }} [deps]
   */
  constructor(config, deps = {}) {
    this.config = config
    this.fetchImpl = deps.fetchImpl ?? ((...args) => fetch(...args))
    this.now = deps.now ?? (() => Date.now())
    this.minTimeout = deps.minTimeout ?? 250
    this.maxTimeout = deps.maxTimeout ?? 2000
  }

  cacheKey() {
    return this.config.clientId || 'default'
  }

  invalidateToken() {
    tokenCache.delete(this.cacheKey())
  }

  async fetchWithTimeout(url, init, timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs))
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Get a bearer token, reusing the cached one until 60s before expiry.
   * Concurrent callers share one in-flight refresh.
   */
  async getToken(deadlineMs) {
    const key = this.cacheKey()
    const cached = tokenCache.get(key)
    const now = this.now()
    if (cached?.token && cached.expiresAt - 60_000 > now) return cached.token
    if (cached?.inflight) return cached.inflight

    const inflight = (async () => {
      const remaining = deadlineMs - this.now()
      if (remaining <= 0) {
        throw new KountApiError('Kount token request exceeded the operation deadline', {
          operation: 'token', phase: 'before_send', retryable: false,
        })
      }
      let res
      try {
        res = await this.fetchWithTimeout(this.config.tokenUrl, {
          method: 'POST',
          headers: {
            // The portal API key is already the Basic credential value.
            Authorization: `Basic ${this.config.apiKey}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ grant_type: 'client_credentials', scope: this.config.tokenScope }).toString(),
        }, Math.min(this.config.attemptTimeoutMs, remaining))
      } catch {
        throw new KountApiError('Kount token request failed in transit', {
          operation: 'token', phase: 'awaiting_response', retryable: true,
        })
      }
      if (!res.ok) {
        // 4xx on the token endpoint means bad credentials/config: do not retry.
        throw new KountApiError(`Kount token request rejected (HTTP ${res.status})`, {
          operation: 'token', status: res.status, retryable: isRetryableStatus(res.status),
          retryAfterMs: parseRetryAfter(res.headers.get('retry-after'), this.now()),
        })
      }
      let body
      try {
        body = await res.json()
      } catch {
        throw new KountApiError('Kount token response was not JSON', { operation: 'token', retryable: true })
      }
      if (!body?.access_token) {
        throw new KountApiError('Kount token response had no access_token', { operation: 'token', retryable: false })
      }
      const ttlMs = (Number(body.expires_in) || 300) * 1000
      tokenCache.set(key, { token: body.access_token, expiresAt: this.now() + ttlMs })
      return body.access_token
    })()

    tokenCache.set(key, { ...(cached || {}), inflight })
    try {
      return await inflight
    } catch (error) {
      tokenCache.delete(key)
      throw error
    }
  }

  /**
   * Perform one Commerce API operation with the shared retry budget.
   *
   * @param {object} req
   * @param {'POST'|'PATCH'|'GET'} req.method
   * @param {string} req.path       e.g. /commerce/v2/orders
   * @param {Record<string, string|boolean>} [req.query]
   * @param {object} [req.body]
   * @param {string} req.operation  for telemetry (evaluate_order, update_order, ...)
   * @returns {Promise<{status:number, body:any, correlationId:string|null, attempts:number, possibleDuplicate:boolean}>}
   */
  async request({ method, path, query, body, operation }) {
    const deadline = this.now() + this.config.operationDeadlineMs
    const url = new URL(path, this.config.apiBaseUrl)
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v))

    let attempts = 0
    // A POST that timed out after send may already exist on Kount's side.
    let sentWithoutResponse = false

    const run = async () => {
      attempts += 1
      const remaining = deadline - this.now()
      if (remaining <= 0) {
        throw new AbortError(new KountApiError(`Kount ${operation} exceeded its deadline`, {
          operation, phase: 'before_send', attempts,
        }))
      }

      let token
      try {
        token = await this.getToken(deadline)
      } catch (error) {
        if (error instanceof KountApiError && !error.retryable) throw new AbortError(error)
        throw error
      }

      let res
      try {
        res = await this.fetchWithTimeout(url.toString(), {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }, Math.min(this.config.attemptTimeoutMs, deadline - this.now()))
      } catch {
        if (method !== 'GET') sentWithoutResponse = true
        throw new KountApiError(`Kount ${operation} failed in transit`, {
          operation, phase: 'awaiting_response', retryable: true, attempts,
        })
      }

      const correlationId = res.headers.get('x-correlation-id')
      if (res.status === 401) {
        this.invalidateToken()
        throw new KountApiError(`Kount ${operation} unauthorized; refreshing token`, {
          operation, status: 401, retryable: true, correlationId, attempts,
        })
      }
      if (!res.ok) {
        const err = new KountApiError(`Kount ${operation} failed (HTTP ${res.status})`, {
          operation,
          status: res.status,
          retryable: isRetryableStatus(res.status),
          retryAfterMs: parseRetryAfter(res.headers.get('retry-after'), this.now()),
          correlationId,
          attempts,
        })
        if (!err.retryable) throw new AbortError(err)
        throw err
      }

      let parsed = null
      const text = await res.text()
      if (text) {
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = undefined // malformed success body; caller decides
        }
      }
      return { status: res.status, body: parsed, correlationId }
    }

    try {
      const result = await pRetry(run, {
        retries: this.config.maxRetries,
        factor: 2,
        minTimeout: this.minTimeout,
        maxTimeout: this.maxTimeout,
        randomize: true, // jitter
        maxRetryTime: this.config.operationDeadlineMs,
        onFailedAttempt: async ({ error, retriesLeft }) => {
          if (retriesLeft <= 0) return
          const wait = error?.retryAfterMs
          if (wait) {
            const remaining = deadline - this.now()
            if (wait > remaining) {
              // Never shorten Retry-After: stop instead.
              throw error
            }
            await new Promise((resolve) => setTimeout(resolve, wait))
          }
        },
      })
      return { ...result, attempts, possibleDuplicate: sentWithoutResponse && method === 'POST' }
    } catch (error) {
      const err = error instanceof KountApiError
        ? error
        : new KountApiError(`Kount ${operation} failed`, { operation, phase: 'before_send' })
      err.attempts = attempts
      err.possibleDuplicate = sentWithoutResponse && method === 'POST'
      throw err
    }
  }
}
