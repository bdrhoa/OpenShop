// Integration tests: Kount screening wired through the HTTP routes.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestApp, createTestRequest, executeRequest, parseJsonResponse, createAdminToken, createAdminHeaders } from '../utils/test-helpers.js'
import { createMockEnv, createMockKV } from '../setup.js'
import { clearKountTokenCache } from '../../src/services/KountService.js'

const stripeClient = vi.hoisted(() => ({
  checkout: { sessions: { create: vi.fn(), retrieve: vi.fn(), list: vi.fn() } },
  paymentIntents: { retrieve: vi.fn(), capture: vi.fn(), cancel: vi.fn() },
  charges: { retrieve: vi.fn() },
}))

// Fake API client, real webhook signing/verification.
vi.mock('stripe', async (importOriginal) => {
  const actual = (await importOriginal()).default
  const Fake = vi.fn(() => stripeClient)
  Fake.webhooks = actual.webhooks
  Fake.createSubtleCryptoProvider = actual.createSubtleCryptoProvider
  return { default: Fake }
})

const WEBHOOK_SECRET = 'whsec_test_kount'
const SESSION_ID = 'cs_test_kount_int'

async function stripeWebhookRequest(event, secret = WEBHOOK_SECRET) {
  const { default: Stripe } = await import('stripe')
  const payload = JSON.stringify(event)
  const header = await Stripe.webhooks.generateTestHeaderStringAsync({
    payload,
    secret,
    cryptoProvider: Stripe.createSubtleCryptoProvider(),
  })
  return createTestRequest('/api/stripe-webhook', {
    method: 'POST',
    body: payload,
    headers: { 'Content-Type': 'application/json', 'stripe-signature': header },
  })
}

function kountEnv() {
  const env = createMockEnv()
  env.TEST_KV = createMockKV()
  env.KOUNT_CLIENT_ID = '900900'
  env.KOUNT_API_KEY = 'portal-key'
  env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET
  return env
}

describe('Kount integration routes', () => {
  let app
  let env
  let fetchSpy

  beforeEach(async () => {
    vi.clearAllMocks()
    clearKountTokenCache()
    app = await createTestApp()
    env = kountEnv()
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  describe('GET /api/kount/config', () => {
    it('enables device data collection whenever a client ID is set', async () => {
      let res = await executeRequest(app, createTestRequest('/api/kount/config'), env)
      expect(await parseJsonResponse(res)).toEqual({ enabled: true, ddcEnabled: true, clientId: '900900', environment: 'TEST' })

      delete env.STRIPE_WEBHOOK_SECRET
      res = await executeRequest(app, createTestRequest('/api/kount/config'), env)
      expect(await parseJsonResponse(res)).toEqual({ enabled: false, ddcEnabled: true, clientId: '900900', environment: 'TEST' })

      delete env.KOUNT_CLIENT_ID
      res = await executeRequest(app, createTestRequest('/api/kount/config'), env)
      expect(await parseJsonResponse(res)).toEqual({ enabled: false, ddcEnabled: false, clientId: null, environment: null })
    })
  })

  describe('checkout creation', () => {
    it('holds payment and carries the device session when Kount is enabled', async () => {
      stripeClient.checkout.sessions.create.mockResolvedValue({ id: SESSION_ID, url: 'https://checkout.stripe.com/x' })
      const req = createTestRequest('/api/create-cart-checkout-session', {
        method: 'POST',
        body: { items: [{ stripePriceId: 'price_1', quantity: 1 }], kountSessionId: 'abcdef0123456789abcdef0123456789' },
        headers: { 'CF-Connecting-IP': '192.0.2.44' },
      })
      const res = await executeRequest(app, req, env)
      expect(res.status).toBe(200)
      const params = stripeClient.checkout.sessions.create.mock.calls[0][0]
      expect(params.payment_intent_data).toEqual({
        capture_method: 'manual',
        metadata: { kount_hold: 'true', kount_session_id: 'abcdef0123456789abcdef0123456789', kount_user_ip: '192.0.2.44' },
      })
      expect(params.metadata.kount_hold).toBe('true')
      expect(Object.keys(params.metadata).length).toBeLessThanOrEqual(50)
    })

    it('ignores an invalid device session ID but still screens', async () => {
      stripeClient.checkout.sessions.create.mockResolvedValue({ id: SESSION_ID, url: 'https://checkout.stripe.com/x' })
      const req = createTestRequest('/api/create-checkout-session', { method: 'POST', body: { priceId: 'price_1', kountSessionId: 'bad id!' } })
      await executeRequest(app, req, env)
      const params = stripeClient.checkout.sessions.create.mock.calls[0][0]
      expect(params.payment_intent_data.capture_method).toBe('manual')
      expect(params.metadata.kount_session_id).toBeUndefined()
    })

    it('does not hold payment when Kount is not configured', async () => {
      delete env.KOUNT_API_KEY
      stripeClient.checkout.sessions.create.mockResolvedValue({ id: SESSION_ID, url: 'https://checkout.stripe.com/x' })
      await executeRequest(app, createTestRequest('/api/create-checkout-session', { method: 'POST', body: { priceId: 'price_1' } }), env)
      const params = stripeClient.checkout.sessions.create.mock.calls[0][0]
      expect(params.payment_intent_data).toBeUndefined()
      expect(params.metadata).toBeUndefined()
    })
  })

  describe('POST /api/stripe-webhook', () => {
    it('rejects an invalid signature', async () => {
      const req = await stripeWebhookRequest({ id: 'evt_1', type: 'checkout.session.completed', data: { object: {} } }, 'whsec_wrong')
      const res = await executeRequest(app, req, env)
      expect(res.status).toBe(400)
    })

    it('acknowledges an unheld checkout without calling Kount', async () => {
      const req = await stripeWebhookRequest({ id: 'evt_2', type: 'checkout.session.completed', data: { object: { id: SESSION_ID, metadata: {} } } })
      const res = await executeRequest(app, req, env)
      expect(await parseJsonResponse(res)).toMatchObject({ received: true, handled: false, reason: 'not_held' })
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('evaluates a held checkout, captures on APPROVE, and the success page reports confirmed', async () => {
      const pi = { id: 'pi_1', status: 'requires_capture', latest_charge: { id: 'ch_1', payment_method_details: { card: { last4: '4242', checks: {} } } } }
      stripeClient.checkout.sessions.retrieve.mockImplementation(async () => ({
        id: SESSION_ID,
        amount_total: 1000,
        amount_subtotal: 1000,
        currency: 'usd',
        payment_status: 'unpaid',
        metadata: { kount_hold: 'true', kount_session_id: 'abc' },
        line_items: { data: [{ quantity: 1, price: { unit_amount: 1000, product: { id: 'prod_1', name: 'Mug' } } }] },
        payment_intent: pi,
      }))
      stripeClient.paymentIntents.retrieve.mockResolvedValue(pi)
      stripeClient.paymentIntents.capture.mockImplementation(async () => { pi.status = 'succeeded'; return pi })

      fetchSpy.mockImplementation(async (url) => {
        const u = String(url)
        if (u.startsWith('https://login-uat.equifax.com')) return Response.json({ access_token: 't', expires_in: 1200 })
        if (u.includes('/commerce/v2/orders?riskInquiry=true')) return Response.json({ order: { orderId: 'K1', riskInquiry: { decision: 'APPROVE' }, transactions: [{ transactionId: 'K1#0' }] } })
        if (u.endsWith('/commerce/v2/orders/K1')) return Response.json({})
        throw new Error(`unexpected fetch ${u}`)
      })

      const req = await stripeWebhookRequest({ id: 'evt_3', type: 'checkout.session.completed', data: { object: { id: SESSION_ID, metadata: { kount_hold: 'true' } } } })
      const res = await executeRequest(app, req, env)
      expect(res.status).toBe(200)
      expect(await parseJsonResponse(res)).toMatchObject({ handled: true, status: 'approved' })
      expect(stripeClient.paymentIntents.capture).toHaveBeenCalledTimes(1)

      const status = await executeRequest(app, createTestRequest(`/api/checkout-session/${SESSION_ID}`), env)
      const body = await parseJsonResponse(status)
      expect(body.orderStatus).toBe('confirmed')
      expect(body.kountHold).toBeUndefined()
    })

    describe('when Kount stays unavailable', () => {
      let pi
      beforeEach(() => {
        pi = { id: 'pi_1', status: 'requires_capture', latest_charge: { id: 'ch_1' } }
        stripeClient.checkout.sessions.retrieve.mockResolvedValue({ id: SESSION_ID, metadata: { kount_hold: 'true' }, line_items: { data: [] }, payment_intent: pi })
        stripeClient.paymentIntents.retrieve.mockResolvedValue(pi)
        stripeClient.paymentIntents.capture.mockImplementation(async () => { pi.status = 'succeeded'; return pi })
        stripeClient.paymentIntents.cancel.mockImplementation(async () => { pi.status = 'canceled'; return pi })
        fetchSpy.mockImplementation(async () => new Response('', { status: 503 }))
        env.KOUNT_MAX_RETRIES = '1'
      })

      async function deliver() {
        const req = await stripeWebhookRequest({ id: 'evt_4', type: 'checkout.session.completed', data: { object: { id: SESSION_ID, metadata: { kount_hold: 'true' } } } })
        return executeRequest(app, req, env)
      }

      it('retries the configured number of times, then applies the APPROVE fallback', async () => {
        const res = await deliver()
        expect(res.status).toBe(200)
        expect(await parseJsonResponse(res)).toMatchObject({ handled: true, status: 'approved' })
        expect(fetchSpy).toHaveBeenCalledTimes(2) // first attempt + 1 retry
        expect(stripeClient.paymentIntents.capture).toHaveBeenCalledTimes(1)
      })

      it('applies a DECLINE fallback when configured', async () => {
        env.KOUNT_FALLBACK_DECISION = 'DECLINE'
        const res = await deliver()
        expect(await parseJsonResponse(res)).toMatchObject({ handled: true, status: 'declined' })
        expect(stripeClient.paymentIntents.cancel).toHaveBeenCalledTimes(1)
        expect(stripeClient.paymentIntents.capture).not.toHaveBeenCalled()
      })
    })
  })

  describe('POST /api/kount-webhook', () => {
    it('refuses deliveries when no public key is configured', async () => {
      const req = createTestRequest('/api/kount-webhook', { method: 'POST', body: { eventType: 'Order.StatusChange' } })
      const res = await executeRequest(app, req, env)
      expect(res.status).toBe(503)
    })
  })

  describe('admin review API', () => {
    it('requires admin auth', async () => {
      const res = await executeRequest(app, createTestRequest(`/api/admin/kount/orders/${SESSION_ID}/resolve`, { method: 'POST', body: { decision: 'APPROVE' } }), env)
      expect(res.status).toBe(401)
    })

    it('resolves a REVIEW order', async () => {
      const kv = env.TEST_KV
      await kv.put(`kount:order:${SESSION_ID}`, JSON.stringify({
        checkoutSessionId: SESSION_ID, paymentIntentId: 'pi_1', status: 'review', decision: 'REVIEW',
        kountOrderId: 'K1', kountTransactionId: 'K1#0', payment: 'authorized', fulfillmentAllowed: false, kountStatusReported: 'AUTHORIZED',
        createdAt: '2026-11-17T00:00:00Z',
      }))
      const pi = { id: 'pi_1', status: 'requires_capture' }
      stripeClient.paymentIntents.retrieve.mockResolvedValue(pi)
      stripeClient.paymentIntents.cancel.mockImplementation(async () => { pi.status = 'canceled'; return pi })
      fetchSpy.mockImplementation(async (url) => (String(url).startsWith('https://login-uat') ? Response.json({ access_token: 't', expires_in: 1200 }) : Response.json({})))

      const token = await createAdminToken(env, kv)
      const list = await executeRequest(app, createTestRequest('/api/admin/kount/orders?status=review', { headers: createAdminHeaders(token) }), env)
      expect((await parseJsonResponse(list)).orders).toHaveLength(1)

      const res = await executeRequest(app, createTestRequest(`/api/admin/kount/orders/${SESSION_ID}/resolve`, {
        method: 'POST', body: { decision: 'decline' }, headers: createAdminHeaders(token),
      }), env)
      expect(res.status).toBe(200)
      expect((await parseJsonResponse(res)).order).toMatchObject({ status: 'declined', payment: 'canceled', decisionSource: 'admin' })
    })
  })
})
