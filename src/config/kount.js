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

/** Captures the payment, but the order is on hold until a Kount webhook resolves it. */
export const KOUNT_REVIEW_DECISION = 'REVIEW'
export const KOUNT_DECLINE_DECISION = 'DECLINE'
/** The only decisions that release a held payment. Anything else cancels it. */
export const KOUNT_CAPTURE_DECISIONS = ['APPROVE', KOUNT_REVIEW_DECISION]
export const KOUNT_DECISIONS = [...KOUNT_CAPTURE_DECISIONS, KOUNT_DECLINE_DECISION]

/** A captured order that may not ship until a reviewer approves it. */
export const ORDER_STATUS_ON_HOLD = 'on_hold'
/** A captured order that a reviewer declined, so its payment is refunded. */
export const ORDER_STATUS_REFUNDED = 'refunded'

/** Kount's guide recommends this window, so that its retries still verify. */
export const KOUNT_WEBHOOK_MAX_AGE_MS = 45 * 60 * 1000

const KOUNT_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

export function isKountDdcHost(hostname) {
  return hostname === KOUNT_DDC_HOST
}

export function isValidKountSessionId(value) {
  return typeof value === 'string' && KOUNT_SESSION_ID_PATTERN.test(value)
}
