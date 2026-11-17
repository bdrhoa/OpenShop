// Kount Payments Fraud v2 API client (server-side only).
//
// - OAuth client_credentials token, cached per isolate until shortly before
//   expiry, with concurrent refreshes coalesced into one request.
// - POST /commerce/v2/orders (riskInquiry=true for evaluation, false for
//   data-only) and PATCH /commerce/v2/orders/{orderId} for status updates.
// - Failures carry a phase so callers never treat an uncertain write as
//   "not sent". Transient failures that Kount cannot have acted on are retried
//   with bounded backoff; uncertain ones are surfaced, not retried.
import {
  KOUNT_SANDBOX_TOKEN_URL,
  KOUNT_SANDBOX_API_URL,
  KOUNT_TOKEN_SCOPE,
  KOUNT_DDC_ENVIRONMENT_DEFAULT,
  KOUNT_TOKEN_REFRESH_MARGIN_MS,
  KOUNT_REQUEST_TIMEOUT_MS,
  KOUNT_MAX_ATTEMPTS,
  KOUNT_BACKOFF_MS,
} from '../config/kount.js'
import { resolveSetting } from './DeveloperSettingsService.js'

export const KOUNT_SETTING_KEYS = [
  'KOUNT_CLIENT_ID',
  'KOUNT_API_KEY',
  'KOUNT_WEBHOOK_PUBLIC_KEY',
  'KOUNT_CHANNEL',
  'KOUNT_TOKEN_URL',
  'KOUNT_API_URL',
  'KOUNT_DDC_ENVIRONMENT',
  'STRIPE_WEBHOOK_SECRET',
]

/**
 * Resolve all Kount-related settings (KV first, then env).
 * @returns {Promise<Record<string, string|undefined>>}
 */
export async function resolveKountConfig(kv, env) {
  const entries = await Promise.all(
    KOUNT_SETTING_KEYS.map(async (key) => [key, await resolveSetting(kv, env, key)]),
  )
  const cfg = Object.fromEntries(entries)
  return {
    clientId: cfg.KOUNT_CLIENT_ID || undefined,
    apiKey: cfg.KOUNT_API_KEY || undefined,
    webhookPublicKey: cfg.KOUNT_WEBHOOK_PUBLIC_KEY || undefined,
    channel: cfg.KOUNT_CHANNEL || undefined,
    tokenUrl: cfg.KOUNT_TOKEN_URL || KOUNT_SANDBOX_TOKEN_URL,
    apiUrl: (cfg.KOUNT_API_URL || KOUNT_SANDBOX_API_URL).replace(/\/+$/, ''),
    ddcEnvironment: (cfg.KOUNT_DDC_ENVIRONMENT || KOUNT_DDC_ENVIRONMENT_DEFAULT).toUpperCase(),
    stripeWebhookSecret: cfg.STRIPE_WEBHOOK_SECRET || undefined,
  }
}

/**
 * Kount screening holds payment (manual capture) until a decision is made.
 * That is only safe when the Stripe webhook that releases the hold is also
 * configured; otherwise authorizations would sit uncaptured and expire.
 */
export function isKountEnabled(cfg) {
  return Boolean(cfg?.clientId && cfg?.apiKey && cfg?.stripeWebhookSecret)
}

export class KountApiError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, phase: 'before_send'|'awaiting_response'|'response_received', retryable: boolean, correlationId?: string, operation: string }} info
   */
  constructor(message, info) {
    super(message)
    this.name = 'KountApiError'
    Object.assign(this, info)
  }

  /** True when Kount may have accepted the write; do not blindly re-send. */
  get uncertain() {
    if (this.phase === 'awaiting_response') return true
    return this.phase === 'response_received' && this.status >= 500 && this.status !== 503
  }
}

// Per-isolate token cache. Keyed by token URL + key so a settings change takes
// effect immediately. The key itself is never logged or returned.
const tokenCache = new Map()

/** Test hook. */
export function clearKountTokenCache() {
  tokenCache.clear()
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class KountService {
  /**
   * @param {{ apiKey: string, tokenUrl: string, apiUrl: string }} cfg
   * @param {{ fetch?: typeof fetch, now?: () => number, sleep?: (ms:number)=>Promise<void> }} [deps]
   */
  constructor(cfg, deps = {}) {
    if (!cfg?.apiKey) throw new Error('KountService requires KOUNT_API_KEY')
    this.cfg = cfg
    this.fetch = deps.fetch || ((...args) => fetch(...args))
    this.now = deps.now || (() => Date.now())
    this.sleep = deps.sleep || sleep
    this.cacheKey = `${cfg.tokenUrl}|${cfg.apiKey}`
  }

  async getToken({ forceRefresh = false } = {}) {
    const cached = tokenCache.get(this.cacheKey)
    if (!forceRefresh && cached?.token && cached.expiresAt - KOUNT_TOKEN_REFRESH_MARGIN_MS > this.now()) {
      return cached.token
    }
    if (cached?.pending) return cached.pending

    const pending = this.requestToken()
      .then(({ token, expiresIn }) => {
        tokenCache.set(this.cacheKey, { token, expiresAt: this.now() + expiresIn * 1000 })
        return token
      })
      .catch((err) => {
        tokenCache.delete(this.cacheKey)
        throw err
      })
    tokenCache.set(this.cacheKey, { ...(cached || {}), pending })
    return pending
  }

  async requestToken() {
    let res
    try {
      res = await this.fetch(this.cfg.tokenUrl, {
        method: 'POST',
        headers: {
          // The portal API key is already the Basic credential; send it as-is.
          Authorization: `Basic ${this.cfg.apiKey.trim()}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ grant_type: 'client_credentials', scope: KOUNT_TOKEN_SCOPE }).toString(),
        signal: AbortSignal.timeout(KOUNT_REQUEST_TIMEOUT_MS),
      })
    } catch (err) {
      // No order was sent; safe to retry the whole operation.
      throw new KountApiError(`Kount token request failed: ${err?.name || 'network error'}`, {
        operation: 'token', phase: 'before_send', retryable: true,
      })
    }
    if (!res.ok) {
      throw new KountApiError(`Kount token request returned HTTP ${res.status}`, {
        operation: 'token',
        status: res.status,
        phase: 'before_send',
        retryable: res.status === 429 || res.status >= 500,
      })
    }
    const body = await res.json().catch(() => ({}))
    if (!body.access_token) {
      throw new KountApiError('Kount token response had no access_token', {
        operation: 'token', phase: 'before_send', retryable: false,
      })
    }
    const expiresIn = Number(body.expires_in) > 0 ? Number(body.expires_in) : 300
    return { token: body.access_token, expiresIn }
  }

  /** One HTTP attempt against the Commerce API. */
  async send(operation, method, path, body) {
    const token = await this.getToken() // throws before_send on failure
    let res
    try {
      res = await this.fetch(`${this.cfg.apiUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(KOUNT_REQUEST_TIMEOUT_MS),
      })
    } catch (err) {
      throw new KountApiError(`Kount ${operation} got no response: ${err?.name || 'network error'}`, {
        operation, phase: 'awaiting_response', retryable: false,
      })
    }
    const correlationId = res.headers?.get?.('x-correlation-id') || undefined
    const data = await res.json().catch(() => null)
    if (res.ok) return { data, correlationId }

    if (res.status === 401) tokenCache.delete(this.cacheKey)
    // Response messages are not echoed into errors: they may contain order data.
    throw new KountApiError(`Kount ${operation} returned HTTP ${res.status}`, {
      operation,
      status: res.status,
      phase: 'response_received',
      correlationId,
      retryable: res.status === 401 || res.status === 429 || res.status === 503,
    })
  }

  /**
   * Retry wrapper. `idempotent` writes (PATCH status) may also be retried after
   * uncertain failures; a POST may not, since it would create a second order.
   */
  async withRetry(fn, { idempotent }) {
    let lastErr
    for (let attempt = 0; attempt < KOUNT_MAX_ATTEMPTS; attempt++) {
      try {
        return await fn()
      } catch (err) {
        lastErr = err
        const canRetry = err instanceof KountApiError && (err.retryable || (idempotent && err.uncertain))
        if (!canRetry || attempt === KOUNT_MAX_ATTEMPTS - 1) throw err
        await this.sleep(KOUNT_BACKOFF_MS[Math.min(attempt, KOUNT_BACKOFF_MS.length - 1)])
      }
    }
    throw lastErr
  }

  /** POST an order. riskInquiry=true returns a decision; false is data-only. */
  async postOrder(order, { riskInquiry }) {
    const path = `/commerce/v2/orders?riskInquiry=${riskInquiry ? 'true' : 'false'}`
    const operation = riskInquiry ? 'evaluate_order' : 'data_only_order'
    const { data, correlationId } = await this.withRetry(
      () => this.send(operation, 'POST', path, order),
      { idempotent: false },
    )
    return parseOrderResponse(data, correlationId)
  }

  /** PATCH an existing Kount order (no new risk inquiry). */
  async updateOrder(orderId, patch) {
    const path = `/commerce/v2/orders/${encodeURIComponent(orderId)}`
    const { data, correlationId } = await this.withRetry(
      () => this.send('update_order', 'PATCH', path, patch),
      { idempotent: true },
    )
    return { data, correlationId }
  }
}

const DECISIONS = new Set(['APPROVE', 'DECLINE', 'REVIEW'])

/** Extract the fields OpenShop stores; unknown decisions stay null (never approval). */
export function parseOrderResponse(data, correlationId) {
  const order = data?.order || {}
  const raw = order.riskInquiry?.decision
  return {
    orderId: order.orderId || null,
    decision: DECISIONS.has(raw) ? raw : null,
    omniscore: typeof order.riskInquiry?.omniscore === 'number' ? order.riskInquiry.omniscore : null,
    deviceId: order.riskInquiry?.device?.id || null,
    transactionId: order.transactions?.[0]?.transactionId || null,
    correlationId: correlationId || null,
  }
}
