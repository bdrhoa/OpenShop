// Kount payload mapping, response parsing and config validation (pure functions).
import { describe, it, expect } from 'vitest'
import {
  buildEvaluationPayload,
  buildFailedAttemptPayload,
  buildStatusUpdatePayload,
  mapAvs,
  mapPayment,
  resolveShippingMethod,
  parseEvaluationResponse,
  parseRetryAfter,
  splitName,
} from '../../../src/lib/kountPayload.js'
import { buildKountConfig, KountConfigError, validateKountSetting } from '../../../src/config/kount.js'
import { SESSION, CHARGE, LINE_ITEMS } from './fixtures.js'

describe('buildEvaluationPayload', () => {
  const payload = buildEvaluationPayload({
    merchantOrderId: 'order-1',
    session: SESSION,
    paymentIntent: { id: 'pi_test_1', amount: 3000, currency: 'usd' },
    charge: CHARGE,
    lineItems: LINE_ITEMS,
    deviceSessionId: 'a'.repeat(32),
    userIp: '192.0.2.10',
    channel: 'WEB',
  })

  it('maps order, device and items with minor-unit string amounts', () => {
    expect(payload.merchantOrderId).toBe('order-1')
    expect(payload.deviceSessionId).toBe('a'.repeat(32))
    expect(payload.userIp).toBe('192.0.2.10')
    expect(payload.channel).toBe('WEB')
    expect(payload.items).toEqual([expect.objectContaining({ id: 'price_1', price: '1250', quantity: 2, isDigital: false, sku: 'prod_1' })])
  })

  it('sends the known post-authorization outcome and card data Stripe exposes', () => {
    const [tx] = payload.transactions
    expect(tx.transactionStatus).toBe('AUTHORIZED')
    expect(tx.authorizationStatus).toEqual(expect.objectContaining({ authResult: 'APPROVED', processorTransactionId: 'ch_test_1', processorAuthCode: '123456' }))
    expect(tx.authorizationStatus.verificationResponse).toEqual({ cvvStatus: 'MATCH', avsStatus: 'Y' })
    expect(tx.payment).toEqual({ type: 'TOKEN', paymentToken: 'fpTestCard4242', last4: '4242', cardBrand: 'visa', expirationMonth: 12, expirationYear: 2030 })
    expect(tx.payment).not.toHaveProperty('bin') // not exposed by Stripe; never invented
    expect(tx.orderTotal).toBe('3000')
    expect(tx.subtotal).toBe('2500')
    expect(tx.currency).toBe('USD')
    expect(tx.billedPerson.address).toEqual(expect.objectContaining({ postalCode: '83702', countryCode: 'US' }))
    expect(tx.billedPerson.name).toEqual({ first: 'Ada Q', family: 'Lovelace' })
  })

  it('omits timestamps and non-IPv4 addresses', () => {
    expect(JSON.stringify(payload)).not.toMatch(/DateTime/)
    const v6 = buildEvaluationPayload({ merchantOrderId: 'x', session: SESSION, lineItems: [], userIp: '2001:db8::1' })
    expect(v6).not.toHaveProperty('userIp')
  })

  it('includes shipping recipient and amount', () => {
    expect(payload.fulfillment[0]).toEqual(expect.objectContaining({
      type: 'SHIPPED',
      shipping: { amount: '300' },
      recipientPerson: expect.objectContaining({ address: expect.objectContaining({ line1: '2 Ship Rd' }) }),
    }))
  })
})

describe('mapPayment', () => {
  const card = (extra) => ({ payment_method_details: { card: { brand: 'mastercard', last4: '4444', ...extra } } })

  it('sends the Stripe card fingerprint as a TOKEN', () => {
    expect(mapPayment(card({ fingerprint: 'fpX', funding: 'debit' }))).toEqual(expect.objectContaining({ type: 'TOKEN', paymentToken: 'fpX', cardBrand: 'mastercard' }))
  })

  it('falls back to the card type with no token when there is no fingerprint', () => {
    expect(mapPayment(card({ funding: 'debit' }))).toEqual({ type: 'DEBIT_CARD', last4: '4444', cardBrand: 'mastercard' })
    expect(mapPayment(card({ fingerprint: null }))).toEqual({ type: 'CREDIT_CARD', last4: '4444', cardBrand: 'mastercard' })
  })

  it('sends NONE without card details', () => {
    expect(mapPayment({})).toEqual({ type: 'NONE' })
  })
})

describe('shipping method', () => {
  const build = (extra) => buildEvaluationPayload({ merchantOrderId: 'o', session: SESSION, lineItems: LINE_ITEMS, ...extra }).fulfillment[0].shipping

  it('sends the store-wide method on shipped orders', () => {
    expect(build({ shippingMethod: 'STANDARD' })).toEqual({ amount: '300', method: 'STANDARD' })
  })

  it('omits the method when none is configured', () => {
    expect(build({})).toEqual({ amount: '300' })
  })

  it('prefers a Stripe shipping rate tagged with a valid Kount method', () => {
    expect(build({ shippingMethod: 'STANDARD', shippingRate: { id: 'shr_1', metadata: { kount_shipping_method: 'next_day' } } }).method).toBe('NEXT_DAY')
  })

  it('ignores untagged or invalid shipping-rate metadata', () => {
    expect(resolveShippingMethod({ shippingRate: { metadata: { kount_shipping_method: 'OVERNIGHT' } }, defaultMethod: 'EXPRESS' })).toBe('EXPRESS')
    expect(resolveShippingMethod({ shippingRate: 'shr_unexpanded', defaultMethod: undefined })).toBeUndefined()
    expect(resolveShippingMethod({ defaultMethod: 'FAST' })).toBeUndefined()
  })
})

describe('buildFailedAttemptPayload', () => {
  it('reports an issuer decline as REFUSED / DECLINED with the decline code', () => {
    const { payload, failure } = buildFailedAttemptPayload({
      merchantOrderId: 'order-1',
      paymentIntent: { id: 'pi_1', amount: 1000, currency: 'usd', last_payment_error: { decline_code: 'insufficient_funds' } },
      charge: { id: 'ch_f', outcome: { type: 'issuer_declined', network_decline_code: '51' }, payment_method_details: { card: { brand: 'visa', last4: '0002', fingerprint: 'fpDeclined' } } },
    })
    expect(failure.kind).toBe('issuer_decline')
    expect(payload.transactions[0].payment).toEqual(expect.objectContaining({ type: 'TOKEN', paymentToken: 'fpDeclined' }))
    expect(payload.transactions[0]).toEqual(expect.objectContaining({
      transactionStatus: 'REFUSED',
      authorizationStatus: { authResult: 'DECLINED', declineCode: '51', processorTransactionId: 'ch_f' },
    }))
  })

  it('reports a Radar block as REFUSED / UNKNOWN', () => {
    const { payload, failure } = buildFailedAttemptPayload({
      merchantOrderId: 'order-1',
      paymentIntent: { id: 'pi_1', amount: 1000, currency: 'usd' },
      charge: { id: 'ch_b', outcome: { type: 'blocked' } },
    })
    expect(failure.kind).toBe('radar_block')
    expect(payload.transactions[0].authorizationStatus.authResult).toBe('UNKNOWN')
    expect(payload.transactions[0].authorizationStatus).not.toHaveProperty('declineCode')
  })
})

describe('buildStatusUpdatePayload', () => {
  it('builds a transaction status update with optional reviewer decision', () => {
    expect(buildStatusUpdatePayload({ merchantOrderId: 'o', kountTransactionId: 'T#0', transactionStatus: 'CAPTURED', decision: 'APPROVE' }))
      .toEqual({ merchantOrderId: 'o', riskInquiry: { decision: 'APPROVE' }, transactions: [{ transactionId: 'T#0', transactionStatus: 'CAPTURED' }] })
  })
})

describe('parseEvaluationResponse (MCP response fixtures)', () => {
  it('object_review → usable decision', () => {
    const r = parseEvaluationResponse({ order: { orderId: 'K1', riskInquiry: { decision: 'REVIEW', device: { id: 'dev' } }, transactions: [{ transactionId: 'K1#0' }] } })
    expect(r).toEqual(expect.objectContaining({ status: 'usable', decision: 'REVIEW', shapeConflict: false, kountOrderId: 'K1', kountTransactionId: 'K1#0', deviceId: 'dev' }))
  })

  it('array_approve → usable decision with shape conflict flagged', () => {
    const r = parseEvaluationResponse({ order: { orderId: 'K2', riskInquiry: [{ decision: 'APPROVE' }] } })
    expect(r).toEqual(expect.objectContaining({ status: 'usable', decision: 'APPROVE', shapeConflict: true }))
  })

  it('array with conflicting decisions is not usable', () => {
    const r = parseEvaluationResponse({ order: { riskInquiry: [{ decision: 'APPROVE' }, { decision: 'DECLINE' }] } })
    expect(r.status).toBe('unknown_decision')
  })

  it('unknown_decision → DECLINED spelling is not accepted', () => {
    expect(parseEvaluationResponse({ order: { orderId: 'K', riskInquiry: { decision: 'DECLINED' } } }).status).toBe('unknown_decision')
  })

  it('missing_decision and malformed_response', () => {
    expect(parseEvaluationResponse({ order: { orderId: 'K' } }).status).toBe('missing_decision')
    expect(parseEvaluationResponse(null).status).toBe('malformed_response')
  })
})

describe('helpers', () => {
  it('parses Retry-After seconds and HTTP dates', () => {
    expect(parseRetryAfter('3')).toBe(3000)
    expect(parseRetryAfter(new Date(10000).toUTCString(), 4000)).toBe(6000)
    expect(parseRetryAfter('nonsense')).toBeUndefined()
    expect(parseRetryAfter(null)).toBeUndefined()
  })

  it('maps AVS only for unambiguous combinations', () => {
    expect(mapAvs({ address_line1_check: 'fail', address_postal_code_check: 'pass' })).toBe('Z')
    expect(mapAvs({ address_line1_check: 'unavailable', address_postal_code_check: 'pass' })).toBeUndefined()
  })

  it('splits names', () => {
    expect(splitName('Cher')).toEqual({ first: 'Cher' })
    expect(splitName('  ')).toBeUndefined()
  })
})

describe('Kount configuration', () => {
  it('applies defaults and Sandbox endpoints', () => {
    const cfg = buildKountConfig({ KOUNT_CLIENT_ID: 'c', KOUNT_API_KEY: 'k' })
    expect(cfg).toEqual(expect.objectContaining({
      enabled: true,
      maxRetries: 2,
      fallbackDecision: 'APPROVE',
      environment: 'SANDBOX',
      ddcEnvironment: 'TEST',
      tokenUrl: 'https://login-uat.equifax.com/as/token',
      apiBaseUrl: 'https://api-sandbox.kount.com',
    }))
  })

  it('PRODUCTION switches token server, API host and DDC together', () => {
    expect(buildKountConfig({ KOUNT_ENVIRONMENT: 'PRODUCTION' })).toEqual(expect.objectContaining({
      environment: 'PRODUCTION',
      tokenUrl: 'https://login.equifax.com/as/token',
      apiBaseUrl: 'https://api.kount.com',
      ddcEnvironment: 'PROD',
    }))
  })

  it('is disabled without both credentials', () => {
    expect(buildKountConfig({ KOUNT_CLIENT_ID: 'c' }).enabled).toBe(false)
  })

  it('accepts retries 0 and 3 and DECLINE fallback', () => {
    expect(buildKountConfig({ KOUNT_MAX_RETRIES: '0' }).maxRetries).toBe(0)
    expect(buildKountConfig({ KOUNT_MAX_RETRIES: '3', KOUNT_FALLBACK_DECISION: 'DECLINE' })).toEqual(expect.objectContaining({ maxRetries: 3, fallbackDecision: 'DECLINE' }))
  })

  it('rejects invalid policy values instead of silently defaulting', () => {
    expect(() => buildKountConfig({ KOUNT_MAX_RETRIES: '4' })).toThrow(KountConfigError)
    expect(() => buildKountConfig({ KOUNT_MAX_RETRIES: '-1' })).toThrow(/KOUNT_MAX_RETRIES/)
    expect(() => buildKountConfig({ KOUNT_FALLBACK_DECISION: 'REVIEW' })).toThrow(/KOUNT_FALLBACK_DECISION/)
    expect(validateKountSetting('KOUNT_API_KEY', 'Basic abc')).toMatch(/Basic/)
    expect(validateKountSetting('KOUNT_ENVIRONMENT', 'STAGING')).toMatch(/SANDBOX, PRODUCTION/)
    expect(() => buildKountConfig({ KOUNT_ENVIRONMENT: 'sandbox' })).toThrow(/KOUNT_ENVIRONMENT/)
    expect(() => buildKountConfig({ KOUNT_SHIPPING_METHOD: 'OVERNIGHT' })).toThrow(/KOUNT_SHIPPING_METHOD/)
    expect(buildKountConfig({ KOUNT_SHIPPING_METHOD: 'SECOND_DAY' }).shippingMethod).toBe('SECOND_DAY')
    expect(buildKountConfig({}).shippingMethod).toBe('')
  })
})
