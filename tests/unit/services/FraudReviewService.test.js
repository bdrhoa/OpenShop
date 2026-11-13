import { describe, it, expect, beforeEach, vi } from 'vitest'
import { FraudReviewService, customerOrderStatus } from '../../../src/services/FraudReviewService.js'
import { KountError } from '../../../src/services/KountService.js'
import { FRAUD_STATES, KOUNT_KV_PREFIX } from '../../../src/config/kount.js'
import { createMockKV } from '../../setup.js'

function heldSession({ status = 'requires_capture', hold = '1' } = {}) {
  return {
    session: {
      id: 'cs_test_1',
      currency: 'usd',
      amount_total: 1000,
      amount_subtotal: 1000,
      customer_details: { email: 'buyer@example.com' },
      payment_intent: {
        id: 'pi_test_1',
        amount: 1000,
        currency: 'usd',
        status,
        metadata: { kount_hold: hold, kount_device_session_id: 'dev123', kount_user_ip: '192.0.2.1' },
        latest_charge: { id: 'ch_1', payment_method_details: { card: { brand: 'visa', last4: '4242', fingerprint: 'fp' } } },
      },
    },
    lineItems: [{ description: 'Mug', quantity: 1, price: { id: 'price_1', unit_amount: 1000, product: 'prod_1' } }],
  }
}

function makeDeps({ decision = 'APPROVE', evaluateError } = {}) {
  const stripe = {
    getCheckoutSessionForReview: vi.fn(async () => heldSession()),
    capturePaymentIntent: vi.fn(async (id) => ({ id, status: 'succeeded' })),
    cancelPaymentIntent: vi.fn(async (id) => ({ id, status: 'canceled' })),
    retrievePaymentIntent: vi.fn(async (id) => ({ id, status: 'requires_capture' })),
    refundPaymentIntent: vi.fn(async () => ({ id: 're_1', status: 'succeeded', amount: 1000 })),
  }
  const kount = {
    evaluateOrder: vi.fn(async () => {
      if (evaluateError) throw evaluateError
      return { kountOrderId: 'K1', transactionId: 'K1#0', decision, omniscore: 80, deviceId: 'd1' }
    }),
    updateOrder: vi.fn(async () => ({})),
  }
  const kv = createMockKV()
  return { stripe, kount, kv, service: new FraudReviewService({ kv, stripe, kount }) }
}

describe('FraudReviewService.handleCheckoutCompleted', () => {
  let deps
  beforeEach(() => { deps = makeDeps() })

  it('captures on APPROVE and reports the capture to Kount', async () => {
    const result = await deps.service.handleCheckoutCompleted('cs_test_1')
    expect(result.record.state).toBe(FRAUD_STATES.APPROVED_CAPTURED)
    expect(deps.stripe.capturePaymentIntent).toHaveBeenCalledWith('pi_test_1')
    expect(deps.kount.evaluateOrder).toHaveBeenCalledWith(expect.objectContaining({
      merchantOrderId: 'cs_test_1', deviceSessionId: 'dev123', userIp: '192.0.2.1',
    }))
    expect(deps.kount.updateOrder).toHaveBeenCalledWith('K1', { transactions: [{ transactionId: 'K1#0', transactionStatus: 'CAPTURED' }] })
  })

  it('cancels the authorization on DECLINE', async () => {
    deps = makeDeps({ decision: 'DECLINE' })
    const result = await deps.service.handleCheckoutCompleted('cs_test_1')
    expect(result.record.state).toBe(FRAUD_STATES.DECLINED_CANCELED)
    expect(deps.stripe.cancelPaymentIntent).toHaveBeenCalledWith('pi_test_1')
    expect(deps.stripe.capturePaymentIntent).not.toHaveBeenCalled()
  })

  it('captures on REVIEW but keeps the order unfulfillable', async () => {
    deps = makeDeps({ decision: 'REVIEW' })
    const result = await deps.service.handleCheckoutCompleted('cs_test_1')
    expect(result.record.state).toBe(FRAUD_STATES.REVIEW_CAPTURED)
    expect(deps.stripe.capturePaymentIntent).toHaveBeenCalledWith('pi_test_1')
    expect(deps.stripe.cancelPaymentIntent).not.toHaveBeenCalled()
    expect(deps.kount.updateOrder).toHaveBeenCalledWith('K1', { transactions: [{ transactionId: 'K1#0', transactionStatus: 'CAPTURED' }] })
    await expect(deps.service.getFulfillmentStatus('cs_test_1')).resolves.toEqual({ fulfillable: false, state: FRAUD_STATES.REVIEW_CAPTURED })
  })

  it('holds (never captures) when Kount fails', async () => {
    deps = makeDeps({ evaluateError: new KountError('boom', { status: 500, uncertain: true }) })
    const result = await deps.service.handleCheckoutCompleted('cs_test_1')
    expect(result.record.state).toBe(FRAUD_STATES.EVALUATION_FAILED_HOLD)
    expect(result.record.error).toMatch(/Reconcile/)
    expect(deps.stripe.capturePaymentIntent).not.toHaveBeenCalled()
  })

  it('treats duplicate deliveries as no-ops', async () => {
    await deps.service.handleCheckoutCompleted('cs_test_1')
    const second = await deps.service.handleCheckoutCompleted('cs_test_1')
    expect(second.reason).toBe('already_processed')
    expect(deps.kount.evaluateOrder).toHaveBeenCalledTimes(1)
    expect(deps.stripe.capturePaymentIntent).toHaveBeenCalledTimes(1)
  })

  it('reports in-progress for a concurrent delivery and does not re-submit a stale one', async () => {
    const record = { checkoutSessionId: 'cs_test_1', paymentIntentId: 'pi_test_1', state: FRAUD_STATES.EVALUATING, updatedAt: new Date().toISOString() }
    await deps.kv.put(`${KOUNT_KV_PREFIX}cs_test_1`, JSON.stringify(record))
    expect((await deps.service.handleCheckoutCompleted('cs_test_1')).status).toBe('in_progress')

    await deps.kv.put(`${KOUNT_KV_PREFIX}cs_test_1`, JSON.stringify({ ...record, updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() }))
    const stale = await deps.service.handleCheckoutCompleted('cs_test_1')
    expect(stale.record.state).toBe(FRAUD_STATES.EVALUATION_FAILED_HOLD)
    expect(deps.kount.evaluateOrder).not.toHaveBeenCalled()
  })

  it('ignores sessions that were not held for review', async () => {
    deps.stripe.getCheckoutSessionForReview.mockResolvedValue(heldSession({ hold: '0' }))
    expect((await deps.service.handleCheckoutCompleted('cs_test_1')).status).toBe('ignored')
    deps.stripe.getCheckoutSessionForReview.mockResolvedValue(heldSession({ status: 'succeeded' }))
    expect((await deps.service.handleCheckoutCompleted('cs_test_1')).status).toBe('ignored')
    expect(deps.kount.evaluateOrder).not.toHaveBeenCalled()
  })

  it('records a failed capture separately from success', async () => {
    deps.stripe.capturePaymentIntent.mockRejectedValue(new Error('card_declined'))
    const result = await deps.service.handleCheckoutCompleted('cs_test_1')
    expect(result.record.state).toBe(FRAUD_STATES.PAYMENT_ACTION_FAILED)
  })
})

describe('FraudReviewService.handleKountDecision', () => {
  let deps
  beforeEach(async () => {
    deps = makeDeps({ decision: 'REVIEW' })
    await deps.service.handleCheckoutCompleted('cs_test_1')
    vi.clearAllMocks()
    // The REVIEW order was captured at evaluation time.
    deps.stripe.retrievePaymentIntent.mockResolvedValue({ id: 'pi_test_1', status: 'succeeded' })
  })

  it('approves a captured REVIEW order without another payment action (lookup by Kount order id)', async () => {
    const result = await deps.service.handleKountDecision({ kountOrderId: 'K1', decision: 'APPROVE' })
    expect(result.record.state).toBe(FRAUD_STATES.REVIEW_APPROVED)
    expect(deps.stripe.capturePaymentIntent).not.toHaveBeenCalled()
    expect(deps.stripe.refundPaymentIntent).not.toHaveBeenCalled()
    await expect(deps.service.getFulfillmentStatus('cs_test_1')).resolves.toEqual({ fulfillable: true, state: FRAUD_STATES.REVIEW_APPROVED })
  })

  it('refunds a captured REVIEW order declined by a reviewer, recording it only after Stripe confirms', async () => {
    deps.stripe.refundPaymentIntent.mockResolvedValueOnce({ id: 're_1', status: 'pending' })
    let result = await deps.service.handleKountDecision({ merchantOrderId: 'cs_test_1', decision: 'DECLINE' })
    expect(result.record.state).toBe(FRAUD_STATES.REVIEW_DECLINED_REFUND_PENDING)
    expect(deps.stripe.cancelPaymentIntent).not.toHaveBeenCalled()

    result = await deps.service.handleKountDecision({ merchantOrderId: 'cs_test_1', decision: 'DECLINE' })
    expect(result.record.state).toBe(FRAUD_STATES.REVIEW_DECLINED_REFUNDED)
    expect(deps.stripe.refundPaymentIntent).toHaveBeenCalledWith('pi_test_1', { attempt: 0, checkoutSessionId: 'cs_test_1' })
    expect(deps.kount.updateOrder).toHaveBeenCalledWith('K1', {
      transactions: [{ transactionId: 'K1#0', transactionStatus: 'REFUNDED', reversals: [{ refundAmount: '1000' }] }],
    })
    await expect(deps.service.getFulfillmentStatus('cs_test_1')).resolves.toMatchObject({ fulfillable: false })
  })

  it('records a failed refund and retries it on redelivery', async () => {
    deps.stripe.refundPaymentIntent.mockRejectedValueOnce(new Error('stripe down'))
    let result = await deps.service.handleKountDecision({ kountOrderId: 'K1', decision: 'DECLINE' })
    expect(result.record.state).toBe(FRAUD_STATES.PAYMENT_ACTION_FAILED)
    result = await deps.service.handleKountDecision({ kountOrderId: 'K1', decision: 'DECLINE' })
    expect(result.record.state).toBe(FRAUD_STATES.REVIEW_DECLINED_REFUNDED)
  })

  it('retries a capture that failed at review time when the reviewer approves', async () => {
    const d = makeDeps({ decision: 'REVIEW' })
    d.stripe.capturePaymentIntent.mockRejectedValueOnce(new Error('stripe down'))
    expect((await d.service.handleCheckoutCompleted('cs_test_1')).record.state).toBe(FRAUD_STATES.PAYMENT_ACTION_FAILED)
    const result = await d.service.handleKountDecision({ kountOrderId: 'K1', decision: 'APPROVE' })
    expect(result.record.state).toBe(FRAUD_STATES.REVIEW_APPROVED)
    expect(d.stripe.capturePaymentIntent).toHaveBeenCalledTimes(2)
  })

  it('releases the authorization if the review-time capture failed and the reviewer declines', async () => {
    const d = makeDeps({ decision: 'REVIEW' })
    d.stripe.capturePaymentIntent.mockRejectedValueOnce(new Error('stripe down'))
    await d.service.handleCheckoutCompleted('cs_test_1')
    const result = await d.service.handleKountDecision({ kountOrderId: 'K1', decision: 'DECLINE' })
    expect(result.record.state).toBe(FRAUD_STATES.REVIEW_DECLINED_CANCELED)
    expect(d.stripe.refundPaymentIntent).not.toHaveBeenCalled()
  })

  it('ignores replays once final, non-REVIEW orders, and unknown orders', async () => {
    await deps.service.handleKountDecision({ kountOrderId: 'K1', decision: 'APPROVE' })
    const replay = await deps.service.handleKountDecision({ kountOrderId: 'K1', decision: 'DECLINE' })
    expect(replay.reason).toBe('already_final')
    expect(deps.stripe.refundPaymentIntent).not.toHaveBeenCalled()
    expect((await deps.service.handleKountDecision({ kountOrderId: 'nope', decision: 'APPROVE' })).reason).toBe('unknown_order')

    const approved = makeDeps({ decision: 'APPROVE' })
    approved.stripe.capturePaymentIntent.mockRejectedValueOnce(new Error('stripe down'))
    await approved.service.handleCheckoutCompleted('cs_test_1')
    const ignored = await approved.service.handleKountDecision({ kountOrderId: 'K1', decision: 'APPROVE' })
    expect(ignored.status).toBe('ignored')
  })

  it('keeps payment state when the Kount update fails', async () => {
    deps.kount.updateOrder.mockRejectedValue(new Error('kount down'))
    const result = await deps.service.handleKountDecision({ kountOrderId: 'K1', decision: 'DECLINE' })
    expect(result.record.state).toBe(FRAUD_STATES.REVIEW_DECLINED_REFUNDED)
    expect(result.record.kountUpdateError).toBe('kount down')
  })
})

describe('FraudReviewService.handleRefundUpdated', () => {
  let deps
  beforeEach(async () => {
    deps = makeDeps({ decision: 'REVIEW' })
    await deps.service.handleCheckoutCompleted('cs_test_1')
    deps.stripe.retrievePaymentIntent.mockResolvedValue({ id: 'pi_test_1', status: 'succeeded' })
    deps.stripe.refundPaymentIntent.mockResolvedValueOnce({ id: 're_1', status: 'pending', amount: 1000 })
    await deps.service.handleKountDecision({ kountOrderId: 'K1', decision: 'DECLINE' })
    vi.clearAllMocks()
  })

  const refund = (overrides = {}) => ({
    id: 're_1', payment_intent: 'pi_test_1', amount: 1000, status: 'succeeded',
    metadata: { checkout_session_id: 'cs_test_1' }, ...overrides,
  })

  it('marks a pending refund refunded when Stripe reports success', async () => {
    const result = await deps.service.handleRefundUpdated(refund())
    expect(result.record.state).toBe(FRAUD_STATES.REVIEW_DECLINED_REFUNDED)
    expect(deps.kount.updateOrder).toHaveBeenCalledWith('K1', {
      transactions: [{ transactionId: 'K1#0', transactionStatus: 'REFUNDED', reversals: [{ refundAmount: '1000' }] }],
    })
    // Duplicate delivery is a no-op.
    expect((await deps.service.handleRefundUpdated(refund())).reason).toBe('not_pending')
    expect(deps.kount.updateOrder).toHaveBeenCalledTimes(1)
  })

  it('finds the record by PaymentIntent when refund metadata is missing', async () => {
    const result = await deps.service.handleRefundUpdated(refund({ metadata: {} }))
    expect(result.record.state).toBe(FRAUD_STATES.REVIEW_DECLINED_REFUNDED)
  })

  it('flags a failed refund and retries with a fresh idempotency attempt', async () => {
    const failed = await deps.service.handleRefundUpdated(refund({ status: 'failed', failure_reason: 'expired_or_canceled_card' }))
    expect(failed.record.state).toBe(FRAUD_STATES.PAYMENT_ACTION_FAILED)
    expect(failed.record.error).toMatch(/expired_or_canceled_card/)
    expect(deps.kount.updateOrder).toHaveBeenCalledWith('K1', { transactions: [{ transactionId: 'K1#0', transactionStatus: 'REFUND_FAILED' }] })
    await expect(deps.service.getFulfillmentStatus('cs_test_1')).resolves.toMatchObject({ fulfillable: false })

    deps.stripe.refundPaymentIntent.mockResolvedValueOnce({ id: 're_2', status: 'succeeded', amount: 1000 })
    const retried = await deps.service.handleKountDecision({ kountOrderId: 'K1', decision: 'DECLINE' })
    expect(retried.record.state).toBe(FRAUD_STATES.REVIEW_DECLINED_REFUNDED)
    expect(deps.stripe.refundPaymentIntent).toHaveBeenCalledWith('pi_test_1', { attempt: 1, checkoutSessionId: 'cs_test_1' })
  })

  it('leaves the record alone for still-pending, unrelated, or unknown refunds', async () => {
    expect((await deps.service.handleRefundUpdated(refund({ status: 'pending' }))).record.state).toBe(FRAUD_STATES.REVIEW_DECLINED_REFUND_PENDING)
    expect((await deps.service.handleRefundUpdated(refund({ id: 're_other' }))).reason).toBe('other_refund')
    expect((await deps.service.handleRefundUpdated(refund({ metadata: {}, payment_intent: 'pi_unknown' }))).reason).toBe('unknown_order')
  })

  it('asks for a retry when the event arrives before the refund id is saved', async () => {
    const record = JSON.parse(await deps.kv.get(`${KOUNT_KV_PREFIX}cs_test_1`))
    await deps.kv.put(`${KOUNT_KV_PREFIX}cs_test_1`, JSON.stringify({ ...record, refundId: undefined }))
    expect((await deps.service.handleRefundUpdated(refund())).status).toBe('in_progress')
  })
})

describe('FraudReviewService.getFulfillmentStatus', () => {
  it('allows orders with no fraud record and blocks held or declined ones', async () => {
    const { service, kv } = makeDeps()
    await expect(service.getFulfillmentStatus('cs_none')).resolves.toEqual({ fulfillable: true, state: null })
    for (const state of [FRAUD_STATES.EVALUATING, FRAUD_STATES.EVALUATION_FAILED_HOLD, FRAUD_STATES.DECLINED_CANCELED, FRAUD_STATES.PAYMENT_ACTION_FAILED]) {
      await kv.put(`${KOUNT_KV_PREFIX}cs_x`, JSON.stringify({ checkoutSessionId: 'cs_x', state }))
      await expect(service.getFulfillmentStatus('cs_x')).resolves.toMatchObject({ fulfillable: false })
    }
    await kv.put(`${KOUNT_KV_PREFIX}cs_x`, JSON.stringify({ checkoutSessionId: 'cs_x', state: FRAUD_STATES.APPROVED_CAPTURED }))
    await expect(service.getFulfillmentStatus('cs_x')).resolves.toMatchObject({ fulfillable: true })
  })
})

describe('FraudReviewService.getCustomerOrderStatus', () => {
  it('maps fraud states to what the buyer is told', () => {
    expect(customerOrderStatus(undefined)).toBe('processing')
    expect(customerOrderStatus(FRAUD_STATES.EVALUATING)).toBe('processing')
    expect(customerOrderStatus(FRAUD_STATES.EVALUATION_FAILED_HOLD)).toBe('processing')
    expect(customerOrderStatus(FRAUD_STATES.PAYMENT_ACTION_FAILED)).toBe('processing')
    expect(customerOrderStatus(FRAUD_STATES.APPROVED_CAPTURED)).toBe('confirmed')
    expect(customerOrderStatus(FRAUD_STATES.REVIEW_CAPTURED)).toBe('confirmed')
    expect(customerOrderStatus(FRAUD_STATES.REVIEW_APPROVED)).toBe('confirmed')
    expect(customerOrderStatus(FRAUD_STATES.DECLINED_CANCELED)).toBe('declined')
    expect(customerOrderStatus(FRAUD_STATES.REVIEW_DECLINED_REFUNDED)).toBe('declined')
    expect(customerOrderStatus(FRAUD_STATES.REVIEW_DECLINED_REFUND_PENDING)).toBe('declined')
  })

  it('treats orders that were not held as confirmed and reads held ones from KV', async () => {
    const kv = createMockKV()
    const service = new FraudReviewService({ kv })
    expect(await service.getCustomerOrderStatus('cs_x', { held: false })).toBe('confirmed')
    expect(await service.getCustomerOrderStatus('cs_x', { held: true })).toBe('processing')
    await kv.put(`${KOUNT_KV_PREFIX}cs_x`, JSON.stringify({ state: FRAUD_STATES.DECLINED_CANCELED }))
    expect(await service.getCustomerOrderStatus('cs_x', { held: true })).toBe('declined')
  })
})
