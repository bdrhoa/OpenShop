// Kount webhook - resolves orders on hold for a Kount review.
//
// A REVIEW decision captures the Stripe payment and puts the order on hold. When
// a reviewer decides, Kount sends a signed event: APPROVE releases the order to
// ship, and DECLINE refunds the payment. Kount can deliver an event more than
// once, so repeats must be harmless. Anything unclear leaves the order on hold.
import {
  KOUNT_DECISIONS,
  KOUNT_DECISION_METADATA_KEY,
  KOUNT_DECLINE_DECISION,
  KOUNT_ORDER_ID_METADATA_KEY,
  KOUNT_REVIEW_DECISION,
  KOUNT_WEBHOOK_MAX_AGE_MS,
} from '../config/kount.js'
import { APIError, ValidationError } from '../utils/errors.js'
import { settleHeldPayment } from './KountService.js'

const STATUS_FIELD = 'status'

// Kount's guide also spells a decline as DECLINED in places.
const DECISION_ALIASES = { APPROVED: 'APPROVE', DECLINED: 'DECLINE' }

function decodeBase64(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
}

/** The Kount portal key, as PEM or as bare base64 SPKI. */
async function importPublicKey(publicKey) {
  const base64 = publicKey.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '')
  return await crypto.subtle.importKey(
    'spki',
    decodeBase64(base64),
    { name: 'RSA-PSS', hash: 'SHA-256' },
    false,
    ['verify'],
  )
}

/**
 * Check a delivery's signature and age. The signed message is the timestamp
 * header followed by the raw body.
 * @returns {Promise<boolean>}
 */
export async function verifyKountWebhook({ rawBody, signature, timestamp, publicKey, now = Date.now() }) {
  if (!signature || !timestamp) return false

  const sentAt = Date.parse(timestamp)
  if (Number.isNaN(sentAt) || Math.abs(now - sentAt) > KOUNT_WEBHOOK_MAX_AGE_MS) return false

  try {
    return await crypto.subtle.verify(
      { name: 'RSA-PSS', saltLength: 32 },
      await importPublicKey(publicKey),
      decodeBase64(signature),
      new TextEncoder().encode(`${timestamp}${rawBody}`),
    )
  } catch (error) {
    console.error(`[KountWebhook] signature check failed: ${error.name}`)
    return false
  }
}

function normalizeDecision(value) {
  const upper = typeof value === 'string' ? value.trim().toUpperCase() : undefined
  const decision = DECISION_ALIASES[upper] ?? upper
  return KOUNT_DECISIONS.includes(decision) ? decision : undefined
}

/**
 * Kount's published docs name eventType and fieldName but not the other fields,
 * so identifiers are read under each spelling the docs use. A decision missing
 * here is looked up from Kount by the caller.
 */
function parseEvent(event) {
  return {
    fieldName: event?.fieldName,
    orderId: event?.orderId ?? event?.kountOrderId ?? event?.order?.orderId,
    merchantOrderId: event?.merchantOrderId ?? event?.order?.merchantOrderId,
    decision: normalizeDecision(event?.newValue),
  }
}

async function getSession(stripeService, sessionId) {
  try {
    return await stripeService.getCheckoutSessionForRiskEvaluation(sessionId)
  } catch (error) {
    if (error.code === 'resource_missing') return null
    throw error
  }
}

/**
 * Apply a verified Kount event to its order.
 * @returns {Promise<{decision?: string, outcome: 'released'|'refunded'|'captured'|'canceled'|'on_hold'|'ignored'|'skipped'}>}
 */
export async function processKountOrderEvent({ stripeService, kountService, event }) {
  const parsed = parseEvent(event)

  // Order Update also reports notes, agents, reason codes and reversals.
  if (parsed.fieldName && parsed.fieldName !== STATUS_FIELD) {
    return { outcome: 'ignored' }
  }
  if (!parsed.orderId) {
    console.error(`[KountWebhook] event has no order ID; fields: ${Object.keys(event ?? {}).join(',')}`)
    throw new ValidationError('Kount event has no order ID')
  }

  let { decision, merchantOrderId } = parsed
  if (!decision || !merchantOrderId) {
    const order = await kountService.getOrder(parsed.orderId)
    decision ??= order.decision
    merchantOrderId ??= order.merchantOrderId
  }

  // Merchant order IDs are Checkout Session IDs, so anything else is not ours.
  if (!merchantOrderId?.startsWith('cs_')) return { outcome: 'ignored' }

  const session = await getSession(stripeService, merchantOrderId)
  const paymentIntent = session?.payment_intent
  if (!paymentIntent || paymentIntent.capture_method !== 'manual') return { outcome: 'ignored' }
  if (!['requires_capture', 'succeeded'].includes(paymentIntent.status)) return { decision, outcome: 'skipped' }

  const savedOrderId = paymentIntent.metadata?.[KOUNT_ORDER_ID_METADATA_KEY]
  const savedDecision = paymentIntent.metadata?.[KOUNT_DECISION_METADATA_KEY]

  // The event beat the Stripe webhook that records the evaluation. Kount retries.
  if (!savedOrderId) {
    throw new APIError('Order has not finished evaluation', 503)
  }
  if (savedOrderId !== parsed.orderId) {
    console.error(`[KountWebhook] order ID does not match session ${merchantOrderId}`)
    return { outcome: 'ignored' }
  }

  if (decision === KOUNT_REVIEW_DECISION) return { decision, outcome: 'on_hold' }

  // A saved final decision that matches means an earlier delivery failed part way.
  // One that differs may belong to an order that has shipped, so a person decides.
  if (savedDecision !== KOUNT_REVIEW_DECISION && savedDecision !== decision) {
    console.error(`[KountWebhook] ${decision} ignored: session ${merchantOrderId} was already ${savedDecision}`)
    return { decision, outcome: 'skipped' }
  }
  if (paymentIntent.latest_charge?.refunded) return { decision, outcome: 'skipped' }

  await stripeService.updatePaymentIntentMetadata(paymentIntent.id, {
    [KOUNT_DECISION_METADATA_KEY]: decision,
  })

  // The Stripe webhook saves REVIEW before it captures, so this can still be held.
  if (paymentIntent.status === 'requires_capture') {
    return await settleHeldPayment(stripeService, paymentIntent.id, decision)
  }
  if (decision === KOUNT_DECLINE_DECISION) {
    await stripeService.refundPaymentIntentAsFraudulent(paymentIntent.id)
    return { decision, outcome: 'refunded' }
  }
  return { decision, outcome: 'released' }
}
