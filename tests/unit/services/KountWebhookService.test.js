import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { processKountOrderEvent, verifyKountWebhook } from '../../../src/services/KountWebhookService.js'

function session(paymentIntentOverrides = {}) {
  return {
    id: 'cs_test_1',
    payment_intent: {
      id: 'pi_test_1',
      capture_method: 'manual',
      status: 'succeeded',
      metadata: { kount_order_id: 'K1', kount_decision: 'REVIEW' },
      ...paymentIntentOverrides,
    },
  }
}

const statusEvent = (overrides = {}) => ({
  eventType: 'Order.StatusChange',
  fieldName: 'status',
  orderId: 'K1',
  merchantOrderId: 'cs_test_1',
  newValue: 'APPROVE',
  ...overrides,
})

describe('processKountOrderEvent', () => {
  let stripeService
  let kountService

  const process = (event) => processKountOrderEvent({ stripeService, kountService, event })

  beforeEach(() => {
    stripeService = {
      getCheckoutSessionForRiskEvaluation: vi.fn().mockResolvedValue(session()),
      updatePaymentIntentMetadata: vi.fn().mockResolvedValue({}),
      capturePaymentIntent: vi.fn().mockResolvedValue({}),
      cancelPaymentIntentAsFraudulent: vi.fn().mockResolvedValue({}),
      refundPaymentIntentAsFraudulent: vi.fn().mockResolvedValue({}),
    }
    kountService = { getOrder: vi.fn() }
  })

  function expectNoMoneyMoved() {
    expect(stripeService.capturePaymentIntent).not.toHaveBeenCalled()
    expect(stripeService.cancelPaymentIntentAsFraudulent).not.toHaveBeenCalled()
    expect(stripeService.refundPaymentIntentAsFraudulent).not.toHaveBeenCalled()
  }

  it('releases the order on APPROVE, without moving money', async () => {
    await expect(process(statusEvent())).resolves.toEqual({ decision: 'APPROVE', outcome: 'released' })

    expect(stripeService.updatePaymentIntentMetadata).toHaveBeenCalledWith('pi_test_1', { kount_decision: 'APPROVE' })
    expectNoMoneyMoved()
  })

  it.each(['DECLINE', 'DECLINED', 'decline'])('saves the decision, then refunds on %s', async (newValue) => {
    await expect(process(statusEvent({ newValue }))).resolves.toEqual({ decision: 'DECLINE', outcome: 'refunded' })

    expect(stripeService.refundPaymentIntentAsFraudulent).toHaveBeenCalledWith('pi_test_1')
    expect(stripeService.updatePaymentIntentMetadata.mock.invocationCallOrder[0])
      .toBeLessThan(stripeService.refundPaymentIntentAsFraudulent.mock.invocationCallOrder[0])
  })

  it('cancels instead of refunding when the capture has not happened yet', async () => {
    stripeService.getCheckoutSessionForRiskEvaluation.mockResolvedValue(session({ status: 'requires_capture' }))

    await expect(process(statusEvent({ newValue: 'DECLINE' }))).resolves.toEqual({ decision: 'DECLINE', outcome: 'canceled' })

    expect(stripeService.cancelPaymentIntentAsFraudulent).toHaveBeenCalledWith('pi_test_1')
    expect(stripeService.refundPaymentIntentAsFraudulent).not.toHaveBeenCalled()
  })

  it('captures on approval when the capture has not happened yet', async () => {
    stripeService.getCheckoutSessionForRiskEvaluation.mockResolvedValue(session({ status: 'requires_capture' }))

    await expect(process(statusEvent())).resolves.toEqual({ decision: 'APPROVE', outcome: 'captured' })
  })

  it('stays on hold while the order is still in review', async () => {
    await expect(process(statusEvent({ newValue: 'REVIEW' }))).resolves.toEqual({ decision: 'REVIEW', outcome: 'on_hold' })

    expect(stripeService.updatePaymentIntentMetadata).not.toHaveBeenCalled()
    expectNoMoneyMoved()
  })

  it('reads the decision from Kount when the event does not carry one', async () => {
    kountService.getOrder.mockResolvedValue({ orderId: 'K1', merchantOrderId: 'cs_test_1', decision: 'DECLINE' })

    const result = await process({ eventType: 'Order.StatusChange', kountOrderId: 'K1' })

    expect(kountService.getOrder).toHaveBeenCalledWith('K1')
    expect(result).toEqual({ decision: 'DECLINE', outcome: 'refunded' })
  })

  it('looks the order up rather than act on a decision it does not recognise', async () => {
    kountService.getOrder.mockResolvedValue({ orderId: 'K1', merchantOrderId: 'cs_test_1', decision: 'REVIEW' })

    await expect(process(statusEvent({ newValue: 'ESCALATE' }))).resolves.toEqual({ decision: 'REVIEW', outcome: 'on_hold' })

    expectNoMoneyMoved()
  })

  it('leaves the order on hold when the Kount lookup fails', async () => {
    kountService.getOrder.mockRejectedValue(new Error('unavailable'))

    await expect(process({ orderId: 'K1' })).rejects.toThrow('unavailable')

    expect(stripeService.updatePaymentIntentMetadata).not.toHaveBeenCalled()
    expectNoMoneyMoved()
  })

  it('ignores updates to other fields', async () => {
    await expect(process(statusEvent({ fieldName: 'notes' }))).resolves.toEqual({ outcome: 'ignored' })

    expect(stripeService.getCheckoutSessionForRiskEvaluation).not.toHaveBeenCalled()
  })

  it('rejects an event with no order ID', async () => {
    await expect(process({ eventType: 'Order.StatusChange', newValue: 'APPROVE' })).rejects.toThrow('no order ID')

    expectNoMoneyMoved()
  })

  it('ignores orders that are not Checkout Sessions', async () => {
    await expect(process(statusEvent({ merchantOrderId: 'other-123' }))).resolves.toEqual({ outcome: 'ignored' })

    expect(stripeService.getCheckoutSessionForRiskEvaluation).not.toHaveBeenCalled()
  })

  it('ignores a session Stripe does not know', async () => {
    stripeService.getCheckoutSessionForRiskEvaluation.mockRejectedValue(
      Object.assign(new Error('missing'), { code: 'resource_missing' }),
    )

    await expect(process(statusEvent())).resolves.toEqual({ outcome: 'ignored' })
  })

  it('fails on any other Stripe error so Kount retries', async () => {
    stripeService.getCheckoutSessionForRiskEvaluation.mockRejectedValue(new Error('stripe down'))

    await expect(process(statusEvent())).rejects.toThrow('stripe down')
  })

  it('does nothing for a canceled payment', async () => {
    stripeService.getCheckoutSessionForRiskEvaluation.mockResolvedValue(session({ status: 'canceled' }))

    await expect(process(statusEvent())).resolves.toEqual({ decision: 'APPROVE', outcome: 'skipped' })

    expect(stripeService.updatePaymentIntentMetadata).not.toHaveBeenCalled()
    expectNoMoneyMoved()
  })

  it('never touches a payment linked to a different Kount order', async () => {
    stripeService.getCheckoutSessionForRiskEvaluation.mockResolvedValue(
      session({ metadata: { kount_order_id: 'OTHER', kount_decision: 'REVIEW' } }),
    )

    await expect(process(statusEvent({ newValue: 'DECLINE' }))).resolves.toEqual({ outcome: 'ignored' })

    expectNoMoneyMoved()
  })

  it('asks for a retry when the evaluation is not saved yet', async () => {
    stripeService.getCheckoutSessionForRiskEvaluation.mockResolvedValue(session({ metadata: {} }))

    await expect(process(statusEvent({ newValue: 'DECLINE' }))).rejects.toMatchObject({ statusCode: 503 })

    expectNoMoneyMoved()
  })

  it('finishes a refund that an earlier delivery left half done', async () => {
    stripeService.getCheckoutSessionForRiskEvaluation.mockResolvedValue(
      session({ metadata: { kount_order_id: 'K1', kount_decision: 'DECLINE' } }),
    )

    await expect(process(statusEvent({ newValue: 'DECLINE' }))).resolves.toEqual({ decision: 'DECLINE', outcome: 'refunded' })
  })

  it('does not refund twice', async () => {
    stripeService.getCheckoutSessionForRiskEvaluation.mockResolvedValue(session({
      metadata: { kount_order_id: 'K1', kount_decision: 'DECLINE' },
      latest_charge: { refunded: true },
    }))

    await expect(process(statusEvent({ newValue: 'DECLINE' }))).resolves.toEqual({ decision: 'DECLINE', outcome: 'skipped' })

    expectNoMoneyMoved()
  })

  it.each([
    ['refund an order already approved', 'APPROVE', 'DECLINE'],
    ['release an order already declined', 'DECLINE', 'APPROVE'],
  ])('does not %s', async (_label, kount_decision, newValue) => {
    stripeService.getCheckoutSessionForRiskEvaluation.mockResolvedValue(
      session({ metadata: { kount_order_id: 'K1', kount_decision } }),
    )

    await expect(process(statusEvent({ newValue }))).resolves.toEqual({ decision: newValue, outcome: 'skipped' })

    expect(stripeService.updatePaymentIntentMetadata).not.toHaveBeenCalled()
    expectNoMoneyMoved()
  })
})

describe('verifyKountWebhook', () => {
  const rawBody = '{"orderId":"K1"}'
  const timestamp = '2026-11-05T12:00:00.000Z'
  const now = Date.parse(timestamp)
  let keys
  let publicKey

  const encode = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  const sign = async (message, privateKey = keys.privateKey) => encode(await crypto.subtle.sign(
    { name: 'RSA-PSS', saltLength: 32 },
    privateKey,
    new TextEncoder().encode(message),
  ))
  const generate = () => crypto.subtle.generateKey(
    { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )

  beforeAll(async () => {
    keys = await generate()
    publicKey = encode(await crypto.subtle.exportKey('spki', keys.publicKey))
  })

  it('accepts a signature over the timestamp and body', async () => {
    const signature = await sign(`${timestamp}${rawBody}`)

    await expect(verifyKountWebhook({ rawBody, signature, timestamp, publicKey, now })).resolves.toBe(true)
  })

  it('accepts a PEM public key', async () => {
    const signature = await sign(`${timestamp}${rawBody}`)
    const pem = `-----BEGIN PUBLIC KEY-----\n${publicKey.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----\n`

    await expect(verifyKountWebhook({ rawBody, signature, timestamp, publicKey: pem, now })).resolves.toBe(true)
  })

  it('accepts a retry inside the 45 minute window', async () => {
    const signature = await sign(`${timestamp}${rawBody}`)

    await expect(verifyKountWebhook({ rawBody, signature, timestamp, publicKey, now: now + 44 * 60 * 1000 })).resolves.toBe(true)
  })

  it('rejects a delivery outside the window', async () => {
    const signature = await sign(`${timestamp}${rawBody}`)

    await expect(verifyKountWebhook({ rawBody, signature, timestamp, publicKey, now: now + 46 * 60 * 1000 })).resolves.toBe(false)
  })

  it('rejects a changed body', async () => {
    const signature = await sign(`${timestamp}${rawBody}`)

    await expect(verifyKountWebhook({ rawBody: '{"orderId":"K2"}', signature, timestamp, publicKey, now })).resolves.toBe(false)
  })

  it('rejects a changed timestamp', async () => {
    const signature = await sign(`${timestamp}${rawBody}`)
    const later = '2026-11-05T12:00:01.000Z'

    await expect(verifyKountWebhook({ rawBody, signature, timestamp: later, publicKey, now })).resolves.toBe(false)
  })

  it('rejects a signature from another key', async () => {
    const other = await generate()
    const signature = await sign(`${timestamp}${rawBody}`, other.privateKey)

    await expect(verifyKountWebhook({ rawBody, signature, timestamp, publicKey, now })).resolves.toBe(false)
  })

  it.each([
    ['no signature', { signature: undefined }],
    ['no timestamp', { timestamp: undefined }],
    ['a malformed timestamp', { timestamp: 'yesterday' }],
    ['a malformed signature', { signature: '***' }],
    ['a malformed public key', { signature: 'AAAA', publicKey: 'not a key' }],
  ])('rejects %s', async (_label, overrides) => {
    const signature = await sign(`${timestamp}${rawBody}`)

    await expect(verifyKountWebhook({ rawBody, signature, timestamp, publicKey, now, ...overrides })).resolves.toBe(false)
  })
})
