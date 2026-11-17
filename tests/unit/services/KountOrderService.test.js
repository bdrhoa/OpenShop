import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockKV } from '../../setup.js'
import {
  KountOrderService,
  RetryLaterError,
  buyerStatus,
  orderKey,
} from '../../../src/services/KountOrderService.js'
import { KountApiError } from '../../../src/services/KountService.js'

const SESSION_ID = 'cs_test_kount'

function heldSession() {
  return { id: SESSION_ID, metadata: { kount_hold: 'true', kount_session_id: 'abc' } }
}

function fakeStripe({ piStatus = 'requires_capture' } = {}) {
  const pi = { id: 'pi_1', status: piStatus, metadata: { kount_hold: 'true' }, latest_charge: { id: 'ch_1', payment_method_details: { card: { last4: '4242', checks: {} } } } }
  return {
    pi,
    checkout: {
      sessions: {
        retrieve: vi.fn(async () => ({
          id: SESSION_ID,
          amount_total: 1000,
          amount_subtotal: 1000,
          currency: 'usd',
          metadata: heldSession().metadata,
          line_items: { data: [{ quantity: 1, price: { unit_amount: 1000, product: { id: 'prod_1', name: 'Mug' } } }] },
          payment_intent: pi,
        })),
        list: vi.fn(async () => ({ data: [{ id: SESSION_ID }] })),
      },
    },
    paymentIntents: {
      retrieve: vi.fn(async () => pi),
      capture: vi.fn(async () => { pi.status = 'succeeded'; return pi }),
      cancel: vi.fn(async () => { pi.status = 'canceled'; return pi }),
    },
    charges: { retrieve: vi.fn() },
  }
}

function fakeKount(decision = 'APPROVE') {
  return {
    postOrder: vi.fn(async () => ({ orderId: 'K1', decision, omniscore: 80, deviceId: 'd1', transactionId: 'K1#0', correlationId: 'c1' })),
    updateOrder: vi.fn(async () => ({})),
  }
}

describe('KountOrderService', () => {
  let kv, stripe, kount, svc, now
  beforeEach(() => {
    kv = createMockKV()
    stripe = fakeStripe()
    kount = fakeKount()
    now = Date.parse('2026-11-17T12:00:00Z')
    svc = new KountOrderService({ kv, stripe, kount, now: () => now })
  })

  it('skips checkouts that were not held for screening', async () => {
    expect(await svc.handleCheckoutCompleted({ id: SESSION_ID, metadata: {} })).toEqual({ skipped: 'not_held' })
    expect(kount.postOrder).not.toHaveBeenCalled()
  })

  it('APPROVE: evaluates, captures, reports CAPTURED, allows fulfillment', async () => {
    const { record } = await svc.handleCheckoutCompleted(heldSession())
    expect(kount.postOrder).toHaveBeenCalledWith(expect.objectContaining({ merchantOrderId: SESSION_ID, deviceSessionId: 'abc' }), { riskInquiry: true })
    expect(stripe.paymentIntents.capture).toHaveBeenCalledWith('pi_1', {}, { idempotencyKey: `kount-capture-${SESSION_ID}` })
    expect(kount.updateOrder).toHaveBeenCalledWith('K1', { merchantOrderId: SESSION_ID, transactions: [{ transactionId: 'K1#0', transactionStatus: 'CAPTURED' }] })
    expect(record).toMatchObject({ status: 'approved', payment: 'captured', fulfillmentAllowed: true, kountStatusReported: 'CAPTURED', pendingKountStatus: null })
    expect(buyerStatus(record)).toBe('confirmed')
  })

  it('DECLINE: cancels the authorization without a fraud reason and reports CANCELED', async () => {
    svc.kount = fakeKount('DECLINE')
    const { record } = await svc.handleCheckoutCompleted(heldSession())
    expect(stripe.paymentIntents.cancel).toHaveBeenCalledWith('pi_1', {}, { idempotencyKey: `kount-cancel-${SESSION_ID}` })
    expect(stripe.paymentIntents.capture).not.toHaveBeenCalled()
    expect(svc.kount.updateOrder).toHaveBeenCalledWith('K1', expect.objectContaining({ transactions: [expect.objectContaining({ transactionStatus: 'CANCELED' })] }))
    expect(record).toMatchObject({ status: 'declined', payment: 'canceled', fulfillmentAllowed: false })
    expect(buyerStatus(record)).toBe('declined')
  })

  it('REVIEW: keeps the authorization held and blocks fulfillment', async () => {
    svc.kount = fakeKount('REVIEW')
    const { record } = await svc.handleCheckoutCompleted(heldSession())
    expect(stripe.paymentIntents.capture).not.toHaveBeenCalled()
    expect(stripe.paymentIntents.cancel).not.toHaveBeenCalled()
    expect(record).toMatchObject({ status: 'review', payment: 'authorized', fulfillmentAllowed: false })
    expect(buyerStatus(record)).toBe('received')
  })

  it('duplicate webhook delivery does not re-evaluate', async () => {
    await svc.handleCheckoutCompleted(heldSession())
    await svc.handleCheckoutCompleted(heldSession())
    expect(kount.postOrder).toHaveBeenCalledTimes(1)
    expect(stripe.paymentIntents.capture).toHaveBeenCalledTimes(1)
  })

  it('concurrent delivery while evaluating is told to retry later', async () => {
    await kv.put(orderKey(SESSION_ID), JSON.stringify({ checkoutSessionId: SESSION_ID, status: 'evaluating', lockedAt: new Date(now - 5000).toISOString() }))
    await expect(svc.handleCheckoutCompleted(heldSession())).rejects.toBeInstanceOf(RetryLaterError)
    expect(kount.postOrder).not.toHaveBeenCalled()
  })

  it('a stale evaluating lock is evaluated again', async () => {
    await kv.put(orderKey(SESSION_ID), JSON.stringify({ checkoutSessionId: SESSION_ID, status: 'evaluating', lockedAt: new Date(now - 10 * 60000).toISOString() }))
    const { record } = await svc.handleCheckoutCompleted(heldSession())
    expect(kount.postOrder).toHaveBeenCalledTimes(1)
    expect(record).toMatchObject({ status: 'approved', decisionSource: 'kount' })
  })

  describe('fallback when the risk inquiry fails after all retries', () => {
    const unavailable = () => Object.assign(
      new KountApiError('503', { operation: 'evaluate_order', status: 503, phase: 'response_received', retryable: true }),
      { attempts: 3 },
    )

    it('defaults to APPROVE: captures and allows fulfillment', async () => {
      kount.postOrder.mockRejectedValueOnce(unavailable())
      const { record } = await svc.handleCheckoutCompleted(heldSession())
      expect(record).toMatchObject({
        status: 'approved', decision: 'APPROVE', decisionSource: 'fallback', fallbackReason: 'kount_unavailable',
        payment: 'captured', fulfillmentAllowed: true, kountOrderId: null,
      })
      expect(record.error).toMatchObject({ status: 503, attempts: 3 })
      expect(stripe.paymentIntents.capture).toHaveBeenCalledTimes(1)
      expect(kount.updateOrder).not.toHaveBeenCalled() // no Kount order to update
      expect(buyerStatus(record)).toBe('confirmed')
    })

    it('DECLINE fallback releases the authorization', async () => {
      svc = new KountOrderService({ kv, stripe, kount, fallbackDecision: 'DECLINE', now: () => now })
      kount.postOrder.mockRejectedValueOnce(new KountApiError('timeout', { operation: 'evaluate_order', phase: 'awaiting_response', retryable: true }))
      const { record } = await svc.handleCheckoutCompleted(heldSession())
      expect(record).toMatchObject({ status: 'declined', decisionSource: 'fallback', fallbackReason: 'kount_unavailable', payment: 'canceled' })
      expect(stripe.paymentIntents.cancel).toHaveBeenCalledTimes(1)
      expect(stripe.paymentIntents.capture).not.toHaveBeenCalled()
    })

    it('a rejected request also falls back, with its own reason', async () => {
      kount.postOrder.mockRejectedValueOnce(new KountApiError('400', { operation: 'evaluate_order', status: 400, phase: 'response_received', retryable: false }))
      const { record } = await svc.handleCheckoutCompleted(heldSession())
      expect(record).toMatchObject({ status: 'approved', fallbackReason: 'kount_request_rejected' })
    })

    it('a response without a decision falls back and still reports the outcome to Kount', async () => {
      kount.postOrder.mockResolvedValueOnce({ orderId: 'K1', transactionId: 'K1#0', decision: null })
      const { record } = await svc.handleCheckoutCompleted(heldSession())
      expect(record).toMatchObject({ status: 'approved', decisionSource: 'fallback', fallbackReason: 'kount_no_decision', kountStatusReported: 'CAPTURED' })
      expect(kount.updateOrder).toHaveBeenCalledWith('K1', expect.objectContaining({ transactions: [expect.objectContaining({ transactionStatus: 'CAPTURED' })] }))
    })

    it('a duplicate delivery after the fallback does not evaluate again', async () => {
      kount.postOrder.mockRejectedValueOnce(unavailable())
      await svc.handleCheckoutCompleted(heldSession())
      await svc.handleCheckoutCompleted(heldSession())
      expect(kount.postOrder).toHaveBeenCalledTimes(1)
      expect(stripe.paymentIntents.capture).toHaveBeenCalledTimes(1)
    })
  })

  it('a failed Kount status update is retried on the next delivery without recapturing', async () => {
    kount.updateOrder.mockRejectedValueOnce(new KountApiError('x', { operation: 'update_order', phase: 'awaiting_response', retryable: false }))
    await expect(svc.handleCheckoutCompleted(heldSession())).rejects.toBeInstanceOf(RetryLaterError)
    const pending = await svc.get(SESSION_ID)
    expect(pending).toMatchObject({ status: 'approved', payment: 'captured', pendingKountStatus: 'CAPTURED' })

    const { record } = await svc.handleCheckoutCompleted(heldSession())
    expect(record.pendingKountStatus).toBeNull()
    expect(kount.updateOrder).toHaveBeenCalledTimes(2)
    expect(stripe.paymentIntents.capture).toHaveBeenCalledTimes(1)
  })

  describe('review resolution', () => {
    beforeEach(async () => {
      svc.kount = kount = fakeKount('REVIEW')
      await svc.handleCheckoutCompleted(heldSession())
    })

    it('reviewer APPROVE captures and reports', async () => {
      const { record } = await svc.resolve(SESSION_ID, 'APPROVE', 'kount_webhook', { kountOrderId: 'K1' })
      expect(record).toMatchObject({ status: 'approved', decisionSource: 'kount_webhook', fulfillmentAllowed: true })
      expect(stripe.paymentIntents.capture).toHaveBeenCalledTimes(1)
      expect(kount.updateOrder).toHaveBeenCalledWith('K1', expect.objectContaining({ transactions: [expect.objectContaining({ transactionStatus: 'CAPTURED' })] }))
    })

    it('reviewer DECLINE releases the authorization', async () => {
      const { record } = await svc.resolve(SESSION_ID, 'DECLINE', 'admin')
      expect(record).toMatchObject({ status: 'declined', payment: 'canceled' })
    })

    it('duplicate and conflicting deliveries do not regress state', async () => {
      await svc.resolve(SESSION_ID, 'APPROVE', 'kount_webhook')
      const dup = await svc.resolve(SESSION_ID, 'APPROVE', 'kount_webhook')
      expect(dup.duplicate).toBe(true)
      const late = await svc.resolve(SESSION_ID, 'DECLINE', 'kount_webhook')
      expect(late.ignored).toBe('status_approved')
      expect(late.record.status).toBe('approved')
      expect(stripe.paymentIntents.cancel).not.toHaveBeenCalled()
      expect(stripe.paymentIntents.capture).toHaveBeenCalledTimes(1)
    })

    it('rejects a Kount order ID that does not match', async () => {
      await expect(svc.resolve(SESSION_ID, 'APPROVE', 'kount_webhook', { kountOrderId: 'OTHER' })).rejects.toThrow(/does not match/)
    })

    it('approval after the authorization expired is parked, not captured', async () => {
      stripe.pi.status = 'canceled'
      const { record } = await svc.resolve(SESSION_ID, 'APPROVE', 'admin')
      expect(record).toMatchObject({ status: 'error', reason: 'capture_impossible:canceled', fulfillmentAllowed: false })
      expect(stripe.paymentIntents.capture).not.toHaveBeenCalled()
    })

    it('Stripe expiring the held authorization reports EXPIRED', async () => {
      const { record } = await svc.handlePaymentIntentCanceled({ id: 'pi_1', metadata: { kount_hold: 'true' }, cancellation_reason: 'automatic' })
      expect(record).toMatchObject({ status: 'error', reason: 'authorization_expired', payment: 'canceled', kountStatusReported: 'EXPIRED' })
    })
  })

  describe('failed authorization attempts', () => {
    const failedPi = { id: 'pi_1', metadata: { kount_hold: 'true' }, latest_charge: { id: 'ch_bad', amount: 1000, outcome: { type: 'issuer_declined', reason: 'generic_decline' }, failure_code: 'card_declined' } }

    it('reports a data-only order once per charge', async () => {
      const first = await svc.handlePaymentFailed(failedPi)
      expect(first.reported).toBe(true)
      expect(kount.postOrder).toHaveBeenCalledWith(expect.objectContaining({ merchantOrderId: `${SESSION_ID}:ch_bad` }), { riskInquiry: false })
      expect(await svc.handlePaymentFailed(failedPi)).toEqual({ skipped: 'duplicate' })
      expect(kount.postOrder).toHaveBeenCalledTimes(1)
    })
  })
})
