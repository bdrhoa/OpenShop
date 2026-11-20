// Post-authorization hosted-checkout lifecycle with synthetic provider doubles.
// No live Stripe or Kount calls.
import { describe, it, expect, vi } from 'vitest'
import { FraudCheckoutService } from '../../../src/services/FraudCheckoutService.js'
import { FraudOrderStore } from '../../../src/services/FraudOrderStore.js'
import { KountApiError } from '../../../src/services/KountClient.js'
import { parseKountConfig } from '../../../src/config/kount.js'
import { createMockKV } from '../../setup.js'

const CS = 'cs_test_1'
const PI = 'pi_test_1'

function session(overrides = {}) {
  return {
    id: CS,
    mode: 'payment',
    payment_intent: PI,
    currency: 'usd',
    amount_subtotal: 1000,
    amount_total: 1000,
    customer_details: { name: 'Pat Example', email: 'pat@example.com', address: { country: 'US', postal_code: '83702' } },
    ...overrides,
  }
}

function fakeStripe() {
  const pi = {
    id: PI,
    status: 'requires_capture',
    currency: 'usd',
    amount: 1000,
    metadata: { kount_screening: '1', kount_device_session_id: 'dev123' },
    latest_charge: { id: 'ch_1', payment_method_details: { card: { fingerprint: 'fp', last4: '4242', brand: 'visa', checks: {} } } },
  }
  return {
    pi,
    getPaymentIntentForFraud: vi.fn(async () => pi),
    getCheckoutSessionLineItems: vi.fn(async () => ({ data: [{ id: 'li', quantity: 1, description: 'Tee', price: { id: 'price_1', unit_amount: 1000 } }] })),
    capturePaymentIntent: vi.fn(async () => ({ id: PI, status: 'succeeded' })),
    cancelPaymentIntent: vi.fn(async () => ({ id: PI, status: 'canceled' })),
    refundPaymentIntent: vi.fn(async () => ({ id: 're_1', status: 'pending' })),
  }
}

function fakeKount(decision = 'APPROVE', overrides = {}) {
  return {
    evaluate: vi.fn(async () => ({
      decision, decisionSource: 'kount', fallbackReason: null, attempts: 1,
      kountOrderId: 'K1', kountTransactionId: 'T1', correlationId: 'corr',
    })),
    updateTransactionStatus: vi.fn(async () => ({})),
    reportDataOnly: vi.fn(async () => ({ kountOrderId: 'KD1' })),
    ...overrides,
  }
}

function setup(decision, kountOverrides) {
  const kv = createMockKV()
  let t = Date.parse('2026-11-20T12:00:00Z')
  const now = () => t
  const store = new FraudOrderStore(kv, { now })
  const stripe = fakeStripe()
  const kount = fakeKount(decision, kountOverrides)
  const config = parseKountConfig({ KOUNT_CLIENT_ID: 'c', KOUNT_API_KEY: 'k' })
  const svc = new FraudCheckoutService({ store, stripe, kount, config, now })
  return { kv, store, stripe, kount, svc, advance: (ms) => { t += ms } }
}

const completed = (s = session()) => ({ id: 'evt_1', type: 'checkout.session.completed', data: { object: s } })

describe('FraudCheckoutService — initial decisions', () => {
  it('APPROVE: captures, releases fulfillment, reports CAPTURED', async () => {
    const { svc, stripe, kount, store } = setup('APPROVE')
    const res = await svc.handleStripeEvent(completed())
    expect(res.outcome).toBe('approved')
    expect(stripe.capturePaymentIntent).toHaveBeenCalledTimes(1)
    const rec = await store.getOrder(CS)
    expect(rec).toMatchObject({ fulfillmentAllowed: true, buyerStatus: 'confirmed', payment: { state: 'captured' } })
    expect(rec.evaluation).toMatchObject({ decision: 'APPROVE', decisionSource: 'kount', kountOrderId: 'K1' })
    expect(kount.updateTransactionStatus).toHaveBeenCalledWith(expect.objectContaining({ transactionStatus: 'CAPTURED', kountOrderId: 'K1', kountTransactionId: 'T1' }))
    expect(rec.reports[0].state).toBe('confirmed')
  })

  it('evaluates with the device session ID and post-authorization status', async () => {
    const { svc, kount, store } = setup('APPROVE')
    await store.saveCheckoutContext(CS, { deviceSessionId: 'abc123', userIp: '192.0.2.1' })
    await svc.handleStripeEvent(completed())
    const payload = kount.evaluate.mock.calls[0][0]
    expect(payload).toMatchObject({ merchantOrderId: CS, deviceSessionId: 'abc123', userIp: '192.0.2.1' })
    expect(payload.transactions[0]).toMatchObject({ transactionStatus: 'AUTHORIZED', authorizationStatus: { authResult: 'APPROVED' }, payment: { type: 'TOKEN' } })
  })

  it('DECLINE: releases the authorization, blocks fulfillment, reports CANCELED', async () => {
    const { svc, stripe, kount, store } = setup('DECLINE')
    const res = await svc.handleStripeEvent(completed())
    expect(res.outcome).toBe('declined')
    expect(stripe.capturePaymentIntent).not.toHaveBeenCalled()
    expect(stripe.cancelPaymentIntent).toHaveBeenCalledTimes(1)
    expect((await store.getOrder(CS))).toMatchObject({ fulfillmentAllowed: false, payment: { state: 'canceled' } })
    expect(kount.updateTransactionStatus).toHaveBeenCalledWith(expect.objectContaining({ transactionStatus: 'CANCELED' }))
  })

  it('REVIEW: captures but keeps fulfillment blocked', async () => {
    const { svc, stripe, store } = setup('REVIEW')
    const res = await svc.handleStripeEvent(completed())
    expect(res.outcome).toBe('review_open')
    expect(stripe.capturePaymentIntent).toHaveBeenCalledTimes(1)
    expect(await store.getOrder(CS)).toMatchObject({
      fulfillmentAllowed: false, buyerStatus: 'payment_captured_review_pending',
      payment: { state: 'captured' }, review: { status: 'open' },
    })
  })

  it('records fallback provenance and never labels it a Kount decision', async () => {
    const { svc, kount, store } = setup('APPROVE')
    kount.evaluate.mockResolvedValueOnce({ decision: 'APPROVE', decisionSource: 'fallback', fallbackReason: 'http_503', attempts: 3 })
    await svc.handleStripeEvent(completed())
    const rec = await store.getOrder(CS)
    expect(rec.evaluation).toMatchObject({ decision: 'APPROVE', decisionSource: 'fallback', fallbackReason: 'http_503', attempts: 3 })
    // No Kount order exists to update: recorded, not faked.
    expect(rec.reports[0]).toMatchObject({ transactionStatus: 'CAPTURED', state: 'not_applicable', reason: 'no_kount_order' })
    expect(kount.updateTransactionStatus).not.toHaveBeenCalled()
  })

  it('DECLINE fallback cancels like a Kount DECLINE', async () => {
    const { svc, kount, stripe } = setup()
    kount.evaluate.mockResolvedValueOnce({ decision: 'DECLINE', decisionSource: 'fallback', fallbackReason: 'missing_decision' })
    await svc.handleStripeEvent(completed())
    expect(stripe.cancelPaymentIntent).toHaveBeenCalledTimes(1)
    expect(stripe.capturePaymentIntent).not.toHaveBeenCalled()
  })

  it('skips sessions created without screening', async () => {
    const { svc, stripe, kount } = setup('APPROVE')
    stripe.pi.metadata = {}
    expect((await svc.handleStripeEvent(completed())).outcome).toBe('skipped_unscreened')
    expect(kount.evaluate).not.toHaveBeenCalled()
  })
})

describe('FraudCheckoutService — idempotency and failures', () => {
  it('duplicate delivery resumes from the saved decision without re-evaluating or re-capturing', async () => {
    const { svc, kount, stripe } = setup('APPROVE')
    await svc.handleStripeEvent(completed())
    await svc.handleStripeEvent(completed())
    expect(kount.evaluate).toHaveBeenCalledTimes(1)
    expect(stripe.capturePaymentIntent).toHaveBeenCalledTimes(1)
    expect(kount.updateTransactionStatus).toHaveBeenCalledTimes(1)
  })

  it('capture failure is unresolved, never paid; transient errors ask for redelivery', async () => {
    const { svc, stripe, store } = setup('APPROVE')
    stripe.capturePaymentIntent.mockRejectedValueOnce(Object.assign(new Error('down'), { type: 'StripeAPIError', statusCode: 500 }))
    const res = await svc.handleStripeEvent(completed())
    expect(res).toEqual({ outcome: 'capture_failed', retry: true })
    expect(await store.getOrder(CS)).toMatchObject({ fulfillmentAllowed: false, payment: { state: 'capture_failed' } })
    // Redelivery resumes capture with the saved decision.
    const again = await svc.handleStripeEvent(completed())
    expect(again.outcome).toBe('approved')
    expect(stripe.capturePaymentIntent).toHaveBeenCalledTimes(2)
  })

  it('a second handler during an in-flight evaluation does not evaluate again', async () => {
    const { svc, kount, store } = setup('APPROVE')
    const rec = store.newOrder({ checkoutSessionId: CS, paymentIntentId: PI })
    await store.claimEvaluation(rec, 'other-owner')
    const res = await svc.handleStripeEvent(completed())
    expect(res).toEqual({ outcome: 'evaluation_in_progress', retry: true })
    expect(kount.evaluate).not.toHaveBeenCalled()
  })

  it('a lost owner after claim becomes an unknown outcome, not a re-send', async () => {
    const { svc, kount, store, advance } = setup('APPROVE')
    const rec = store.newOrder({ checkoutSessionId: CS, paymentIntentId: PI })
    await store.claimEvaluation(rec, 'crashed-owner')
    advance(10 * 60000)
    const res = await svc.handleStripeEvent(completed())
    expect(res.outcome).toBe('evaluation_unknown')
    expect(kount.evaluate).not.toHaveBeenCalled()
    expect((await store.getOrder(CS)).fulfillmentAllowed).toBe(false)
  })

  it('a failed report stays pending and the recovery job confirms it later', async () => {
    const { svc, kount, store, advance } = setup('APPROVE')
    kount.updateTransactionStatus.mockRejectedValueOnce(new KountApiError('x', { status: 503 }))
    await svc.handleStripeEvent(completed())
    let rec = await store.getOrder(CS)
    expect(rec.reports[0]).toMatchObject({ state: 'pending', attempts: 1 })
    expect(await store.listPendingOrderIds()).toContain(CS)

    advance(2 * 60000)
    const summary = await svc.runRecovery()
    rec = await store.getOrder(CS)
    expect(rec.reports[0].state).toBe('confirmed')
    expect(summary.reportsConfirmed).toBe(1)
    expect(await store.listPendingOrderIds()).not.toContain(CS)
    expect(await store.getRecoveryRun()).toMatchObject({ pendingOrders: 1 })
  })

  it('a permanently rejected report is escalated, not retried forever', async () => {
    const { svc, kount, store } = setup('APPROVE')
    kount.updateTransactionStatus.mockRejectedValueOnce(new KountApiError('x', { status: 400 }))
    await svc.handleStripeEvent(completed())
    expect((await store.getOrder(CS)).reports[0].state).toBe('rejected')
  })
})

describe('FraudCheckoutService — reviewer decisions', () => {
  async function reviewOrder() {
    const ctx = setup('REVIEW')
    await ctx.svc.handleStripeEvent(completed())
    return ctx
  }
  const evt = (newValue, key = `e-${newValue}`) => ({ eventKey: key, eventType: 'Order.StatusChange', kountOrderId: 'K1', merchantOrderId: CS, fieldName: 'status', oldValue: 'REVIEW', newValue })

  it('approval releases fulfillment without capturing again', async () => {
    const { svc, stripe, store } = await reviewOrder()
    const res = await svc.handleKountEvent(evt('APPROVE'))
    expect(res.outcome).toBe('review_approved')
    expect(stripe.capturePaymentIntent).toHaveBeenCalledTimes(1)
    expect(await store.getOrder(CS)).toMatchObject({ fulfillmentAllowed: true, review: { status: 'approved' } })
  })

  it('decline requests an idempotent refund and keeps fulfillment blocked until confirmed', async () => {
    const { svc, stripe, kount, store } = await reviewOrder()
    const res = await svc.handleKountEvent(evt('DECLINE'))
    expect(res.outcome).toBe('review_declined_refund_pending')
    expect(stripe.refundPaymentIntent).toHaveBeenCalledWith(PI, CS)
    let rec = await store.getOrder(CS)
    expect(rec).toMatchObject({ fulfillmentAllowed: false, payment: { state: 'refund_pending', refundId: 're_1' } })
    // A refund request is not a refund: nothing REFUNDED yet.
    expect(kount.updateTransactionStatus).not.toHaveBeenCalledWith(expect.objectContaining({ transactionStatus: 'REFUNDED' }))

    await svc.handleStripeEvent({ type: 'refund.updated', data: { object: { id: 're_1', status: 'succeeded', payment_intent: PI, metadata: { openshop_refund_cause: 'kount_reviewer_decline', openshop_checkout_session: CS } } } })
    rec = await store.getOrder(CS)
    expect(rec).toMatchObject({ fulfillmentAllowed: false, payment: { state: 'refunded' } })
    expect(kount.updateTransactionStatus).toHaveBeenLastCalledWith(expect.objectContaining({ transactionStatus: 'REFUNDED' }))
  })

  it('a failed refund is reported as REFUND_FAILED and stays blocked', async () => {
    const { svc, kount, store } = await reviewOrder()
    await svc.handleKountEvent(evt('DECLINE'))
    await svc.handleRefund({ id: 're_1', status: 'failed', payment_intent: PI, metadata: { openshop_refund_cause: 'kount_reviewer_decline', openshop_checkout_session: CS } })
    expect(await store.getOrder(CS)).toMatchObject({ fulfillmentAllowed: false, payment: { state: 'refund_failed' } })
    expect(kount.updateTransactionStatus).toHaveBeenLastCalledWith(expect.objectContaining({ transactionStatus: 'REFUND_FAILED' }))
  })

  it('refund callback before the refund ID is saved is correlated once', async () => {
    const { svc, stripe, store, kount } = await reviewOrder()
    stripe.refundPaymentIntent.mockRejectedValueOnce(Object.assign(new Error('timeout'), { type: 'StripeConnectionError' }))
    await svc.handleKountEvent(evt('DECLINE'))
    let rec = await store.getOrder(CS)
    expect(rec.payment.refundId).toBeUndefined()
    expect(rec.reports.some((r) => r.effect === 'refund' && r.state === 'pending')).toBe(true)

    const refundEvent = { id: 're_9', status: 'succeeded', payment_intent: PI, metadata: { openshop_refund_cause: 'kount_reviewer_decline', openshop_checkout_session: CS } }
    await svc.handleRefund(refundEvent)
    await svc.handleRefund(refundEvent) // redelivery
    rec = await store.getOrder(CS)
    expect(rec.payment).toMatchObject({ state: 'refunded', refundId: 're_9' })
    expect(rec.reports.some((r) => r.effect === 'refund')).toBe(false)
    const refundedReports = kount.updateTransactionStatus.mock.calls.filter(([a]) => a.transactionStatus === 'REFUNDED')
    expect(refundedReports).toHaveLength(1)
  })

  it('unrelated or older refund events cannot regress state', async () => {
    const { svc, store } = await reviewOrder()
    await svc.handleKountEvent(evt('DECLINE'))
    await svc.handleRefund({ id: 're_1', status: 'succeeded', payment_intent: PI, metadata: { openshop_refund_cause: 'kount_reviewer_decline', openshop_checkout_session: CS } })
    expect((await svc.handleRefund({ id: 're_other', status: 'failed', payment_intent: PI, metadata: { openshop_refund_cause: 'kount_reviewer_decline', openshop_checkout_session: CS } })).outcome).toBe('ignored_unrelated_refund')
    expect((await svc.handleRefund({ id: 're_x', status: 'failed', payment_intent: PI, metadata: {} })).outcome).toBe('ignored_unrelated_refund')
    await svc.handleRefund({ id: 're_1', status: 'pending', payment_intent: PI, metadata: { openshop_refund_cause: 'kount_reviewer_decline', openshop_checkout_session: CS } })
    expect((await store.getOrder(CS)).payment.state).toBe('refunded')
  })

  it('conflicting reviewer verdicts keep the first final state and surface a conflict', async () => {
    const { svc, stripe, store } = await reviewOrder()
    await svc.handleKountEvent(evt('APPROVE'))
    const res = await svc.handleKountEvent(evt('DECLINE'))
    expect(res.outcome).toBe('conflict')
    expect(stripe.refundPaymentIntent).not.toHaveBeenCalled()
    const rec = await store.getOrder(CS)
    expect(rec).toMatchObject({ fulfillmentAllowed: true, review: { status: 'approved' } })
    expect(rec.conflicts).toHaveLength(1)
    // Repeat after completion: still no extra payment effects.
    await svc.handleKountEvent(evt('APPROVE'))
    await svc.handleKountEvent(evt('DECLINE', 'e-again'))
    expect(stripe.refundPaymentIntent).not.toHaveBeenCalled()
    expect(stripe.capturePaymentIntent).toHaveBeenCalledTimes(1)
  })

  it('early callback is durably deferred and applied once by recovery', async () => {
    const { svc, store, stripe } = setup('REVIEW')
    // Reviewer event arrives before the order is saved.
    expect((await svc.handleKountEvent(evt('DECLINE'))).outcome).toBe('deferred')
    expect(await store.listDeferredKeys()).toContain('e-DECLINE')

    await svc.handleStripeEvent(completed())
    const summary = await svc.runRecovery()
    expect(summary.deferredApplied).toBe(1)
    expect(stripe.refundPaymentIntent).toHaveBeenCalledTimes(1)
    expect(await store.listDeferredKeys()).not.toContain('e-DECLINE')
    expect((await store.getOrder(CS)).fulfillmentAllowed).toBe(false)

    await svc.runRecovery()
    expect(stripe.refundPaymentIntent).toHaveBeenCalledTimes(1)
  })

  it('a status change on a non-REVIEW order is surfaced, not acted on', async () => {
    const { svc, stripe, store } = setup('APPROVE')
    await svc.handleStripeEvent(completed())
    const res = await svc.handleKountEvent(evt('DECLINE'))
    expect(res.outcome).toBe('conflict_not_review')
    expect(stripe.refundPaymentIntent).not.toHaveBeenCalled()
    expect((await store.getOrder(CS)).conflicts).toHaveLength(1)
  })
})

describe('FraudCheckoutService — failed attempts and authorization lifecycle', () => {
  it('reports a Radar block as a data-only REFUSED order, once', async () => {
    const { svc, stripe, kount } = setup()
    stripe.pi.status = 'requires_payment_method'
    stripe.pi.latest_charge = { id: 'ch_blocked', outcome: { type: 'blocked', reason: 'highest_risk_level' } }
    const evt = { type: 'payment_intent.payment_failed', data: { object: { id: PI, metadata: { kount_screening: '1' } } } }
    expect((await svc.handleStripeEvent(evt)).outcome).toBe('failed_attempt_confirmed')
    expect((await svc.handleStripeEvent(evt)).outcome).toBe('duplicate')
    expect(kount.reportDataOnly).toHaveBeenCalledTimes(1)
    expect(kount.reportDataOnly.mock.calls[0][0].transactions[0].authorizationStatus.authResult).toBe('UNKNOWN')
  })

  it('a failed data-only report is retried by recovery', async () => {
    const { svc, stripe, kount, store, advance } = setup()
    stripe.pi.latest_charge = { id: 'ch_d', outcome: { type: 'issuer_declined' } }
    kount.reportDataOnly.mockRejectedValueOnce(new KountApiError('x', { status: 502 }))
    await svc.handlePaymentFailed({ id: PI, metadata: { kount_screening: '1' } })
    expect((await store.getAttempt(`${PI}:ch_d`)).state).toBe('pending')
    advance(5 * 60000)
    await svc.runRecovery()
    expect((await store.getAttempt(`${PI}:ch_d`)).state).toBe('confirmed')
  })

  it('an expired authorization blocks fulfillment and is reported', async () => {
    const { svc, kount, store } = setup('REVIEW')
    // Stop before capture to leave an authorized order.
    const rec = store.newOrder({ checkoutSessionId: CS, paymentIntentId: PI })
    rec.evaluation = { state: 'complete', decision: 'REVIEW', kountOrderId: 'K1', kountTransactionId: 'T1' }
    await store.saveOrder(rec)
    const res = await svc.handleStripeEvent({ type: 'payment_intent.canceled', data: { object: { id: PI, cancellation_reason: 'automatic', metadata: { kount_screening: '1' } } } })
    expect(res.outcome).toBe('authorization_expired')
    expect(await store.getOrder(CS)).toMatchObject({ fulfillmentAllowed: false, payment: { state: 'expired' } })
    expect(kount.updateTransactionStatus).toHaveBeenCalledWith(expect.objectContaining({ transactionStatus: 'EXPIRED' }))
  })
})
