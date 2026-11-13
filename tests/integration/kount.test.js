// Integration tests for the Kount fraud review wiring (routes + services).
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest'
import { createTestApp, createTestRequest, executeRequest, parseJsonResponse, createStripePriceId, createAdminToken, createAdminHeaders } from '../utils/test-helpers.js'
import { createMockEnv } from '../setup.js'
import { resetKountTokenCache } from '../../src/services/KountService.js'
import { KOUNT_KV_PREFIX } from '../../src/config/kount.js'

const stripeMock = vi.hoisted(() => ({
  checkout: { sessions: { create: vi.fn(), retrieve: vi.fn(), listLineItems: vi.fn(), list: vi.fn() } },
  paymentIntents: { capture: vi.fn(), cancel: vi.fn(), retrieve: vi.fn() },
  refunds: { create: vi.fn() },
  charges: { retrieve: vi.fn() },
  webhooks: { constructEventAsync: vi.fn() },
}))

vi.mock('stripe', () => {
  const Stripe = vi.fn(() => stripeMock)
  Stripe.createSubtleCryptoProvider = vi.fn(() => ({}))
  return { default: Stripe }
})

function toBase64(buffer) {
  return Buffer.from(new Uint8Array(buffer)).toString('base64')
}

let keyPair
let publicKeyB64

beforeAll(async () => {
  keyPair = await crypto.subtle.generateKey(
    { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )
  publicKeyB64 = toBase64(await crypto.subtle.exportKey('spki', keyPair.publicKey))
})

async function signedKountRequest(payload, { timestamp = new Date().toISOString(), tamper = false } = {}) {
  const body = JSON.stringify(payload)
  const sig = await crypto.subtle.sign({ name: 'RSA-PSS', saltLength: 32 }, keyPair.privateKey, new TextEncoder().encode(`${timestamp}${body}`))
  return createTestRequest('/api/kount-webhook', {
    method: 'POST',
    body: tamper ? body.replace('APPROVE', 'DECLINE') : body,
    headers: { 'Content-Type': 'application/json', 'X-Event-Timestamp': timestamp, 'X-Event-Signature': toBase64(sig) },
  })
}

function heldSession() {
  return {
    id: 'cs_test_kount',
    currency: 'usd',
    amount_total: 1500,
    amount_subtotal: 1500,
    customer_details: { email: 'buyer@example.com' },
    payment_intent: {
      id: 'pi_test_kount',
      amount: 1500,
      currency: 'usd',
      status: 'requires_capture',
      metadata: { kount_hold: '1', kount_device_session_id: 'abc123' },
      latest_charge: { id: 'ch_1', payment_method_details: { card: { brand: 'visa', last4: '4242' } } },
    },
  }
}

describe('Kount integration', () => {
  let app
  let env
  let fetchSpy

  beforeEach(async () => {
    vi.clearAllMocks()
    resetKountTokenCache()
    app = await createTestApp()
    env = createMockEnv()
    env.KOUNT_CLIENT_ID = 'synthetic-client'
    env.KOUNT_API_KEY = 'synthetic-key'
    env.KOUNT_WEBHOOK_PUBLIC_KEY = publicKeyB64
    env.STRIPE_WEBHOOK_SECRET = 'whsec_synthetic'

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('/as/token')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 1200 }), { status: 200 })
      }
      if (String(url).includes('/commerce/v2/orders')) {
        return new Response(JSON.stringify({
          order: { orderId: 'K1', transactions: [{ transactionId: 'K1#0' }], riskInquiry: { decision: 'REVIEW' } },
        }), { status: 200 })
      }
      throw new Error(`unexpected fetch ${url}`)
    })
  })

  it('exposes the Kount client id (never the API key) in payments-status', async () => {
    const response = await executeRequest(app, createTestRequest('/api/payments-status'), env)
    const data = await parseJsonResponse(response)
    expect(data.fraudPrevention).toEqual({ provider: 'kount', clientId: 'synthetic-client', environment: 'TEST' })
    expect(JSON.stringify(data)).not.toContain('synthetic-key')
  })

  it('reports no fraud prevention when Kount is not configured', async () => {
    delete env.KOUNT_API_KEY
    const data = await parseJsonResponse(await executeRequest(app, createTestRequest('/api/payments-status'), env))
    expect(data.fraudPrevention).toBeNull()
  })

  it('creates a manual-capture checkout with the device session id when Kount is on', async () => {
    stripeMock.checkout.sessions.create.mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.com/x' })
    const request = createTestRequest('/api/create-checkout-session', {
      method: 'POST',
      body: { priceId: createStripePriceId(), kountSessionId: 'abc123' },
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.5' },
    })
    expect((await executeRequest(app, request, env)).status).toBe(200)
    expect(stripeMock.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      payment_intent_data: {
        capture_method: 'manual',
        metadata: { kount_hold: '1', kount_device_session_id: 'abc123', kount_user_ip: '192.0.2.5' },
      },
    }))
  })

  it('leaves checkout unchanged when Kount is off', async () => {
    delete env.KOUNT_CLIENT_ID
    stripeMock.checkout.sessions.create.mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.com/x' })
    const request = createTestRequest('/api/create-cart-checkout-session', {
      method: 'POST',
      body: { items: [{ priceId: createStripePriceId(), quantity: 1 }], kountSessionId: 'abc123' },
    })
    expect((await executeRequest(app, request, env)).status).toBe(200)
    expect(stripeMock.checkout.sessions.create.mock.calls[0][0].payment_intent_data).toBeUndefined()
  })

  it('captures a REVIEW order, blocks fulfillment, then refunds when a reviewer declines', async () => {
    stripeMock.webhooks.constructEventAsync.mockResolvedValue({ type: 'checkout.session.completed', data: { object: { id: 'cs_test_kount' } } })
    stripeMock.checkout.sessions.retrieve.mockResolvedValue(heldSession())
    stripeMock.checkout.sessions.listLineItems.mockResolvedValue({ data: [] })
    stripeMock.paymentIntents.capture.mockResolvedValue({ id: 'pi_test_kount', status: 'succeeded' })
    stripeMock.paymentIntents.retrieve.mockResolvedValue({ id: 'pi_test_kount', status: 'succeeded' })
    stripeMock.refunds.create.mockResolvedValue({ id: 're_1', status: 'succeeded', amount: 1500 })

    const stripeRes = await executeRequest(app, createTestRequest('/api/stripe-webhook', {
      method: 'POST', body: '{}', headers: { 'stripe-signature': 't=1,v1=x' },
    }), env)
    expect(stripeRes.status).toBe(200)
    expect((await parseJsonResponse(stripeRes)).state).toBe('review_captured')
    expect(stripeMock.paymentIntents.capture).toHaveBeenCalledWith('pi_test_kount', {}, { idempotencyKey: 'kount-capture-pi_test_kount' })

    const token = await createAdminToken(env, env.TEST_KV)
    const blocked = await executeRequest(app, createTestRequest('/api/admin/analytics/orders/cs_test_kount/fulfill', {
      method: 'POST', headers: createAdminHeaders(token),
    }), env)
    expect(blocked.status).toBe(409)
    expect(await env.TEST_KV.get('order_fulfillment:cs_test_kount')).toBeNull()

    const orderCall = fetchSpy.mock.calls.find(([url]) => String(url).includes('/commerce/v2/orders'))
    expect(JSON.parse(orderCall[1].body)).toMatchObject({ merchantOrderId: 'cs_test_kount', deviceSessionId: 'abc123' })

    const kountRes = await executeRequest(app, await signedKountRequest({
      eventType: 'Order.StatusChange', fieldName: 'status', kountOrderId: 'K1', merchantOrderId: 'cs_test_kount', newValue: 'DECLINE',
    }), env)
    expect(kountRes.status).toBe(200)
    expect((await parseJsonResponse(kountRes)).state).toBe('review_declined_refunded')
    expect(stripeMock.refunds.create).toHaveBeenCalledWith(
      { payment_intent: 'pi_test_kount', reason: 'fraudulent', metadata: { checkout_session_id: 'cs_test_kount' } },
      { idempotencyKey: 'kount-refund-pi_test_kount' },
    )
    expect(stripeMock.paymentIntents.capture).toHaveBeenCalledTimes(1)

    const stored = JSON.parse(await env.TEST_KV.get(`${KOUNT_KV_PREFIX}cs_test_kount`))
    expect(stored.state).toBe('review_declined_refunded')
  })

  it('settles a pending reviewer-decline refund from a Stripe refund.updated event', async () => {
    const pending = {
      checkoutSessionId: 'cs_test_kount', paymentIntentId: 'pi_test_kount', amount: 1500,
      state: 'review_declined_refund_pending', refundId: 're_1', decision: 'REVIEW', history: [{}],
    }
    await env.TEST_KV.put(`${KOUNT_KV_PREFIX}cs_test_kount`, JSON.stringify(pending))
    stripeMock.webhooks.constructEventAsync.mockResolvedValue({
      type: 'refund.updated',
      data: { object: { id: 're_1', status: 'succeeded', amount: 1500, payment_intent: 'pi_test_kount', metadata: { checkout_session_id: 'cs_test_kount' } } },
    })
    const res = await executeRequest(app, createTestRequest('/api/stripe-webhook', {
      method: 'POST', body: '{}', headers: { 'stripe-signature': 't=1,v1=x' },
    }), env)
    expect(res.status).toBe(200)
    expect((await parseJsonResponse(res)).state).toBe('review_declined_refunded')
  })

  it('tells the buyer a held order is processing, then declined after Kount declines', async () => {
    stripeMock.checkout.sessions.retrieve.mockResolvedValue({
      id: 'cs_test_kount', payment_status: 'unpaid',
      payment_intent: { id: 'pi_test_kount', metadata: { kount_hold: '1' } },
    })
    const lookup = () => executeRequest(app, createTestRequest('/api/checkout-session/cs_test_kount'), env)
    let data = await parseJsonResponse(await lookup())
    expect(data.order_status).toBe('processing')
    expect(data).not.toHaveProperty('fraud_hold')

    await env.TEST_KV.put(`${KOUNT_KV_PREFIX}cs_test_kount`, JSON.stringify({ state: 'declined_canceled' }))
    data = await parseJsonResponse(await lookup())
    expect(data.order_status).toBe('declined')
    expect(Object.keys(data).sort()).toEqual(['id', 'order_status', 'payment_status'])
  })

  it('reports a Radar-blocked attempt to Kount without a risk inquiry', async () => {
    stripeMock.webhooks.constructEventAsync.mockResolvedValue({
      type: 'payment_intent.payment_failed',
      data: { object: {
        id: 'pi_test_kount',
        metadata: { kount_hold: '1', kount_device_session_id: 'abc123' },
        last_payment_error: { charge: 'ch_blocked' },
      } },
    })
    stripeMock.charges.retrieve.mockResolvedValue({
      id: 'ch_blocked',
      outcome: { type: 'blocked', reason: 'blocklist' },
      billing_details: { email: 'buyer@example.com' },
      payment_method_details: { card: { brand: 'visa', last4: '4242', fingerprint: 'fp', checks: { cvc_check: 'unavailable' } } },
    })
    stripeMock.checkout.sessions.list.mockResolvedValue({ data: [{ id: 'cs_test_kount', currency: 'usd', amount_total: 1500 }] })
    stripeMock.checkout.sessions.listLineItems.mockResolvedValue({ data: [] })

    const send = () => executeRequest(app, createTestRequest('/api/stripe-webhook', {
      method: 'POST', body: '{}', headers: { 'stripe-signature': 't=1,v1=x' },
    }), env)
    const res = await send()
    expect(res.status).toBe(200)
    expect((await parseJsonResponse(res)).state).toBe('submitted')

    const orderCalls = fetchSpy.mock.calls.filter(([url]) => String(url).includes('/commerce/v2/orders'))
    expect(orderCalls).toHaveLength(1)
    expect(String(orderCalls[0][0])).toContain('riskInquiry=false')
    const tx = JSON.parse(orderCalls[0][1].body).transactions[0]
    expect(tx.transactionStatus).toBe('REFUSED')
    expect(tx.authorizationStatus).toMatchObject({
      authResult: 'UNKNOWN', declineCode: 'stripe_radar_blocklist', verificationResponse: { cvvStatus: 'UNKNOWN' },
    })
    expect(tx.authorizationStatus.verificationResponse).not.toHaveProperty('avsStatus')

    // A redelivery of the same event is not sent again.
    expect((await send()).status).toBe(200)
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('/commerce/v2/orders'))).toHaveLength(1)
  })

  it('rejects Stripe webhooks with a bad signature or without configuration', async () => {
    stripeMock.webhooks.constructEventAsync.mockRejectedValue(new Error('bad sig'))
    const bad = await executeRequest(app, createTestRequest('/api/stripe-webhook', {
      method: 'POST', body: '{}', headers: { 'stripe-signature': 'x' },
    }), env)
    expect(bad.status).toBe(400)

    delete env.STRIPE_WEBHOOK_SECRET
    const off = await executeRequest(app, createTestRequest('/api/stripe-webhook', {
      method: 'POST', body: '{}', headers: { 'stripe-signature': 'x' },
    }), env)
    expect(off.status).toBe(503)
  })

  it('rejects Kount webhooks with a bad signature or stale timestamp', async () => {
    const payload = { eventType: 'Order.StatusChange', fieldName: 'status', kountOrderId: 'K1', newValue: 'APPROVE' }
    const tampered = await executeRequest(app, await signedKountRequest(payload, { tamper: true }), env)
    expect(tampered.status).toBe(401)

    const stale = await executeRequest(app, await signedKountRequest(payload, {
      timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    }), env)
    expect(stale.status).toBe(401)
  })

  it('lists fraud review records for admins only', async () => {
    const res = await executeRequest(app, createTestRequest('/api/admin/fraud-reviews'), env)
    expect(res.status).toBe(401)
  })
})
