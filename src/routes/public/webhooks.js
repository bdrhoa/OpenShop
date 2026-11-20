// Webhook processors for fraud screening.
//
//   POST /api/webhooks/stripe  Stripe events (signature: STRIPE_WEBHOOK_SECRET)
//   POST /api/webhooks/kount   Kount reviewer events (RSA-PSS, KOUNT_WEBHOOK_PUBLIC_KEY)
//
// Both routes always exist. With no key configured they reject business
// events safely (503) instead of disappearing.
//
// Logging is summary-only: reason codes, header presence, body length and
// digest, key fingerprint. Raw bodies, signatures and tokens are never logged.
import { Hono } from 'hono'
import { getKVNamespace } from '../../utils/kv.js'
import { KOUNT_DEFAULTS, KountConfigError } from '../../config/kount.js'
import {
  KOUNT_SIGNATURE_HEADER,
  KOUNT_TIMESTAMP_HEADER,
  KOUNT_TEST_PING_EVENT_TYPE,
  bodyDigest,
  isExactTestPing,
  publicKeyFingerprint,
  verifyKountSignature,
} from '../../lib/kountWebhook.js'
import { createFraudCheckoutService } from '../../services/FraudCheckoutService.js'
import { resolveKountConfig } from '../../services/KountConfigService.js'
import { FraudOrderStore } from '../../services/FraudOrderStore.js'
import { resolveSetting } from '../../services/DeveloperSettingsService.js'
import { StripeService } from '../../services/StripeService.js'

const MAX_WEBHOOK_BYTES = 256 * 1024

const router = new Hono()

function logSummary(source, fields) {
  console.log(`[webhook:${source}] ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ')}`)
}

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------
router.post('/webhooks/stripe', async (c) => {
  const kv = getKVNamespace(c.env)
  const rawBody = await c.req.text()
  if (rawBody.length > MAX_WEBHOOK_BYTES) return c.json({ error: 'payload_too_large' }, 413)

  const signature = c.req.header('stripe-signature')
  const [secretKey, siteUrl, webhookSecret] = await Promise.all([
    resolveSetting(kv, c.env, 'STRIPE_SECRET_KEY'),
    resolveSetting(kv, c.env, 'SITE_URL'),
    resolveSetting(kv, c.env, 'STRIPE_WEBHOOK_SECRET'),
  ])
  if (!webhookSecret || !secretKey) {
    logSummary('stripe', { outcome: 'not_configured', bytes: rawBody.length })
    return c.json({ error: 'not_configured' }, 503)
  }
  if (!signature) {
    logSummary('stripe', { outcome: 'missing_signature_header', bytes: rawBody.length })
    return c.json({ error: 'missing_signature' }, 400)
  }

  const stripe = new StripeService(secretKey, siteUrl)
  let event
  try {
    event = await stripe.constructWebhookEvent(rawBody, signature, webhookSecret)
  } catch {
    logSummary('stripe', { outcome: 'signature_rejected', bytes: rawBody.length })
    return c.json({ error: 'signature_rejected' }, 400)
  }

  const store = new FraudOrderStore(kv)
  if (await store.isEventProcessed('stripe', event.id)) {
    return c.json({ received: true, outcome: 'duplicate' })
  }

  let fraud
  try {
    fraud = await createFraudCheckoutService(kv, c.env, { stripe })
  } catch (error) {
    if (error instanceof KountConfigError) {
      console.error(`[webhook:stripe] invalid Kount configuration: ${error.message}`)
      return c.json({ error: 'kount_misconfigured' }, 500)
    }
    throw error
  }

  if (!fraud.service) {
    // Screening is off now, but a session created while it was on holds an
    // uncaptured authorization. Never capture it unscreened: ask Stripe to
    // redeliver until Kount is configured again.
    if (event.type === 'checkout.session.completed' && event.data?.object?.payment_intent) {
      const pi = await stripe.getPaymentIntentForFraud(event.data.object.payment_intent)
      if (pi?.metadata?.kount_screening === '1' && pi.status === 'requires_capture') {
        logSummary('stripe', { event: event.type, outcome: 'held_payment_screening_disabled' })
        return c.json({ error: 'screening_disabled' }, 503)
      }
    }
    return c.json({ received: true, outcome: 'screening_disabled' })
  }

  const result = await fraud.service.handleStripeEvent(event)
  logSummary('stripe', { event: event.type, id: event.id, outcome: result.outcome, retry: Boolean(result.retry) })
  if (result.retry) return c.json({ received: true, outcome: result.outcome }, 500)

  await store.markEventProcessed('stripe', event.id)
  return c.json({ received: true, outcome: result.outcome })
})

// ---------------------------------------------------------------------------
// Kount
// ---------------------------------------------------------------------------
router.post('/webhooks/kount', async (c) => {
  const kv = getKVNamespace(c.env)
  const rawBody = new Uint8Array(await c.req.arrayBuffer())
  if (rawBody.length > MAX_WEBHOOK_BYTES) return c.json({ error: 'payload_too_large' }, 413)

  const signature = c.req.header(KOUNT_SIGNATURE_HEADER) || null
  const timestamp = c.req.header(KOUNT_TIMESTAMP_HEADER) || null
  const digest = await bodyDigest(rawBody)
  const summary = {
    bytes: rawBody.length,
    sha256: digest,
    signature: signature ? 'present' : 'absent',
    timestamp: timestamp ? 'present' : 'absent',
  }

  let parsed = null
  try {
    parsed = JSON.parse(new TextDecoder().decode(rawBody))
  } catch {
    parsed = null
  }

  // Unsigned delivery: only the exact portal ping shape is allowed, as a
  // no-op that proves reachability. Unsigned business events are rejected.
  if (!signature && !timestamp) {
    if (isExactTestPing(parsed)) {
      logSummary('kount', { ...summary, outcome: 'test_ping_noop' })
      return c.json({ received: true, outcome: 'test_ping' })
    }
    logSummary('kount', { ...summary, outcome: 'unsigned_rejected' })
    return c.json({ error: 'signature_required' }, 401)
  }

  let config
  try {
    config = await resolveKountConfig(kv, c.env)
  } catch (error) {
    console.error(`[webhook:kount] invalid Kount configuration: ${error.message}`)
    return c.json({ error: 'kount_misconfigured' }, 500)
  }
  summary.key = (await publicKeyFingerprint(config.webhookPublicKey)) || 'none'

  const verification = await verifyKountSignature({
    rawBody,
    signature,
    timestamp,
    publicKeyPem: config.webhookPublicKey,
    nowMs: Date.now(),
    freshness: { maxAgeMs: KOUNT_DEFAULTS.webhookMaxAgeMs, maxFutureSkewMs: KOUNT_DEFAULTS.webhookMaxFutureSkewMs },
  })
  if (!verification.ok) {
    logSummary('kount', { ...summary, outcome: verification.reason, ageMs: verification.ageMs ?? 'n/a' })
    const status = verification.reason === 'not_configured' ? 503 : 401
    return c.json({ error: verification.reason }, status)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logSummary('kount', { ...summary, outcome: 'body_not_json_object' })
    return c.json({ error: 'invalid_body' }, 400)
  }

  const src = parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)
    ? { ...parsed, ...parsed.data }
    : parsed

  if (src.eventType === KOUNT_TEST_PING_EVENT_TYPE) {
    logSummary('kount', { ...summary, outcome: 'signed_test_ping_noop' })
    return c.json({ received: true, outcome: 'test_ping' })
  }

  if (!config.enabled) {
    logSummary('kount', { ...summary, outcome: 'screening_disabled' })
    return c.json({ error: 'screening_disabled' }, 503)
  }

  const eventKey = String(src.id || src.eventId || `sha256-${digest}`).slice(0, 128).replace(/[^A-Za-z0-9._:-]/g, '_')
  const store = new FraudOrderStore(kv)
  if (await store.isEventProcessed('kount', eventKey)) {
    logSummary('kount', { ...summary, event: eventKey, outcome: 'duplicate' })
    return c.json({ received: true, outcome: 'duplicate' })
  }

  const { service } = await createFraudCheckoutService(kv, c.env)
  const result = await service.handleKountEvent({
    eventKey,
    eventType: src.eventType,
    kountOrderId: src.kountOrderId || src.orderId,
    merchantOrderId: src.merchantOrderId,
    fieldName: src.fieldName,
    oldValue: src.oldValue,
    newValue: src.newValue,
  })
  logSummary('kount', { ...summary, event: eventKey, type: src.eventType || 'unknown', outcome: result.outcome })

  if (result.retry) return c.json({ received: true, outcome: result.outcome }, 500)
  // A deferred event is stored durably but not marked processed: the
  // recovery job marks it once it has actually been applied.
  if (result.outcome !== 'deferred') await store.markEventProcessed('kount', eventKey)
  return c.json({ received: true, outcome: result.outcome })
})

export default router
