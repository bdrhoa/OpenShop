// Kount webhook verification and parsing.
//
// Kount signs each delivery with RSA-PSS / SHA-256 (32-byte salt). The signed
// message is the X-Event-Timestamp header value followed by the raw request
// body. The signature arrives base64-encoded in X-Event-Signature. The public
// key comes from the Kount portal.
import { KOUNT_WEBHOOK_MAX_AGE_MS } from '../config/kount.js'

function base64ToBytes(b64) {
  const clean = String(b64).replace(/\s+/g, '')
  const binary = atob(clean)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Accept a PEM "PUBLIC KEY" block or bare base64 SPKI DER. */
export function publicKeyToDer(publicKey) {
  if (typeof publicKey !== 'string' || !publicKey.trim()) {
    throw new Error('Kount webhook public key is not configured')
  }
  const body = publicKey
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [A-Z ]+-----/g, '')
    .replace(/-----END [A-Z ]+-----/g, '')
  return base64ToBytes(body)
}

const keyCache = new Map()

async function importKey(publicKey) {
  if (keyCache.has(publicKey)) return keyCache.get(publicKey)
  const key = await crypto.subtle.importKey(
    'spki',
    publicKeyToDer(publicKey),
    { name: 'RSA-PSS', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  keyCache.set(publicKey, key)
  return key
}

/**
 * Parse X-Event-Timestamp. The format is not pinned down in the guide, so
 * accept RFC 3339 / ISO 8601 and Unix epoch seconds or milliseconds.
 * @returns {number|null} epoch milliseconds
 */
export function parseEventTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed)
    return trimmed.length <= 10 ? n * 1000 : n
  }
  const parsed = Date.parse(trimmed)
  return Number.isNaN(parsed) ? null : parsed
}

export function isTimestampFresh(ms, now = Date.now(), maxAgeMs = KOUNT_WEBHOOK_MAX_AGE_MS) {
  return typeof ms === 'number' && Math.abs(now - ms) <= maxAgeMs
}

/**
 * Verify a Kount webhook signature.
 * @returns {Promise<boolean>}
 */
export async function verifyKountSignature({ publicKey, timestamp, rawBody, signature }) {
  if (!timestamp || !signature || typeof rawBody !== 'string') return false
  let sigBytes
  try {
    sigBytes = base64ToBytes(signature)
  } catch {
    return false
  }
  const key = await importKey(publicKey)
  const message = new TextEncoder().encode(`${timestamp}${rawBody}`)
  return crypto.subtle.verify({ name: 'RSA-PSS', saltLength: 32 }, key, sigBytes, message)
}

const DECISION_ALIASES = {
  APPROVE: 'APPROVE',
  APPROVED: 'APPROVE',
  DECLINE: 'DECLINE',
  // Some guide prose uses DECLINED; the schema enum uses DECLINE.
  DECLINED: 'DECLINE',
  REVIEW: 'REVIEW',
}

/**
 * Pull the fields OpenShop acts on out of a webhook payload. The k360pf
 * sample uses eventType "Order.StatusChange" with fieldName "status" and
 * newValue; Order Update deliveries should be verified against a current
 * Sandbox delivery, so both top-level and `data`-nested shapes are read.
 */
export function parseKountWebhookEvent(payload) {
  if (!payload || typeof payload !== 'object') return null
  const src = payload.data && typeof payload.data === 'object' ? { ...payload, ...payload.data } : payload
  const eventType = typeof payload.eventType === 'string' ? payload.eventType : null
  const fieldName = typeof src.fieldName === 'string' ? src.fieldName.toLowerCase() : null
  const rawValue = typeof src.newValue === 'string' ? src.newValue.toUpperCase() : null
  const isDecisionField = !fieldName || fieldName === 'status' || fieldName === 'decision'
  return {
    eventType,
    kountOrderId: src.kountOrderId || src.orderId || null,
    merchantOrderId: src.merchantOrderId || null,
    decision: isDecisionField && rawValue ? DECISION_ALIASES[rawValue] || null : null,
  }
}
