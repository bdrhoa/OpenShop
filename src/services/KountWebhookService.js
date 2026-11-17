// Kount webhook verification and parsing.
//
// Kount signs `X-Event-Timestamp + rawBody` with RSA-PSS / SHA-256 (32-byte
// salt) and sends the base64 signature in X-Event-Signature. The public key
// comes from the Kount portal (KOUNT_WEBHOOK_PUBLIC_KEY, PEM or bare base64
// SPKI). The event payload shape below follows the k360pf reference example
// and must be confirmed against a live Sandbox delivery (see docs/KOUNT.md).
import { KOUNT_WEBHOOK_MAX_SKEW_MS } from '../config/kount.js'

function base64ToBytes(b64) {
  const clean = String(b64).replace(/\s+/g, '')
  const bin = atob(clean)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function pemToSpki(pem) {
  const body = String(pem)
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
  return base64ToBytes(body)
}

/** Parse RFC 3339 or epoch seconds/milliseconds; NaN when unparseable. */
export function parseEventTimestamp(value) {
  if (!value) return NaN
  const s = String(value).trim()
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    return n < 1e12 ? n * 1000 : n
  }
  return Date.parse(s)
}

/**
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
export async function verifyKountSignature({ publicKey, signature, timestamp, rawBody, now = Date.now() }) {
  if (!publicKey) return { ok: false, reason: 'not_configured' }
  if (!signature || !timestamp) return { ok: false, reason: 'missing_headers' }

  const ts = parseEventTimestamp(timestamp)
  if (!Number.isFinite(ts) || Math.abs(now - ts) > KOUNT_WEBHOOK_MAX_SKEW_MS) {
    return { ok: false, reason: 'stale_timestamp' }
  }

  let key
  try {
    key = await crypto.subtle.importKey(
      'spki',
      pemToSpki(publicKey),
      { name: 'RSA-PSS', hash: 'SHA-256' },
      false,
      ['verify'],
    )
  } catch {
    return { ok: false, reason: 'bad_public_key' }
  }

  let sigBytes
  try {
    sigBytes = base64ToBytes(signature)
  } catch {
    return { ok: false, reason: 'bad_signature' }
  }

  const message = new TextEncoder().encode(`${timestamp}${rawBody}`)
  const valid = await crypto.subtle.verify({ name: 'RSA-PSS', saltLength: 32 }, key, sigBytes, message)
  return valid ? { ok: true } : { ok: false, reason: 'bad_signature' }
}

const REVIEW_OUTCOMES = new Map([
  ['APPROVE', 'APPROVE'],
  ['APPROVED', 'APPROVE'],
  ['DECLINE', 'DECLINE'],
  ['DECLINED', 'DECLINE'], // guide prose uses DECLINED in places
])

/**
 * Extract a review resolution from a Kount event, or null if the event is not
 * one OpenShop acts on.
 * @returns {{ merchantOrderId: string, kountOrderId?: string, decision: 'APPROVE'|'DECLINE' } | null}
 */
export function parseReviewResolution(event) {
  if (!event || typeof event !== 'object') return null
  const type = String(event.eventType || '')
  const field = String(event.fieldName || '').toLowerCase()
  const isStatusEvent = type === 'Order.StatusChange' || (type.startsWith('Order.') && field === 'status')
  if (!isStatusEvent) return null

  const decision = REVIEW_OUTCOMES.get(String(event.newValue || '').toUpperCase())
  const merchantOrderId = event.merchantOrderId
  if (!decision || typeof merchantOrderId !== 'string' || !merchantOrderId.startsWith('cs_')) return null

  return {
    merchantOrderId,
    kountOrderId: typeof event.kountOrderId === 'string' ? event.kountOrderId : undefined,
    decision,
  }
}
