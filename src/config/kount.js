// Kount Payments Fraud v2 configuration.
//
// OpenShop targets the Kount Sandbox by default. Production hosts are set with
// KOUNT_TOKEN_URL / KOUNT_API_URL / KOUNT_DDC_ENVIRONMENT once a production
// tenant exists. See docs/KOUNT.md.

export const KOUNT_SANDBOX_TOKEN_URL = 'https://login-uat.equifax.com/as/token'
export const KOUNT_SANDBOX_API_URL = 'https://api-sandbox.kount.com'
export const KOUNT_TOKEN_SCOPE = 'k1_integration_api'

/** Device data collection environment passed to @kount/kount-web-client-sdk. */
export const KOUNT_DDC_ENVIRONMENT_DEFAULT = 'TEST'

/** Refresh a cached bearer token this long before it expires. */
export const KOUNT_TOKEN_REFRESH_MARGIN_MS = 60_000

/** Per-request timeout for Kount HTTP calls. */
export const KOUNT_REQUEST_TIMEOUT_MS = 8_000

/** Bounded retry for transient (pre-send / 429 / 503) failures. */
export const KOUNT_MAX_ATTEMPTS = 3
export const KOUNT_BACKOFF_MS = [250, 1_000]

/** An in-flight evaluation lock older than this is treated as abandoned. */
export const KOUNT_EVALUATION_LOCK_MS = 120_000

/** Kount webhook timestamps outside this window are rejected (guide: 45 min). */
export const KOUNT_WEBHOOK_MAX_SKEW_MS = 45 * 60_000

/**
 * The SDK accepts only [a-zA-Z0-9.] session IDs. Kept at 32 hex chars by the
 * storefront; the server accepts up to 64 to stay tolerant.
 */
export const KOUNT_SESSION_ID_PATTERN = /^[a-zA-Z0-9.]{1,64}$/

/** KV key prefix for per-checkout Kount order state. */
export const KOUNT_ORDER_KV_PREFIX = 'kount:order:'

/** Stripe metadata keys written at checkout creation. */
export const KOUNT_METADATA = {
  HOLD: 'kount_hold',
  SESSION_ID: 'kount_session_id',
  USER_IP: 'kount_user_ip',
}
