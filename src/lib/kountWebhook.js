// Kount webhook signature and freshness verification (Web Crypto only).
//
// Kount signs `X-Event-Timestamp` text followed by the original request body
// bytes with RSA-PSS / SHA-256 (32-byte salt) and sends the base64 signature
// in `X-Event-Signature`. We verify against exactly the configured public
// key and never fall back to another algorithm.
//
// Results are reason codes, not exceptions, so the route can log a
// summary-only diagnosis (header presence, body length/hash, key
// fingerprint) without ever emitting raw bodies or signatures.

export const KOUNT_SIGNATURE_HEADER = 'x-event-signature'
export const KOUNT_TIMESTAMP_HEADER = 'x-event-timestamp'

/** The only unsigned event allowed, and only as a no-op reachability probe. */
export const KOUNT_TEST_PING_EVENT_TYPE = 'Webhook.TestPing'

function pemToDer(pem) {
  const body = String(pem)
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\\n/g, '') // tolerate keys pasted with literal "\n"
    .replace(/\s+/g, '')
  if (!body || /[^A-Za-z0-9+/=]/.test(body)) throw new Error('malformed_pem')
  const bin = atob(body)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function decodeBase64(value) {
  const cleaned = String(value).trim()
  // Accept standard and URL-safe alphabets; anything else is a decode failure.
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(cleaned)) throw new Error('signature_decode_failure')
  const std = cleaned.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(std)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** SHA-256 fingerprint of the normalized SPKI bytes (first 16 hex chars). */
export async function publicKeyFingerprint(pem) {
  try {
    const der = pemToDer(pem)
    // Only fingerprint something that actually parses as an SPKI RSA key.
    await crypto.subtle.importKey('spki', der, { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['verify'])
    return toHex(await crypto.subtle.digest('SHA-256', der)).slice(0, 16)
  } catch {
    return null
  }
}

export async function bodyDigest(bytes) {
  return toHex(await crypto.subtle.digest('SHA-256', bytes)).slice(0, 16)
}

/**
 * Parse X-Event-Timestamp. Kount sends RFC 3339; numeric epoch seconds or
 * milliseconds are also accepted. Returns epoch ms or null.
 */
export function parseEventTimestamp(value) {
  if (value === undefined || value === null || value === '') return null
  const text = String(value).trim()
  if (/^\d+$/.test(text)) {
    const n = Number(text)
    return n > 1e12 ? n : n * 1000
  }
  const ms = Date.parse(text)
  return Number.isNaN(ms) ? null : ms
}

/**
 * Freshness check with inclusive boundaries:
 *   age === maxAgeMs        → fresh
 *   age === maxAgeMs + 1    → expired
 *   -age === maxFutureSkewMs → fresh
 *   beyond future skew      → future_timestamp_rejected
 */
export function checkFreshness(timestampMs, nowMs, { maxAgeMs, maxFutureSkewMs }) {
  if (timestampMs === null) return { ok: false, reason: 'timestamp_unparseable' }
  const ageMs = nowMs - timestampMs
  if (ageMs > maxAgeMs) return { ok: false, reason: 'expired', ageMs }
  if (-ageMs > maxFutureSkewMs) return { ok: false, reason: 'future_timestamp_rejected', ageMs }
  return { ok: true, ageMs }
}

/**
 * Verify a Kount webhook delivery.
 *
 * @param {object} p
 * @param {Uint8Array} p.rawBody  original request body bytes (never re-serialized)
 * @param {string|null} p.signature  X-Event-Signature header
 * @param {string|null} p.timestamp  X-Event-Timestamp header
 * @param {string|undefined} p.publicKeyPem  configured key
 * @param {number} p.nowMs
 * @param {{maxAgeMs:number,maxFutureSkewMs:number}} p.freshness
 * @returns {Promise<{ok:boolean, reason:string, ageMs?:number}>}
 */
export async function verifyKountSignature({ rawBody, signature, timestamp, publicKeyPem, nowMs, freshness }) {
  if (!publicKeyPem) return { ok: false, reason: 'not_configured' }
  if (!signature) return { ok: false, reason: 'missing_signature_header' }
  if (!timestamp) return { ok: false, reason: 'missing_timestamp_header' }

  let key
  try {
    key = await crypto.subtle.importKey(
      'spki',
      pemToDer(publicKeyPem),
      { name: 'RSA-PSS', hash: 'SHA-256' },
      false,
      ['verify'],
    )
  } catch {
    return { ok: false, reason: 'key_parse_failure' }
  }

  let sigBytes
  try {
    sigBytes = decodeBase64(signature)
  } catch {
    return { ok: false, reason: 'signature_decode_failure' }
  }

  const tsBytes = new TextEncoder().encode(String(timestamp))
  const message = new Uint8Array(tsBytes.length + rawBody.length)
  message.set(tsBytes, 0)
  message.set(rawBody, tsBytes.length)

  let valid = false
  try {
    valid = await crypto.subtle.verify({ name: 'RSA-PSS', saltLength: 32 }, key, sigBytes, message)
  } catch {
    valid = false
  }
  // Signature is checked before freshness so the two failure modes stay
  // distinguishable: a correctly signed but old delivery reports "expired".
  if (!valid) return { ok: false, reason: 'signature_mismatch' }

  const fresh = checkFreshness(parseEventTimestamp(timestamp), nowMs, freshness)
  if (!fresh.ok) return { ok: false, reason: fresh.reason, ageMs: fresh.ageMs }
  return { ok: true, reason: 'verified', ageMs: fresh.ageMs }
}

/**
 * True only for the exact allowlisted unsigned ping shape. Never a substring
 * match: "Order.TestPingInjected" is not a ping.
 */
export function isExactTestPing(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  if (parsed.eventType !== KOUNT_TEST_PING_EVENT_TYPE) return false
  // A ping carries no order identifiers; anything that names an order is
  // treated as a business event and must be signed.
  return !('kountOrderId' in parsed) && !('orderId' in parsed) && !('merchantOrderId' in parsed)
}
