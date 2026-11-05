// Kount scope and limits.
//
// Kount is a proof of concept for one store. Every Kount behaviour (client
// collection, CSP allowances, forwarding the session ID to checkout, manual
// capture and risk evaluation) is gated on this exact hostname, so other sites
// stay unchanged even if they are built from the same code.
export const KOUNT_DDC_HOST = 'kount-poc-run-110301.bdrhoa.workers.dev'

export const KOUNT_DDC_ENVIRONMENT = 'TEST'
export const KOUNT_COLLECTOR_ORIGIN = 'https://tst.kaptcha.com'

// Payments Fraud v2 Sandbox. The API key is a Worker secret (KOUNT_API_KEY).
export const KOUNT_TOKEN_URL = 'https://login-uat.equifax.com/as/token'
export const KOUNT_TOKEN_SCOPE = 'k1_integration_api'
export const KOUNT_ORDERS_URL = 'https://api-sandbox.kount.com/commerce/v2/orders'
export const KOUNT_REQUEST_TIMEOUT_MS = 8000
export const KOUNT_CHANNEL = 'kount-poc-run-110301'

/** Stripe metadata key that links an order to its device data. */
export const KOUNT_SESSION_METADATA_KEY = 'kount_session_id'
/** The webhook has no customer connection, so checkout records the buyer's IP. */
export const KOUNT_USER_IP_METADATA_KEY = 'kount_user_ip'
/** PaymentIntent metadata keys. A saved decision stops a webhook retry re-evaluating. */
export const KOUNT_ORDER_ID_METADATA_KEY = 'kount_order_id'
export const KOUNT_DECISION_METADATA_KEY = 'kount_decision'

/** The only decisions that release a held payment. Anything else cancels it. */
export const KOUNT_CAPTURE_DECISIONS = ['APPROVE', 'REVIEW']
export const KOUNT_DECISIONS = [...KOUNT_CAPTURE_DECISIONS, 'DECLINE']

const KOUNT_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

export function isKountDdcHost(hostname) {
  return hostname === KOUNT_DDC_HOST
}

export function isValidKountSessionId(value) {
  return typeof value === 'string' && KOUNT_SESSION_ID_PATTERN.test(value)
}
