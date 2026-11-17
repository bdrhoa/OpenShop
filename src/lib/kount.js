// Client-side Kount device data collection (DDC).
//
// Hosted Stripe Checkout runs on Stripe's domain, so device data must be
// collected on OpenShop pages before the buyer leaves. Collection starts on
// every storefront entry (including deep links), with one fresh session ID per
// browser session (sessionStorage is per tab). The same ID is sent with the
// checkout request and ends up as the Kount order's deviceSessionId.

const SESSION_KEY = 'openshop-kount-session-id'
let memorySessionId = null
let started = false

function newSessionId() {
  // The SDK accepts [a-zA-Z0-9.] only: 32 hex chars.
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID().replace(/-/g, '')
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function getKountSessionId() {
  try {
    let id = sessionStorage.getItem(SESSION_KEY)
    if (!id) {
      id = newSessionId()
      sessionStorage.setItem(SESSION_KEY, id)
    }
    return id
  } catch {
    // Storage blocked (private mode, sandboxed frame): keep it for this page.
    memorySessionId = memorySessionId || newSessionId()
    return memorySessionId
  }
}

/** Start DDC once per page load. Never throws; checkout works without it. */
export async function startKountCollection() {
  if (started || typeof window === 'undefined') return
  started = true
  try {
    const res = await fetch('/api/kount/config')
    if (!res.ok) return
    const cfg = await res.json()
    if (!cfg?.enabled || !cfg.clientId) return
    const { default: kountSDK } = await import('@kount/kount-web-client-sdk')
    kountSDK(
      { clientID: cfg.clientId, environment: cfg.environment || 'TEST', isSinglePageApp: true },
      getKountSessionId(),
    )
  } catch (error) {
    console.warn('[Kount] device data collection unavailable:', error?.message || error)
  }
}

/** Add the device session ID to a checkout request body. */
export function withKountSession(body) {
  return { ...body, kountSessionId: getKountSessionId() }
}
