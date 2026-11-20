// KountService: response parsing fixtures, attributed fallback, payment mapping.
import { describe, it, expect } from 'vitest'
import {
  KountService,
  parseEvaluationResponse,
  mapPayment,
  mapAvs,
  buildFailedAttemptPayload,
} from '../../../src/services/KountService.js'
import { KountApiError } from '../../../src/services/KountClient.js'
import { parseKountConfig, KountConfigError } from '../../../src/config/kount.js'

function service(fallback, requestImpl) {
  const config = parseKountConfig({ KOUNT_CLIENT_ID: 'c', KOUNT_API_KEY: 'k', KOUNT_FALLBACK_DECISION: fallback })
  return new KountService(config, { client: { request: requestImpl } })
}

describe('parseEvaluationResponse', () => {
  it('object riskInquiry with REVIEW is usable', () => {
    const r = parseEvaluationResponse({ order: { orderId: 'K1', riskInquiry: { decision: 'REVIEW', device: { id: 'd' } }, transactions: [{ transactionId: 'T1' }] } })
    expect(r).toMatchObject({ status: 'usable_decision', decision: 'REVIEW', kountOrderId: 'K1', kountTransactionId: 'T1', deviceId: 'd', shapeConflict: false })
  })
  it('array riskInquiry is usable but reports the shape conflict', () => {
    const r = parseEvaluationResponse({ order: { orderId: 'K1', riskInquiry: [{ decision: 'APPROVE' }] } })
    expect(r).toMatchObject({ status: 'usable_decision', decision: 'APPROVE', shapeConflict: true })
  })
  it('unknown decision spelling is not usable', () => {
    expect(parseEvaluationResponse({ order: { riskInquiry: { decision: 'DECLINED' } } }).status).toBe('unknown_decision')
  })
  it('missing decision', () => {
    expect(parseEvaluationResponse({ order: { orderId: 'K1' } }).status).toBe('missing_decision')
  })
  it('malformed success body', () => {
    expect(parseEvaluationResponse(null).status).toBe('malformed_response')
    expect(parseEvaluationResponse(undefined).status).toBe('malformed_response')
  })
})

describe('KountService.evaluate', () => {
  const ok = (decision) => async () => ({ status: 200, attempts: 1, correlationId: 'corr', body: { order: { orderId: 'K1', riskInquiry: { decision }, transactions: [{ transactionId: 'T1' }] } } })

  it('returns Kount REVIEW as a Kount decision (never a fallback)', async () => {
    const r = await service('DECLINE', ok('REVIEW')).evaluate({})
    expect(r).toMatchObject({ decision: 'REVIEW', decisionSource: 'kount', fallbackReason: null, kountOrderId: 'K1' })
  })

  it('applies an attributed APPROVE fallback when the call fails', async () => {
    const r = await service('APPROVE', async () => { throw new KountApiError('x', { status: 503, attempts: 3 }) }).evaluate({})
    expect(r).toMatchObject({ decision: 'APPROVE', decisionSource: 'fallback', fallbackReason: 'http_503', attempts: 3 })
  })

  it('applies an attributed DECLINE fallback for a missing decision', async () => {
    const r = await service('DECLINE', async () => ({ status: 200, attempts: 1, body: { order: { orderId: 'K1' } } })).evaluate({})
    expect(r).toMatchObject({ decision: 'DECLINE', decisionSource: 'fallback', fallbackReason: 'missing_decision', kountOrderId: 'K1' })
  })

  it('treats an unrecognized decision as fallback, not as that value', async () => {
    const r = await service('APPROVE', ok('DECLINED')).evaluate({})
    expect(r).toMatchObject({ decisionSource: 'fallback', fallbackReason: 'unknown_decision' })
  })

  it('data-only errors propagate instead of becoming approvals', async () => {
    const svc = service('APPROVE', async () => { throw new KountApiError('x', { status: 500 }) })
    await expect(svc.reportDataOnly({})).rejects.toBeInstanceOf(KountApiError)
  })
})

describe('payment mapping policy', () => {
  it('uses the persistent Stripe card fingerprint as TOKEN with last4, never a BIN', () => {
    const p = mapPayment({ fingerprint: 'fp1', last4: '4242', brand: 'amex', exp_month: 1, exp_year: 2030 })
    expect(p).toEqual({ type: 'TOKEN', paymentToken: 'fp1', last4: '4242', cardBrand: 'americanexpress', expirationMonth: 1, expirationYear: 2030 })
    expect(p.bin).toBeUndefined()
  })
  it('falls back to CREDIT_CARD with last4 and no token', () => {
    expect(mapPayment({ last4: '1111', brand: 'visa' })).toMatchObject({ type: 'CREDIT_CARD', last4: '1111' })
    expect(mapPayment({ last4: '1111' }).paymentToken).toBeUndefined()
  })
  it('uses NONE without card data', () => {
    expect(mapPayment(null)).toEqual({ type: 'NONE' })
  })
  it('maps only definite AVS combinations', () => {
    expect(mapAvs('pass', 'pass')).toBe('Y')
    expect(mapAvs('fail', 'fail')).toBe('N')
    expect(mapAvs('unavailable', 'pass')).toBeUndefined()
  })
})

describe('failed attempt payloads', () => {
  const base = { id: 'pi_1', amount: 1000, currency: 'usd', metadata: {} }
  it('issuer decline → REFUSED / DECLINED', () => {
    const p = buildFailedAttemptPayload({ paymentIntent: { ...base, last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds' }, latest_charge: { id: 'ch_1', outcome: { type: 'issuer_declined' } } } })
    expect(p.transactions[0]).toMatchObject({ transactionStatus: 'REFUSED', authorizationStatus: { authResult: 'DECLINED', declineCode: 'insufficient_funds' } })
  })
  it('Radar block → REFUSED / UNKNOWN', () => {
    const p = buildFailedAttemptPayload({ paymentIntent: { ...base, latest_charge: { id: 'ch_2', outcome: { type: 'blocked', reason: 'highest_risk_level' } } } })
    expect(p.transactions[0]).toMatchObject({ transactionStatus: 'REFUSED', authorizationStatus: { authResult: 'UNKNOWN', declineCode: 'stripe_radar_highest_risk_level' } })
  })
})

describe('parseKountConfig', () => {
  it('applies defaults', () => {
    const c = parseKountConfig({})
    expect(c).toMatchObject({ enabled: false, maxRetries: 2, fallbackDecision: 'APPROVE', environment: 'SANDBOX', ddcEnvironment: 'TEST' })
    expect(c.tokenUrl).toBe('https://login-uat.equifax.com/as/token')
    expect(c.apiBaseUrl).toBe('https://api-sandbox.kount.com')
  })
  it('one environment setting selects endpoints and device collection together', () => {
    const p = parseKountConfig({ KOUNT_ENVIRONMENT: 'production' })
    expect(p).toMatchObject({
      environment: 'PRODUCTION',
      tokenUrl: 'https://login.equifax.com/as/token',
      apiBaseUrl: 'https://api.kount.com',
      ddcEnvironment: 'PROD',
      ordersPath: '/commerce/v2/orders',
    })
    expect(parseKountConfig({ KOUNT_ENVIRONMENT: 'Sandbox' })).toMatchObject({ environment: 'SANDBOX', ddcEnvironment: 'TEST', apiBaseUrl: 'https://api-sandbox.kount.com' })
  })
  it('rejects invalid policy values instead of silently defaulting', () => {
    expect(() => parseKountConfig({ KOUNT_MAX_RETRIES: '4' })).toThrow(KountConfigError)
    expect(() => parseKountConfig({ KOUNT_MAX_RETRIES: 'two' })).toThrow(KountConfigError)
    expect(() => parseKountConfig({ KOUNT_FALLBACK_DECISION: 'REVIEW' })).toThrow(KountConfigError)
    expect(() => parseKountConfig({ KOUNT_ENVIRONMENT: 'STAGING' })).toThrow(KountConfigError)
    expect(() => parseKountConfig({ KOUNT_ENVIRONMENT: 'TEST' })).toThrow(KountConfigError)
  })
  it('accepts the webhook key as bare base64 (as the portal shows it) or PEM', () => {
    const der = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA' + 'A'.repeat(300) + 'IDAQAB'
    expect(parseKountConfig({ KOUNT_WEBHOOK_PUBLIC_KEY: der }).webhookPublicKey).toBe(der)
    const pem = `-----BEGIN PUBLIC KEY-----\n${der}\n-----END PUBLIC KEY-----`
    expect(parseKountConfig({ KOUNT_WEBHOOK_PUBLIC_KEY: pem }).webhookPublicKey).toBe(pem)
    expect(() => parseKountConfig({ KOUNT_WEBHOOK_PUBLIC_KEY: 'not a key!' })).toThrow(KountConfigError)
    expect(() => parseKountConfig({ KOUNT_WEBHOOK_PUBLIC_KEY: 'aGVsbG8gd29ybGQ=' })).toThrow(KountConfigError)
  })
  it('accepts boundary retry values and normalizes case', () => {
    expect(parseKountConfig({ KOUNT_MAX_RETRIES: '0' }).maxRetries).toBe(0)
    expect(parseKountConfig({ KOUNT_MAX_RETRIES: '3' }).maxRetries).toBe(3)
    expect(parseKountConfig({ KOUNT_FALLBACK_DECISION: 'decline' }).fallbackDecision).toBe('DECLINE')
  })
})
