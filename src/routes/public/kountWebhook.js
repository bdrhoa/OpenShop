// Kount webhook receiver: decisions made by reviewers in the Kount portal.
//
// POST /api/kount-webhook
//   - 503 when KOUNT_WEBHOOK_PUBLIC_KEY is not configured
//   - 400 for missing headers, stale or future timestamps, invalid JSON
//   - 401 for a bad signature
//   - 200 once handled (including events that need no action), so Kount
//     stops retrying; 500 when a payment side effect fails, so it retries.
import { Hono } from 'hono'
import { getKVNamespace } from '../../utils/kv.js'
import { resolveSetting } from '../../services/DeveloperSettingsService.js'
import { StripeService } from '../../services/StripeService.js'
import { KountOrderService, resolveKountConfig } from '../../services/KountOrderService.js'
import { KountWebhookError, parseKountWebhookEvent, verifyKountWebhook } from '../../lib/kountWebhook.js'

const router = new Hono()

router.post('/kount-webhook', async (c) => {
  const kv = getKVNamespace(c.env)
  let config
  try {
    config = await resolveKountConfig(kv, c.env)
  } catch (error) {
    console.error(`[Kount] ${error.message}`)
    return c.json({ error: 'Kount configuration is invalid' }, 500)
  }
  if (!config.webhookPublicKey) {
    return c.json({ error: 'Kount webhook public key is not configured' }, 503)
  }

  const rawBody = new Uint8Array(await c.req.arrayBuffer())
  let event
  try {
    await verifyKountWebhook({
      publicKey: config.webhookPublicKey,
      signature: c.req.header('X-Event-Signature') || null,
      timestamp: c.req.header('X-Event-Timestamp') || null,
      rawBody,
    })
    let body
    try {
      body = JSON.parse(new TextDecoder().decode(rawBody))
    } catch {
      throw new KountWebhookError('Invalid JSON payload', 400, 'invalid_json')
    }
    event = parseKountWebhookEvent(body)
  } catch (error) {
    if (error instanceof KountWebhookError) {
      console.warn(`[Kount] webhook rejected: ${error.code}`)
      return c.json({ error: error.message }, error.status)
    }
    throw error
  }

  const stripeService = new StripeService(
    await resolveSetting(kv, c.env, 'STRIPE_SECRET_KEY'),
    await resolveSetting(kv, c.env, 'SITE_URL'),
  )
  const service = new KountOrderService({ kv, stripe: stripeService.stripe, config })
  try {
    const result = await service.handleKountWebhookEvent(event)
    console.log(`[Kount] webhook ${event.eventId || '(no id)'} ${event.eventType || ''}: ${result.outcome}`)
    return c.json({ received: true, outcome: result.outcome })
  } catch (error) {
    console.error(`[Kount] webhook ${event.eventId || '(no id)'} failed: ${error?.message || error}`)
    return c.json({ error: 'Webhook processing failed' }, 500)
  }
})

export default router
