// Fraud review orchestration: Stripe hosted Checkout + Kount Payments Fraud v2.
//
// Flow (post-authorization, pre-capture — hosted Checkout gives no hook
// before authorization):
//
//   checkout.session.completed (PaymentIntent requires_capture)
//     → Kount Evaluate Order (with the authorization outcome)
//       APPROVE → capture
//       DECLINE → cancel the authorization
//       REVIEW  → capture now, block fulfillment; a Kount webhook later
//                 approves (unblock) or declines (refund, once Stripe
//                 confirms it)
//     Kount error/timeout → hold for manual handling. Never an approval.
//
// One KV record per Checkout Session tracks state so duplicate Stripe and
// Kount deliveries are no-ops once an order reaches a final state.
import {
  KOUNT_KV_PREFIX,
  KOUNT_EVALUATION_STALE_MS,
  FRAUD_STATES,
  FRAUD_FINAL_STATES,
  FRAUD_FULFILLABLE_STATES,
  KOUNT_DECLINE_KV_PREFIX,
  DECLINE_REPORT_STATES,
} from '../config/kount.js'
import { buildKountOrder, mapFailedAuthorization } from '../lib/kountOrder.js'
import { FRAUD_HOLD_METADATA_KEY, StripeService } from './StripeService.js'
import { KountService, isKountConfigured } from './KountService.js'
import { resolveSetting } from './DeveloperSettingsService.js'

const KOUNT_ORDER_INDEX_PREFIX = 'kount:kountorder:'
const PAYMENT_INTENT_INDEX_PREFIX = 'kount:pi:'
const MAX_HISTORY = 20

export class FraudReviewService {
  /**
   * @param {object} deps
   * @param {object} deps.kv - KV namespace
   * @param {import('./StripeService.js').StripeService} deps.stripe
   * @param {import('./KountService.js').KountService} deps.kount
   */
  constructor({ kv, stripe, kount }) {
    this.kv = kv
    this.stripe = stripe
    this.kount = kount
  }

  // ---- records -----------------------------------------------------------

  async getRecord(checkoutSessionId) {
    const raw = await this.kv.get(`${KOUNT_KV_PREFIX}${checkoutSessionId}`)
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  async #save(record, event) {
    const now = new Date().toISOString()
    const history = [...(record.history || []), { at: now, state: record.state, event }].slice(-MAX_HISTORY)
    const next = { ...record, updatedAt: now, history }
    await this.kv.put(`${KOUNT_KV_PREFIX}${record.checkoutSessionId}`, JSON.stringify(next))
    if (next.kountOrderId) {
      await this.kv.put(`${KOUNT_ORDER_INDEX_PREFIX}${next.kountOrderId}`, record.checkoutSessionId)
    }
    if (next.paymentIntentId && !record.history?.length) {
      await this.kv.put(`${PAYMENT_INTENT_INDEX_PREFIX}${next.paymentIntentId}`, record.checkoutSessionId)
    }
    return next
  }

  async findByKountOrder({ merchantOrderId, kountOrderId }) {
    if (merchantOrderId) {
      const record = await this.getRecord(merchantOrderId)
      if (record) return record
    }
    if (kountOrderId) {
      const sessionId = await this.kv.get(`${KOUNT_ORDER_INDEX_PREFIX}${kountOrderId}`)
      if (sessionId) return this.getRecord(sessionId)
    }
    return null
  }

  async listRecords({ limit = 50 } = {}) {
    const { keys = [] } = await this.kv.list({ prefix: KOUNT_KV_PREFIX })
    const records = await Promise.all(keys.slice(0, limit).map((k) => this.kv.get(k.name)))
    return records
      .map((raw) => { try { return JSON.parse(raw) } catch { return null } })
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  }

  // ---- Stripe checkout.session.completed --------------------------------

  /**
   * Evaluate a completed Checkout Session with Kount and act on the decision.
   * @returns {Promise<{ status: 'ignored'|'done'|'in_progress', record?: object, reason?: string }>}
   *   'in_progress' means a concurrent delivery is evaluating; the webhook
   *   should ask Stripe to retry later.
   */
  async handleCheckoutCompleted(checkoutSessionId) {
    const existing = await this.getRecord(checkoutSessionId)
    if (existing) {
      if (existing.state !== FRAUD_STATES.EVALUATING) {
        return { status: 'done', record: existing, reason: 'already_processed' }
      }
      const age = Date.now() - Date.parse(existing.updatedAt || 0)
      if (age < KOUNT_EVALUATION_STALE_MS) {
        return { status: 'in_progress', record: existing }
      }
      // A previous attempt started but never recorded an outcome. Kount may
      // have accepted the order; re-submitting could create a duplicate, so
      // hold the authorization for reconciliation instead.
      const record = await this.#save({
        ...existing,
        state: FRAUD_STATES.EVALUATION_FAILED_HOLD,
        error: 'Evaluation outcome unknown (stale in-progress record). Reconcile in the Kount portal before capturing.',
      }, 'stale_evaluation')
      return { status: 'done', record }
    }

    const { session, lineItems } = await this.stripe.getCheckoutSessionForReview(checkoutSessionId)
    const paymentIntent = session.payment_intent && typeof session.payment_intent === 'object'
      ? session.payment_intent
      : null

    if (!paymentIntent || paymentIntent.metadata?.[FRAUD_HOLD_METADATA_KEY] !== '1') {
      return { status: 'ignored', reason: 'not_held_for_review' }
    }
    if (paymentIntent.status !== 'requires_capture') {
      return { status: 'ignored', reason: `payment_intent_${paymentIntent.status}` }
    }

    let record = await this.#save({
      checkoutSessionId,
      paymentIntentId: paymentIntent.id,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      state: FRAUD_STATES.EVALUATING,
      createdAt: new Date().toISOString(),
    }, 'evaluation_started')

    const charge = paymentIntent.latest_charge && typeof paymentIntent.latest_charge === 'object'
      ? paymentIntent.latest_charge
      : null

    const orderBody = buildKountOrder({
      session,
      paymentIntent,
      charge,
      lineItems,
      deviceSessionId: paymentIntent.metadata?.kount_device_session_id,
      userIp: paymentIntent.metadata?.kount_user_ip,
    })

    let evaluation
    try {
      evaluation = await this.kount.evaluateOrder(orderBody)
    } catch (error) {
      console.error('[FraudReview] Kount evaluation failed:', error.message)
      record = await this.#save({
        ...record,
        state: FRAUD_STATES.EVALUATION_FAILED_HOLD,
        error: error.uncertain
          ? 'Kount evaluation outcome unknown. Reconcile in the Kount portal before capturing.'
          : `Kount evaluation failed${error.status ? ` (HTTP ${error.status})` : ''}.`,
        kountCorrelationId: error.correlationId || undefined,
      }, 'evaluation_failed')
      return { status: 'done', record }
    }

    record = await this.#save({
      ...record,
      kountOrderId: evaluation.kountOrderId,
      kountTransactionId: evaluation.transactionId,
      decision: evaluation.decision,
      omniscore: evaluation.omniscore,
      deviceCollected: Boolean(evaluation.deviceId),
      kountCorrelationId: evaluation.correlationId || undefined,
    }, `decision_${evaluation.decision || 'missing'}`)

    switch (evaluation.decision) {
      case 'APPROVE':
        record = await this.#capture(record, FRAUD_STATES.APPROVED_CAPTURED)
        break
      case 'DECLINE':
        record = await this.#cancel(record, FRAUD_STATES.DECLINED_CANCELED)
        break
      case 'REVIEW':
        record = await this.#capture(record, FRAUD_STATES.REVIEW_CAPTURED)
        break
      default:
        record = await this.#save({
          ...record,
          state: FRAUD_STATES.EVALUATION_FAILED_HOLD,
          error: 'Kount response had no recognizable decision.',
        }, 'decision_missing')
    }
    return { status: 'done', record }
  }

  // ---- Kount webhook ----------------------------------------------------

  /**
   * Apply a reviewer decision delivered by a Kount webhook.
   * @param {{ merchantOrderId?: string, kountOrderId?: string, decision: 'APPROVE'|'DECLINE'|'REVIEW'|null }} event
   */
  async handleKountDecision(event) {
    const record = await this.findByKountOrder(event)
    if (!record) return { status: 'ignored', reason: 'unknown_order' }
    if (!event.decision || event.decision === 'REVIEW') {
      return { status: 'ignored', reason: 'no_actionable_decision', record }
    }
    if (FRAUD_FINAL_STATES.has(record.state)) {
      return { status: 'done', reason: 'already_final', record }
    }
    // Only orders Kount sent to REVIEW take reviewer decisions. That includes
    // one whose capture or refund failed, so a redelivery can retry it.
    const awaitingReview = record.state === FRAUD_STATES.REVIEW_CAPTURED
      || record.state === FRAUD_STATES.REVIEW_DECLINED_REFUND_PENDING
      || (record.state === FRAUD_STATES.PAYMENT_ACTION_FAILED && record.decision === 'REVIEW')
    if (!awaitingReview) {
      return { status: 'ignored', reason: `state_${record.state}`, record }
    }

    const withDecision = { ...record, reviewDecision: event.decision }
    if (event.decision === 'APPROVE') {
      return { status: 'done', record: await this.#approveAfterReview(withDecision) }
    }
    return { status: 'done', record: await this.#declineAfterReview(withDecision) }
  }

  /**
   * Whether an order may ship. REVIEW orders are captured but stay blocked
   * until a reviewer approves; declined, failed, and held orders never ship.
   */
  async getFulfillmentStatus(checkoutSessionId) {
    const record = await this.getRecord(checkoutSessionId)
    if (!record) return { fulfillable: true, state: null }
    return { fulfillable: FRAUD_FULFILLABLE_STATES.has(record.state), state: record.state }
  }

  /**
   * Buyer-facing order status for the storefront success page.
   * @param {string} checkoutSessionId
   * @param {{ held: boolean }} options - whether checkout held the payment for Kount
   */
  async getCustomerOrderStatus(checkoutSessionId, { held }) {
    if (!held) return CUSTOMER_ORDER_STATUS.CONFIRMED
    const record = await this.getRecord(checkoutSessionId)
    return customerOrderStatus(record?.state)
  }

  // ---- Declined authorization attempts ----------------------------------

  /**
   * Report a failed payment attempt (payment_intent.payment_failed) to Kount
   * as data only (no risk inquiry), so declines feed Kount's model. Nothing
   * changes in Stripe or for the buyer. One report per failed charge.
   * @param {object} paymentIntent - Stripe PaymentIntent from the verified event
   * @returns {Promise<{ status: 'done'|'ignored'|'in_progress'|'retry', reason?: string, report?: object }>}
   */
  async handlePaymentFailed(paymentIntent) {
    if (!paymentIntent?.id || paymentIntent.metadata?.[FRAUD_HOLD_METADATA_KEY] !== '1') {
      return { status: 'ignored', reason: 'not_held_for_review' }
    }
    const chargeId = paymentIntent.last_payment_error?.charge
      || (typeof paymentIntent.latest_charge === 'string' ? paymentIntent.latest_charge : paymentIntent.latest_charge?.id)
    if (!chargeId) return { status: 'ignored', reason: 'no_charge' }

    const key = `${KOUNT_DECLINE_KV_PREFIX}${chargeId}`
    const existing = await this.#getJson(key)
    if (existing) {
      const age = Date.now() - Date.parse(existing.updatedAt || 0)
      if (existing.state === DECLINE_REPORT_STATES.SUBMITTING && age < KOUNT_EVALUATION_STALE_MS) {
        return { status: 'in_progress', report: existing }
      }
      if (existing.state === DECLINE_REPORT_STATES.SUBMITTING) {
        // Started but never finished: Kount may have it, so don't resubmit.
        const report = await this.#putJson(key, { ...existing, state: DECLINE_REPORT_STATES.UNCERTAIN, error: 'Submission outcome unknown (stale)' })
        return { status: 'done', report }
      }
      return { status: 'done', reason: 'already_reported', report: existing }
    }

    const { charge, session, lineItems } = await this.stripe.getFailedAttemptContext(paymentIntent.id, chargeId)
    if (!session) return { status: 'ignored', reason: 'no_checkout_session' }

    const authorization = mapFailedAuthorization(charge, paymentIntent)
    const base = {
      chargeId,
      paymentIntentId: paymentIntent.id,
      checkoutSessionId: session.id,
      authResult: authorization.authResult,
      declineCode: authorization.declineCode || null,
      createdAt: new Date().toISOString(),
    }
    await this.#putJson(key, { ...base, state: DECLINE_REPORT_STATES.SUBMITTING })

    const orderBody = buildKountOrder({
      session,
      paymentIntent,
      charge,
      lineItems,
      deviceSessionId: paymentIntent.metadata?.kount_device_session_id,
      userIp: paymentIntent.metadata?.kount_user_ip,
      authorization,
    })

    try {
      const { kountOrderId } = await this.kount.submitOrder(orderBody)
      const report = await this.#putJson(key, { ...base, state: DECLINE_REPORT_STATES.SUBMITTED, kountOrderId })
      return { status: 'done', report }
    } catch (error) {
      console.error('[FraudReview] Kount decline report failed:', error.message)
      if (error.uncertain) {
        const report = await this.#putJson(key, { ...base, state: DECLINE_REPORT_STATES.UNCERTAIN, error: error.message })
        return { status: 'done', report }
      }
      if (error.status >= 400 && error.status < 500) {
        const report = await this.#putJson(key, { ...base, state: DECLINE_REPORT_STATES.REJECTED, error: error.message })
        return { status: 'done', report }
      }
      // Kount certainly did not record it (e.g. token failure, retries
      // exhausted on 429/503). Clear the marker so Stripe's retry resubmits.
      await this.kv.delete(key)
      return { status: 'retry', reason: error.message }
    }
  }

  async #getJson(key) {
    const raw = await this.kv.get(key)
    if (!raw) return null
    try { return JSON.parse(raw) } catch { return null }
  }

  async #putJson(key, value) {
    const next = { ...value, updatedAt: new Date().toISOString() }
    await this.kv.put(key, JSON.stringify(next))
    return next
  }

  // ---- Stripe refund events ---------------------------------------------

  /**
   * Settle a pending reviewer-decline refund from Stripe's refund events
   * (refund.updated, refund.failed, charge.refund.updated). Only the refund
   * OpenShop created for the record is acted on.
   * @param {object} refund - Stripe Refund object from the verified event
   */
  async handleRefundUpdated(refund) {
    if (!refund?.id) return { status: 'ignored', reason: 'no_refund' }
    let sessionId = refund.metadata?.checkout_session_id || null
    if (!sessionId && refund.payment_intent) {
      const pi = typeof refund.payment_intent === 'string' ? refund.payment_intent : refund.payment_intent.id
      sessionId = await this.kv.get(`${PAYMENT_INTENT_INDEX_PREFIX}${pi}`)
    }
    const record = sessionId ? await this.getRecord(sessionId) : null
    if (!record) return { status: 'ignored', reason: 'unknown_order' }
    if (!record.refundId && refund.metadata?.checkout_session_id === record.checkoutSessionId) {
      // The event beat our own write of the refund id. Ask Stripe to retry.
      return { status: 'in_progress', record }
    }
    if (record.refundId !== refund.id) return { status: 'ignored', reason: 'other_refund', record }
    if (record.state !== FRAUD_STATES.REVIEW_DECLINED_REFUND_PENDING) {
      return { status: 'done', reason: 'not_pending', record }
    }

    if (refund.status === 'succeeded') {
      const next = await this.#save({ ...record, state: FRAUD_STATES.REVIEW_DECLINED_REFUNDED, error: undefined }, 'refund_succeeded')
      return {
        status: 'done',
        record: await this.#reportToKount(next, {
          transactionStatus: 'REFUNDED',
          reversals: [{ refundAmount: String(refund.amount ?? record.amount ?? 0) }],
        }),
      }
    }
    if (refund.status === 'failed' || refund.status === 'canceled') {
      // The next attempt (a redelivered Kount decline) needs a fresh
      // idempotency key. Stays unfulfillable; Kount is told the refund failed.
      const next = await this.#save({
        ...record,
        state: FRAUD_STATES.PAYMENT_ACTION_FAILED,
        refundAttempt: (record.refundAttempt || 0) + 1,
        error: `Stripe refund ${refund.status}${refund.failure_reason ? ` (${refund.failure_reason})` : ''}. Retry or refund manually.`,
      }, `refund_${refund.status}`)
      return { status: 'done', record: await this.#reportToKount(next, { transactionStatus: 'REFUND_FAILED' }) }
    }
    return { status: 'done', reason: `refund_${refund.status}`, record }
  }

  // ---- payment actions --------------------------------------------------

  async #capture(record, successState) {
    try {
      await this.stripe.capturePaymentIntent(record.paymentIntentId)
      const next = await this.#save({ ...record, state: successState, error: undefined }, 'captured')
      return this.#reportToKount(next, { transactionStatus: 'CAPTURED' })
    } catch (error) {
      console.error('[FraudReview] capture failed:', error.message)
      return this.#save({ ...record, state: FRAUD_STATES.PAYMENT_ACTION_FAILED, error: `Stripe capture failed: ${error.message}` }, 'capture_failed')
    }
  }

  async #cancel(record, successState) {
    try {
      await this.stripe.cancelPaymentIntent(record.paymentIntentId)
      const next = await this.#save({ ...record, state: successState, error: undefined }, 'authorization_canceled')
      return this.#reportToKount(next, {
        transactionStatus: 'CANCELED',
        reversals: [{ voidedAmount: String(record.amount ?? 0) }],
      })
    } catch (error) {
      console.error('[FraudReview] cancel failed:', error.message)
      return this.#save({ ...record, state: FRAUD_STATES.PAYMENT_ACTION_FAILED, error: `Stripe cancel failed: ${error.message}` }, 'cancel_failed')
    }
  }

  /**
   * Reviewer approved. The payment was captured when the order went to
   * review; if that capture failed, retry it now.
   */
  async #approveAfterReview(record) {
    let pi
    try {
      pi = await this.stripe.retrievePaymentIntent(record.paymentIntentId)
    } catch (error) {
      return this.#save({ ...record, state: FRAUD_STATES.PAYMENT_ACTION_FAILED, error: `Stripe lookup failed: ${error.message}` }, 'lookup_failed')
    }
    if (pi.status === 'succeeded') {
      return this.#save({ ...record, state: FRAUD_STATES.REVIEW_APPROVED, error: undefined }, 'review_approved')
    }
    if (pi.status === 'requires_capture') {
      return this.#capture(record, FRAUD_STATES.REVIEW_APPROVED)
    }
    return this.#save({
      ...record,
      state: FRAUD_STATES.PAYMENT_ACTION_FAILED,
      error: `PaymentIntent is ${pi.status}; cannot apply approval automatically.`,
    }, 'unexpected_payment_state')
  }

  /**
   * Reviewer declined. Refund the captured payment; if the capture at
   * review time failed and the authorization is still open, release it.
   * A refund counts as complete only once Stripe reports it succeeded.
   */
  async #declineAfterReview(record) {
    let pi
    try {
      pi = await this.stripe.retrievePaymentIntent(record.paymentIntentId)
    } catch (error) {
      return this.#save({ ...record, state: FRAUD_STATES.PAYMENT_ACTION_FAILED, error: `Stripe lookup failed: ${error.message}` }, 'lookup_failed')
    }

    if (pi.status === 'canceled') {
      return this.#save({ ...record, state: FRAUD_STATES.REVIEW_DECLINED_CANCELED, error: undefined }, 'already_canceled')
    }
    if (pi.status === 'requires_capture') {
      return this.#cancel(record, FRAUD_STATES.REVIEW_DECLINED_CANCELED)
    }
    if (pi.status === 'succeeded') {
      try {
        const refund = await this.stripe.refundPaymentIntent(record.paymentIntentId, {
          attempt: record.refundAttempt || 0,
          checkoutSessionId: record.checkoutSessionId,
        })
        const done = refund?.status === 'succeeded'
        const next = await this.#save({
          ...record,
          refundId: refund?.id,
          state: done ? FRAUD_STATES.REVIEW_DECLINED_REFUNDED : FRAUD_STATES.REVIEW_DECLINED_REFUND_PENDING,
          error: undefined,
        }, done ? 'refunded' : `refund_${refund?.status || 'unknown'}`)
        if (!done) return next
        return this.#reportToKount(next, {
          transactionStatus: 'REFUNDED',
          reversals: [{ refundAmount: String(refund.amount ?? record.amount ?? 0) }],
        })
      } catch (error) {
        return this.#save({ ...record, state: FRAUD_STATES.PAYMENT_ACTION_FAILED, error: `Stripe refund failed: ${error.message}` }, 'refund_failed')
      }
    }
    return this.#save({
      ...record,
      state: FRAUD_STATES.PAYMENT_ACTION_FAILED,
      error: `PaymentIntent is ${pi.status}; cannot apply decline automatically.`,
    }, 'unexpected_payment_state')
  }

  /**
   * Best-effort PATCH so Kount knows the payment outcome. Failure here does
   * not change the payment state; it is logged and recorded.
   */
  async #reportToKount(record, transactionPatch) {
    if (!record.kountOrderId || !record.kountTransactionId) return record
    try {
      await this.kount.updateOrder(record.kountOrderId, {
        transactions: [{ transactionId: record.kountTransactionId, ...transactionPatch }],
      })
      return record
    } catch (error) {
      console.error('[FraudReview] Kount order update failed:', error.message)
      return this.#save({ ...record, kountUpdateError: error.message }, 'kount_update_failed')
    }
  }
}

/**
 * What the buyer is told about an order. Fraud details never reach the
 * storefront: REVIEW orders read as confirmed (they are captured), and
 * holds or failed payment actions read as processing.
 */
export const CUSTOMER_ORDER_STATUS = Object.freeze({
  CONFIRMED: 'confirmed',
  PROCESSING: 'processing',
  DECLINED: 'declined',
})

const CUSTOMER_CONFIRMED_STATES = new Set([
  FRAUD_STATES.APPROVED_CAPTURED,
  FRAUD_STATES.REVIEW_CAPTURED,
  FRAUD_STATES.REVIEW_APPROVED,
])

const CUSTOMER_DECLINED_STATES = new Set([
  FRAUD_STATES.DECLINED_CANCELED,
  FRAUD_STATES.REVIEW_DECLINED_CANCELED,
  FRAUD_STATES.REVIEW_DECLINED_REFUNDED,
  FRAUD_STATES.REVIEW_DECLINED_REFUND_PENDING,
])

/** Map a fraud record state (or none yet) to a buyer-facing status. */
export function customerOrderStatus(state) {
  if (CUSTOMER_CONFIRMED_STATES.has(state)) return CUSTOMER_ORDER_STATUS.CONFIRMED
  if (CUSTOMER_DECLINED_STATES.has(state)) return CUSTOMER_ORDER_STATUS.DECLINED
  return CUSTOMER_ORDER_STATUS.PROCESSING
}

/**
 * Resolve Kount settings (KV first, then env) for a request.
 * @returns {Promise<{ enabled: boolean, clientId: string|undefined, apiKey: string|undefined, webhookPublicKey: string|undefined }>}
 */
export async function resolveKountSettings(kv, env) {
  const [clientId, apiKey, webhookPublicKey] = await Promise.all([
    resolveSetting(kv, env, 'KOUNT_CLIENT_ID'),
    resolveSetting(kv, env, 'KOUNT_API_KEY'),
    resolveSetting(kv, env, 'KOUNT_WEBHOOK_PUBLIC_KEY'),
  ])
  return { enabled: isKountConfigured(clientId, apiKey), clientId, apiKey, webhookPublicKey }
}

/** Build a FraudReviewService wired to this request's settings. */
export async function createFraudReviewService(kv, env) {
  const [stripeKey, siteUrl, kount] = await Promise.all([
    resolveSetting(kv, env, 'STRIPE_SECRET_KEY'),
    resolveSetting(kv, env, 'SITE_URL'),
    resolveKountSettings(kv, env),
  ])
  return new FraudReviewService({
    kv,
    stripe: new StripeService(stripeKey, siteUrl),
    kount: new KountService({ clientId: kount.clientId, apiKey: kount.apiKey }),
  })
}
