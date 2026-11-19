// Kount order orchestration for hosted Stripe Checkout (post-authorization).
//
// Flow (see docs/KOUNT.md):
//   1. Checkout is created with capture_method=manual, so the card is only
//      authorized. Device session ID and buyer IP are saved in KV.
//   2. checkout.session.completed (signed webhook) → evaluate with Kount
//      (riskInquiry=true), sending the known authorization outcome.
//   3. The decision (Kount or attributed fallback) is persisted BEFORE any
//      payment side effect. Redelivered webhooks resume from that record and
//      never re-evaluate or change the decision.
//   4. APPROVE → capture; DECLINE → cancel the authorization;
//      REVIEW → keep the authorization, block fulfillment until a reviewer
//      approves (capture) or declines (cancel).
//   5. Status changes are reported to Kount with PATCH through durable
//      reporting jobs (pending → confirmed / rejected / escalated), retried by
//      the cron trigger, independent of further webhook deliveries.
//   6. Refused authorization attempts are reported as data-only orders.
import { buildKountConfig, KOUNT_SETTING_KEYS, KountConfigError } from '../config/kount.js'
import {
  buildEvaluationPayload,
  buildFailedAttemptPayload,
  buildStatusUpdatePayload,
} from '../lib/kountPayload.js'
import { KountClient } from './KountClient.js'
import { resolveSetting } from './DeveloperSettingsService.js'
import { StripeService } from './StripeService.js'

export const KOUNT_KV = {
  CHECKOUT_PREFIX: 'kount:checkout:', // openshop order id -> { deviceSessionId, userIp }
  ORDER_PREFIX: 'kount:order:', // checkout session id -> order record
  PI_INDEX_PREFIX: 'kount:pi:', // payment intent id -> checkout session id
  ATTEMPT_PREFIX: 'kount:attempt:', // charge id -> failed-attempt job id
  JOB_PREFIX: 'kount:job:', // job id -> reporting job
  QUEUE_PREFIX: 'kount:jobq:', // marker while a job still needs work
}

const CHECKOUT_CONTEXT_TTL_SECONDS = 8 * 24 * 3600
export const REPORTING_MAX_ATTEMPTS = 12
const REPORTING_BACKOFF_BASE_MS = 60_000
const REPORTING_BACKOFF_MAX_MS = 6 * 3600_000

/** Resolve every Kount setting (Developer Settings KV first, then env). */
export async function resolveKountConfig(kv, env) {
  const entries = await Promise.all(
    KOUNT_SETTING_KEYS.map(async (key) => [key, await resolveSetting(kv, env, key)]),
  )
  return buildKountConfig(Object.fromEntries(entries))
}

/**
 * Whether new checkouts should be held for Kount. Requires credentials and a
 * webhook secret: without the webhook, a held authorization would never be
 * evaluated or captured.
 */
export function shouldHoldForKount(config) {
  return Boolean(config?.enabled && config.stripeWebhookSecret)
}

async function getJson(kv, key) {
  const raw = await kv.get(key)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function putJson(kv, key, value, options) {
  return kv.put(key, JSON.stringify(value), options)
}

function nowIso() {
  return new Date().toISOString()
}

/** Buyer-facing status derived from the stored record. */
export function buyerStatusOf(record) {
  if (!record) return null
  if (record.payment?.state === 'captured') return 'confirmed'
  if (['canceled', 'expired'].includes(record.payment?.state)) return 'declined'
  if (record.evaluation?.decision === 'REVIEW') return 'received'
  return 'processing'
}

/** Admin-safe summary (no payloads, no secrets). */
export function summarizeRecord(record) {
  if (!record) return null
  return {
    merchantOrderId: record.merchantOrderId,
    decision: record.evaluation?.decision || null,
    decisionSource: record.evaluation?.decisionSource || null,
    fallbackReason: record.evaluation?.fallbackReason || null,
    omniscore: record.evaluation?.omniscore ?? null,
    kountOrderId: record.evaluation?.kountOrderId || null,
    attempts: record.evaluation?.attempts ?? null,
    correlationId: record.evaluation?.correlationId || null,
    possibleDuplicate: Boolean(record.evaluation?.possibleDuplicate),
    paymentState: record.payment?.state || null,
    review: record.review || null,
    fulfillmentAllowed: Boolean(record.fulfillmentAllowed),
    buyerStatus: buyerStatusOf(record),
    reporting: record.reporting || [],
  }
}

export class KountOrderService {
  /**
   * @param {{kv: any, stripe: import('stripe').Stripe, config: any, client?: KountClient, now?: () => number}} deps
   */
  constructor({ kv, stripe, config, client, now }) {
    this.kv = kv
    this.stripe = stripe
    this.config = config
    this.client = client || (config?.enabled ? new KountClient(config) : null)
    this.now = now || (() => Date.now())
  }

  // ---------------------------------------------------------------- checkout

  /** Save browser context for a held checkout. */
  async saveCheckoutContext(merchantOrderId, { deviceSessionId, userIp }) {
    await putJson(this.kv, `${KOUNT_KV.CHECKOUT_PREFIX}${merchantOrderId}`, {
      deviceSessionId: deviceSessionId || null,
      userIp: userIp || null,
      createdAt: nowIso(),
    }, { expirationTtl: CHECKOUT_CONTEXT_TTL_SECONDS })
  }

  async getCheckoutContext(merchantOrderId) {
    if (!merchantOrderId) return {}
    return (await getJson(this.kv, `${KOUNT_KV.CHECKOUT_PREFIX}${merchantOrderId}`)) || {}
  }

  // ------------------------------------------------------------------ record

  async getRecord(sessionId) {
    return getJson(this.kv, `${KOUNT_KV.ORDER_PREFIX}${sessionId}`)
  }

  async saveRecord(record) {
    record.updatedAt = nowIso()
    await putJson(this.kv, `${KOUNT_KV.ORDER_PREFIX}${record.checkoutSessionId}`, record)
    return record
  }

  async getRecordByPaymentIntent(paymentIntentId) {
    const sessionId = await this.kv.get(`${KOUNT_KV.PI_INDEX_PREFIX}${paymentIntentId}`)
    return sessionId ? this.getRecord(sessionId) : null
  }

  /** Whether an order may be fulfilled. Orders without a Kount record are unaffected. */
  async isFulfillmentAllowed(sessionId) {
    const record = await this.getRecord(sessionId)
    if (!record) return { allowed: true, record: null }
    return { allowed: Boolean(record.fulfillmentAllowed), record }
  }

  // ---------------------------------------------------------- webhook: paid

  /**
   * Handle checkout.session.completed for a held checkout. Idempotent: a
   * redelivery resumes from the persisted decision.
   */
  async handleCheckoutCompleted(session) {
    if (session?.metadata?.kount_hold !== 'true') return { skipped: 'not_held' }
    if (!session.payment_intent) return { skipped: 'no_payment_intent' }

    const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent.id
    let record = await this.getRecord(session.id)
    if (!record) {
      record = {
        checkoutSessionId: session.id,
        merchantOrderId: session.metadata.openshop_order_id || session.id,
        paymentIntentId,
        createdAt: nowIso(),
        payment: { state: 'authorized' },
        fulfillmentAllowed: false,
        reporting: [],
      }
      await this.kv.put(`${KOUNT_KV.PI_INDEX_PREFIX}${paymentIntentId}`, session.id)
      await this.saveRecord(record)
    }

    const paymentIntent = await this.stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] })

    if (!record.evaluation) {
      if (paymentIntent.status !== 'requires_capture') {
        // Nothing to evaluate against: authorization already gone or settled.
        record.payment.state = paymentIntent.status === 'canceled' ? 'expired' : paymentIntent.status
        await this.saveRecord(record)
        return { skipped: `payment_${paymentIntent.status}`, record }
      }
      if (!this.client) {
        throw new KountConfigError('Kount is not configured, but this checkout was held for Kount evaluation')
      }

      const lineItems = await this.stripe.checkout.sessions.listLineItems(session.id, { limit: 100, expand: ['data.price'] })
      const context = await this.getCheckoutContext(record.merchantOrderId)
      const charge = typeof paymentIntent.latest_charge === 'object' ? paymentIntent.latest_charge : null
      record.chargeId = charge?.id || null
      const payload = buildEvaluationPayload({
        merchantOrderId: record.merchantOrderId,
        session,
        paymentIntent,
        charge,
        lineItems: lineItems?.data || [],
        deviceSessionId: context.deviceSessionId,
        userIp: context.userIp,
        channel: this.config.channel,
      })

      const evaluation = await this.client.evaluateWithFallback(payload)
      record.evaluation = evaluation
      if (evaluation.decision === 'REVIEW') record.review = { status: 'open', openedAt: nowIso() }
      if (evaluation.decisionSource === 'fallback') {
        console.warn(`[Kount] fallback ${evaluation.decision} for ${record.merchantOrderId}: ${evaluation.fallbackReason} after ${evaluation.attempts} attempt(s)${evaluation.correlationId ? ` (correlation ${evaluation.correlationId})` : ''}`)
      }
      // Persist the decision before any payment side effect.
      await this.saveRecord(record)
    }

    await this.applyDecision(record, paymentIntent)
    await this.flushOrderReporting(record)
    return { record }
  }

  /** Bring the payment in line with the persisted decision. Idempotent. */
  async applyDecision(record, paymentIntent) {
    const decision = record.review?.status === 'approved'
      ? 'APPROVE'
      : (record.review?.status === 'declined' ? 'DECLINE' : record.evaluation?.decision)

    if (decision === 'APPROVE') {
      await this.capture(record, paymentIntent)
    } else if (decision === 'DECLINE') {
      await this.cancel(record, paymentIntent)
    } else if (decision === 'REVIEW') {
      record.fulfillmentAllowed = false
      await this.saveRecord(record)
    }
  }

  async capture(record, paymentIntent) {
    let pi = paymentIntent
    if (pi.status === 'requires_capture') {
      pi = await this.stripe.paymentIntents.capture(pi.id, {}, { idempotencyKey: `kount-capture-${pi.id}` })
    }
    if (pi.status === 'succeeded') {
      if (record.payment.state !== 'captured') {
        record.payment = { state: 'captured', capturedAt: nowIso() }
        await this.queueReport(record, { transactionStatus: 'CAPTURED', decision: record.review?.status === 'approved' ? 'APPROVE' : undefined })
      }
      record.fulfillmentAllowed = true
    } else if (pi.status === 'canceled') {
      await this.markAuthorizationGone(record, pi)
    }
    await this.saveRecord(record)
  }

  async cancel(record, paymentIntent) {
    let pi = paymentIntent
    if (pi.status === 'requires_capture') {
      pi = await this.stripe.paymentIntents.cancel(pi.id, {}, { idempotencyKey: `kount-cancel-${pi.id}` })
    }
    record.fulfillmentAllowed = false
    if (pi.status === 'canceled' && !['canceled', 'expired'].includes(record.payment.state)) {
      record.payment = { state: 'canceled', canceledAt: nowIso() }
      await this.queueReport(record, { transactionStatus: 'CANCELED', decision: record.review?.status === 'declined' ? 'DECLINE' : undefined })
    } else if (pi.status === 'succeeded') {
      // Captured outside this flow; a refund must be issued in Stripe.
      record.payment = { ...record.payment, state: 'captured', note: 'captured before decline; refund required' }
    }
    await this.saveRecord(record)
  }

  async markAuthorizationGone(record, pi) {
    const expired = pi.cancellation_reason === 'automatic'
    record.payment = { state: expired ? 'expired' : 'canceled', canceledAt: nowIso(), cancellationReason: pi.cancellation_reason || null }
    record.fulfillmentAllowed = false
    if (record.review?.status === 'open') record.review = { ...record.review, status: expired ? 'expired' : 'canceled' }
    await this.queueReport(record, { transactionStatus: expired ? 'EXPIRED' : 'CANCELED' })
  }

  /** payment_intent.canceled: authorization expired or was released elsewhere. */
  async handlePaymentIntentCanceled(paymentIntent) {
    const record = await this.getRecordByPaymentIntent(paymentIntent.id)
    if (!record || ['canceled', 'expired'].includes(record.payment?.state)) return { skipped: 'no_change' }
    await this.markAuthorizationGone(record, paymentIntent)
    await this.saveRecord(record)
    await this.flushOrderReporting(record)
    return { record }
  }

  // ------------------------------------------------------------------ review

  /** Reviewer decision on a REVIEW order: APPROVE captures, DECLINE releases. */
  async resolveReview(sessionId, reviewerDecision, reviewer = 'admin') {
    const record = await this.getRecord(sessionId)
    if (!record) return { error: 'not_found' }
    if (record.evaluation?.decision !== 'REVIEW') return { error: 'not_in_review' }
    if (record.review?.status && record.review.status !== 'open') {
      return record.review.status === (reviewerDecision === 'APPROVE' ? 'approved' : 'declined')
        ? { record } // repeated click: same outcome
        : { error: 'already_resolved' }
    }

    const pi = await this.stripe.paymentIntents.retrieve(record.paymentIntentId)
    if (pi.status === 'canceled') {
      await this.markAuthorizationGone(record, pi)
      await this.saveRecord(record)
      await this.flushOrderReporting(record)
      return { error: 'authorization_gone', record }
    }

    // Persist the reviewer decision before the payment side effect.
    record.review = { ...record.review, status: reviewerDecision === 'APPROVE' ? 'approved' : 'declined', decidedAt: nowIso(), decidedBy: reviewer }
    await this.saveRecord(record)
    await this.applyDecision(record, pi)
    await this.flushOrderReporting(record)
    return { record }
  }

  // ---------------------------------------------------- failed auth attempts

  /** payment_intent.payment_failed on a held checkout → data-only order. */
  async handlePaymentFailed(paymentIntent) {
    if (paymentIntent?.metadata?.kount_hold !== 'true') return { skipped: 'not_held' }
    const chargeRef = paymentIntent.last_payment_error?.charge || paymentIntent.latest_charge
    const chargeId = typeof chargeRef === 'string' ? chargeRef : chargeRef?.id
    const dedupeKey = `${KOUNT_KV.ATTEMPT_PREFIX}${chargeId || `${paymentIntent.id}:${paymentIntent.last_payment_error?.code || 'unknown'}`}`
    const existingJobId = await this.kv.get(dedupeKey)
    if (existingJobId) {
      // Already recorded; the job queue owns recovery. Resume, never duplicate.
      const job = await this.getJob(existingJobId)
      if (job && job.state !== 'confirmed') await this.runJob(job)
      return { skipped: 'duplicate', job }
    }

    const charge = chargeId ? await this.stripe.charges.retrieve(chargeId) : null
    const merchantOrderId = paymentIntent.metadata.openshop_order_id || paymentIntent.id
    const context = await this.getCheckoutContext(merchantOrderId)
    const { payload, failure } = buildFailedAttemptPayload({
      merchantOrderId,
      paymentIntent,
      charge,
      deviceSessionId: context.deviceSessionId,
      userIp: context.userIp,
      channel: this.config.channel,
    })

    const job = await this.createJob({ operation: 'data_only_order', payload, merchantOrderId, failureKind: failure.kind })
    await this.kv.put(dedupeKey, job.id)
    await this.runJob(job)
    return { job }
  }

  // --------------------------------------------------------- reporting jobs

  async getJob(id) {
    return getJson(this.kv, `${KOUNT_KV.JOB_PREFIX}${id}`)
  }

  async saveJob(job) {
    job.updatedAt = nowIso()
    await putJson(this.kv, `${KOUNT_KV.JOB_PREFIX}${job.id}`, job)
    if (['pending', 'unknown'].includes(job.state)) {
      await this.kv.put(`${KOUNT_KV.QUEUE_PREFIX}${job.id}`, String(job.nextAttemptAt || 0))
    } else {
      await this.kv.delete(`${KOUNT_KV.QUEUE_PREFIX}${job.id}`)
    }
    return job
  }

  async createJob(fields) {
    const job = {
      id: crypto.randomUUID(),
      state: 'pending',
      attempts: 0,
      createdAt: nowIso(),
      nextAttemptAt: 0,
      ...fields,
    }
    return this.saveJob(job)
  }

  /** Durably record an Update Order for this order; sent by flushOrderReporting or cron. */
  async queueReport(record, { transactionStatus, decision }) {
    const job = await this.createJob({
      operation: 'update_order',
      checkoutSessionId: record.checkoutSessionId,
      merchantOrderId: record.merchantOrderId,
      transactionStatus,
      decision: decision || null,
    })
    record.reporting = [...(record.reporting || []), { jobId: job.id, transactionStatus, decision: decision || null, state: job.state }]
    return job
  }

  async flushOrderReporting(record) {
    for (const entry of record.reporting || []) {
      if (entry.state === 'confirmed' || entry.state === 'rejected' || entry.state === 'escalated') continue
      const job = await this.getJob(entry.jobId)
      if (job) await this.runJob(job)
    }
  }

  async syncRecordReporting(job) {
    if (!job.checkoutSessionId) return
    const record = await this.getRecord(job.checkoutSessionId)
    if (!record) return
    record.reporting = (record.reporting || []).map((r) => (r.jobId === job.id ? { ...r, state: job.state, lastError: job.lastError || null } : r))
    await this.saveRecord(record)
  }

  /**
   * Attempt one reporting job. Outcomes:
   *   confirmed — usable acknowledgment saved
   *   rejected  — definite permanent rejection (needs repair)
   *   pending   — retry later (bounded by REPORTING_MAX_ATTEMPTS)
   *   unknown   — a POST may have been accepted; replay keeps duplicate risk
   *   escalated — attempts exhausted; operator action needed
   */
  async runJob(job) {
    if (!this.client) return job
    if (job.state === 'confirmed' || job.state === 'rejected' || job.state === 'escalated') return job

    job.attempts += 1
    job.lastAttemptAt = nowIso()
    try {
      if (job.operation === 'update_order') {
        const record = await this.getRecord(job.checkoutSessionId)
        const kountOrderId = record?.evaluation?.kountOrderId
        if (!kountOrderId) {
          // A fallback decision has no Kount order to update.
          job.state = 'rejected'
          job.lastError = 'no_kount_order_id'
        } else {
          const payload = buildStatusUpdatePayload({
            merchantOrderId: job.merchantOrderId,
            kountTransactionId: record.evaluation.kountTransactionId,
            transactionStatus: job.transactionStatus,
            decision: job.decision || undefined,
          })
          const res = await this.client.updateOrder(kountOrderId, payload)
          job.state = 'confirmed'
          job.correlationId = res.correlationId
          job.lastError = null
        }
      } else if (job.operation === 'data_only_order') {
        const res = await this.client.sendDataOnlyOrder(job.payload)
        job.state = 'confirmed'
        job.kountOrderId = res.body?.order?.orderId || null
        job.correlationId = res.correlationId
        job.possibleDuplicate = Boolean(job.possibleDuplicate || res.possibleDuplicate)
        job.lastError = null
      }
    } catch (error) {
      job.lastError = `${error.kind || 'error'}${error.status ? ` (${error.status})` : ''}`
      job.correlationId = error.correlationId || job.correlationId
      if (error.kind === 'rejected' || error.kind === 'token_rejected') {
        job.state = 'rejected'
        console.error(`[Kount] ${job.operation} rejected for ${job.merchantOrderId}: ${job.lastError}`)
      } else if (job.attempts >= REPORTING_MAX_ATTEMPTS) {
        job.state = 'escalated'
        console.error(`[Kount] ${job.operation} escalated for ${job.merchantOrderId} after ${job.attempts} attempts: ${job.lastError}`)
      } else {
        if (error.outcomeUnknown) job.possibleDuplicate = true
        job.state = error.outcomeUnknown ? 'unknown' : 'pending'
        const backoff = Math.min(REPORTING_BACKOFF_MAX_MS, REPORTING_BACKOFF_BASE_MS * 2 ** (job.attempts - 1))
        job.nextAttemptAt = this.now() + backoff
      }
    }
    await this.saveJob(job)
    await this.syncRecordReporting(job)
    return job
  }

  /** Retry due reporting jobs. Called from the Worker's scheduled handler. */
  async processDueJobs({ limit = 50 } = {}) {
    if (!this.client) return { processed: 0 }
    const listing = await this.kv.list({ prefix: KOUNT_KV.QUEUE_PREFIX, limit: 1000 })
    let processed = 0
    for (const key of listing.keys || []) {
      if (processed >= limit) break
      const id = key.name.slice(KOUNT_KV.QUEUE_PREFIX.length)
      const job = await this.getJob(id)
      if (!job) {
        await this.kv.delete(key.name)
        continue
      }
      if ((job.nextAttemptAt || 0) > this.now()) continue
      await this.runJob(job)
      processed += 1
    }
    return { processed }
  }

  /** Re-open a rejected or escalated job after the cause is fixed. */
  async requeueJob(id) {
    const job = await this.getJob(id)
    if (!job) return null
    if (job.state === 'confirmed') return job
    job.state = 'pending'
    job.attempts = 0
    job.nextAttemptAt = 0
    await this.saveJob(job)
    return this.runJob(job)
  }
}

/**
 * Cron entry point: retry due Kount reporting jobs so recovery does not
 * depend on another webhook delivery.
 */
export async function runKountScheduledWork(kv, env) {
  let config
  try {
    config = await resolveKountConfig(kv, env)
  } catch (error) {
    console.error(`[Kount] scheduled run skipped: ${error.message}`)
    return { processed: 0, error: error.message }
  }
  if (!config.enabled) return { processed: 0 }
  const stripeService = new StripeService(await resolveSetting(kv, env, 'STRIPE_SECRET_KEY'), '')
  const service = new KountOrderService({ kv, stripe: stripeService.stripe, config })
  return service.processDueJobs()
}
