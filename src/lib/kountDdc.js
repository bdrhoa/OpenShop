// Browser-side Kount device data collection (DDC).
//
// OpenShop sends buyers to hosted Stripe Checkout, which Kount cannot
// instrument, and buyers can arrive on any storefront page (deep links). So
// collection starts on every storefront entry, not on a checkout page.
//
// One fresh device session ID per browser session (sessionStorage), kept
// across navigation and handed to the server when checkout starts. Checkout
// waits a bounded time for collection to finish before redirecting; a slow
// or blocked collector never blocks the purchase.

const SESSION_KEY = 'openshop-kount-session-id'
const DEFAULT_WAIT_MS = 1500

let startPromise = null
let collectionDone = null
let resolveCollection = null
let state = { enabled: false, status: 'idle' }

function newSessionId() {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** The device session ID for this browser session (created on first use). */
export function getKountSessionId() {
  try {
    let id = sessionStorage.getItem(SESSION_KEY)
    if (!id || !/^[a-f0-9]{32}$/.test(id)) {
      id = newSessionId()
      sessionStorage.setItem(SESSION_KEY, id)
    }
    return id
  } catch {
    // Storage blocked: keep one ID for this page lifetime.
    state.fallbackId ||= newSessionId()
    return state.fallbackId
  }
}

/** Current collection state, for debugging: idle | disabled | collecting | complete | failed. */
export function getKountCollectionState() {
  return { ...state }
}

/**
 * Start collection once per page load. Safe to call repeatedly.
 * Does nothing when Kount is not configured on the server.
 */
export function startKountCollection() {
  if (startPromise) return startPromise
  collectionDone = new Promise((resolve) => { resolveCollection = resolve })

  startPromise = (async () => {
    try {
      const res = await fetch('/api/kount/config', { headers: { Accept: 'application/json' } })
      const config = res.ok ? await res.json() : { enabled: false }
      if (!config.enabled || !config.clientId) {
        state = { enabled: false, status: 'disabled' }
        resolveCollection(false)
        return state
      }

      state = { enabled: true, status: 'collecting', sessionId: getKountSessionId() }
      const { default: kountSDK } = await import('@kount/kount-web-client-sdk')
      const sdk = kountSDK({
        clientID: config.clientId,
        environment: config.environment,
        isSinglePageApp: true,
        callbacks: {
          'collect-end': () => {
            state = { ...state, status: 'complete' }
            resolveCollection(true)
          },
        },
      }, state.sessionId)
      if (!sdk) {
        state = { ...state, status: 'failed', reason: 'sdk_disabled' }
        resolveCollection(false)
      }
    } catch (error) {
      state = { ...state, status: 'failed', reason: error?.message || 'load_failed' }
      resolveCollection(false)
    }
    return state
  })()
  return startPromise
}

/**
 * Fields to add to a checkout request. Waits up to `waitMs` for collection
 * to finish; the session ID is sent either way when Kount is enabled.
 */
export async function getKountCheckoutFields({ waitMs = DEFAULT_WAIT_MS } = {}) {
  await startKountCollection()
  if (!state.enabled) return {}
  await Promise.race([
    collectionDone,
    new Promise((resolve) => setTimeout(resolve, waitMs)),
  ])
  return { kountSessionId: state.sessionId || getKountSessionId() }
}
