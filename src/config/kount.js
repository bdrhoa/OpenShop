// Kount Payments Fraud (v2) configuration.
//
// Every setting here can come from the Worker environment (ENV / wrangler
// vars / secrets) or from Developer Settings in the admin UI, which writes to
// KV and takes precedence. Both paths go through `parseKountConfig`, so the
// same defaults and validation apply whichever source a value came from.
//
// One setting, KOUNT_ENVIRONMENT (SANDBOX or PRODUCTION), selects the token
// endpoint, the API host and the device data collection environment together,
// so they can never point at different Kount environments. The Sandbox token
// endpoint is login-uat.equifax.com; the Commerce OpenAPI document still names
// a stale login.kount.com host, which we deliberately do not use (see
// docs/KOUNT.md).

const KOUNT_COMMON = Object.freeze({
  ordersPath: '/commerce/v2/orders',
  tokenScope: 'k1_integration_api',
})

export const KOUNT_ENVIRONMENT_SETTINGS = Object.freeze({
  SANDBOX: Object.freeze({
    ...KOUNT_COMMON,
    environment: 'SANDBOX',
    tokenUrl: 'https://login-uat.equifax.com/as/token',
    apiBaseUrl: 'https://api-sandbox.kount.com',
    ddcEnvironment: 'TEST', // tst.kaptcha.com
  }),
  PRODUCTION: Object.freeze({
    ...KOUNT_COMMON,
    environment: 'PRODUCTION',
    tokenUrl: 'https://login.equifax.com/as/token',
    apiBaseUrl: 'https://api.kount.com',
    ddcEnvironment: 'PROD', // ssl.kaptcha.com
  }),
})

export const KOUNT_ENVIRONMENTS = Object.freeze(Object.keys(KOUNT_ENVIRONMENT_SETTINGS))

/** Kept for callers that want the Sandbox endpoints explicitly. */
export const KOUNT_SANDBOX = KOUNT_ENVIRONMENT_SETTINGS.SANDBOX

export const KOUNT_DECISIONS = Object.freeze(['APPROVE', 'DECLINE', 'REVIEW'])
export const KOUNT_FALLBACK_DECISIONS = Object.freeze(['APPROVE', 'DECLINE'])

export const KOUNT_DEFAULTS = Object.freeze({
  maxRetries: 2,
  fallbackDecision: 'APPROVE',
  environment: 'SANDBOX',
  channel: 'OPENSHOP_WEB',
  // Per-attempt HTTP timeout and the total budget for one logical operation
  // (token + request + backoff sleeps). Kept well under the Stripe webhook
  // response window so a slow Kount never makes Stripe retry the delivery.
  attemptTimeoutMs: 4000,
  operationDeadlineMs: 9000,
  // Webhook timestamp freshness: the Kount guide suggests 45 minutes so
  // provider retries stay acceptable. Future skew bounds clock drift.
  webhookMaxAgeMs: 45 * 60 * 1000,
  webhookMaxFutureSkewMs: 5 * 60 * 1000,
})

export const KOUNT_MAX_RETRIES_LIMIT = 3

/**
 * Every Kount-related setting. `secret` values are never sent to the browser.
 * The same list drives Developer Settings so UI and ENV stay in parity.
 */
export const KOUNT_SETTING_FIELDS = Object.freeze([
  { key: 'KOUNT_CLIENT_ID', label: 'Kount client ID', secret: false },
  { key: 'KOUNT_API_KEY', label: 'Kount API key', secret: true },
  { key: 'KOUNT_MAX_RETRIES', label: 'Kount max retries (0–3, default 2)', secret: false },
  { key: 'KOUNT_FALLBACK_DECISION', label: 'Kount fallback decision (APPROVE or DECLINE)', secret: false },
  { key: 'KOUNT_WEBHOOK_PUBLIC_KEY', label: 'Kount webhook public key (base64 from the Kount portal)', secret: false, multiline: true },
  { key: 'KOUNT_CHANNEL', label: 'Kount channel', secret: false },
  { key: 'KOUNT_ENVIRONMENT', label: 'Kount environment (SANDBOX or PRODUCTION; sets API endpoints and device collection)', secret: false },
  { key: 'STRIPE_WEBHOOK_SECRET', label: 'Stripe webhook signing secret', secret: true },
])

export const KOUNT_SETTING_KEYS = Object.freeze(KOUNT_SETTING_FIELDS.map((f) => f.key))

export class KountConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'KountConfigError'
  }
}

function blank(value) {
  return value === undefined || value === null || String(value).trim() === ''
}

/**
 * Validate a single setting value. Returns the normalized value, or throws
 * KountConfigError with a message suitable for the admin UI.
 */
export function validateKountSetting(key, raw) {
  if (blank(raw)) return undefined
  const value = String(raw).trim()
  switch (key) {
    case 'KOUNT_MAX_RETRIES': {
      if (!/^\d+$/.test(value)) {
        throw new KountConfigError(`KOUNT_MAX_RETRIES must be a whole number from 0 to ${KOUNT_MAX_RETRIES_LIMIT}`)
      }
      const n = Number(value)
      if (n < 0 || n > KOUNT_MAX_RETRIES_LIMIT) {
        throw new KountConfigError(`KOUNT_MAX_RETRIES must be from 0 to ${KOUNT_MAX_RETRIES_LIMIT}`)
      }
      return n
    }
    case 'KOUNT_FALLBACK_DECISION': {
      const upper = value.toUpperCase()
      if (!KOUNT_FALLBACK_DECISIONS.includes(upper)) {
        throw new KountConfigError('KOUNT_FALLBACK_DECISION must be APPROVE or DECLINE')
      }
      return upper
    }
    case 'KOUNT_ENVIRONMENT': {
      const upper = value.toUpperCase()
      if (!KOUNT_ENVIRONMENTS.includes(upper)) {
        throw new KountConfigError('KOUNT_ENVIRONMENT must be SANDBOX or PRODUCTION')
      }
      return upper
    }
    case 'KOUNT_WEBHOOK_PUBLIC_KEY': {
      // The Kount portal shows the key as bare base64 (DER SubjectPublicKeyInfo,
      // e.g. "MIICIjANBgkq..."). PEM-armored keys are accepted too.
      const body = value
        .replace(/-----BEGIN PUBLIC KEY-----/, '')
        .replace(/-----END PUBLIC KEY-----/, '')
        .replace(/\\n/g, '')
        .replace(/\s+/g, '')
      let der
      try {
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) throw new Error('not base64')
        der = atob(body)
      } catch {
        throw new KountConfigError('KOUNT_WEBHOOK_PUBLIC_KEY must be the base64 public key from the Kount portal (for example MIICIjANBgkq...)')
      }
      // DER SubjectPublicKeyInfo starts with a SEQUENCE tag (0x30).
      if (der.length < 64 || der.charCodeAt(0) !== 0x30) {
        throw new KountConfigError('KOUNT_WEBHOOK_PUBLIC_KEY is not a valid public key (expected base64 like MIICIjANBgkq...)')
      }
      return value
    }
    case 'KOUNT_CHANNEL': {
      if (value.length > 64) throw new KountConfigError('KOUNT_CHANNEL must be at most 64 characters')
      return value
    }
    default:
      return value
  }
}

/**
 * Build the effective Kount configuration from resolved raw values
 * (`{ KOUNT_CLIENT_ID: '...', ... }`). Invalid policy values throw rather
 * than silently falling back to a default — a typo in the fallback decision
 * must not quietly change what happens to orders.
 */
export function parseKountConfig(raw = {}) {
  const v = (key) => validateKountSetting(key, raw[key])
  const clientId = v('KOUNT_CLIENT_ID')
  const apiKey = v('KOUNT_API_KEY')
  const environment = v('KOUNT_ENVIRONMENT') ?? KOUNT_DEFAULTS.environment
  return {
    enabled: Boolean(clientId && apiKey),
    clientId,
    apiKey,
    maxRetries: v('KOUNT_MAX_RETRIES') ?? KOUNT_DEFAULTS.maxRetries,
    fallbackDecision: v('KOUNT_FALLBACK_DECISION') ?? KOUNT_DEFAULTS.fallbackDecision,
    webhookPublicKey: v('KOUNT_WEBHOOK_PUBLIC_KEY'),
    channel: v('KOUNT_CHANNEL') ?? KOUNT_DEFAULTS.channel,
    stripeWebhookSecret: v('STRIPE_WEBHOOK_SECRET'),
    attemptTimeoutMs: KOUNT_DEFAULTS.attemptTimeoutMs,
    operationDeadlineMs: KOUNT_DEFAULTS.operationDeadlineMs,
    // tokenUrl, apiBaseUrl, ordersPath, tokenScope, environment, ddcEnvironment
    ...KOUNT_ENVIRONMENT_SETTINGS[environment],
  }
}

/** Public webhook paths; the absolute URL is SITE_URL + path. */
export const WEBHOOK_PATHS = Object.freeze({
  stripe: '/api/webhooks/stripe',
  kount: '/api/webhooks/kount',
})

export function webhookUrl(siteUrl, which) {
  if (!siteUrl) return null
  return `${String(siteUrl).replace(/\/+$/, '')}${WEBHOOK_PATHS[which]}`
}
