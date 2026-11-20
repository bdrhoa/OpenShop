// Kount device data collection (DDC) for the storefront.
//
// OpenShop sends buyers straight to hosted Stripe Checkout, sometimes from a
// deep link, so collection starts on every storefront entry rather than on a
// checkout page we do not control. One device session ID is kept per browser
// session (sessionStorage) and passed to the checkout endpoint, which hands
// it to Kount as deviceSessionId when the order is evaluated.
//
// Collection is best effort: a blocked SDK, a missing client ID or a slow
// collector never blocks checkout. Before redirecting, checkout waits a
// bounded time for collection to finish.

const STORAGE_KEY = 'openshop_kount_session'
let collection = null
let memorySessionId = null

function newSessionId() {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  // 32 hex chars: within Kount's alphanumeric, max-32 session ID format.
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** The device session ID for this browser session (created on first use). */
export function getKountSessionId() {
  try {
    let id = sessionStorage.getItem(STORAGE_KEY)
    if (!id || !/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
      id = newSessionId()
      sessionStorage.setItem(STORAGE_KEY, id)
    }
    return id
  } catch {
    // Storage blocked (private mode, etc.): keep one ID for this page life.
    memorySessionId = memorySessionId || newSessionId()
    return memorySessionId
  }
}

/**
 * Start collection once per page load. Resolves with
 * { status: 'collected' | 'disabled' | 'failed' | 'skipped', sessionId? }.
 */
export function startKountCollection() {
  if (collection) return collection
  if (typeof window === 'undefined' || window.location.pathname.startsWith('/admin')) {
    collection = Promise.resolve({ status: 'skipped' })
    return collection
  }

  collection = (async () => {
    const res = await fetch('/api/kount/config')
    const cfg = res.ok ? await res.json() : null
    if (!cfg?.enabled || !cfg.clientId) return { status: 'disabled' }

    const sessionId = getKountSessionId()
    const { default: kountSDK } = await import('@kount/kount-web-client-sdk')
    return await new Promise((resolve) => {
      const sdk = kountSDK({
        clientID: cfg.clientId,
        environment: cfg.environment || 'TEST',
        isSinglePageApp: true,
        callbacks: {
          'collect-end': () => resolve({ status: 'collected', sessionId }),
        },
      }, sessionId)
      if (!sdk) resolve({ status: 'failed', sessionId })
    })
  })().catch(() => ({ status: 'failed' }))

  return collection
}

/**
 * Fields to add to a checkout request. Waits up to `maxWaitMs` for device
 * collection, then proceeds regardless.
 */
export async function kountCheckoutFields(maxWaitMs = 2000) {
  const result = await Promise.race([
    startKountCollection(),
    new Promise((resolve) => setTimeout(() => resolve({ status: 'timeout' }), maxWaitMs)),
  ])
  if (result?.status === 'disabled' || result?.status === 'skipped') return {}
  return { kountSessionId: getKountSessionId() }
}
