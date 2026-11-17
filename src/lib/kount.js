// Client-side Kount device data collection (DDC).
//
// Hosted Stripe Checkout runs on Stripe's domain, so device data must be
// collected on OpenShop pages before the buyer leaves. Collection starts on
// every storefront entry (including deep links), with one fresh session ID per
// browser session (sessionStorage is per tab). The same ID is sent with the
// checkout request and ends up as the Kount order's deviceSessionId.
//
// Checkout waits briefly for collection to finish so a fast click does not
// navigate away mid-collection, but never blocks on it.

const SESSION_KEY = 'openshop-kount-session-id'
/** Longest a checkout click waits for collection before continuing. */
export const KOUNT_COLLECTION_WAIT_MS = 2000

let memorySessionId = null
let collection = null // Promise<string>: resolves with the outcome, never rejects

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

async function runCollection() {
  const res = await fetch('/api/kount/config')
  if (!res.ok) return 'unavailable'
  const cfg = await res.json()
  if (!cfg?.ddcEnabled || !cfg.clientId) return 'disabled'

  const { default: kountSDK } = await import('@kount/kount-web-client-sdk')
  const sessionId = getKountSessionId()
  return new Promise((resolve) => {
    const sdk = kountSDK(
      {
        clientID: cfg.clientId,
        environment: cfg.environment || 'TEST',
        isSinglePageApp: true,
        callbacks: {
          'collect-begin': () => console.info('[Kount] device data collection started', sessionId),
          'collect-end': () => {
            console.info('[Kount] device data collection finished', sessionId)
            resolve('complete')
          },
        },
      },
      sessionId,
    )
    if (!sdk) {
      console.warn('[Kount] device data collection did not start (SDK rejected its config)')
      resolve('failed')
    }
  })
}

/**
 * Start DDC once per page load. Never throws or rejects; checkout works
 * without it. Resolves with 'complete', 'disabled', 'unavailable' or 'failed'.
 */
export function startKountCollection() {
  if (typeof window === 'undefined') return Promise.resolve('unavailable')
  if (!collection) {
    collection = runCollection().catch((error) => {
      console.warn('[Kount] device data collection unavailable:', error?.message || error)
      return 'failed'
    })
  }
  return collection
}

/**
 * Add the device session ID to a checkout request body, after giving
 * collection up to KOUNT_COLLECTION_WAIT_MS to finish.
 */
export async function withKountSession(body, { waitMs = KOUNT_COLLECTION_WAIT_MS } = {}) {
  let timer
  await Promise.race([
    startKountCollection(),
    new Promise((resolve) => { timer = setTimeout(resolve, waitMs) }),
  ])
  clearTimeout(timer)
  return { ...body, kountSessionId: getKountSessionId() }
}

/** Test hook. */
export function resetKountCollection() {
  collection = null
  memorySessionId = null
}
