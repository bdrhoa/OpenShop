import { describe, it, expect } from 'vitest'
import {
  mapFailedAuthorization,
  buildKountOrder,
  parseEvaluateResponse,
  mapAvsStatus,
  mapCvvStatus,
  mapCardBrand,
  normalizeDeviceSessionId,
  isIPv4,
} from '../../src/lib/kountOrder.js'

// Synthetic Stripe objects only.
function fixture() {
  const session = {
    id: 'cs_test_synthetic',
    currency: 'usd',
    amount_subtotal: 2500,
    amount_total: 2800,
    total_details: { amount_tax: 0, amount_shipping: 300 },
    customer_details: {
      name: 'Test Buyer',
      email: 'buyer@example.com',
      phone: '+15555550100',
      address: { line1: '1 Test St', city: 'Testville', state: 'ID', postal_code: '83702', country: 'US' },
    },
    collected_information: {
      shipping_details: {
        name: 'Test Recipient',
        address: { line1: '2 Ship Rd', city: 'Shiptown', state: 'ID', postal_code: '83703', country: 'US' },
      },
    },
  }
  const paymentIntent = { id: 'pi_test_synthetic', amount: 2800, currency: 'usd', status: 'requires_capture' }
  const charge = {
    id: 'ch_test_synthetic',
    authorization_code: '123456',
    payment_method_details: {
      card: {
        brand: 'amex', last4: '0005', exp_month: 12, exp_year: 2030, fingerprint: 'fp_synthetic',
        checks: { cvc_check: 'pass', address_line1_check: 'pass', address_postal_code_check: 'fail' },
      },
    },
  }
  const lineItems = [
    { description: 'Mug', quantity: 2, amount_subtotal: 2500, price: { id: 'price_1', unit_amount: 1250, product: 'prod_mug' } },
  ]
  return { session, paymentIntent, charge, lineItems }
}

describe('buildKountOrder', () => {
  it('maps a held Stripe checkout to an Evaluate Order body', () => {
    const order = buildKountOrder({ ...fixture(), deviceSessionId: 'abc123', userIp: '192.0.2.10' })

    expect(order.merchantOrderId).toBe('cs_test_synthetic')
    expect(order.deviceSessionId).toBe('abc123')
    expect(order.userIp).toBe('192.0.2.10')
    expect(order.items).toEqual([{ id: 'prod_mug', name: 'Mug', price: '1250', quantity: 2, isDigital: false }])

    const [tx] = order.transactions
    expect(tx.orderTotal).toBe('2800')
    expect(tx.subtotal).toBe('2500')
    expect(tx.currency).toBe('USD')
    expect(tx.transactionStatus).toBe('AUTHORIZED')
    expect(tx.payment).toEqual({
      type: 'TOKEN', paymentToken: 'fp_synthetic', last4: '0005', cardBrand: 'americanexpress',
      expirationMonth: 12, expirationYear: 2030,
    })
    expect(tx.authorizationStatus).toEqual({
      authResult: 'APPROVED',
      verificationResponse: { cvvStatus: 'MATCH', avsStatus: 'A' },
      processorAuthCode: '123456',
      processorTransactionId: 'ch_test_synthetic',
    })
    expect(tx.billedPerson.address).toEqual({ line1: '1 Test St', city: 'Testville', region: 'ID', postalCode: '83702', countryCode: 'US' })
    expect(tx.tax).toBeUndefined()

    const [ful] = order.fulfillment
    expect(ful.type).toBe('SHIPPED')
    expect(ful.shipping.amount).toBe('300')
    expect(ful.recipientPerson.name).toEqual({ first: 'Test', family: 'Recipient' })
    expect(ful.recipientPerson.address.postalCode).toBe('83703')
  })

  it('omits unusable device session ids, IPv6 addresses, and timestamps', () => {
    const order = buildKountOrder({ ...fixture(), deviceSessionId: 'bad id!', userIp: '2001:db8::1' })
    expect(order.deviceSessionId).toBeUndefined()
    expect(order.userIp).toBeUndefined()
    expect(JSON.stringify(order)).not.toMatch(/DateTime/)
  })

  it('falls back to payment type NONE without a card fingerprint', () => {
    const f = fixture()
    f.charge.payment_method_details.card.fingerprint = undefined
    const order = buildKountOrder(f)
    expect(order.transactions[0].payment.type).toBe('NONE')
    expect(order.transactions[0].payment.paymentToken).toBeUndefined()
  })
})

describe('mapping helpers', () => {
  it('maps AVS only for unambiguous combinations', () => {
    expect(mapAvsStatus('pass', 'pass')).toBe('Y')
    expect(mapAvsStatus('fail', 'pass')).toBe('Z')
    expect(mapAvsStatus('fail', 'fail')).toBe('N')
    expect(mapAvsStatus('unchecked', 'pass')).toBeUndefined()
  })

  it('maps CVV and card brands', () => {
    expect(mapCvvStatus('fail')).toBe('NO_MATCH')
    expect(mapCvvStatus(null)).toBe('UNKNOWN')
    expect(mapCardBrand('visa')).toBe('visa')
    expect(mapCardBrand('unionpay')).toBeUndefined()
  })

  it('validates device session ids and IPv4', () => {
    expect(normalizeDeviceSessionId(' 0123abcd ')).toBe('0123abcd')
    expect(normalizeDeviceSessionId('a'.repeat(65))).toBeNull()
    expect(isIPv4('256.1.1.1')).toBe(false)
    expect(isIPv4('10.0.0.1')).toBe(true)
  })
})

describe('parseEvaluateResponse', () => {
  it('reads decision, ids, and device from the order', () => {
    const parsed = parseEvaluateResponse({
      order: {
        orderId: 'K1',
        transactions: [{ transactionId: 'K1#0' }],
        riskInquiry: { decision: 'REVIEW', omniscore: 42.5, device: { id: 'dev1' } },
      },
    })
    expect(parsed).toMatchObject({ kountOrderId: 'K1', transactionId: 'K1#0', decision: 'REVIEW', omniscore: 42.5, deviceId: 'dev1' })
  })

  it('accepts riskInquiry as an array and rejects unknown decisions', () => {
    expect(parseEvaluateResponse({ order: { riskInquiry: [{ decision: 'APPROVE' }] } }).decision).toBe('APPROVE')
    expect(parseEvaluateResponse({ order: { riskInquiry: { decision: 'MAYBE' } } }).decision).toBeNull()
  })
})

function failedCharge(outcome, checks = {}) {
  return {
    id: 'ch_failed',
    outcome,
    failure_code: 'card_declined',
    billing_details: { name: 'Pat Buyer', email: 'pat@example.com', address: { line1: '1 Main', city: 'Boise', state: 'ID', postal_code: '83702', country: 'US' } },
    shipping: { name: 'Pat Buyer', address: { line1: '1 Main', city: 'Boise', state: 'ID', postal_code: '83702', country: 'US' } },
    payment_method_details: { card: { brand: 'visa', last4: '4242', fingerprint: 'fp_x', checks } },
  }
}

describe('declined authorization attempts', () => {
  it('reports a Radar block as UNKNOWN with the blocklist code, CVV UNKNOWN and no AVS', () => {
    const auth = mapFailedAuthorization(failedCharge(
      { type: 'blocked', reason: 'blocklist' },
      { cvc_check: 'unavailable', address_line1_check: 'unavailable', address_postal_code_check: 'unavailable' },
    ))
    expect(auth).toEqual({
      transactionStatus: 'REFUSED',
      authResult: 'UNKNOWN',
      declineCode: 'stripe_radar_blocklist',
      cvvStatus: 'UNKNOWN',
      avsStatus: undefined,
    })
  })

  it('names other Radar block reasons after the reason', () => {
    expect(mapFailedAuthorization(failedCharge({ type: 'blocked', reason: 'highest_risk_level' })).declineCode)
      .toBe('stripe_radar_highest_risk_level')
  })

  it('reports an issuer decline as DECLINED with the network code and the checks that ran', () => {
    const auth = mapFailedAuthorization(
      failedCharge({ type: 'issuer_declined', network_decline_code: '05' }, { cvc_check: 'pass', address_line1_check: 'pass', address_postal_code_check: 'pass' }),
    )
    expect(auth).toMatchObject({ authResult: 'DECLINED', declineCode: '05', cvvStatus: 'MATCH', avsStatus: 'Y' })
  })

  it('falls back to the PaymentIntent decline code, then the charge failure code', () => {
    const pi = { last_payment_error: { decline_code: 'insufficient_funds' } }
    expect(mapFailedAuthorization(failedCharge({ type: 'issuer_declined' }), pi).declineCode).toBe('insufficient_funds')
    expect(mapFailedAuthorization(failedCharge({ type: 'issuer_declined' })).declineCode).toBe('card_declined')
  })

  it('builds the order from the charge when the checkout session has no customer details', () => {
    const charge = failedCharge({ type: 'blocked', reason: 'blocklist' }, { cvc_check: 'unavailable' })
    const body = buildKountOrder({
      session: { id: 'cs_open', currency: 'usd', amount_total: 3799, amount_subtotal: 3799 },
      paymentIntent: { id: 'pi_x', amount: 3799 },
      charge,
      authorization: mapFailedAuthorization(charge),
    })
    const tx = body.transactions[0]
    expect(body.merchantOrderId).toBe('cs_open')
    expect(tx.transactionStatus).toBe('REFUSED')
    expect(tx.authorizationStatus).toEqual({
      authResult: 'UNKNOWN',
      declineCode: 'stripe_radar_blocklist',
      verificationResponse: { cvvStatus: 'UNKNOWN' },
      processorTransactionId: 'ch_failed',
    })
    expect(tx.billedPerson.emailAddress).toBe('pat@example.com')
    expect(body.fulfillment[0].recipientPerson.address.postalCode).toBe('83702')
  })
})
