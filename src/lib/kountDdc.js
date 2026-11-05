// Kount Device Data Collector (DDC) client.
//
// One session ID covers a web session: every page, tab, Stripe Checkout
// redirect and order within it. A session cookie ends with the browser, and the
// ID is replaced once it is more than 15 minutes old.
import { KOUNT_DDC_ENVIRONMENT, isKountDdcHost, isValidKountSessionId } from '../config/kount.js'

const COOKIE_NAME = 'openshop_kount_session'
const SESSION_MAX_AGE_MS = 15 * 60 * 1000

let memorySession = null
let sdk = null
let sdkPromise = null

function clientId() {
  return import.meta.env.VITE_KOUNT_CLIENT_ID
}

function isDdcEnabled() {
  return Boolean(clientId()) && isKountDdcHost(window.location.hostname)
}

function readCookieSession() {
  try {
    const cookie = document.cookie.split('; ').find((entry) => entry.startsWith(`${COOKIE_NAME}=`))
    const [id, createdAt] = (cookie?.slice(COOKIE_NAME.length + 1) ?? '').split('.')
    return isValidKountSessionId(id) && Number(createdAt) > 0
      ? { id, createdAt: Number(createdAt) }
      : null
  } catch {
    return null
  }
}

function createSession() {
  const session = { id: crypto.randomUUID().replaceAll('-', ''), createdAt: Date.now() }
  memorySession = session
  try {
    // No Expires or Max-Age: the browser must drop this cookie when it closes.
    document.cookie = `${COOKIE_NAME}=${session.id}.${session.createdAt}; Path=/; SameSite=Lax; Secure`
  } catch {
    // Cookies can be blocked; the ID then lasts for this page load only.
  }
  return session
}

function currentSession() {
  const session = readCookieSession() ?? memorySession
  return session && Date.now() - session.createdAt <= SESSION_MAX_AGE_MS ? session : createSession()
}

/** Current session ID, or null when the DDC does not run on this site. */
export function getKountSessionId() {
  if (!isDdcEnabled()) return null
  const { id } = currentSession()
  if (sdk && sdk.sessionID !== id) sdk.NewSession(id)
  return id
}

/** Adds the session ID to a checkout request body when the DDC is running. */
export function withKountSession(body) {
  const kountSessionId = getKountSessionId()
  return kountSessionId ? { ...body, kountSessionId } : body
}

// Renews on time so collection for the new ID can finish before checkout.
function keepSessionCurrent() {
  getKountSessionId()
  const { createdAt } = currentSession()
  setTimeout(keepSessionCurrent, createdAt + SESSION_MAX_AGE_MS - Date.now() + 1)
}

/** Starts collection once per page load. Failures never affect the storefront. */
export function startKountDdc() {
  if (sdkPromise || !isDdcEnabled() || window.location.pathname.startsWith('/admin')) {
    return sdkPromise
  }

  const sessionID = getKountSessionId()
  sdkPromise = import('@kount/kount-web-client-sdk')
    .then(({ default: kountSDK }) => {
      sdk = kountSDK({
        clientID: clientId(),
        environment: KOUNT_DDC_ENVIRONMENT,
        isSinglePageApp: true,
      }, sessionID)
      if (sdk) keepSessionCurrent()
      return sdk
    })
    .catch((error) => {
      console.warn('Kount DDC failed to load:', error)
      return null
    })
  return sdkPromise
}
