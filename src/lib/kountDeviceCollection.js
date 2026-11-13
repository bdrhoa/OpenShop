// Browser-side Kount device data collection (DDC).
//
// OpenShop sends buyers straight to hosted Stripe Checkout, so there is no
// merchant-controlled checkout page to collect on. Collection starts on every
// storefront entry instead (including deep links to products), and the same
// device session id is handed to the server when checkout begins.
//
// A fresh id is created per browser session (sessionStorage) and kept through
// navigation and the checkout handoff.

const STORAGE_KEY = 'openshop-kount-session-id'

let memorySessionId = null
let collectionStarted = false

function newSessionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '')
  }
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** The device session id for this browser session (created on first use). */
export function getKountSessionId() {
  try {
    let id = sessionStorage.getItem(STORAGE_KEY)
    if (!id) {
      id = newSessionId()
      sessionStorage.setItem(STORAGE_KEY, id)
    }
    return id
  } catch {
    // Storage blocked (private mode, sandboxed frame): keep one id per page load.
    memorySessionId ||= newSessionId()
    return memorySessionId
  }
}

/**
 * Start Kount collection once per page load, if the store has Kount enabled.
 * Never throws: a collection failure must not break the storefront.
 */
export async function startKountCollection() {
  if (collectionStarted || typeof window === 'undefined') return
  collectionStarted = true
  try {
    const response = await fetch('/api/payments-status')
    if (!response.ok) return
    const { fraudPrevention } = await response.json()
    if (fraudPrevention?.provider !== 'kount' || !fraudPrevention.clientId) return

    const { default: kountSDK } = await import('@kount/kount-web-client-sdk')
    kountSDK(
      {
        clientID: fraudPrevention.clientId,
        environment: fraudPrevention.environment,
        isSinglePageApp: true,
      },
      getKountSessionId(),
    )
  } catch (error) {
    console.warn('[Kount] device data collection did not start:', error?.message || error)
  }
}
