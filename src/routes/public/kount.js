// Kount fraud screening: storefront config + Stripe and Kount webhooks.
import { Hono } from 'hono'
import { asyncHandler } from '../../middleware/errorHandler.js'
import { getKVNamespace } from '../../utils/kv.js'
import { resolveKountConfig, isKountEnabled } from '../../services/KountService.js'
import { createKountOrderService, RetryLaterError } from '../../services/KountOrderService.js'
import { verifyKountSignature, parseReviewResolution } from '../../services/KountWebhookService.js'
import { constructStripeWebhookEvent } from '../../services/StripeService.js'
import { resolveSetting } from '../../services/DeveloperSettingsService.js'

const router = new Hono()

// What the storefront needs to start device data collection. The Kount client
// ID is a public merchant identifier (it is sent by the browser SDK anyway);
// the API key never leaves the Worker.
router.get('/kount/config', asyncHandler(async (c) => {
  const cfg = await resolveKountConfig(getKVNamespace(c.env), c.env)
  // Device data collection only needs the (public) client ID. It runs even
  // before screening is fully configured, so collection can be checked first.
  const ddcEnabled = Boolean(cfg.clientId)
  return c.json({
    enabled: isKountEnabled(cfg),
    ddcEnabled,
    clientId: ddcEnabled ? cfg.clientId : null,
    environment: ddcEnabled ? cfg.ddcEnvironment : null,
  })
}))

const HANDLED_STRIPE_EVENTS = new Set([
  'checkout.session.completed',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
])

router.post('/stripe-webhook', asyncHandler(async (c) => {
  const kv = getKVNamespace(c.env)
  const secret = await resolveSetting(kv, c.env, 'STRIPE_WEBHOOK_SECRET')
  if (!secret) {
    return c.json({ error: 'Stripe webhook is not configured', status: 503 }, 503)
  }

  const rawBody = await c.req.text()
  let event
  try {
    event = await constructStripeWebhookEvent(rawBody, c.req.header('stripe-signature') || '', secret)
  } catch {
    return c.json({ error: 'Invalid Stripe signature', status: 400 }, 400)
  }

  if (!HANDLED_STRIPE_EVENTS.has(event.type)) {
    return c.json({ received: true, handled: false })
  }

  const object = event.data?.object
  if (object?.metadata?.kount_hold !== 'true') {
    // Checkout created without screening (Kount off at the time). Nothing held.
    return c.json({ received: true, handled: false, reason: 'not_held' })
  }

  const { service } = await createKountOrderService(kv, c.env)
  if (!service) {
    // A held payment arrived but screening is now misconfigured. Ask Stripe to
    // redeliver rather than dropping the authorization on the floor.
    console.error('[Kount] held checkout received but Kount/Stripe is not fully configured')
    throw new RetryLaterError('Kount screening is not configured')
  }

  let result
  if (event.type === 'checkout.session.completed') {
    result = await service.handleCheckoutCompleted(object)
  } else if (event.type === 'payment_intent.payment_failed') {
    result = await service.handlePaymentFailed(object)
  } else {
    result = await service.handlePaymentIntentCanceled(object)
  }

  return c.json({
    received: true,
    handled: true,
    status: result?.record?.status ?? null,
    skipped: result?.skipped ?? null,
  })
}))

router.post('/kount-webhook', asyncHandler(async (c) => {
  const kv = getKVNamespace(c.env)
  const cfg = await resolveKountConfig(kv, c.env)
  const rawBody = await c.req.text()

  const verdict = await verifyKountSignature({
    publicKey: cfg.webhookPublicKey,
    signature: c.req.header('X-Event-Signature'),
    timestamp: c.req.header('X-Event-Timestamp'),
    rawBody,
  })
  if (!verdict.ok) {
    const status = verdict.reason === 'not_configured' ? 503 : 401
    return c.json({ error: 'Webhook rejected', reason: verdict.reason, status }, status)
  }

  let event
  try {
    event = JSON.parse(rawBody)
  } catch {
    return c.json({ error: 'Invalid JSON body', status: 400 }, 400)
  }

  const resolution = parseReviewResolution(event)
  if (!resolution) {
    return c.json({ received: true, handled: false })
  }

  const { service } = await createKountOrderService(kv, c.env)
  if (!service) throw new RetryLaterError('Kount screening is not configured')

  const existing = await service.get(resolution.merchantOrderId)
  if (!existing) {
    // Not an order this store evaluated (or KV lagging). Acknowledge; nothing to do.
    return c.json({ received: true, handled: false, reason: 'unknown_order' })
  }

  const out = await service.resolve(resolution.merchantOrderId, resolution.decision, 'kount_webhook', {
    kountOrderId: resolution.kountOrderId,
  })
  return c.json({
    received: true,
    handled: true,
    status: out.record.status,
    duplicate: Boolean(out.duplicate),
    ignored: out.ignored ?? null,
  })
}))

export default router
