// Stripe webhook → Kount risk evaluation for held (manual-capture) checkouts.
//
// Events (subscribe the endpoint to all of them):
//   checkout.session.completed     evaluate, then capture / cancel / hold for review
//   payment_intent.payment_failed  report the refused attempt as a data-only order
//   payment_intent.canceled        record authorization expiry or release
//
// A 2xx is returned only after the decision is persisted and the payment
// side effect is applied. Any failure returns 500 so Stripe redelivers, and
// the redelivery resumes from the persisted record.
import { Hono } from 'hono'
import { StripeService } from '../../services/StripeService.js'
import { resolveSetting } from '../../services/DeveloperSettingsService.js'
import { KountOrderService, resolveKountConfig } from '../../services/KountOrderService.js'
import { getKVNamespace } from '../../utils/kv.js'

const router = new Hono()

router.post('/stripe-webhook', async (c) => {
  const kv = getKVNamespace(c.env)
  let config
  try {
    config = await resolveKountConfig(kv, c.env)
  } catch (error) {
    // Invalid policy configuration: refuse loudly; Stripe will redeliver.
    console.error(`[Kount] ${error.message}`)
    return c.json({ error: 'Kount configuration is invalid' }, 500)
  }

  if (!config.stripeWebhookSecret) {
    return c.json({ error: 'Webhook signing secret is not configured' }, 503)
  }

  const stripeService = new StripeService(
    await resolveSetting(kv, c.env, 'STRIPE_SECRET_KEY'),
    await resolveSetting(kv, c.env, 'SITE_URL'),
  )
  if (!stripeService.isConfigured) {
    return c.json({ error: 'Payments are not configured' }, 503)
  }

  const signature = c.req.header('stripe-signature')
  if (!signature) return c.json({ error: 'Missing signature' }, 400)

  const rawBody = await c.req.text()
  let event
  try {
    event = await stripeService.constructWebhookEvent(rawBody, signature, config.stripeWebhookSecret)
  } catch {
    return c.json({ error: 'Invalid signature' }, 400)
  }

  const service = new KountOrderService({ kv, stripe: stripeService.stripe, config })
  try {
    let result = { skipped: 'unhandled_event' }
    switch (event.type) {
      case 'checkout.session.completed':
        result = await service.handleCheckoutCompleted(event.data.object)
        break
      case 'payment_intent.payment_failed':
        result = await service.handlePaymentFailed(event.data.object)
        break
      case 'payment_intent.canceled':
        result = await service.handlePaymentIntentCanceled(event.data.object)
        break
      default:
        break
    }
    return c.json({
      received: true,
      eventId: event.id,
      skipped: result.skipped || undefined,
      decision: result.record?.evaluation?.decision,
      decisionSource: result.record?.evaluation?.decisionSource,
    })
  } catch (error) {
    console.error(`[Kount] webhook ${event.type} ${event.id} failed: ${error?.message || error}`)
    return c.json({ error: 'Webhook processing failed', eventId: event.id }, 500)
  }
})

export default router
