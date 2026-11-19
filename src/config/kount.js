// Kount Payments Fraud v2 configuration.
//
// One definition per setting, shared by the Worker (env + Developer Settings
// KV overrides) and the admin settings UI, so both paths apply the same
// defaults and validation. Invalid policy values are rejected with a clear
// error instead of being silently replaced by a default.

import { validatePublicKey } from '../lib/kountWebhook.js'

export const KOUNT_TOKEN_SCOPE = 'k1_integration_api'

// One switch selects the token server, API host and device-collection
// environment together, so they cannot point at different environments.
// Endpoints from the Payments Fraud v2.0 Integration Guide.
export const KOUNT_ENVIRONMENTS = {
  SANDBOX: {
    label: 'Sandbox',
    tokenUrl: 'https://login-uat.equifax.com/as/token',
    apiBaseUrl: 'https://api-sandbox.kount.com',
    ddcEnvironment: 'TEST',
    // Webhook public key service (Kount ENS). Not in the integration guide;
    // taken from the k360pf reference implementation.
    ensBaseUrl: 'https://app-sandbox.kount.com',
  },
  PRODUCTION: {
    label: 'Production',
    tokenUrl: 'https://login.equifax.com/as/token',
    apiBaseUrl: 'https://api.kount.com',
    ddcEnvironment: 'PROD',
    ensBaseUrl: 'https://app.kount.com',
  },
}
export const KOUNT_DEFAULT_ENVIRONMENT = 'SANDBOX'

export const KOUNT_DEFAULT_MAX_RETRIES = 2
export const KOUNT_MAX_RETRIES_LIMIT = 3
export const KOUNT_FALLBACK_DECISIONS = ['APPROVE', 'DECLINE']
export const KOUNT_DEFAULT_FALLBACK_DECISION = 'APPROVE'
export const KOUNT_DECISIONS = ['APPROVE', 'DECLINE', 'REVIEW']
// Kount fulfillment shipping.method enumeration.
export const KOUNT_SHIPPING_METHODS = ['STANDARD', 'EXPRESS', 'SAME_DAY', 'NEXT_DAY', 'SECOND_DAY']

// Time budgets (ms). The evaluation runs inside a Stripe webhook delivery, so
// the whole operation, including token refresh and backoff sleeps, must
// finish well before Stripe gives up on the delivery.
export const KOUNT_ATTEMPT_TIMEOUT_MS = 4000
export const KOUNT_OPERATION_DEADLINE_MS = 12000
export const KOUNT_BACKOFF_MIN_MS = 250
export const KOUNT_BACKOFF_MAX_MS = 2000

// Device data collection session IDs: we mint 32 lowercase hex characters.
export const KOUNT_SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/

/**
 * Every setting the integration reads. `secret` values are never returned to
 * the browser. All are editable from Developer Settings and fall back to env.
 * `options` renders the field as a dropdown; `defaultValue` is what applies
 * when neither Developer Settings nor env sets it.
 */
export const KOUNT_SETTING_FIELDS = [
  {
    key: 'KOUNT_ENVIRONMENT',
    label: 'Kount environment',
    secret: false,
    options: Object.entries(KOUNT_ENVIRONMENTS).map(([value, env]) => ({ value, label: env.label })),
    defaultValue: KOUNT_DEFAULT_ENVIRONMENT,
  },
  { key: 'KOUNT_CLIENT_ID', label: 'Kount client ID', secret: false },
  { key: 'KOUNT_API_KEY', label: 'Kount API key', secret: true },
  { key: 'KOUNT_MAX_RETRIES', label: `Kount max retries (0–${KOUNT_MAX_RETRIES_LIMIT}, default ${KOUNT_DEFAULT_MAX_RETRIES})`, secret: false },
  { key: 'KOUNT_FALLBACK_DECISION', label: 'Kount fallback decision (APPROVE or DECLINE, default APPROVE)', secret: false },
  { key: 'KOUNT_CHANNEL', label: 'Kount channel (optional)', secret: false },
  { key: 'KOUNT_SHIPPING_METHOD', label: `Kount shipping method for shipped orders (${KOUNT_SHIPPING_METHODS.join(', ')}; blank = not sent)`, secret: false },
  { key: 'KOUNT_WEBHOOK_PUBLIC_KEY', label: 'Kount webhook public key (base64 or PEM, from the Kount portal; enables portal review decisions)', secret: false },
  { key: 'STRIPE_WEBHOOK_SECRET', label: 'Stripe webhook signing secret', secret: true },
]

export const KOUNT_SETTING_KEYS = KOUNT_SETTING_FIELDS.map((f) => f.key)

export class KountConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'KountConfigError'
  }
}

function blank(value) {
  return value === undefined || value === null || String(value).trim() === ''
}

/** Validate one setting value. Returns an error string, or null when valid. */
export function validateKountSetting(key, value) {
  if (blank(value)) return null // blank = use the default / env fallback
  const v = String(value).trim()
  switch (key) {
    case 'KOUNT_MAX_RETRIES': {
      if (!/^\d+$/.test(v) || Number(v) > KOUNT_MAX_RETRIES_LIMIT) {
        return `KOUNT_MAX_RETRIES must be an integer from 0 to ${KOUNT_MAX_RETRIES_LIMIT}`
      }
      return null
    }
    case 'KOUNT_FALLBACK_DECISION':
      return KOUNT_FALLBACK_DECISIONS.includes(v)
        ? null
        : `KOUNT_FALLBACK_DECISION must be one of ${KOUNT_FALLBACK_DECISIONS.join(', ')}`
    case 'KOUNT_SHIPPING_METHOD':
      return KOUNT_SHIPPING_METHODS.includes(v)
        ? null
        : `KOUNT_SHIPPING_METHOD must be one of ${KOUNT_SHIPPING_METHODS.join(', ')}`
    case 'KOUNT_ENVIRONMENT':
      return Object.hasOwn(KOUNT_ENVIRONMENTS, v)
        ? null
        : `KOUNT_ENVIRONMENT must be one of ${Object.keys(KOUNT_ENVIRONMENTS).join(', ')}`
    case 'KOUNT_WEBHOOK_PUBLIC_KEY':
      return validatePublicKey(v)
    case 'KOUNT_API_KEY':
      return /\s/.test(v) || /^basic\s/i.test(v)
        ? 'KOUNT_API_KEY must be the raw portal API key (no "Basic " prefix or whitespace)'
        : null
    default:
      return null
  }
}

/**
 * Build the effective Kount configuration from resolved raw values.
 * Throws KountConfigError when a policy value is invalid.
 *
 * @param {Record<string, string|undefined>} raw
 */
export function buildKountConfig(raw = {}) {
  const errors = KOUNT_SETTING_KEYS
    .map((key) => validateKountSetting(key, raw[key]))
    .filter(Boolean)
  if (errors.length > 0) {
    throw new KountConfigError(`Invalid Kount configuration: ${errors.join('; ')}`)
  }

  const str = (key) => (blank(raw[key]) ? '' : String(raw[key]).trim())
  const clientId = str('KOUNT_CLIENT_ID')
  const apiKey = str('KOUNT_API_KEY')
  const environment = str('KOUNT_ENVIRONMENT') || KOUNT_DEFAULT_ENVIRONMENT
  const endpoints = KOUNT_ENVIRONMENTS[environment]

  return {
    // Risk evaluation runs only when both credentials are present.
    enabled: Boolean(clientId && apiKey),
    clientId,
    apiKey,
    maxRetries: blank(raw.KOUNT_MAX_RETRIES) ? KOUNT_DEFAULT_MAX_RETRIES : Number(str('KOUNT_MAX_RETRIES')),
    fallbackDecision: str('KOUNT_FALLBACK_DECISION') || KOUNT_DEFAULT_FALLBACK_DECISION,
    channel: str('KOUNT_CHANNEL'),
    shippingMethod: str('KOUNT_SHIPPING_METHOD'),
    environment,
    tokenUrl: endpoints.tokenUrl,
    apiBaseUrl: endpoints.apiBaseUrl,
    ddcEnvironment: endpoints.ddcEnvironment,
    ensBaseUrl: endpoints.ensBaseUrl,
    stripeWebhookSecret: str('STRIPE_WEBHOOK_SECRET'),
    webhookPublicKey: str('KOUNT_WEBHOOK_PUBLIC_KEY'),
  }
}
