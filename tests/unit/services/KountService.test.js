import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  KountService,
  buildKountOrder,
  resetKountTokenCache,
  settleHeldCheckout,
} from '../../../src/services/KountService.js'

const address = { line1: '1 Test St', line2: null, city: 'Boise', state: 'ID', postal_code: '83702', country: 'US' }

function heldSession(paymentIntentOverrides = {}) {
  return {
    id: 'cs_test_1',
    currency: 'usd',
    amount_subtotal: 2500,
    amount_total: 2700,
    total_details: { amount_tax: 200 },
    metadata: { kount_session_id: 'ddcsession1', kount_user_ip: '203.0.113.7' },
    customer_details: { email: 'buyer@example.com' },
    collected_information: { shipping_details: { name: 'Ship To Person', address } },
    payment_intent: {
      id: 'pi_test_1',
      capture_method: 'manual',
      status: 'requires_capture',
      metadata: {},
      latest_charge: {
        id: 'ch_test_1',
        billing_details: { name: 'Bill Person', phone: '+12085551234', address },
        payment_method_details: {
          card: {
            brand: 'amex',
            last4: '4242',
            exp_month: 12,
            exp_year: 2030,
            fingerprint: 'fp_1',
            checks: { cvc_check: 'pass', address_line1_check: 'fail', address_postal_code_check: 'pass' },
          },
        },
      },
      ...paymentIntentOverrides,
    },
  }
}

const lineItems = [{
  description: 'Tee',
  quantity: 2,
  price: { id: 'price_1', unit_amount: 1250, product: { description: 'A tee' } },
}]

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

describe('buildKountOrder', () => {
  it('links the order to the device data collected in the browser', () => {
    const order = buildKountOrder(heldSession(), lineItems)

    expect(order.deviceSessionId).toBe('ddcsession1')
    expect(order.merchantOrderId).toBe('cs_test_1')
    expect(order.userIp).toBe('203.0.113.7')
  })

  it('sends amounts in the lowest denomination as strings', () => {
    const order = buildKountOrder(heldSession(), lineItems)

    expect(order.items[0]).toMatchObject({ id: 'price_1', price: '1250', quantity: 2 })
    expect(order.transactions[0]).toMatchObject({
      subtotal: '2500',
      orderTotal: '2700',
      currency: 'USD',
      tax: { taxAmount: '200' },
    })
  })

  it('reports the authorization and card checks from Stripe', () => {
    const [transaction] = buildKountOrder(heldSession(), lineItems).transactions

    expect(transaction.transactionStatus).toBe('AUTHORIZED')
    expect(transaction.authorizationStatus).toEqual({
      authResult: 'APPROVED',
      verificationResponse: { cvvStatus: 'MATCH', avsStatus: 'Z' },
      processorTransactionId: 'ch_test_1',
    })
    expect(transaction.payment).toEqual({
      type: 'TOKEN',
      paymentToken: 'fp_1',
      cardBrand: 'americanexpress',
      last4: '4242',
      expirationMonth: 12,
      expirationYear: 2030,
    })
  })

  it('separates the billed person from the recipient', () => {
    const order = buildKountOrder(heldSession(), lineItems)

    expect(order.transactions[0].billedPerson).toMatchObject({
      name: { first: 'Bill', family: 'Person' },
      emailAddress: 'buyer@example.com',
      phoneNumber: '+12085551234',
    })
    expect(order.fulfillment[0].recipientPerson).toMatchObject({
      name: { first: 'Ship To', family: 'Person' },
      address: { region: 'ID', countryCode: 'US', postalCode: '83702' },
    })
  })

  it('leaves out an IPv6 address, which the API does not accept', () => {
    const session = heldSession()
    session.metadata.kount_user_ip = '2001:db8::1'

    expect(buildKountOrder(session, lineItems).userIp).toBeUndefined()
  })

  it('still builds an order when the DDC session ID is missing', () => {
    const session = heldSession()
    delete session.metadata.kount_session_id

    expect(buildKountOrder(session, lineItems).deviceSessionId).toBeUndefined()
  })
})

describe('settleHeldCheckout', () => {
  let stripeService
  let kountService

  function settle() {
    return settleHeldCheckout({ stripeService, kountService, sessionId: 'cs_test_1' })
  }

  beforeEach(() => {
    stripeService = {
      getCheckoutSessionForRiskEvaluation: vi.fn().mockResolvedValue(heldSession()),
      getCheckoutSessionLineItems: vi.fn().mockResolvedValue({ data: lineItems }),
      updatePaymentIntentMetadata: vi.fn().mockResolvedValue({}),
      capturePaymentIntent: vi.fn().mockResolvedValue({}),
      cancelPaymentIntentAsFraudulent: vi.fn().mockResolvedValue({}),
    }
    kountService = { evaluateOrder: vi.fn() }
  })

  it.each(['APPROVE', 'REVIEW'])('captures on %s', async (decision) => {
    kountService.evaluateOrder.mockResolvedValue({ orderId: 'K1', decision })

    await expect(settle()).resolves.toEqual({ decision, outcome: 'captured' })

    expect(stripeService.capturePaymentIntent).toHaveBeenCalledWith('pi_test_1')
    expect(stripeService.cancelPaymentIntentAsFraudulent).not.toHaveBeenCalled()
  })

  it('cancels on DECLINE', async () => {
    kountService.evaluateOrder.mockResolvedValue({ orderId: 'K1', decision: 'DECLINE' })

    await expect(settle()).resolves.toEqual({ decision: 'DECLINE', outcome: 'canceled' })

    expect(stripeService.cancelPaymentIntentAsFraudulent).toHaveBeenCalledWith('pi_test_1')
    expect(stripeService.capturePaymentIntent).not.toHaveBeenCalled()
  })

  it('saves the decision before moving any money', async () => {
    kountService.evaluateOrder.mockResolvedValue({ orderId: 'K1', decision: 'APPROVE' })

    await settle()

    expect(stripeService.updatePaymentIntentMetadata).toHaveBeenCalledWith('pi_test_1', {
      kount_order_id: 'K1',
      kount_decision: 'APPROVE',
      kount_session_id: 'ddcsession1',
    })
    expect(stripeService.updatePaymentIntentMetadata.mock.invocationCallOrder[0])
      .toBeLessThan(stripeService.capturePaymentIntent.mock.invocationCallOrder[0])
  })

  it('leaves the payment held when Kount fails', async () => {
    kountService.evaluateOrder.mockRejectedValue(new Error('unavailable'))

    await expect(settle()).rejects.toThrow('unavailable')

    expect(stripeService.capturePaymentIntent).not.toHaveBeenCalled()
    expect(stripeService.cancelPaymentIntentAsFraudulent).not.toHaveBeenCalled()
  })

  it('resumes from a saved decision without evaluating again', async () => {
    stripeService.getCheckoutSessionForRiskEvaluation.mockResolvedValue(
      heldSession({ metadata: { kount_decision: 'REVIEW' } }),
    )

    await settle()

    expect(kountService.evaluateOrder).not.toHaveBeenCalled()
    expect(stripeService.capturePaymentIntent).toHaveBeenCalledTimes(1)
  })

  it('does not capture on a saved decision it does not recognise', async () => {
    stripeService.getCheckoutSessionForRiskEvaluation.mockResolvedValue(
      heldSession({ metadata: { kount_decision: 'SOMETHING_ELSE' } }),
    )

    await settle()

    expect(stripeService.capturePaymentIntent).not.toHaveBeenCalled()
  })

  it.each([
    ['already captured', { status: 'succeeded' }],
    ['already canceled', { status: 'canceled' }],
    ['automatic capture', { capture_method: 'automatic', status: 'succeeded' }],
  ])('skips a payment that is %s', async (_label, overrides) => {
    stripeService.getCheckoutSessionForRiskEvaluation.mockResolvedValue(heldSession(overrides))

    await expect(settle()).resolves.toEqual({ outcome: 'skipped' })

    expect(kountService.evaluateOrder).not.toHaveBeenCalled()
    expect(stripeService.capturePaymentIntent).not.toHaveBeenCalled()
  })
})

describe('KountService', () => {
  let fetchMock
  const order = { merchantOrderId: 'cs_test_1' }
  const tokenResponse = () => jsonResponse({ access_token: 'token1', expires_in: 1200 })

  beforeEach(() => {
    resetKountTokenCache()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('requests a risk inquiry with a bearer token', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ order: { orderId: 'K1', riskInquiry: { decision: 'REVIEW' } } }))

    await expect(new KountService('key').evaluateOrder(order)).resolves.toEqual({ orderId: 'K1', decision: 'REVIEW' })

    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0]
    expect(tokenUrl).toBe('https://login-uat.equifax.com/as/token')
    expect(tokenInit.headers.Authorization).toBe('Basic key')
    const [orderUrl, orderInit] = fetchMock.mock.calls[1]
    expect(orderUrl).toBe('https://api-sandbox.kount.com/commerce/v2/orders?riskInquiry=true')
    expect(orderInit.headers.Authorization).toBe('Bearer token1')
  })

  it('reuses a token until it nears expiry', async () => {
    fetchMock.mockImplementation(async (url) => (String(url).includes('/as/token')
      ? tokenResponse()
      : jsonResponse({ order: { orderId: 'K1', riskInquiry: { decision: 'APPROVE' } } })))

    await new KountService('key').evaluateOrder(order)
    await new KountService('key').evaluateOrder(order)

    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/as/token'))).toHaveLength(1)
  })

  it('reads a decision returned as a list', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ order: { orderId: 'K1', riskInquiry: [{ decision: 'DECLINE' }] } }))

    await expect(new KountService('key').evaluateOrder(order)).resolves.toMatchObject({ decision: 'DECLINE' })
  })

  it.each([
    ['a missing decision', { order: { orderId: 'K1', riskInquiry: {} } }],
    ['an unknown decision', { order: { orderId: 'K1', riskInquiry: { decision: 'MAYBE' } } }],
    ['a missing order ID', { order: { riskInquiry: { decision: 'APPROVE' } } }],
  ])('treats %s as a failure, never an approval', async (_label, body) => {
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(jsonResponse(body))

    await expect(new KountService('key').evaluateOrder(order)).rejects.toMatchObject({ statusCode: 503 })
  })

  it('fails when the token request is refused', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }))

    await expect(new KountService('key').evaluateOrder(order)).rejects.toMatchObject({ statusCode: 503 })
  })

  it('drops a token that Kount rejects', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ order: { orderId: 'K1', riskInquiry: { decision: 'APPROVE' } } }))

    await expect(new KountService('key').evaluateOrder(order)).rejects.toMatchObject({ statusCode: 503 })
    await expect(new KountService('key').evaluateOrder(order)).resolves.toMatchObject({ decision: 'APPROVE' })
  })
})
