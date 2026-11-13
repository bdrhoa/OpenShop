// Inbound webhooks: Stripe (checkout completion, payment failures, refunds)
// and Kount (review decisions).
//
// Both handlers read the raw body before parsing so signatures are checked
// against exactly the bytes that were signed.
import { Hono } from 'hono'
import { asyncHandler } from '../../middleware/errorHandler.js'
import { resolveSetting } from '../../services/DeveloperSettingsService.js'
import { createFraudReviewService, resolveKountSettings } from '../../services/FraudReviewService.js'
import { getKVNamespace } from '../../utils/kv.js'
import { FRAUD_STATES } from '../../config/kount.js'
import {
  parseEventTimestamp,
  isTimestampFresh,
  verifyKountSignature,
  parseKountWebhookEvent,
} from '../../lib/kountWebhook.js'

const router = new Hono()

// Refund status changes settle reviewer-decline refunds that Stripe
// reported as pending. charge.refund.updated is the older event name.
const REFUND_EVENTS = new Set(['refund.updated', 'refund.failed', 'charge.refund.updated'])

// Stripe → checkout.session.completed starts the Kount evaluation;
// payment_intent.payment_failed reports a declined attempt to Kount.
router.post('/stripe-webhook', asyncHandler(async (c) => {
  const kv = getKVNamespace(c.env)
  const secret = await resolveSetting(kv, c.env, 'STRIPE_WEBHOOK_SECRET')
  if (!secret) {
    return c.json({ error: 'Stripe webhook is not configured' }, 503)
  }

  const signature = c.req.header('stripe-signature')
  if (!signature) {
    return c.json({ error: 'Missing Stripe signature' }, 400)
  }

  const rawBody = await c.req.text()
  const service = await createFraudReviewService(kv, c.env)

  let event
  try {
    event = await service.stripe.constructWebhookEvent(rawBody, signature, secret)
  } catch (error) {
    console.warn('[StripeWebhook] signature verification failed:', error.message)
    return c.json({ error: 'Invalid Stripe signature' }, 400)
  }

  if (REFUND_EVENTS.has(event.type)) {
    const result = await service.handleRefundUpdated(event.data.object)
    if (result.status === 'in_progress') {
      return c.json({ error: 'Refund not recorded yet' }, 409)
    }
    return c.json({ received: true, status: result.status, state: result.record?.state })
  }

  if (event.type === 'payment_intent.payment_failed') {
    // A declined attempt on a held checkout: report it to Kount as data.
    const result = await service.handlePaymentFailed(event.data.object)
    if (result.status === 'in_progress') {
      return c.json({ error: 'Decline report in progress' }, 409)
    }
    return c.json({ received: true, status: result.status, state: result.report?.state })
  }

  if (event.type !== 'checkout.session.completed') {
    return c.json({ received: true, status: 'ignored' })
  }

  const result = await service.handleCheckoutCompleted(event.data.object.id)
  if (result.status === 'in_progress') {
    // Another delivery is evaluating this order. Ask Stripe to retry later.
    return c.json({ error: 'Evaluation in progress' }, 409)
  }
  return c.json({ received: true, status: result.status, state: result.record?.state })
}))

// Kount → order decision changes (e.g. a REVIEW order approved or declined).
router.post('/kount-webhook', asyncHandler(async (c) => {
  const kv = getKVNamespace(c.env)
  const kount = await resolveKountSettings(kv, c.env)
  if (!kount.webhookPublicKey) {
    return c.json({ error: 'Kount webhook is not configured' }, 503)
  }

  const timestamp = c.req.header('X-Event-Timestamp')
  const signature = c.req.header('X-Event-Signature')
  const rawBody = await c.req.text()

  if (!isTimestampFresh(parseEventTimestamp(timestamp))) {
    return c.json({ error: 'Stale or missing event timestamp' }, 401)
  }

  let valid = false
  try {
    valid = await verifyKountSignature({ publicKey: kount.webhookPublicKey, timestamp, rawBody, signature })
  } catch (error) {
    console.error('[KountWebhook] could not verify signature:', error.message)
    return c.json({ error: 'Kount webhook key is invalid' }, 503)
  }
  if (!valid) {
    return c.json({ error: 'Invalid signature' }, 401)
  }

  let payload
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  const event = parseKountWebhookEvent(payload)
  const service = await createFraudReviewService(kv, c.env)
  const result = await service.handleKountDecision(event || {})

  if (result.record?.state === FRAUD_STATES.PAYMENT_ACTION_FAILED) {
    // Let Kount redeliver so the Stripe action is attempted again.
    return c.json({ error: 'Payment action failed', state: result.record.state }, 500)
  }
  return c.json({ received: true, status: result.status, state: result.record?.state })
}))

export default router
