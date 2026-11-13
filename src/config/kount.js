// Kount Payments Fraud v2 configuration.
//
// Only the Kount Sandbox is wired up. The token and API hosts below are the
// Sandbox endpoints confirmed for this integration; the Commerce OAuth
// definition still names login.kount.com, which is stale for Sandbox. A
// production rollout needs the production hosts added here and the device
// collector switched to 'PROD' — see docs/KOUNT.md.

export const KOUNT_SANDBOX = Object.freeze({
  tokenUrl: 'https://login-uat.equifax.com/as/token',
  apiBaseUrl: 'https://api-sandbox.kount.com',
  // Environment name the Kount Web Client SDK expects for Sandbox collection.
  collectorEnvironment: 'TEST',
})

export const KOUNT_TOKEN_SCOPE = 'k1_integration_api'

// Refresh the bearer token this long before it actually expires.
export const KOUNT_TOKEN_REFRESH_SKEW_MS = 60_000

// Per-request timeout for Kount API calls.
export const KOUNT_REQUEST_TIMEOUT_MS = 10_000

// Bounded retries for requests Kount explicitly did not process (429/503,
// token endpoint errors). Order writes are never retried after a timeout.
export const KOUNT_MAX_ATTEMPTS = 3
export const KOUNT_BACKOFF_BASE_MS = 250
export const KOUNT_BACKOFF_MAX_MS = 2_000

// Webhook timestamp freshness window (Kount guidance: 45 minutes, to allow
// for retries).
export const KOUNT_WEBHOOK_MAX_AGE_MS = 45 * 60 * 1000

// Device session IDs are generated client-side as 32 hex characters; accept
// a conservative superset.
export const KOUNT_DEVICE_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

// Channel reported on every order so Kount policies can target OpenShop.
export const KOUNT_CHANNEL = 'OPENSHOP_WEB'

// KV keys for fraud review records.
export const KOUNT_KV_PREFIX = 'kount:order:'

// An evaluation still marked in progress after this long is treated as an
// uncertain outcome that needs reconciliation, never re-submitted blindly.
export const KOUNT_EVALUATION_STALE_MS = 5 * 60 * 1000

// Fraud review record states.
export const FRAUD_STATES = Object.freeze({
  EVALUATING: 'evaluating',
  APPROVED_CAPTURED: 'approved_captured',
  DECLINED_CANCELED: 'declined_canceled',
  // REVIEW: captured immediately; fulfillment is blocked until a reviewer
  // decides. Approval needs no payment action; decline is refunded.
  REVIEW_CAPTURED: 'review_captured',
  REVIEW_APPROVED: 'review_approved',
  REVIEW_DECLINED_CANCELED: 'review_declined_canceled',
  REVIEW_DECLINED_REFUNDED: 'review_declined_refunded',
  REVIEW_DECLINED_REFUND_PENDING: 'review_declined_refund_pending',
  // Kount could not give a decision (error, timeout, uncertain outcome).
  // The authorization is held — this is never treated as an approval.
  EVALUATION_FAILED_HOLD: 'evaluation_failed_hold',
  // Kount decided but the Stripe capture/cancel/refund failed.
  PAYMENT_ACTION_FAILED: 'payment_action_failed',
})

export const FRAUD_FINAL_STATES = new Set([
  FRAUD_STATES.APPROVED_CAPTURED,
  FRAUD_STATES.DECLINED_CANCELED,
  FRAUD_STATES.REVIEW_APPROVED,
  FRAUD_STATES.REVIEW_DECLINED_CANCELED,
  FRAUD_STATES.REVIEW_DECLINED_REFUNDED,
])

// Orders in these states may ship. Orders with no fraud record (Kount off
// when they were placed) are also fulfillable.
export const FRAUD_FULFILLABLE_STATES = new Set([
  FRAUD_STATES.APPROVED_CAPTURED,
  FRAUD_STATES.REVIEW_APPROVED,
])
