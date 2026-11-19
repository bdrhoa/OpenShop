// Kount webhook verification and parsing (Web Crypto; runs in Workers).
//
// Kount signs each delivery with RSA-PSS / SHA-256 (32-byte salt). The signed
// message is the X-Event-Timestamp header text followed by the raw request
// body, and the signature arrives base64-encoded in X-Event-Signature. The
// public key comes from the Kount portal as base64 DER (SubjectPublicKeyInfo);
// a PEM block is also accepted, with or without line breaks.

// Kount's guide suggests a 45-minute window so its own retries still verify.
export const KOUNT_WEBHOOK_MAX_AGE_MS = 45 * 60 * 1000
// Small allowance for clock skew on timestamps slightly in the future.
export const KOUNT_WEBHOOK_MAX_FUTURE_MS = 5 * 60 * 1000

export const KOUNT_REVIEW_DECISIONS = ['APPROVE', 'DECLINE']

export class KountWebhookError extends Error {
  /** @param {string} message @param {number} status @param {string} code */
  constructor(message, status, code) {
    super(message)
    this.name = 'KountWebhookError'
    this.status = status
    this.code = code
  }
}

function base64ToBytes(b64) {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Strip PEM armour and whitespace, returning the base64 DER body. */
export function normalizePublicKey(value) {
  return String(value || '')
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '')
}

/** Validation for the setting: must look like a base64 DER public key. */
export function validatePublicKey(value) {
  const b64 = normalizePublicKey(value)
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return 'KOUNT_WEBHOOK_PUBLIC_KEY must be a base64 (or PEM) public key'
  try {
    const bytes = base64ToBytes(b64)
    // DER SubjectPublicKeyInfo starts with a SEQUENCE tag; RSA keys are > 100 bytes.
    if (bytes[0] !== 0x30 || bytes.length < 100) return 'KOUNT_WEBHOOK_PUBLIC_KEY is not a DER-encoded public key'
  } catch {
    return 'KOUNT_WEBHOOK_PUBLIC_KEY must be a base64 (or PEM) public key'
  }
  return null
}

async function importPublicKey(publicKey) {
  try {
    return await crypto.subtle.importKey(
      'spki',
      base64ToBytes(normalizePublicKey(publicKey)),
      { name: 'RSA-PSS', hash: 'SHA-256' },
      false,
      ['verify'],
    )
  } catch {
    throw new KountWebhookError('Kount webhook public key could not be loaded', 500, 'bad_public_key')
  }
}

/**
 * Verify a delivery. Throws KountWebhookError (400 for a bad request, 401 for
 * a bad signature, 500 for a bad key). Checks freshness before the signature
 * so stale replays are refused cheaply.
 *
 * @param {{publicKey: string, signature: string|null, timestamp: string|null, rawBody: Uint8Array, now?: number}} input
 */
export async function verifyKountWebhook({ publicKey, signature, timestamp, rawBody, now = Date.now() }) {
  if (!timestamp) throw new KountWebhookError('Missing X-Event-Timestamp header', 400, 'missing_timestamp')
  if (!signature) throw new KountWebhookError('Missing X-Event-Signature header', 400, 'missing_signature')
  if (!rawBody || rawBody.length === 0) throw new KountWebhookError('Empty request body', 400, 'empty_body')

  const sentAt = Date.parse(timestamp)
  if (Number.isNaN(sentAt)) throw new KountWebhookError('Invalid X-Event-Timestamp', 400, 'invalid_timestamp')
  if (now - sentAt > KOUNT_WEBHOOK_MAX_AGE_MS) throw new KountWebhookError('Webhook timestamp is too old', 400, 'timestamp_too_old')
  if (sentAt - now > KOUNT_WEBHOOK_MAX_FUTURE_MS) throw new KountWebhookError('Webhook timestamp is too far in the future', 400, 'timestamp_too_new')

  let signatureBytes
  try {
    signatureBytes = base64ToBytes(signature.trim())
  } catch {
    throw new KountWebhookError('Invalid signature encoding', 401, 'invalid_signature')
  }

  const key = await importPublicKey(publicKey)
  const prefix = new TextEncoder().encode(timestamp)
  const message = new Uint8Array(prefix.length + rawBody.length)
  message.set(prefix, 0)
  message.set(rawBody, prefix.length)

  const valid = await crypto.subtle.verify({ name: 'RSA-PSS', saltLength: 32 }, key, signatureBytes, message)
  if (!valid) throw new KountWebhookError('Invalid webhook signature', 401, 'invalid_signature')
  return true
}

/**
 * True for Kount's portal connectivity test ("Webhook.TestPing"). Kount sends
 * it without X-Event-Signature / X-Event-Timestamp (observed on a live Sandbox
 * delivery), so it can only be acknowledged, never acted on.
 */
export function isTestPing(body) {
  return Boolean(body && typeof body === 'object' && /test\s*ping/i.test(String(body.eventType || body.type || '')))
}

/** Parse a raw body as JSON, or null. */
export function tryParseJson(rawBody) {
  try {
    return JSON.parse(new TextDecoder().decode(rawBody))
  } catch {
    return null
  }
}

/**
 * Interpret a verified event. Only a status/decision change to APPROVE or
 * DECLINE is actionable; everything else is acknowledged and ignored.
 *
 * Shape follows the Kount sample (Order.StatusChange with fieldName,
 * oldValue, newValue). The guide prefers the newer Order Update event; the
 * same fields are read from either, and the shape should be confirmed with a
 * real Sandbox delivery.
 */
export function parseKountWebhookEvent(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new KountWebhookError('Webhook body must be a JSON object', 400, 'invalid_body')
  }
  const field = String(body.fieldName || '').toLowerCase()
  const newValue = String(body.newValue ?? '').toUpperCase()
  const isDecisionChange = ['status', 'decision', 'riskinquiry.decision'].includes(field)
  return {
    eventId: typeof body.id === 'string' ? body.id : null,
    eventType: body.eventType || null,
    kountOrderId: body.kountOrderId || body.orderId || null,
    merchantOrderId: body.merchantOrderId || null,
    oldValue: body.oldValue ?? null,
    decision: isDecisionChange && KOUNT_REVIEW_DECISIONS.includes(newValue) ? newValue : null,
  }
}
