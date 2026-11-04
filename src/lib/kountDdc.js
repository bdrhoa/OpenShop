// Kount Device Data Collector (DDC) client.
//
// One session ID follows the customer from their first page load, across tabs
// and through the hosted Stripe Checkout redirect. Kount requires a unique ID
// per risk assessment, so it changes only after a paid order or a long absence.
import { KOUNT_DDC_ENVIRONMENT, isKountDdcHost, isValidKountSessionId } from '../config/kount.js'

const STORAGE_KEY = 'openshop-kount-session'
const VISIT_EXPIRY_MS = 24 * 60 * 60 * 1000

let memorySessionId = null
let sdkPromise = null

function clientId() {
  return import.meta.env.VITE_KOUNT_CLIENT_ID
}

function isDdcEnabled() {
  return Boolean(clientId()) && isKountDdcHost(window.location.hostname)
}

function createSessionId() {
  return crypto.randomUUID().replaceAll('-', '')
}

function readStoredSession() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY))
    return isValidKountSessionId(stored?.id) ? stored : null
  } catch {
    return null
  }
}

function storeSession(id) {
  memorySessionId = id
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ id, lastSeen: Date.now() }))
  } catch {
    // Storage can be blocked; the ID then lasts for this page load only.
  }
}

/** Current session ID, or null when the DDC does not run on this site. */
export function getKountSessionId() {
  if (!isDdcEnabled()) return null
  const id = readStoredSession()?.id ?? memorySessionId ?? createSessionId()
  storeSession(id)
  return id
}

/** Adds the session ID to a checkout request body when the DDC is running. */
export function withKountSession(body) {
  const kountSessionId = getKountSessionId()
  return kountSessionId ? { ...body, kountSessionId } : body
}

/** Starts collection once per page load. Failures never affect the storefront. */
export function startKountDdc() {
  if (sdkPromise || !isDdcEnabled() || window.location.pathname.startsWith('/admin')) {
    return sdkPromise
  }

  const stored = readStoredSession()
  if (stored && Date.now() - stored.lastSeen > VISIT_EXPIRY_MS) {
    storeSession(createSessionId())
  }

  const sessionID = getKountSessionId()
  sdkPromise = import('@kount/kount-web-client-sdk')
    .then(({ default: kountSDK }) => kountSDK({
      clientID: clientId(),
      environment: KOUNT_DDC_ENVIRONMENT,
      isSinglePageApp: true,
    }, sessionID))
    .catch((error) => {
      console.warn('Kount DDC failed to load:', error)
      return null
    })
  return sdkPromise
}

/**
 * Moves to a new session ID once an order has used the current one. Comparing
 * IDs makes this safe to repeat when the success page is reloaded.
 */
export async function rotateKountSessionAfterOrder(orderSessionId) {
  if (!orderSessionId || getKountSessionId() !== orderSessionId) return
  const nextId = createSessionId()
  storeSession(nextId)
  const sdk = await sdkPromise
  sdk?.NewSession(nextId)
}
