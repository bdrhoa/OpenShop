// KountOrderService: hosted-checkout lifecycle against a fake Stripe and a
// fake Kount client. Covers decision persistence before side effects,
// duplicate delivery, review, fulfillment gating and reporting recovery.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { KountOrderService, KOUNT_KV, REPORTING_MAX_ATTEMPTS, summarizeRecord, buyerStatusOf } from '../../../src/services/KountOrderService.js'
import { KountApiError } from '../../../src/services/KountClient.js'
import { buildKountConfig } from '../../../src/config/kount.js'
import { createMockKV } from '../../setup.js'
import { SESSION, CHARGE, LINE_ITEMS } from './fixtures.js'

function fakeStripe({ status = 'requires_capture' } = {}) {
  const pi = { id: 'pi_test_1', status, amount: 3000, currency: 'usd', latest_charge: CHARGE, metadata: SESSION.metadata }
  const stripe = {
    pi,
    paymentIntents: {
      retrieve: vi.fn(async () => ({ ...pi })),
      capture: vi.fn(async () => { pi.status = 'succeeded'; return { ...pi } }),
      cancel: vi.fn(async () => { pi.status = 'canceled'; pi.cancellation_reason = null; return { ...pi } }),
    },
    checkout: { sessions: { listLineItems: vi.fn(async () => ({ data: LINE_ITEMS })) } },
    charges: { retrieve: vi.fn(async (id) => ({ id, outcome: { type: 'issuer_declined', network_decline_code: '05' } })) },
    shippingRates: { retrieve: vi.fn(async (id) => ({ id, metadata: { kount_shipping_method: 'EXPRESS' } })) },
  }
  return stripe
}

function fakeClient(evaluation) {
  return {
    evaluateWithFallback: vi.fn(async () => ({ evaluatedAt: 'now', attempts: 1, ...evaluation })),
    updateOrder: vi.fn(async () => ({ status: 200, body: {}, correlationId: 'c-up', attempts: 1 })),
    sendDataOnlyOrder: vi.fn(async () => ({ status: 200, body: { order: { orderId: 'KD1' } }, attempts: 1 })),
  }
}

const config = buildKountConfig({ KOUNT_CLIENT_ID: 'c', KOUNT_API_KEY: 'k', STRIPE_WEBHOOK_SECRET: 'whsec_x', KOUNT_CHANNEL: 'WEB' })
const KOUNT_APPROVE = { decision: 'APPROVE', decisionSource: 'kount', kountOrderId: 'K1', kountTransactionId: 'K1#0' }
const KOUNT_DECLINE = { decision: 'DECLINE', decisionSource: 'kount', kountOrderId: 'K1', kountTransactionId: 'K1#0' }
const KOUNT_REVIEW = { decision: 'REVIEW', decisionSource: 'kount', kountOrderId: 'K1', kountTransactionId: 'K1#0' }

let kv
beforeEach(() => {
  kv = createMockKV()
})

function service(stripe, client) {
  return new KountOrderService({ kv, stripe, config, client })
}

describe('checkout.session.completed', () => {
  it('ignores checkouts that were not held', async () => {
    const stripe = fakeStripe()
    const client = fakeClient(KOUNT_APPROVE)
    const result = await service(stripe, client).handleCheckoutCompleted({ ...SESSION, metadata: {} })
    expect(result.skipped).toBe('not_held')
    expect(client.evaluateWithFallback).not.toHaveBeenCalled()
  })

  it('sends device session, IP and channel saved at checkout', async () => {
    const stripe = fakeStripe()
    const client = fakeClient(KOUNT_APPROVE)
    const svc = service(stripe, client)
    await svc.saveCheckoutContext('order-1', { deviceSessionId: 'd'.repeat(32), userIp: '192.0.2.7' })
    await svc.handleCheckoutCompleted(SESSION)
    const payload = client.evaluateWithFallback.mock.calls[0][0]
    expect(payload).toEqual(expect.objectContaining({ merchantOrderId: 'order-1', deviceSessionId: 'd'.repeat(32), userIp: '192.0.2.7', channel: 'WEB' }))
  })

  it('sends the configured shipping method, or the chosen Stripe shipping rate', async () => {
    const stripe = fakeStripe()
    const client = fakeClient(KOUNT_APPROVE)
    const withMethod = buildKountConfig({ KOUNT_CLIENT_ID: 'c', KOUNT_API_KEY: 'k', KOUNT_SHIPPING_METHOD: 'STANDARD' })
    await new KountOrderService({ kv, stripe, config: withMethod, client }).handleCheckoutCompleted(SESSION)
    expect(client.evaluateWithFallback.mock.calls[0][0].fulfillment[0].shipping.method).toBe('STANDARD')
    expect(stripe.shippingRates.retrieve).not.toHaveBeenCalled()

    kv = createMockKV()
    const client2 = fakeClient(KOUNT_APPROVE)
    await new KountOrderService({ kv, stripe: fakeStripe(), config: withMethod, client: client2 })
      .handleCheckoutCompleted({ ...SESSION, shipping_cost: { shipping_rate: 'shr_express' } })
    expect(client2.evaluateWithFallback.mock.calls[0][0].fulfillment[0].shipping.method).toBe('EXPRESS')
  })

  it('APPROVE → captures, allows fulfillment and reports CAPTURED', async () => {
    const stripe = fakeStripe()
    const client = fakeClient(KOUNT_APPROVE)
    const svc = service(stripe, client)
    const { record } = await svc.handleCheckoutCompleted(SESSION)

    expect(stripe.paymentIntents.capture).toHaveBeenCalledWith('pi_test_1', {}, { idempotencyKey: 'kount-capture-pi_test_1' })
    const stored = await svc.getRecord(SESSION.id)
    expect(stored.payment.state).toBe('captured')
    expect(stored.fulfillmentAllowed).toBe(true)
    expect(client.updateOrder).toHaveBeenCalledWith('K1', { merchantOrderId: 'order-1', transactions: [{ transactionId: 'K1#0', transactionStatus: 'CAPTURED' }] })
    expect(stored.reporting[0]).toEqual(expect.objectContaining({ transactionStatus: 'CAPTURED', state: 'confirmed' }))
    expect(buyerStatusOf(stored)).toBe('confirmed')
    expect(record.evaluation.decisionSource).toBe('kount')
  })

  it('DECLINE → cancels the authorization and blocks fulfillment', async () => {
    const stripe = fakeStripe()
    const client = fakeClient(KOUNT_DECLINE)
    const svc = service(stripe, client)
    await svc.handleCheckoutCompleted(SESSION)
    expect(stripe.paymentIntents.cancel).toHaveBeenCalled()
    expect(stripe.paymentIntents.capture).not.toHaveBeenCalled()
    const stored = await svc.getRecord(SESSION.id)
    expect(stored.payment.state).toBe('canceled')
    expect(stored.fulfillmentAllowed).toBe(false)
    expect(client.updateOrder.mock.calls[0][1].transactions[0].transactionStatus).toBe('CANCELED')
    expect(buyerStatusOf(stored)).toBe('declined')
  })

  it('REVIEW → keeps the authorization, blocks fulfillment, no capture', async () => {
    const stripe = fakeStripe()
    const client = fakeClient(KOUNT_REVIEW)
    const svc = service(stripe, client)
    await svc.handleCheckoutCompleted(SESSION)
    expect(stripe.paymentIntents.capture).not.toHaveBeenCalled()
    expect(stripe.paymentIntents.cancel).not.toHaveBeenCalled()
    const gate = await svc.isFulfillmentAllowed(SESSION.id)
    expect(gate.allowed).toBe(false)
    expect(gate.record.review.status).toBe('open')
    expect(buyerStatusOf(gate.record)).toBe('received')
  })

  it('persists fallback provenance and never labels it a Kount decision', async () => {
    const stripe = fakeStripe()
    const client = fakeClient({ decision: 'APPROVE', decisionSource: 'fallback', fallbackReason: 'transient_http', attempts: 3, correlationId: 'c-9' })
    const svc = service(stripe, client)
    await svc.handleCheckoutCompleted(SESSION)
    const summary = summarizeRecord(await svc.getRecord(SESSION.id))
    expect(summary).toEqual(expect.objectContaining({ decision: 'APPROVE', decisionSource: 'fallback', fallbackReason: 'transient_http', attempts: 3, correlationId: 'c-9' }))
    // No Kount order exists, so the CAPTURED update is rejected, not faked.
    expect(summary.reporting[0]).toEqual(expect.objectContaining({ state: 'rejected', lastError: 'no_kount_order_id' }))
    expect(client.updateOrder).not.toHaveBeenCalled()
  })

  it('persists the decision before the payment side effect; redelivery resumes without re-evaluating', async () => {
    const stripe = fakeStripe()
    stripe.paymentIntents.capture.mockRejectedValueOnce(new Error('stripe down'))
    const client = fakeClient(KOUNT_APPROVE)
    const svc = service(stripe, client)

    await expect(svc.handleCheckoutCompleted(SESSION)).rejects.toThrow('stripe down')
    const afterFailure = await svc.getRecord(SESSION.id)
    expect(afterFailure.evaluation.decision).toBe('APPROVE')
    expect(afterFailure.payment.state).toBe('authorized')

    // Stripe redelivers the same event.
    client.evaluateWithFallback.mockResolvedValue({ decision: 'DECLINE', decisionSource: 'kount' })
    await svc.handleCheckoutCompleted(SESSION)
    expect(client.evaluateWithFallback).toHaveBeenCalledTimes(1)
    expect((await svc.getRecord(SESSION.id)).payment.state).toBe('captured')
  })

  it('duplicate delivery after completion repeats no payment effects or reports', async () => {
    const stripe = fakeStripe()
    const client = fakeClient(KOUNT_APPROVE)
    const svc = service(stripe, client)
    await svc.handleCheckoutCompleted(SESSION)
    await svc.handleCheckoutCompleted(SESSION)
    expect(client.evaluateWithFallback).toHaveBeenCalledTimes(1)
    expect(stripe.paymentIntents.capture).toHaveBeenCalledTimes(1)
    expect(client.updateOrder).toHaveBeenCalledTimes(1)
    expect((await svc.getRecord(SESSION.id)).reporting).toHaveLength(1)
  })

  it('does not evaluate when the authorization is already gone', async () => {
    const stripe = fakeStripe({ status: 'canceled' })
    const client = fakeClient(KOUNT_APPROVE)
    const result = await service(stripe, client).handleCheckoutCompleted(SESSION)
    expect(result.skipped).toBe('payment_canceled')
    expect(client.evaluateWithFallback).not.toHaveBeenCalled()
  })
})

describe('manual review', () => {
  async function reviewOrder() {
    const stripe = fakeStripe()
    const client = fakeClient(KOUNT_REVIEW)
    const svc = service(stripe, client)
    await svc.handleCheckoutCompleted(SESSION)
    return { stripe, client, svc }
  }

  it('reviewer APPROVE captures, reports CAPTURED with the decision, allows fulfillment', async () => {
    const { stripe, client, svc } = await reviewOrder()
    const { record } = await svc.resolveReview(SESSION.id, 'APPROVE')
    expect(stripe.paymentIntents.capture).toHaveBeenCalledTimes(1)
    expect(record.review.status).toBe('approved')
    expect((await svc.getRecord(SESSION.id)).fulfillmentAllowed).toBe(true)
    expect(client.updateOrder).toHaveBeenCalledWith('K1', expect.objectContaining({ riskInquiry: { decision: 'APPROVE' }, transactions: [{ transactionId: 'K1#0', transactionStatus: 'CAPTURED' }] }))
  })

  it('reviewer DECLINE releases the authorization and keeps fulfillment blocked', async () => {
    const { stripe, client, svc } = await reviewOrder()
    await svc.resolveReview(SESSION.id, 'DECLINE')
    expect(stripe.paymentIntents.cancel).toHaveBeenCalledTimes(1)
    const stored = await svc.getRecord(SESSION.id)
    expect(stored.fulfillmentAllowed).toBe(false)
    expect(stored.payment.state).toBe('canceled')
    expect(client.updateOrder).toHaveBeenCalledWith('K1', expect.objectContaining({ riskInquiry: { decision: 'DECLINE' } }))
  })

  it('a repeated click is idempotent; a conflicting one is refused', async () => {
    const { stripe, svc } = await reviewOrder()
    await svc.resolveReview(SESSION.id, 'APPROVE')
    expect((await svc.resolveReview(SESSION.id, 'APPROVE')).error).toBeUndefined()
    expect((await svc.resolveReview(SESSION.id, 'DECLINE')).error).toBe('already_resolved')
    expect(stripe.paymentIntents.capture).toHaveBeenCalledTimes(1)
  })

  it('an expired authorization cannot be approved and is reported EXPIRED', async () => {
    const { stripe, client, svc } = await reviewOrder()
    stripe.paymentIntents.retrieve.mockResolvedValueOnce({ id: 'pi_test_1', status: 'canceled', cancellation_reason: 'automatic' })
    const result = await svc.resolveReview(SESSION.id, 'APPROVE')
    expect(result.error).toBe('authorization_gone')
    expect(stripe.paymentIntents.capture).not.toHaveBeenCalled()
    const stored = await svc.getRecord(SESSION.id)
    expect(stored.payment.state).toBe('expired')
    expect(client.updateOrder.mock.calls.at(-1)[1].transactions[0].transactionStatus).toBe('EXPIRED')
  })

  it('refuses review actions on orders that are not in review', async () => {
    const stripe = fakeStripe()
    const svc = service(stripe, fakeClient(KOUNT_APPROVE))
    await svc.handleCheckoutCompleted(SESSION)
    expect((await svc.resolveReview(SESSION.id, 'APPROVE')).error).toBe('not_in_review')
  })
})

describe('payment_intent.canceled', () => {
  it('records an expired authorization for a held order once', async () => {
    const stripe = fakeStripe()
    const client = fakeClient(KOUNT_REVIEW)
    const svc = service(stripe, client)
    await svc.handleCheckoutCompleted(SESSION)
    await svc.handlePaymentIntentCanceled({ id: 'pi_test_1', status: 'canceled', cancellation_reason: 'automatic' })
    await svc.handlePaymentIntentCanceled({ id: 'pi_test_1', status: 'canceled', cancellation_reason: 'automatic' })
    const stored = await svc.getRecord(SESSION.id)
    expect(stored.payment.state).toBe('expired')
    expect(stored.review.status).toBe('expired')
    expect(client.updateOrder).toHaveBeenCalledTimes(1)
  })
})

describe('failed authorization attempts (data-only)', () => {
  const failedPi = { id: 'pi_f', amount: 1000, currency: 'usd', metadata: { kount_hold: 'true', openshop_order_id: 'order-9' }, last_payment_error: { charge: 'ch_f1' } }

  it('reports a refused attempt once, even when the event is redelivered', async () => {
    const stripe = fakeStripe()
    const client = fakeClient(KOUNT_APPROVE)
    const svc = service(stripe, client)
    await svc.handlePaymentFailed(failedPi)
    await svc.handlePaymentFailed(failedPi)
    expect(client.sendDataOnlyOrder).toHaveBeenCalledTimes(1)
    const payload = client.sendDataOnlyOrder.mock.calls[0][0]
    expect(payload.merchantOrderId).toBe('order-9')
    expect(payload.transactions[0]).toEqual(expect.objectContaining({ transactionStatus: 'REFUSED', authorizationStatus: expect.objectContaining({ authResult: 'DECLINED', declineCode: '05' }) }))
  })

  it('ignores attempts on checkouts that were not held', async () => {
    const client = fakeClient(KOUNT_APPROVE)
    expect((await service(fakeStripe(), client).handlePaymentFailed({ ...failedPi, metadata: {} })).skipped).toBe('not_held')
    expect(client.sendDataOnlyOrder).not.toHaveBeenCalled()
  })

  it('a redelivery resumes an unconfirmed report instead of dropping it', async () => {
    const client = fakeClient(KOUNT_APPROVE)
    client.sendDataOnlyOrder.mockRejectedValueOnce(new KountApiError('down', { kind: 'transient_http', status: 503, retryable: true }))
    const svc = service(fakeStripe(), client)
    const first = await svc.handlePaymentFailed(failedPi)
    expect(first.job.state).toBe('pending')
    const second = await svc.handlePaymentFailed(failedPi)
    expect(second.skipped).toBe('duplicate')
    expect(client.sendDataOnlyOrder).toHaveBeenCalledTimes(2)
    expect((await svc.getJob(first.job.id)).state).toBe('confirmed')
  })
})

describe('reporting recovery', () => {
  it('keeps a failed update pending and the cron run confirms it later', async () => {
    let clock = 1000000
    const stripe = fakeStripe()
    const client = fakeClient(KOUNT_APPROVE)
    client.updateOrder.mockRejectedValueOnce(new KountApiError('down', { kind: 'transient_http', status: 503, retryable: true }))
    const svc = new KountOrderService({ kv, stripe, config, client, now: () => clock })

    await svc.handleCheckoutCompleted(SESSION)
    let stored = await svc.getRecord(SESSION.id)
    expect(stored.payment.state).toBe('captured') // payment effect is independent of reporting
    expect(stored.reporting[0].state).toBe('pending')
    expect((await kv.list({ prefix: KOUNT_KV.QUEUE_PREFIX })).keys).toHaveLength(1)

    expect((await svc.processDueJobs()).processed).toBe(0) // not due yet
    clock += 10 * 60000
    expect((await svc.processDueJobs()).processed).toBe(1)
    stored = await svc.getRecord(SESSION.id)
    expect(stored.reporting[0].state).toBe('confirmed')
    expect((await kv.list({ prefix: KOUNT_KV.QUEUE_PREFIX })).keys).toHaveLength(0)
    expect(stripe.paymentIntents.capture).toHaveBeenCalledTimes(1)
  })

  it('marks a timed-out POST as unknown with duplicate risk', async () => {
    const client = fakeClient(KOUNT_APPROVE)
    client.sendDataOnlyOrder.mockRejectedValueOnce(new KountApiError('timeout', { kind: 'timeout', retryable: true, outcomeUnknown: true }))
    const svc = service(fakeStripe(), client)
    const { job } = await svc.handlePaymentFailed({ id: 'pi_t', amount: 1, currency: 'usd', metadata: { kount_hold: 'true' }, last_payment_error: { charge: 'ch_t' } })
    expect(job.state).toBe('unknown')
    expect(job.possibleDuplicate).toBe(true)
  })

  it('a permanent rejection stops retrying until requeued', async () => {
    const stripe = fakeStripe()
    const client = fakeClient(KOUNT_APPROVE)
    client.updateOrder.mockRejectedValueOnce(new KountApiError('bad', { kind: 'rejected', status: 400, retryable: false }))
    const svc = service(stripe, client)
    await svc.handleCheckoutCompleted(SESSION)
    const jobId = (await svc.getRecord(SESSION.id)).reporting[0].jobId
    expect((await svc.getJob(jobId)).state).toBe('rejected')
    expect((await svc.processDueJobs()).processed).toBe(0)
    expect((await svc.requeueJob(jobId)).state).toBe('confirmed')
  })

  it('escalates after the attempt limit', async () => {
    let clock = 0
    const client = fakeClient(KOUNT_APPROVE)
    client.sendDataOnlyOrder.mockRejectedValue(new KountApiError('down', { kind: 'transient_http', status: 503, retryable: true }))
    const svc = new KountOrderService({ kv, stripe: fakeStripe(), config, client, now: () => clock })
    const { job } = await svc.handlePaymentFailed({ id: 'pi_e', amount: 1, currency: 'usd', metadata: { kount_hold: 'true' }, last_payment_error: { charge: 'ch_e' } })
    for (let i = 1; i < REPORTING_MAX_ATTEMPTS; i += 1) {
      clock += 24 * 3600000
      await svc.processDueJobs()
    }
    expect((await svc.getJob(job.id)).state).toBe('escalated')
    expect(client.sendDataOnlyOrder).toHaveBeenCalledTimes(REPORTING_MAX_ATTEMPTS)
  })
})

describe('Kount portal decisions (webhook events)', () => {
  async function reviewOrder() {
    const stripe = fakeStripe()
    const client = fakeClient(KOUNT_REVIEW)
    const svc = service(stripe, client)
    await svc.handleCheckoutCompleted(SESSION)
    return { stripe, client, svc }
  }
  const event = (decision, extra = {}) => ({ eventId: `evt-${decision}`, eventType: 'Order.StatusChange', kountOrderId: 'K1', merchantOrderId: 'order-1', decision, ...extra })

  it('a portal DECLINE releases the authorization and is not echoed back to Kount', async () => {
    const { stripe, client, svc } = await reviewOrder()
    const result = await svc.handleKountWebhookEvent(event('DECLINE'))
    expect(result.outcome).toBe('declined')
    expect(stripe.paymentIntents.cancel).toHaveBeenCalledTimes(1)
    const stored = await svc.getRecord(SESSION.id)
    expect(stored.review).toEqual(expect.objectContaining({ status: 'declined', decidedBy: 'kount', reportDecision: false }))
    expect(stored.fulfillmentAllowed).toBe(false)
    // Status is still reported; the decision itself is not sent back.
    expect(client.updateOrder).toHaveBeenCalledWith('K1', { merchantOrderId: 'order-1', transactions: [{ transactionId: 'K1#0', transactionStatus: 'CANCELED' }] })
  })

  it('a portal APPROVE captures and allows fulfillment', async () => {
    const { stripe, svc } = await reviewOrder()
    expect((await svc.handleKountWebhookEvent(event('APPROVE'))).outcome).toBe('approved')
    expect(stripe.paymentIntents.capture).toHaveBeenCalledTimes(1)
    expect((await svc.isFulfillmentAllowed(SESSION.id)).allowed).toBe(true)
  })

  it('finds the order by merchantOrderId when the Kount order id is unknown', async () => {
    const { svc } = await reviewOrder()
    expect((await svc.handleKountWebhookEvent(event('APPROVE', { kountOrderId: 'OTHER' }))).outcome).toBe('approved')
  })

  it('ignores duplicates, non-decision events, unknown orders and orders not in review', async () => {
    const { stripe, svc } = await reviewOrder()
    await svc.handleKountWebhookEvent(event('APPROVE'))
    expect((await svc.handleKountWebhookEvent(event('APPROVE'))).outcome).toBe('duplicate')
    expect((await svc.handleKountWebhookEvent(event('DECLINE', { eventId: 'evt-late' }))).outcome).toBe('already_resolved')
    expect((await svc.handleKountWebhookEvent(event(null, { eventId: 'evt-x' }))).outcome).toBe('ignored_event')
    expect((await svc.handleKountWebhookEvent(event('APPROVE', { eventId: 'evt-y', kountOrderId: 'NOPE', merchantOrderId: 'nope' }))).outcome).toBe('unknown_order')
    expect(stripe.paymentIntents.capture).toHaveBeenCalledTimes(1)
    expect(stripe.paymentIntents.cancel).not.toHaveBeenCalled()

    kv = createMockKV()
    const approved = service(fakeStripe(), fakeClient(KOUNT_APPROVE))
    await approved.handleCheckoutCompleted(SESSION)
    expect((await approved.handleKountWebhookEvent(event('DECLINE', { eventId: 'evt-z' }))).outcome).toBe('not_in_review')
  })

  it('does not mark the event handled when the payment side effect fails, so a retry applies it', async () => {
    const { stripe, svc } = await reviewOrder()
    stripe.paymentIntents.capture.mockRejectedValueOnce(new Error('stripe down'))
    await expect(svc.handleKountWebhookEvent(event('APPROVE'))).rejects.toThrow('stripe down')
    // The reviewer decision was persisted first; the redelivery resumes it.
    expect((await svc.handleKountWebhookEvent(event('APPROVE'))).outcome).toBe('approved')
    expect((await svc.getRecord(SESSION.id)).payment.state).toBe('captured')
  })

  it('an admin approval in OpenShop still reports the reviewer decision to Kount', async () => {
    const { client, svc } = await reviewOrder()
    await svc.resolveReview(SESSION.id, 'APPROVE')
    expect(client.updateOrder.mock.calls.at(-1)[1].riskInquiry).toEqual({ decision: 'APPROVE' })
  })
})
