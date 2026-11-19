import { describe, it, expect } from 'vitest'
import {
  buildEvaluationOrder,
  buildFailedAttemptOrder,
  buildStatusUpdate,
  classifyFailedCharge,
  mapAvs,
  mapCvv,
  splitName,
  compact,
} from '../../../src/services/kountPayload.js'

function session(overrides = {}) {
  return {
    id: 'cs_test_1',
    amount_subtotal: 2500,
    amount_total: 3299,
    currency: 'usd',
    metadata: { kount_hold: 'true', kount_session_id: 'abc123', kount_user_ip: '192.0.2.10' },
    total_details: { amount_shipping: 500, amount_tax: 299 },
    customer_details: {
      name: 'Test Buyer',
      email: 'buyer@example.com',
      address: { line1: '1 Test St', city: 'Boise', state: 'ID', postal_code: '83702', country: 'US' },
    },
    collected_information: {
      shipping_details: { name: 'Ship To', address: { line1: '2 Ship St', postal_code: '10001', country: 'US' } },
    },
    line_items: {
      data: [{ id: 'li_1', description: 'Mug', quantity: 2, amount_subtotal: 2500, price: { id: 'price_1', unit_amount: 1250, product: { id: 'prod_1', name: 'Mug' } } }],
    },
    ...overrides,
  }
}

const pi = {
  id: 'pi_1',
  status: 'requires_capture',
  latest_charge: {
    id: 'ch_1',
    authorization_code: '123456',
    payment_method_details: {
      card: { fingerprint: 'fp_1', last4: '4242', brand: 'visa', exp_month: 12, exp_year: 2030, checks: { cvc_check: 'pass', address_line1_check: 'pass', address_postal_code_check: 'fail' } },
    },
  },
}

describe('buildEvaluationOrder', () => {
  it('maps a held checkout to a post-authorization order', () => {
    const order = buildEvaluationOrder(session(), pi, { channel: 'WEB' })
    expect(order.merchantOrderId).toBe('cs_test_1')
    expect(order.channel).toBe('WEB')
    expect(order.deviceSessionId).toBe('abc123')
    expect(order.userIp).toBe('192.0.2.10')
    expect(order.items).toEqual([{ id: 'prod_1', name: 'Mug', description: 'Mug', price: '1250', quantity: 2, isDigital: false }])
    const tx = order.transactions[0]
    expect(tx.orderTotal).toBe('3299')
    expect(tx.subtotal).toBe('2500')
    expect(tx.currency).toBe('USD')
    expect(tx.transactionStatus).toBe('AUTHORIZED')
    expect(tx.authorizationStatus).toEqual({
      authResult: 'APPROVED',
      verificationResponse: { cvvStatus: 'MATCH', avsStatus: 'A' },
      processorAuthCode: '123456',
      processorTransactionId: 'ch_1',
    })
    expect(tx.payment).toEqual({ type: 'TOKEN', paymentToken: 'fp_1', last4: '4242', cardBrand: 'visa', expirationMonth: 12, expirationYear: 2030 })
    expect(order.fulfillment[0].recipientPerson.address).toEqual({ line1: '2 Ship St', postalCode: '10001', countryCode: 'US' })
    expect(order.fulfillment[0].shipping.amount).toBe('500')
  })

  it('sends the BIN and issuer when Stripe returns them, and ignores a malformed BIN', () => {
    const withIin = (iin) => ({
      ...pi,
      latest_charge: { ...pi.latest_charge, payment_method_details: { card: { ...pi.latest_charge.payment_method_details.card, iin, issuer: 'Test Bank' } } },
    })
    const payment = buildEvaluationOrder(session(), withIin('424242')).transactions[0].payment
    expect(payment).toMatchObject({ type: 'TOKEN', bin: '424242', issuingOrganization: 'Test Bank', last4: '4242' })
    expect(buildEvaluationOrder(session(), withIin('4242xx')).transactions[0].payment.bin).toBeUndefined()
  })

  it('never sends timestamps and omits unknown data', () => {
    const order = buildEvaluationOrder(session({ metadata: { kount_hold: 'true' }, customer_details: null, collected_information: null }), { id: 'pi_1' })
    expect(JSON.stringify(order)).not.toMatch(/DateTime/)
    expect(order.deviceSessionId).toBeUndefined()
    expect(order.userIp).toBeUndefined()
    expect(order.transactions[0].payment).toEqual({ type: 'NONE' })
    expect(order.transactions[0].billedPerson).toBeUndefined()
  })

  it('drops a non-IPv4 user IP (schema format is ipv4)', () => {
    const order = buildEvaluationOrder(session({ metadata: { kount_user_ip: '2001:db8::1' } }), pi)
    expect(order.userIp).toBeUndefined()
  })
})

describe('failed attempts', () => {
  it('classifies a Radar block as REFUSED / UNKNOWN', () => {
    expect(classifyFailedCharge({ outcome: { type: 'blocked', reason: 'rule' } })).toMatchObject({ kind: 'radar_block', authResult: 'UNKNOWN' })
  })

  it('classifies an issuer decline as REFUSED / DECLINED', () => {
    expect(classifyFailedCharge({ failure_code: 'card_declined', outcome: { type: 'issuer_declined', reason: 'insufficient_funds' } }))
      .toEqual({ kind: 'issuer_decline', authResult: 'DECLINED', declineCode: 'insufficient_funds' })
  })

  it('keys each attempt by session and charge', () => {
    const order = buildFailedAttemptOrder(session(), { id: 'ch_9', amount: 3299, outcome: { type: 'blocked' } })
    expect(order.merchantOrderId).toBe('cs_test_1:ch_9')
    expect(order.transactions[0].transactionStatus).toBe('REFUSED')
    expect(order.transactions[0].authorizationStatus.authResult).toBe('UNKNOWN')
  })
})

describe('helpers', () => {
  it('maps CVV and AVS conservatively', () => {
    expect(mapCvv('pass')).toBe('MATCH')
    expect(mapCvv('fail')).toBe('NO_MATCH')
    expect(mapCvv(null)).toBe('UNKNOWN')
    expect(mapAvs({ address_line1_check: 'pass', address_postal_code_check: 'pass' })).toBe('Y')
    expect(mapAvs({ address_line1_check: 'unavailable', address_postal_code_check: 'pass' })).toBeUndefined()
  })

  it('splits names on the last space', () => {
    expect(splitName('Mary Ann Smith')).toEqual({ first: 'Mary Ann', family: 'Smith' })
    expect(splitName('Cher')).toEqual({ first: 'Cher' })
    expect(splitName('')).toBeUndefined()
  })

  it('compact removes undefined and empty objects', () => {
    expect(compact({ a: undefined, b: {}, c: { d: undefined }, e: [1, undefined], f: 0 })).toEqual({ e: [1], f: 0 })
  })

  it('builds a status update', () => {
    expect(buildStatusUpdate('cs_1', 'K#0', 'CAPTURED')).toEqual({ merchantOrderId: 'cs_1', transactions: [{ transactionId: 'K#0', transactionStatus: 'CAPTURED' }] })
  })
})
