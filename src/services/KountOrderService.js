// Kount screening for hosted Stripe Checkout (post-authorization flow).
//
// Hosted Checkout gives the merchant no hook between "card entered" and
// "authorization requested", so OpenShop evaluates after authorization and
// before capture:
//
//   checkout created with capture_method=manual  (payment held)
//   checkout.session.completed webhook           -> Kount risk inquiry
//     APPROVE  -> capture   -> report CAPTURED   -> fulfillment allowed
//     DECLINE  -> cancel    -> report CANCELED   -> fulfillment blocked
//     REVIEW   -> keep the authorization held     -> fulfillment blocked
//   reviewer decision (Kount webhook or admin API) -> capture / cancel as above
//
// If the risk inquiry cannot produce a decision (Kount unreachable after all
// retries, a rejected request, or a response without a decision), the
// configured fallback decision (KOUNT_FALLBACK_DECISION, APPROVE or DECLINE) is
// applied with decisionSource 'fallback' and the cause in fallbackReason.
//
// State lives in KV under kount:order:<checkout session id>. Every step is
// resumable: a crash between "decided" and "captured" is completed by the next
// webhook delivery. KV is not transactional; the evaluating lock is best-effort.
import {
  KOUNT_ORDER_KV_PREFIX,
  KOUNT_EVALUATION_LOCK_MS,
  KOUNT_METADATA,
} from '../config/kount.js'
import { KountApiError, KountService, resolveKountConfig, isKountEnabled, parseFallbackDecision } from './KountService.js'
import { StripeService } from './StripeService.js'
import { resolveSetting } from './DeveloperSettingsService.js'
import { buildEvaluationOrder, buildFailedAttemptOrder, buildStatusUpdate } from './kountPayload.js'
import { APIError, ValidationError, NotFoundError } from '../utils/errors.js'

export const KOUNT_ORDER_STATUS = {
  EVALUATING: 'evaluating',
  DECIDING: 'deciding', // decision known, payment action not yet confirmed
  APPROVED: 'approved',
  DECLINED: 'declined',
  REVIEW: 'review',
  ERROR: 'error', // needs a human; payment stays held
}

const RESOLVABLE = new Set([KOUNT_ORDER_STATUS.REVIEW, KOUNT_ORDER_STATUS.ERROR])

/** Thrown when the caller (Stripe/Kount webhook) should redeliver later. */
export class RetryLaterError extends APIError {
  constructor(message) {
    super(message, 503)
    this.name = 'RetryLaterError'
  }
}

export function orderKey(checkoutSessionId) {
  return `${KOUNT_ORDER_KV_PREFIX}${checkoutSessionId}`
}

/** Buyer-facing status, deliberately coarser than the internal state. */
export function buyerStatus(record) {
  if (!record) return 'processing'
  switch (record.status) {
    case KOUNT_ORDER_STATUS.APPROVED: return 'confirmed'
    case KOUNT_ORDER_STATUS.DECLINED: return 'declined'
    case KOUNT_ORDER_STATUS.REVIEW:
    case KOUNT_ORDER_STATUS.ERROR: return 'received'
    default: return 'processing'
  }
}

function errorSummary(err) {
  if (err instanceof KountApiError) {
    return {
      operation: err.operation,
      status: err.status ?? null,
      phase: err.phase,
      attempts: err.attempts ?? 1,
      correlationId: err.correlationId ?? null,
    }
  }
  return { operation: 'internal', message: String(err?.message || err).slice(0, 200) }
}

export class KountOrderService {
  /**
   * @param {{ kv: any, stripe: any, kount: import('./KountService.js').KountService, channel?: string, fallbackDecision?: 'APPROVE'|'DECLINE', now?: () => number }} deps
   */
  constructor({ kv, stripe, kount, channel, fallbackDecision, now }) {
    this.kv = kv
    this.stripe = stripe
    this.kount = kount
    this.channel = channel
    this.fallbackDecision = parseFallbackDecision(fallbackDecision)
    this.now = now || (() => Date.now())
  }

  async get(checkoutSessionId) {
    const raw = await this.kv.get(orderKey(checkoutSessionId))
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  async save(record) {
    record.updatedAt = new Date(this.now()).toISOString()
    await this.kv.put(orderKey(record.checkoutSessionId), JSON.stringify(record))
    return record
  }

  // ---------------------------------------------------------------------------
  // Initial evaluation (checkout.session.completed)
  // ---------------------------------------------------------------------------

  /**
   * @param {object} eventSession the Checkout Session from the webhook event
   * @returns {Promise<{ skipped?: string, record?: object }>}
   */
  async handleCheckoutCompleted(eventSession) {
    if (eventSession?.metadata?.[KOUNT_METADATA.HOLD] !== 'true') {
      return { skipped: 'not_held' }
    }
    const id = eventSession.id
    let record = await this.get(id)

    if (record) {
      if (record.status !== KOUNT_ORDER_STATUS.EVALUATING) {
        return { record: await this.resume(record) }
      }
      const age = this.now() - Date.parse(record.lockedAt || 0)
      if (age < KOUNT_EVALUATION_LOCK_MS) {
        throw new RetryLaterError('Kount evaluation already in progress')
      }
      // A previous attempt died mid-evaluation: evaluate again.
    }

    record = {
      checkoutSessionId: id,
      paymentIntentId: null,
      status: KOUNT_ORDER_STATUS.EVALUATING,
      decision: null,
      decisionSource: null,
      fallbackReason: null,
      reason: null,
      kountOrderId: null,
      kountTransactionId: null,
      omniscore: null,
      deviceId: null,
      deviceSessionId: eventSession.metadata?.[KOUNT_METADATA.SESSION_ID] || null,
      correlationId: null,
      payment: 'authorized',
      fulfillmentAllowed: false,
      kountStatusReported: null,
      pendingKountStatus: null,
      error: null,
      ...(record || {}),
      createdAt: record?.createdAt || new Date(this.now()).toISOString(),
      lockedAt: new Date(this.now()).toISOString(),
    }
    record.status = KOUNT_ORDER_STATUS.EVALUATING
    await this.save(record)

    const session = await this.stripe.checkout.sessions.retrieve(id, {
      expand: ['line_items.data.price.product', 'payment_intent.latest_charge'],
    })
    const pi = session.payment_intent
    record.paymentIntentId = typeof pi === 'string' ? pi : pi?.id || null

    if (!pi || typeof pi !== 'object' || pi.status !== 'requires_capture') {
      // Nothing is held for us to decide on (e.g. capture already happened
      // elsewhere). Record it and stop; do not invent a decision.
      record.status = KOUNT_ORDER_STATUS.ERROR
      record.reason = `payment_not_held:${pi?.status || 'missing'}`
      await this.save(record)
      return { record }
    }

    const body = buildEvaluationOrder(session, pi, { channel: this.channel })
    let result
    try {
      result = await this.kount.postOrder(body, { riskInquiry: true })
    } catch (err) {
      const reason = !(err instanceof KountApiError)
        ? 'kount_error'
        : err.retryable ? 'kount_unavailable' : 'kount_request_rejected'
      return { record: await this.applyFallback(record, reason, err) }
    }

    Object.assign(record, {
      kountOrderId: result.orderId,
      kountTransactionId: result.transactionId,
      omniscore: result.omniscore,
      deviceId: result.deviceId,
      correlationId: result.correlationId,
      error: null,
      kountStatusReported: 'AUTHORIZED',
    })

    if (!result.decision) {
      return { record: await this.applyFallback(record, 'kount_no_decision') }
    }

    record.decision = result.decision
    record.decisionSource = 'kount'
    record.status = KOUNT_ORDER_STATUS.DECIDING
    await this.save(record)
    return { record: await this.applyDecision(record) }
  }

  /** The risk inquiry produced no decision: apply the configured fallback. */
  async applyFallback(record, reason, err) {
    console.warn(`[Kount] risk inquiry failed (${reason}) for ${record.checkoutSessionId}; applying fallback ${this.fallbackDecision}`)
    record.decision = this.fallbackDecision
    record.decisionSource = 'fallback'
    record.fallbackReason = reason
    if (err) record.error = errorSummary(err)
    record.status = KOUNT_ORDER_STATUS.DECIDING
    await this.save(record)
    return this.applyDecision(record)
  }

  // ---------------------------------------------------------------------------
  // Decision application (shared by initial evaluation and review resolution)
  // ---------------------------------------------------------------------------

  /** Finish whatever step a record was left on. Idempotent. */
  async resume(record) {
    if (record.status === KOUNT_ORDER_STATUS.DECIDING) {
      return this.applyDecision(record)
    }
    if (record.pendingKountStatus) {
      await this.reportStatus(record, record.pendingKountStatus)
    }
    return record
  }

  async applyDecision(record) {
    const decision = record.decision
    if (decision === 'REVIEW') {
      record.status = KOUNT_ORDER_STATUS.REVIEW
      record.fulfillmentAllowed = false
      await this.save(record)
      return record
    }

    const pi = await this.stripe.paymentIntents.retrieve(record.paymentIntentId)

    if (decision === 'APPROVE') {
      if (pi.status === 'requires_capture') {
        await this.stripe.paymentIntents.capture(pi.id, {}, {
          idempotencyKey: `kount-capture-${record.checkoutSessionId}`,
        })
      } else if (pi.status !== 'succeeded') {
        // Authorization is gone (expired or canceled); cannot honor approval.
        record.status = KOUNT_ORDER_STATUS.ERROR
        record.reason = `capture_impossible:${pi.status}`
        record.payment = pi.status === 'canceled' ? 'canceled' : record.payment
        record.fulfillmentAllowed = false
        await this.save(record)
        return record
      }
      record.payment = 'captured'
      record.fulfillmentAllowed = true
      record.status = KOUNT_ORDER_STATUS.APPROVED
      record.reason = null
      record.pendingKountStatus = 'CAPTURED'
      await this.save(record)
      await this.reportStatus(record, 'CAPTURED')
      return record
    }

    if (decision === 'DECLINE') {
      if (pi.status === 'requires_capture') {
        // No cancellation_reason: "fraudulent" feeds Radar and can skew later
        // decisions for the same identities. Kount holds the fraud signal.
        await this.stripe.paymentIntents.cancel(pi.id, {}, {
          idempotencyKey: `kount-cancel-${record.checkoutSessionId}`,
        })
      } else if (pi.status === 'succeeded') {
        // Captured already (should not happen in this flow). Refunds are a
        // separate, deliberate action; leave it for a human.
        record.status = KOUNT_ORDER_STATUS.ERROR
        record.reason = 'declined_after_capture'
        record.payment = 'captured'
        record.fulfillmentAllowed = false
        await this.save(record)
        return record
      }
      record.payment = 'canceled'
      record.fulfillmentAllowed = false
      record.status = KOUNT_ORDER_STATUS.DECLINED
      record.reason = null
      record.pendingKountStatus = 'CANCELED'
      await this.save(record)
      await this.reportStatus(record, 'CANCELED')
      return record
    }

    throw new Error(`Unknown decision ${decision}`)
  }

  /**
   * Report a payment status to Kount. On failure the status stays in
   * pendingKountStatus and the caller is told to retry.
   */
  async reportStatus(record, transactionStatus) {
    if (!record.kountOrderId) {
      // Never reached Kount (e.g. manual resolution of a failed evaluation).
      record.pendingKountStatus = null
      await this.save(record)
      return
    }
    if (record.kountStatusReported === transactionStatus) {
      record.pendingKountStatus = null
      await this.save(record)
      return
    }
    try {
      await this.kount.updateOrder(
        record.kountOrderId,
        buildStatusUpdate(record.checkoutSessionId, record.kountTransactionId, transactionStatus),
      )
    } catch (err) {
      record.pendingKountStatus = transactionStatus
      record.error = errorSummary(err)
      await this.save(record)
      throw new RetryLaterError('Kount status update failed; will retry')
    }
    record.kountStatusReported = transactionStatus
    record.pendingKountStatus = null
    record.error = null
    await this.save(record)
  }

  // ---------------------------------------------------------------------------
  // Review resolution
  // ---------------------------------------------------------------------------

  /**
   * Resolve a REVIEW (or parked ERROR) order.
   * @param {string} checkoutSessionId
   * @param {'APPROVE'|'DECLINE'} decision
   * @param {'kount_webhook'|'admin'} source
   * @param {{ kountOrderId?: string }} [opts] correlation check for webhooks
   */
  async resolve(checkoutSessionId, decision, source, opts = {}) {
    if (decision !== 'APPROVE' && decision !== 'DECLINE') {
      throw new ValidationError('decision must be APPROVE or DECLINE')
    }
    const record = await this.get(checkoutSessionId)
    if (!record) throw new NotFoundError('No Kount record for this checkout')
    if (opts.kountOrderId && record.kountOrderId && opts.kountOrderId !== record.kountOrderId) {
      throw new ValidationError('Kount order does not match this checkout')
    }

    // Duplicate or out-of-order delivery: never regress a settled order.
    if (!RESOLVABLE.has(record.status)) {
      const resumed = await this.resume(record)
      return record.decision === decision
        ? { record: resumed, duplicate: true }
        : { record: resumed, ignored: `status_${record.status}` }
    }
    if (!record.paymentIntentId) {
      throw new ValidationError('Checkout has no payment to act on')
    }

    record.decision = decision
    record.decisionSource = source
    record.status = KOUNT_ORDER_STATUS.DECIDING
    await this.save(record)
    return { record: await this.applyDecision(record) }
  }

  // ---------------------------------------------------------------------------
  // Other payment lifecycle events
  // ---------------------------------------------------------------------------

  /**
   * Held authorization was canceled outside OpenShop's decision path
   * (Stripe expires uncaptured card authorizations after ~7 days).
   */
  async handlePaymentIntentCanceled(paymentIntent) {
    if (paymentIntent?.metadata?.[KOUNT_METADATA.HOLD] !== 'true') return { skipped: 'not_held' }
    const sessions = await this.stripe.checkout.sessions.list({ payment_intent: paymentIntent.id, limit: 1 })
    const sessionId = sessions?.data?.[0]?.id
    if (!sessionId) return { skipped: 'no_session' }
    const record = await this.get(sessionId)
    if (!record || record.payment !== 'authorized') return { skipped: 'no_change', record }

    record.payment = 'canceled'
    record.fulfillmentAllowed = false
    if (RESOLVABLE.has(record.status)) {
      record.status = KOUNT_ORDER_STATUS.ERROR
      record.reason = paymentIntent.cancellation_reason === 'automatic'
        ? 'authorization_expired'
        : `payment_canceled:${paymentIntent.cancellation_reason || 'unknown'}`
    }
    const kountStatus = paymentIntent.cancellation_reason === 'automatic' ? 'EXPIRED' : 'CANCELED'
    record.pendingKountStatus = kountStatus
    await this.save(record)
    await this.reportStatus(record, kountStatus)
    return { record }
  }

  /**
   * Report a refused authorization attempt as a data-only order, so Kount sees
   * card-testing patterns that never reach a risk inquiry.
   */
  async handlePaymentFailed(paymentIntent) {
    if (paymentIntent?.metadata?.[KOUNT_METADATA.HOLD] !== 'true') return { skipped: 'not_held' }
    const chargeRef = paymentIntent.latest_charge
    const chargeId = typeof chargeRef === 'string' ? chargeRef : chargeRef?.id
    if (!chargeId) return { skipped: 'no_charge' }

    const attemptKey = `${KOUNT_ORDER_KV_PREFIX}attempt:${chargeId}`
    if (await this.kv.get(attemptKey)) return { skipped: 'duplicate' }

    const charge = typeof chargeRef === 'object' ? chargeRef : await this.stripe.charges.retrieve(chargeId)
    const sessions = await this.stripe.checkout.sessions.list({ payment_intent: paymentIntent.id, limit: 1 })
    const sessionId = sessions?.data?.[0]?.id
    const session = sessionId
      ? await this.stripe.checkout.sessions.retrieve(sessionId, { expand: ['line_items.data.price.product'] })
      : { id: paymentIntent.id, metadata: paymentIntent.metadata, amount_total: paymentIntent.amount, currency: paymentIntent.currency }

    const body = buildFailedAttemptOrder(session, charge, { channel: this.channel })
    try {
      const result = await this.kount.postOrder(body, { riskInquiry: false })
      await this.kv.put(attemptKey, JSON.stringify({ kountOrderId: result.orderId, at: new Date(this.now()).toISOString() }))
      return { reported: true, kountOrderId: result.orderId }
    } catch (err) {
      // Retries are exhausted. Record the outcome so a redelivery cannot
      // create a duplicate, and move on. This is telemetry, not a payment gate.
      await this.kv.put(attemptKey, JSON.stringify({ error: errorSummary(err), at: new Date(this.now()).toISOString() }))
      return { reported: false, error: errorSummary(err) }
    }
  }
}

/**
 * Build a KountOrderService from Worker bindings, or null when Kount
 * screening is not fully configured.
 */
export async function createKountOrderService(kv, env) {
  const cfg = await resolveKountConfig(kv, env)
  if (!isKountEnabled(cfg)) return { cfg, service: null }
  const stripeKey = await resolveSetting(kv, env, 'STRIPE_SECRET_KEY')
  const stripeService = new StripeService(stripeKey, await resolveSetting(kv, env, 'SITE_URL'))
  if (!stripeService.isConfigured) return { cfg, service: null }
  return {
    cfg,
    service: new KountOrderService({
      kv,
      stripe: stripeService.stripe,
      kount: new KountService(cfg),
      channel: cfg.channel,
      fallbackDecision: cfg.fallbackDecision,
    }),
  }
}
