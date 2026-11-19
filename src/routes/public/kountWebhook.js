// Kount webhook receiver: decisions made by reviewers in the Kount portal.
//
// POST /api/kount-webhook
//   - 200 for Kount's unsigned Webhook.TestPing (acknowledged, no action)
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
import { KountWebhookError, diagnoseKountSignature, isTestPing, keyFingerprint, parseKountWebhookEvent, tryParseJson, verifyKountWebhook } from '../../lib/kountWebhook.js'
import { KountClient } from '../../services/KountClient.js'

const router = new Hono()

/**
 * After a signature failure, log which key / signing variant would have
 * verified it: the configured key, and Kount's currently published key
 * (fetched with the Worker's Kount credentials). Fingerprints only; never key
 * material or the request body. Diagnostic only: acceptance is unchanged.
 */
async function logSignatureDiagnostics(config, { signature, timestamp, rawBody }) {
  try {
    const configured = await diagnoseKountSignature({ publicKey: config.webhookPublicKey, signature, timestamp, rawBody })
    let published
    if (config.enabled) {
      try {
        const { publicKey, validUntil } = await new KountClient(config).fetchWebhookPublicKey()
        published = {
          ...(await diagnoseKountSignature({ publicKey, signature, timestamp, rawBody })),
          validUntil,
          sameAsConfigured: (await keyFingerprint(publicKey)) === configured.fingerprint,
        }
      } catch (error) {
        published = { error: `${error.kind || 'error'}${error.status ? ` (${error.status})` : ''}` }
      }
    } else {
      published = { error: 'kount_credentials_not_configured' }
    }
    console.warn(`[Kount] signature diagnostics ${JSON.stringify({ environment: config.environment, configured, published })}`)
  } catch (error) {
    console.warn(`[Kount] signature diagnostics failed: ${error?.message || error}`)
  }
}

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
  const signature = c.req.header('X-Event-Signature') || null
  const timestamp = c.req.header('X-Event-Timestamp') || null

  // Kount's portal test ping arrives unsigned. Acknowledge it so the portal
  // shows the endpoint as reachable; it carries no order data and nothing is
  // done with it. Any other unsigned request is rejected below.
  if (!signature && !timestamp) {
    const body = tryParseJson(rawBody)
    if (isTestPing(body)) {
      console.log(`[Kount] webhook test ping received (${body.eventType || body.type}); acknowledged without action`)
      return c.json({ received: true, outcome: 'test_ping' })
    }
  }

  let event
  try {
    await verifyKountWebhook({
      publicKey: config.webhookPublicKey,
      signature,
      timestamp,
      rawBody,
    })
    const body = tryParseJson(rawBody)
    if (body === null) throw new KountWebhookError('Invalid JSON payload', 400, 'invalid_json')
    if (isTestPing(body)) {
      return c.json({ received: true, outcome: 'test_ping' })
    }
    event = parseKountWebhookEvent(body)
  } catch (error) {
    if (error instanceof KountWebhookError) {
      // Header names only (never values) and the event type, so a sender that
      // uses different header names is easy to spot in the logs.
      const headerNames = [...c.req.raw.headers.keys()].filter((k) => !k.startsWith('cf-')).sort().join(', ')
      const eventType = tryParseJson(rawBody)?.eventType || 'unknown'
      console.warn(`[Kount] webhook rejected: ${error.code} (eventType ${eventType}; headers: ${headerNames})`)
      if (error.code === 'invalid_signature') {
        await logSignatureDiagnostics(config, { signature, timestamp, rawBody })
      }
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
