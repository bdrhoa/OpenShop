// Admin Kount routes: integration status, manual review, reporting recovery.
import { Hono } from 'hono'
import { asyncHandler } from '../../middleware/errorHandler.js'
import { APIError, ValidationError } from '../../utils/errors.js'
import { getKVNamespace } from '../../utils/kv.js'
import { resolveSetting } from '../../services/DeveloperSettingsService.js'
import { StripeService } from '../../services/StripeService.js'
import {
  KOUNT_KV,
  KountOrderService,
  resolveKountConfig,
  shouldHoldForKount,
  summarizeRecord,
} from '../../services/KountOrderService.js'

const router = new Hono()

async function buildService(c) {
  const kv = getKVNamespace(c.env)
  const config = await resolveKountConfig(kv, c.env)
  const stripeService = new StripeService(
    await resolveSetting(kv, c.env, 'STRIPE_SECRET_KEY'),
    await resolveSetting(kv, c.env, 'SITE_URL'),
  )
  stripeService.assertCheckoutAvailable()
  return new KountOrderService({ kv, stripe: stripeService.stripe, config })
}

function validSessionId(id) {
  if (typeof id !== 'string' || !id.startsWith('cs_') || id.length > 255) {
    throw new ValidationError('Invalid checkout session ID')
  }
  return id
}

// Effective, non-secret integration status plus reporting jobs needing attention.
router.get('/status', asyncHandler(async (c) => {
  const kv = getKVNamespace(c.env)
  let config = null
  let configError = null
  try {
    config = await resolveKountConfig(kv, c.env)
  } catch (error) {
    configError = error.message
  }

  const service = new KountOrderService({ kv, stripe: null, config, client: null })
  const listing = await kv.list({ prefix: KOUNT_KV.QUEUE_PREFIX, limit: 100 })
  const queued = (await Promise.all((listing.keys || []).map((k) => service.getJob(k.name.slice(KOUNT_KV.QUEUE_PREFIX.length)))))
    .filter(Boolean)
    .map(({ payload: _payload, ...job }) => job)

  return c.json({
    configError,
    enabled: Boolean(config?.enabled),
    holdingCheckouts: shouldHoldForKount(config),
    webhookSecretConfigured: Boolean(config?.stripeWebhookSecret),
    kountWebhookConfigured: Boolean(config?.webhookPublicKey),
    maxRetries: config?.maxRetries ?? null,
    fallbackDecision: config?.fallbackDecision ?? null,
    environment: config?.environment ?? null,
    ddcEnvironment: config?.ddcEnvironment ?? null,
    channel: config?.channel || null,
    shippingMethod: config?.shippingMethod || null,
    apiBaseUrl: config?.apiBaseUrl ?? null,
    tokenUrl: config?.tokenUrl ?? null,
    queuedReportingJobs: queued,
  })
}))

router.get('/orders/:sessionId', asyncHandler(async (c) => {
  const sessionId = validSessionId(c.req.param('sessionId'))
  const service = new KountOrderService({ kv: getKVNamespace(c.env), stripe: null, config: null, client: null })
  const record = await service.getRecord(sessionId)
  if (!record) throw new APIError('No Kount record for this order', 404)
  return c.json({ kount: summarizeRecord(record) })
}))

// Note: there is deliberately no endpoint to approve or decline a REVIEW
// order from OpenShop. A review hold is lifted only by the reviewer's decision
// in the Kount portal, delivered by the signed Kount webhook
// (routes/public/kountWebhook.js).

// Retry a rejected, escalated or pending reporting job after fixing the cause.
router.post('/jobs/:jobId/retry', asyncHandler(async (c) => {
  const jobId = c.req.param('jobId')
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw new ValidationError('Invalid job ID')
  const service = await buildService(c)
  const job = await service.requeueJob(jobId)
  if (!job) throw new APIError('Job not found', 404)
  const { payload: _payload, ...summary } = job
  return c.json({ job: summary })
}))

export default router
