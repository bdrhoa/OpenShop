// Post-authorization fraud screening for hosted Stripe Checkout.
//
//   checkout.session.completed (PI requires_capture)
//     → persist evaluation intent → Kount Evaluate Order (riskInquiry=true)
//     → persist decision (Kount or attributed fallback) BEFORE payment effects
//     → APPROVE: capture, release fulfillment, report CAPTURED
//       DECLINE: cancel authorization, report CANCELED
//       REVIEW:  capture, keep fulfillment blocked, report CAPTURED
//   Kount reviewer webhook (signed)
//     → APPROVE: release fulfillment (capture already confirmed; never re-capture)
//       DECLINE: idempotent Stripe refund; fulfillment stays blocked;
//                REFUNDED / REFUND_FAILED reported only after Stripe confirms
//   payment_intent.payment_failed → data-only REFUSED report
//   scheduled recovery → retries pending reports, deferred reviewer events,
//                        failed refund requests
//
// Every outcome returns `{ outcome, retry }`. `retry: true` tells the webhook
// route to answer non-2xx so the provider redelivers (a supported retry
// disposition), which is how transient Stripe failures are recovered.
import { buildEvaluationPayload, buildFailedAttemptPayload, KountService } from './KountService.js'
import { KountApiError } from './KountClient.js'
import { resolveKountConfig } from './KountConfigService.js'
import { FraudOrderStore } from './FraudOrderStore.js'
import { StripeService } from './StripeService.js'
import { resolveSetting } from './DeveloperSettingsService.js'

const MAX_REPORT_ATTEMPTS = 12
const REPORT_BACKOFF_BASE_MS = 60_000
const REPORT_BACKOFF_MAX_MS = 6 * 3600_000

const PAYMENT_EFFECT = 'payment_effect'
const UPDATE_ORDER = 'update_order'

function sanitizeError(error) {
  if (error instanceof KountApiError) {
    return { kind: 'kount', status: error.status, phase: error.phase, correlationId: error.correlationId }
  }
  return {
    kind: 'stripe',
    type: error?.type || error?.name || 'Error',
    code: error?.code || null,
    statusCode: error?.statusCode || null,
  }
}

/** Transient Stripe failures are worth a provider redelivery. */
export function isTransientStripeError(error) {
  const t = error?.type
  return t === 'StripeConnectionError' || t === 'StripeAPIError' || t === 'StripeRateLimitError'
    || (typeof error?.statusCode === 'number' && error.statusCode >= 500)
}

function isPermanentKountRejection(error) {
  return error instanceof KountApiError && typeof error.status === 'number'
    && error.status >= 400 && error.status < 500 && ![401, 408, 429].includes(error.status)
}

export class FraudCheckoutService {
  /**
   * @param {object} deps
   * @param {import('./FraudOrderStore.js').FraudOrderStore} deps.store
   * @param {import('./StripeService.js').StripeService} deps.stripe
   * @param {import('./KountService.js').KountService} deps.kount
   * @param {object} deps.config  parsed Kount config
   * @param {() => number} [deps.now]
   */
  constructor({ store, stripe, kount, config, now = () => Date.now() }) {
    this.store = store
    this.stripe = stripe
    this.kount = kount
    this.config = config
    this.now = now
  }

  iso() {
    return new Date(this.now()).toISOString()
  }

  // ======================================================================
  // Stripe events
  // ======================================================================

  async handleStripeEvent(event) {
    const obj = event?.data?.object
    switch (event?.type) {
      case 'checkout.session.completed':
        return this.handleCheckoutCompleted(obj)
      case 'payment_intent.payment_failed':
        return this.handlePaymentFailed(obj)
      case 'payment_intent.canceled':
        return this.handlePaymentIntentCanceled(obj)
      case 'refund.created':
      case 'refund.updated':
      case 'refund.failed':
        return this.handleRefund(obj)
      default:
        return { outcome: 'ignored_event_type' }
    }
  }

  async handleCheckoutCompleted(session) {
    const paymentIntentId = typeof session?.payment_intent === 'string'
      ? session.payment_intent
      : session?.payment_intent?.id
    if (session?.mode !== 'payment' || !paymentIntentId) return { outcome: 'ignored_not_payment' }

    const pi = await this.stripe.getPaymentIntentForFraud(paymentIntentId)
    if (pi?.metadata?.kount_screening !== '1') return { outcome: 'skipped_unscreened' }

    let record = await this.store.getOrder(session.id)
    const ctx = await this.store.getCheckoutContext(session.id)
    const deviceSessionId = ctx?.deviceSessionId || pi.metadata?.kount_device_session_id || null
    if (!record) {
      record = this.store.newOrder({ checkoutSessionId: session.id, paymentIntentId, deviceSessionId })
    }

    const evalState = record.evaluation?.state
    if (evalState === 'complete') {
      // Duplicate delivery: resume from the saved decision, never re-evaluate.
      return this.applyDecision(record)
    }
    if (evalState === 'in_flight') {
      const started = Date.parse(record.evaluation.startedAt || 0)
      const staleAfter = this.config.operationDeadlineMs + 30_000
      if (this.now() - started < staleAfter) return { outcome: 'evaluation_in_progress', retry: true }
      // The owner died after sending (or before). Kount may hold an order we
      // never saw; do not assume it was not sent. Escalate; fulfillment
      // stays blocked and the authorization is left untouched.
      record.evaluation = { ...record.evaluation, state: 'unknown', escalatedAt: this.iso(), reason: 'owner_lost_after_claim' }
      record.buyerStatus = 'processing'
      await this.store.saveOrder(record)
      console.error(`[Fraud] evaluation outcome unknown for ${session.id}; operator action required`)
      return { outcome: 'evaluation_unknown' }
    }
    if (evalState === 'unknown') return { outcome: 'evaluation_unknown' }

    if (pi.status !== 'requires_capture') {
      record.payment = { ...record.payment, state: pi.status === 'canceled' ? 'canceled' : 'not_authorized', providerStatus: pi.status }
      record.fulfillmentAllowed = false
      await this.store.saveOrder(record)
      return { outcome: 'not_authorized' }
    }

    const owner = crypto.randomUUID()
    if (!(await this.store.claimEvaluation(record, owner))) {
      return { outcome: 'evaluation_in_progress', retry: true }
    }

    const lineItems = (await this.stripe.getCheckoutSessionLineItems(session.id))?.data || []
    const payload = buildEvaluationPayload({
      session,
      paymentIntent: pi,
      lineItems,
      deviceSessionId,
      userIp: ctx?.userIp,
      channel: this.config.channel,
    })

    const result = await this.kount.evaluate(payload)

    record.deviceSessionId = deviceSessionId
    record.evaluation = {
      state: 'complete',
      decision: result.decision,
      decisionSource: result.decisionSource,
      fallbackReason: result.fallbackReason,
      attempts: result.attempts ?? null,
      correlationId: result.correlationId ?? null,
      kountOrderId: result.kountOrderId ?? null,
      kountTransactionId: result.kountTransactionId ?? null,
      deviceReturned: Boolean(result.deviceId),
      omniscore: result.omniscore ?? null,
      possibleDuplicate: Boolean(result.possibleDuplicate),
      responseShapeConflict: Boolean(result.shapeConflict),
      evaluatedAt: this.iso(),
    }
    record.review = result.decision === 'REVIEW' ? { status: 'open', openedAt: this.iso() } : null
    // Decision is durable before any payment side effect.
    await this.store.saveOrder(record)

    return this.applyDecision(record)
  }

  /**
   * Apply the saved decision. Safe to call repeatedly: Stripe calls use
   * idempotency keys and state checks skip completed effects.
   */
  async applyDecision(record) {
    const decision = record.evaluation.decision
    const pi = record.paymentIntentId

    if (decision === 'DECLINE') {
      if (record.payment.state === 'authorized' || record.payment.state === 'cancel_failed') {
        try {
          await this.stripe.cancelPaymentIntent(pi)
          record.payment = { ...record.payment, state: 'canceled', canceledAt: this.iso() }
        } catch (error) {
          record.payment = { ...record.payment, state: 'cancel_failed', lastError: sanitizeError(error) }
          record.fulfillmentAllowed = false
          record.buyerStatus = 'declined'
          await this.store.saveOrder(record)
          return { outcome: 'cancel_failed', retry: isTransientStripeError(error) }
        }
      }
      record.fulfillmentAllowed = false
      record.buyerStatus = 'declined'
      if (record.payment.state === 'canceled') this.queueReport(record, 'CANCELED')
      await this.store.saveOrder(record)
      await this.flushReports(record)
      return { outcome: 'declined' }
    }

    // APPROVE and REVIEW both capture.
    if (record.payment.state === 'authorized' || record.payment.state === 'capture_failed') {
      try {
        await this.stripe.capturePaymentIntent(pi)
        record.payment = { ...record.payment, state: 'captured', capturedAt: this.iso(), lastError: undefined }
      } catch (error) {
        // Capture failure is an unresolved order, never a paid one.
        record.payment = { ...record.payment, state: 'capture_failed', lastError: sanitizeError(error) }
        record.fulfillmentAllowed = false
        record.buyerStatus = 'payment_unresolved'
        await this.store.saveOrder(record)
        return { outcome: 'capture_failed', retry: isTransientStripeError(error) }
      }
    }

    const captured = ['captured', 'refund_pending', 'refunded', 'refund_failed'].includes(record.payment.state)
    if (captured) this.queueReport(record, 'CAPTURED')

    if (decision === 'APPROVE') {
      record.fulfillmentAllowed = record.payment.state === 'captured'
      record.buyerStatus = record.fulfillmentAllowed ? 'confirmed' : record.buyerStatus
    } else {
      // REVIEW: a reviewer verdict may already have arrived (early callback).
      const status = record.review?.status
      if (status === 'approved' && record.payment.state === 'captured') {
        record.fulfillmentAllowed = true
        record.buyerStatus = 'confirmed'
      } else if (status === 'declined') {
        record.fulfillmentAllowed = false
        await this.store.saveOrder(record)
        return this.requestRefund(record)
      } else {
        record.fulfillmentAllowed = false
        record.buyerStatus = 'payment_captured_review_pending'
      }
    }

    await this.store.saveOrder(record)
    await this.flushReports(record)
    return { outcome: decision === 'APPROVE' ? 'approved' : 'review_open' }
  }

  async handlePaymentIntentCanceled(pi) {
    if (pi?.metadata?.kount_screening !== '1') return { outcome: 'ignored_unscreened' }
    const record = await this.store.getOrderByPaymentIntent(pi.id)
    if (!record) return { outcome: 'ignored_unknown_order' }
    if (record.payment.state !== 'authorized') return { outcome: 'duplicate' } // we canceled it, or later state
    const expired = pi.cancellation_reason === 'automatic'
    record.payment = { ...record.payment, state: expired ? 'expired' : 'canceled', canceledAt: this.iso() }
    record.fulfillmentAllowed = false
    record.buyerStatus = 'canceled'
    if (record.evaluation?.kountOrderId) this.queueReport(record, expired ? 'EXPIRED' : 'CANCELED')
    await this.store.saveOrder(record)
    await this.flushReports(record)
    return { outcome: expired ? 'authorization_expired' : 'authorization_canceled' }
  }

  // ======================================================================
  // Failed checkout attempts → data-only report
  // ======================================================================

  async handlePaymentFailed(piEvent) {
    if (piEvent?.metadata?.kount_screening !== '1') return { outcome: 'ignored_unscreened' }
    const pi = await this.stripe.getPaymentIntentForFraud(piEvent.id)
    const chargeId = typeof pi.latest_charge === 'object' ? pi.latest_charge?.id : pi.latest_charge
    const attemptId = `${pi.id}:${chargeId || 'none'}`

    const existing = await this.store.getAttempt(attemptId)
    if (existing?.state === 'confirmed') return { outcome: 'duplicate' }

    const attempt = existing || {
      attemptId,
      paymentIntentId: pi.id,
      kind: pi.latest_charge?.outcome?.type === 'blocked' ? 'radar_block' : 'issuer_decline',
      state: 'pending',
      attempts: 0,
      createdAt: this.iso(),
      payload: buildFailedAttemptPayload({
        paymentIntent: pi,
        deviceSessionId: pi.metadata?.kount_device_session_id,
        channel: this.config.channel,
      }),
    }
    // Intent is durable before sending.
    await this.store.saveAttempt(attemptId, attempt)
    await this.sendAttempt(attemptId, attempt)
    return { outcome: `failed_attempt_${attempt.state}` }
  }

  async sendAttempt(attemptId, attempt) {
    try {
      const ack = await this.kount.reportDataOnly(attempt.payload)
      attempt.state = 'confirmed'
      attempt.kountOrderId = ack.kountOrderId
      attempt.confirmedAt = this.iso()
      if (ack.possibleDuplicate) attempt.duplicateRisk = true
    } catch (error) {
      attempt.attempts += 1
      attempt.lastError = sanitizeError(error)
      if (error?.possibleDuplicate) attempt.duplicateRisk = true
      if (isPermanentKountRejection(error)) attempt.state = 'rejected'
      else if (attempt.attempts >= MAX_REPORT_ATTEMPTS) attempt.state = 'rejected'
      else {
        attempt.state = error?.possibleDuplicate ? 'unknown' : 'pending'
        attempt.nextAttemptAt = new Date(this.now() + this.reportBackoff(attempt.attempts)).toISOString()
      }
    }
    await this.store.saveAttempt(attemptId, attempt)
    return attempt
  }

  // ======================================================================
  // Kount reviewer decisions
  // ======================================================================

  /**
   * @param {{ eventKey:string, eventType:string, kountOrderId?:string,
   *           merchantOrderId?:string, fieldName?:string, newValue?:string }} evt
   *   Already signature-verified, freshness-checked and deduplicated.
   */
  async handleKountEvent(evt, { fromDeferred = false } = {}) {
    const field = String(evt.fieldName || '').toLowerCase()
    const newValue = String(evt.newValue || '').toUpperCase()
    if (field !== 'status' || !['APPROVE', 'DECLINE'].includes(newValue)) {
      return { outcome: 'ignored_not_status_decision' }
    }

    let record = evt.kountOrderId ? await this.store.getOrderByKountOrderId(evt.kountOrderId) : null
    if (!record && evt.merchantOrderId && String(evt.merchantOrderId).startsWith('cs_')) {
      const candidate = await this.store.getOrder(evt.merchantOrderId)
      if (candidate && (!evt.kountOrderId || candidate.evaluation?.kountOrderId === evt.kountOrderId
        || !candidate.evaluation?.kountOrderId)) {
        record = candidate
      }
    }

    // Early callback: the order (or its decision) is not saved yet. Keep the
    // verified event durably; the recovery job applies it once the order
    // exists. Never mark it handled.
    if (!record || record.evaluation?.state !== 'complete') {
      if (!fromDeferred) await this.store.saveDeferred(evt.eventKey, evt)
      return { outcome: 'deferred' }
    }

    if (record.evaluation.decision !== 'REVIEW') {
      record.conflicts = [...(record.conflicts || []), {
        at: this.iso(), eventKey: evt.eventKey, newValue, reason: 'status_change_outside_review',
      }]
      await this.store.saveOrder(record)
      return { outcome: 'conflict_not_review' }
    }

    const verdict = newValue === 'APPROVE' ? 'approved' : 'declined'
    const current = record.review?.status
    if (current === 'approved' || current === 'declined') {
      if (current === verdict) return { outcome: 'duplicate' }
      // Conflicting verdict: keep the first final state, surface for operator.
      record.conflicts = [...(record.conflicts || []), {
        at: this.iso(), eventKey: evt.eventKey, newValue, reason: 'conflicting_reviewer_decision', kept: current,
      }]
      await this.store.saveOrder(record)
      console.error(`[Fraud] conflicting reviewer decision for ${record.checkoutSessionId}; kept ${current}`)
      return { outcome: 'conflict' }
    }

    record.review = { ...(record.review || {}), status: verdict, decidedAt: this.iso(), eventKey: evt.eventKey }

    if (verdict === 'approved') {
      // Release only after confirmed prior capture; never capture again here.
      if (record.payment.state === 'captured') {
        record.fulfillmentAllowed = true
        record.buyerStatus = 'confirmed'
      }
      await this.store.saveOrder(record)
      return { outcome: record.fulfillmentAllowed ? 'review_approved' : 'review_approved_awaiting_capture' }
    }

    record.fulfillmentAllowed = false
    record.buyerStatus = 'declined_refund_pending'
    await this.store.saveOrder(record)
    if (record.payment.state === 'authorized' || record.payment.state === 'capture_failed') {
      // Never captured: release the authorization instead of refunding.
      return this.applyDecisionAsDecline(record)
    }
    return this.requestRefund(record)
  }

  async applyDecisionAsDecline(record) {
    try {
      await this.stripe.cancelPaymentIntent(record.paymentIntentId)
      record.payment = { ...record.payment, state: 'canceled', canceledAt: this.iso() }
      record.buyerStatus = 'declined'
      this.queueReport(record, 'CANCELED')
    } catch (error) {
      record.payment = { ...record.payment, state: 'cancel_failed', lastError: sanitizeError(error) }
    }
    await this.store.saveOrder(record)
    await this.flushReports(record)
    return { outcome: 'review_declined_authorization_released' }
  }

  /** Idempotent refund request after a verified reviewer decline. */
  async requestRefund(record) {
    if (['refund_pending', 'refunded'].includes(record.payment.state)) return { outcome: 'refund_already_requested' }
    try {
      const refund = await this.stripe.refundPaymentIntent(record.paymentIntentId, record.checkoutSessionId, record.review?.eventKey)
      record.payment = { ...record.payment, refundId: refund.id, refundRequestedAt: this.iso(), lastError: undefined }
      record.reports = (record.reports || []).filter((r) => !(r.operation === PAYMENT_EFFECT && r.effect === 'refund'))
      this.applyRefundStatus(record, refund)
    } catch (error) {
      // The request failed; that is not a failed refund. Queue the effect
      // for the recovery job and keep fulfillment blocked.
      record.payment = { ...record.payment, lastError: sanitizeError(error) }
      if (!(record.reports || []).some((r) => r.operation === PAYMENT_EFFECT && r.effect === 'refund')) {
        record.reports = [...(record.reports || []), {
          id: 'refund_request', operation: PAYMENT_EFFECT, effect: 'refund', state: 'pending', attempts: 1,
          createdAt: this.iso(), nextAttemptAt: new Date(this.now() + REPORT_BACKOFF_BASE_MS).toISOString(),
        }]
      }
    }
    record.fulfillmentAllowed = false
    await this.store.saveOrder(record)
    await this.flushReports(record)
    return { outcome: `review_declined_${record.payment.state}` }
  }

  /** Map a Stripe refund to payment state. Never regresses a final state. */
  applyRefundStatus(record, refund) {
    const status = refund?.status
    if (record.payment.state === 'refunded') return
    if (status === 'succeeded') {
      record.payment = { ...record.payment, state: 'refunded', refundedAt: this.iso() }
      record.buyerStatus = 'declined_refunded'
      this.queueReport(record, 'REFUNDED')
    } else if (status === 'failed' || status === 'canceled') {
      record.payment = { ...record.payment, state: 'refund_failed' }
      record.buyerStatus = 'declined_refund_unresolved'
      this.queueReport(record, 'REFUND_FAILED')
    } else {
      record.payment = { ...record.payment, state: 'refund_pending' }
      record.buyerStatus = 'declined_refund_pending'
    }
    record.fulfillmentAllowed = false
  }

  async handleRefund(refund) {
    if (refund?.metadata?.openshop_refund_cause !== 'kount_reviewer_decline') {
      return { outcome: 'ignored_unrelated_refund' }
    }
    const record = (refund.metadata.openshop_checkout_session
      && await this.store.getOrder(refund.metadata.openshop_checkout_session))
      || await this.store.getOrderByPaymentIntent(refund.payment_intent)
    // Order not saved yet: ask Stripe to redeliver later.
    if (!record) return { outcome: 'refund_order_unknown', retry: true }
    if (record.payment.refundId && record.payment.refundId !== refund.id) {
      return { outcome: 'ignored_unrelated_refund' }
    }
    if (!record.payment.refundId) {
      // Provider callback arrived before we saved the refund ID.
      record.payment = { ...record.payment, refundId: refund.id }
      record.reports = (record.reports || []).filter((r) => !(r.operation === PAYMENT_EFFECT && r.effect === 'refund'))
    }
    // We only create these refunds after a verified reviewer decline, so the
    // refund itself proves the decline. Workers KV is eventually consistent:
    // this handler can read a copy saved before the decline and, writing
    // last, would otherwise put the review back to "open".
    const reviewStatus = record.review?.status
    if (record.evaluation?.decision === 'REVIEW' && reviewStatus !== 'approved' && reviewStatus !== 'declined') {
      record.review = {
        ...(record.review || {}),
        status: 'declined',
        decidedAt: refund.created ? new Date(refund.created * 1000).toISOString() : this.iso(),
        eventKey: refund.metadata.openshop_kount_event || record.review?.eventKey,
        recordedFrom: 'stripe_refund',
      }
    }
    this.applyRefundStatus(record, refund)
    await this.store.saveOrder(record)
    await this.flushReports(record)
    return { outcome: `refund_${record.payment.state}` }
  }

  // ======================================================================
  // Durable Kount status reporting
  // ======================================================================

  queueReport(record, transactionStatus) {
    record.reports = record.reports || []
    if (record.reports.some((r) => r.operation === UPDATE_ORDER && r.transactionStatus === transactionStatus)) return
    const hasOrder = Boolean(record.evaluation?.kountOrderId && record.evaluation?.kountTransactionId)
    record.reports.push({
      id: `update_${transactionStatus}`,
      operation: UPDATE_ORDER,
      transactionStatus,
      // A fallback decision after a failed evaluation leaves no Kount order
      // to update; record that instead of pretending it was reported.
      state: hasOrder ? 'pending' : 'not_applicable',
      reason: hasOrder ? undefined : 'no_kount_order',
      attempts: 0,
      createdAt: this.iso(),
    })
  }

  reportBackoff(attempts) {
    return Math.min(REPORT_BACKOFF_MAX_MS, REPORT_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1))
  }

  /**
   * Send due reports in order. Stops at the first failure so CAPTURED is
   * always reported before REFUNDED.
   */
  async flushReports(record, { onlyDue = false } = {}) {
    let changed = false
    for (const report of record.reports || []) {
      if (report.state !== 'pending' && report.state !== 'unknown') continue
      if (onlyDue && report.nextAttemptAt && Date.parse(report.nextAttemptAt) > this.now()) break

      if (report.operation === PAYMENT_EFFECT) {
        // Queued provider effects only run when due, so a failed refund
        // request is not hammered again inside the same request.
        if (report.nextAttemptAt && Date.parse(report.nextAttemptAt) > this.now()) break
        if (report.effect === 'refund') {
          await this.requestRefund(record)
          return
        }
        continue
      }

      changed = true
      try {
        await this.kount.updateTransactionStatus({
          kountOrderId: record.evaluation.kountOrderId,
          kountTransactionId: record.evaluation.kountTransactionId,
          merchantOrderId: record.checkoutSessionId,
          transactionStatus: report.transactionStatus,
        })
        report.state = 'confirmed'
        report.confirmedAt = this.iso()
        report.lastError = undefined
      } catch (error) {
        report.attempts += 1
        report.lastError = sanitizeError(error)
        if (isPermanentKountRejection(error) || report.attempts >= MAX_REPORT_ATTEMPTS) {
          report.state = 'rejected'
          console.error(`[Fraud] Kount ${report.transactionStatus} report needs operator attention for ${record.checkoutSessionId}`)
        } else {
          report.state = 'pending'
          report.nextAttemptAt = new Date(this.now() + this.reportBackoff(report.attempts)).toISOString()
        }
        break
      }
    }
    if (changed) await this.store.saveOrder(record)
  }

  // ======================================================================
  // Scheduled recovery (Cloudflare cron → worker `scheduled`)
  // ======================================================================

  async runRecovery() {
    const summary = {
      pendingOrders: 0,
      reportsConfirmed: 0,
      deferredApplied: 0,
      deferredWaiting: 0,
      attemptsConfirmed: 0,
      attemptsWaiting: 0,
      oldestPendingAgeMs: 0,
      errors: 0,
    }

    for (const csId of await this.store.listPendingOrderIds()) {
      try {
        const record = await this.store.getOrder(csId)
        if (!record) continue
        summary.pendingOrders += 1
        const before = (record.reports || []).filter((r) => r.state === 'confirmed').length
        for (const r of record.reports || []) {
          if (r.state === 'pending' || r.state === 'unknown') {
            summary.oldestPendingAgeMs = Math.max(summary.oldestPendingAgeMs, this.now() - Date.parse(r.createdAt))
          }
        }
        await this.flushReports(record, { onlyDue: true })
        const after = (record.reports || []).filter((r) => r.state === 'confirmed').length
        summary.reportsConfirmed += after - before
      } catch (error) {
        summary.errors += 1
        console.error(`[Fraud] recovery error for pending order: ${sanitizeError(error).type || 'error'}`)
      }
    }

    for (const key of await this.store.listDeferredKeys()) {
      try {
        const evt = await this.store.getDeferred(key)
        if (!evt) continue
        const res = await this.handleKountEvent(evt, { fromDeferred: true })
        if (res.outcome === 'deferred') {
          summary.deferredWaiting += 1
        } else {
          await this.store.deleteDeferred(key)
          await this.store.markEventProcessed('kount', key)
          summary.deferredApplied += 1
        }
      } catch {
        summary.errors += 1
      }
    }

    for (const id of await this.store.listAttemptIds()) {
      try {
        const attempt = await this.store.getAttempt(id)
        if (!attempt || !['pending', 'unknown'].includes(attempt.state)) continue
        if (attempt.nextAttemptAt && Date.parse(attempt.nextAttemptAt) > this.now()) {
          summary.attemptsWaiting += 1
          continue
        }
        const res = await this.sendAttempt(id, attempt)
        if (res.state === 'confirmed') summary.attemptsConfirmed += 1
        else summary.attemptsWaiting += 1
      } catch {
        summary.errors += 1
      }
    }

    await this.store.saveRecoveryRun(summary)
    return summary
  }
}

/**
 * Wire the fraud services for one request from resolved configuration.
 * Returns null when Kount is not configured (screening disabled).
 */
export async function createFraudCheckoutService(kv, env, deps = {}) {
  const config = await resolveKountConfig(kv, env)
  const stripe = deps.stripe ?? new StripeService(
    await resolveSetting(kv, env, 'STRIPE_SECRET_KEY'),
    await resolveSetting(kv, env, 'SITE_URL'),
  )
  return {
    config,
    stripe,
    service: config.enabled
      ? new FraudCheckoutService({
        store: new FraudOrderStore(kv),
        stripe,
        kount: deps.kount ?? new KountService(config, deps),
        config,
      })
      : null,
  }
}
