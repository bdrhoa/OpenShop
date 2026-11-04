// Kount Device Data Collector (DDC) scope and limits.
//
// The DDC is a proof of concept for one store. Every DDC behaviour (client
// collection, CSP allowances, forwarding the session ID to checkout) is gated
// on this exact hostname, so other sites stay unchanged even if they are built
// from the same code.
export const KOUNT_DDC_HOST = 'kount-poc-run-110301.bdrhoa.workers.dev'

export const KOUNT_DDC_ENVIRONMENT = 'TEST'
export const KOUNT_COLLECTOR_ORIGIN = 'https://tst.kaptcha.com'

/** Stripe metadata key that links an order to its device data. */
export const KOUNT_SESSION_METADATA_KEY = 'kount_session_id'

const KOUNT_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

export function isKountDdcHost(hostname) {
  return hostname === KOUNT_DDC_HOST
}

export function isValidKountSessionId(value) {
  return typeof value === 'string' && KOUNT_SESSION_ID_PATTERN.test(value)
}
