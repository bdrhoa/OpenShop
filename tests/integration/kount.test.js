// Integration tests for the Kount integration through the HTTP surface:
// checkout hold, signed Stripe webhook → Kount → capture, review,
// fulfillment gating, and settings parity between env and Developer Settings.
//
// Stripe API calls are mocked, but webhook signatures are generated and
// verified with the real Stripe library. Kount is reached through a stubbed
// global fetch.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createTestApp,
  createTestRequest,
  executeRequest,
  parseJsonResponse,
  createAdminToken,
  createAdminHeaders,
} from '../utils/test-helpers.js'
import { createMockEnv, createMockKV } from '../setup.js'
import { clearKountTokenCache } from '../../src/services/KountClient.js'
import { SESSION, CHARGE, LINE_ITEMS } from '../unit/kount/fixtures.js'
import { createSigner, SAMPLE_EVENT } from '../unit/kount/webhookSigner.js'

const stripeMocks = vi.hoisted(() => ({
  checkout: { sessions: { create: null, retrieve: null, listLineItems: null, list: null } },
  paymentIntents: { retrieve: null, capture: null, cancel: null },
  charges: { retrieve: null },
}))

vi.mock('stripe', async (importOriginal) => {
  const Actual = (await importOriginal()).default
  function MockStripe(key) {
    const real = new Actual(key)
    return {
      checkout: stripeMocks.checkout,
      paymentIntents: stripeMocks.paymentIntents,
      charges: stripeMocks.charges,
      webhooks: real.webhooks,
    }
  }
  MockStripe.createSubtleCryptoProvider = Actual.createSubtleCryptoProvider
  MockStripe.webhooks = new Actual('sk_test_x').webhooks
  return { default: MockStripe }
})

const WEBHOOK_SECRET = 'whsec_test_kount_integration'

async function signedWebhook(event, secret = WEBHOOK_SECRET) {
  const Stripe = (await import('stripe')).default
  const payload = JSON.stringify(event)
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret })
  return createTestRequest('/api/stripe-webhook', {
    method: 'POST',
    body: payload,
    headers: { 'stripe-signature': header, 'Content-Type': 'application/json' },
  })
}

function kountFetch(decision = 'APPROVE') {
  return vi.fn(async (url) => {
    const u = String(url)
    if (u.startsWith('https://login-uat.equifax.com/as/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 1200 }), { status: 200 })
    }
    if (u.startsWith('https://api-sandbox.kount.com/commerce/v2/orders?riskInquiry=true')) {
      return new Response(JSON.stringify({ order: { orderId: 'K1', riskInquiry: { decision }, transactions: [{ transactionId: 'K1#0' }] } }), { status: 200, headers: { 'x-correlation-id': 'corr-int' } })
    }
    if (u.startsWith('https://api-sandbox.kount.com/commerce/v2/orders/K1')) {
      return new Response(JSON.stringify({ order: { orderId: 'K1' } }), { status: 200 })
    }
    throw new Error(`unexpected fetch ${u}`)
  })
}

describe('Kount integration', () => {
  let app
  let env
  let kv
  let pi

  beforeEach(async () => {
    app = await createTestApp()
    env = createMockEnv()
    kv = createMockKV()
    env.TEST_KV = kv
    env.KOUNT_CLIENT_ID = 'client-123'
    env.KOUNT_API_KEY = 'kount-secret-key'
    env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET
    clearKountTokenCache()

    pi = { id: 'pi_test_1', status: 'requires_capture', amount: 3000, currency: 'usd', latest_charge: CHARGE, metadata: SESSION.metadata }
    stripeMocks.checkout.sessions.create = vi.fn(async () => ({ id: 'cs_new', url: 'https://checkout.stripe.com/x' }))
    stripeMocks.checkout.sessions.retrieve = vi.fn(async () => ({ id: SESSION.id, amount_total: 3000, currency: 'usd', payment_status: 'unpaid', created: 1, metadata: SESSION.metadata, customer_details: {} }))
    stripeMocks.checkout.sessions.listLineItems = vi.fn(async () => ({ data: LINE_ITEMS }))
    stripeMocks.paymentIntents.retrieve = vi.fn(async () => ({ ...pi }))
    stripeMocks.paymentIntents.capture = vi.fn(async () => { pi.status = 'succeeded'; return { ...pi } })
    stripeMocks.paymentIntents.cancel = vi.fn(async () => { pi.status = 'canceled'; return { ...pi } })
    stripeMocks.charges.retrieve = vi.fn(async (id) => ({ id, outcome: { type: 'blocked' } }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('checkout hold', () => {
    it('authorizes without capture and saves device session + IP when Kount is configured', async () => {
      const req = createTestRequest('/api/create-cart-checkout-session', {
        method: 'POST',
        body: { items: [{ priceId: 'price_1', quantity: 1 }], kountSessionId: 'f'.repeat(32) },
        headers: { 'CF-Connecting-IP': '192.0.2.44' },
      })
      const res = await executeRequest(app, req, env)
      expect(res.status).toBe(200)

      const params = stripeMocks.checkout.sessions.create.mock.calls[0][0]
      expect(params.payment_intent_data.capture_method).toBe('manual')
      expect(params.metadata.kount_hold).toBe('true')
      expect(Object.keys(params.metadata).length).toBeLessThanOrEqual(50)
      const orderId = params.metadata.openshop_order_id
      expect(params.payment_intent_data.metadata.openshop_order_id).toBe(orderId)

      const ctx = JSON.parse(await kv.get(`kount:checkout:${orderId}`))
      expect(ctx).toEqual(expect.objectContaining({ deviceSessionId: 'f'.repeat(32), userIp: '192.0.2.44' }))
    })

    it('keeps the original flow when the webhook secret is missing (nothing would capture)', async () => {
      delete env.STRIPE_WEBHOOK_SECRET
      const req = createTestRequest('/api/create-checkout-session', { method: 'POST', body: { priceId: 'price_1' } })
      await executeRequest(app, req, env)
      const params = stripeMocks.checkout.sessions.create.mock.calls[0][0]
      expect(params.payment_intent_data).toBeUndefined()
      expect(params.metadata).toBeUndefined()
    })

    it('drops a malformed device session ID', async () => {
      const req = createTestRequest('/api/create-checkout-session', { method: 'POST', body: { priceId: 'price_1', kountSessionId: '<script>' } })
      await executeRequest(app, req, env)
      const orderId = stripeMocks.checkout.sessions.create.mock.calls[0][0].metadata.openshop_order_id
      expect(JSON.parse(await kv.get(`kount:checkout:${orderId}`)).deviceSessionId).toBeNull()
    })

    it('refuses checkout when a Kount policy value is invalid', async () => {
      env.KOUNT_FALLBACK_DECISION = 'MAYBE'
      const req = createTestRequest('/api/create-checkout-session', { method: 'POST', body: { priceId: 'price_1' } })
      const res = await executeRequest(app, req, env)
      expect(res.status).toBe(500)
      expect(stripeMocks.checkout.sessions.create).not.toHaveBeenCalled()
    })
  })

  describe('GET /api/kount/config', () => {
    it('exposes only what device collection needs', async () => {
      const res = await executeRequest(app, createTestRequest('/api/kount/config'), env)
      const body = await parseJsonResponse(res)
      expect(body).toEqual({ enabled: true, clientId: 'client-123', environment: 'TEST' })
      expect(JSON.stringify(body)).not.toContain('kount-secret-key')
    })
  })

  describe('POST /api/stripe-webhook', () => {
    it('returns 503 when no signing secret is configured', async () => {
      delete env.STRIPE_WEBHOOK_SECRET
      const res = await executeRequest(app, await signedWebhook({ id: 'evt_1', type: 'ping', data: { object: {} } }), env)
      expect(res.status).toBe(503)
    })

    it('rejects an invalid signature', async () => {
      const res = await executeRequest(app, await signedWebhook({ id: 'evt_1', type: 'ping', data: { object: {} } }, 'whsec_wrong'), env)
      expect(res.status).toBe(400)
    })

    it('evaluates a held checkout with Kount and captures on APPROVE', async () => {
      vi.stubGlobal('fetch', kountFetch('APPROVE'))
      const event = { id: 'evt_ok', type: 'checkout.session.completed', data: { object: SESSION } }
      const res = await executeRequest(app, await signedWebhook(event), env)
      const body = await parseJsonResponse(res)
      expect(res.status).toBe(200)
      expect(body).toEqual(expect.objectContaining({ decision: 'APPROVE', decisionSource: 'kount' }))
      expect(stripeMocks.paymentIntents.capture).toHaveBeenCalledTimes(1)

      // Redelivery: no second evaluation or capture.
      const again = await executeRequest(app, await signedWebhook(event), env)
      expect(again.status).toBe(200)
      expect(stripeMocks.paymentIntents.capture).toHaveBeenCalledTimes(1)
      const evaluations = fetch.mock.calls.filter(([u]) => String(u).includes('riskInquiry=true'))
      expect(evaluations).toHaveLength(1)
    })

    it('returns 500 so Stripe redelivers when the payment side effect fails', async () => {
      vi.stubGlobal('fetch', kountFetch('APPROVE'))
      stripeMocks.paymentIntents.capture.mockRejectedValueOnce(new Error('stripe unavailable'))
      const event = { id: 'evt_fail', type: 'checkout.session.completed', data: { object: SESSION } }
      const res = await executeRequest(app, await signedWebhook(event), env)
      expect(res.status).toBe(500)
    })

    it('reports a Radar-blocked attempt as a data-only order', async () => {
      const fetchMock = vi.fn(async (url) => (String(url).includes('/as/token')
        ? new Response(JSON.stringify({ access_token: 'tok', expires_in: 1200 }), { status: 200 })
        : new Response(JSON.stringify({ order: { orderId: 'KD' } }), { status: 200 })))
      vi.stubGlobal('fetch', fetchMock)
      const event = { id: 'evt_pf', type: 'payment_intent.payment_failed', data: { object: { id: 'pi_f', amount: 3000, currency: 'usd', metadata: SESSION.metadata, last_payment_error: { charge: 'ch_blocked' } } } }
      const res = await executeRequest(app, await signedWebhook(event), env)
      expect(res.status).toBe(200)
      const call = fetchMock.mock.calls.find(([u]) => String(u).includes('riskInquiry=false'))
      const sent = JSON.parse(call[1].body)
      expect(sent.transactions[0]).toEqual(expect.objectContaining({ transactionStatus: 'REFUSED', authorizationStatus: expect.objectContaining({ authResult: 'UNKNOWN' }) }))
    })
  })

  describe('review and fulfillment gating', () => {
    it('blocks fulfillment during REVIEW, and allows it after a reviewer approves', async () => {
      vi.stubGlobal('fetch', kountFetch('REVIEW'))
      const adminToken = await createAdminToken(env, kv)
      const event = { id: 'evt_rev', type: 'checkout.session.completed', data: { object: SESSION } }
      expect((await executeRequest(app, await signedWebhook(event), env)).status).toBe(200)
      expect(stripeMocks.paymentIntents.capture).not.toHaveBeenCalled()

      const fulfill = () => executeRequest(app, createTestRequest(`/api/admin/analytics/orders/${SESSION.id}/fulfill`, { method: 'POST', headers: createAdminHeaders(adminToken) }), env)
      expect((await fulfill()).status).toBe(409)

      const buyer = await parseJsonResponse(await executeRequest(app, createTestRequest(`/api/checkout-session/${SESSION.id}`), env))
      expect(buyer.order_status).toBe('received')
      expect(buyer).not.toHaveProperty('held')

      const review = await executeRequest(app, createTestRequest(`/api/admin/kount/orders/${SESSION.id}/review`, {
        method: 'POST',
        headers: createAdminHeaders(adminToken),
        body: { decision: 'APPROVE' },
      }), env)
      expect(review.status).toBe(200)
      expect(stripeMocks.paymentIntents.capture).toHaveBeenCalledTimes(1)
      expect((await fulfill()).status).toBe(200)
    })

    it('rejects review endpoints without admin auth', async () => {
      const res = await executeRequest(app, createTestRequest(`/api/admin/kount/orders/${SESSION.id}/review`, { method: 'POST', body: { decision: 'APPROVE' } }), env)
      expect(res.status).toBe(401)
    })
  })

  describe('Developer Settings parity', () => {
    let adminToken
    beforeEach(async () => {
      adminToken = await createAdminToken(env, kv)
    })

    const put = (body) => executeRequest(app, createTestRequest('/api/admin/developer-settings', {
      method: 'PUT',
      headers: createAdminHeaders(adminToken),
      body: JSON.stringify(body),
    }), env)

    it('lists every Kount setting without exposing secrets', async () => {
      const res = await executeRequest(app, createTestRequest('/api/admin/developer-settings', { headers: createAdminHeaders(adminToken) }), env)
      const body = await parseJsonResponse(res)
      const keys = body.fields.filter((f) => f.group === 'kount').map((f) => f.key)
      expect(keys).toEqual(expect.arrayContaining(['KOUNT_CLIENT_ID', 'KOUNT_API_KEY', 'KOUNT_MAX_RETRIES', 'KOUNT_FALLBACK_DECISION', 'KOUNT_CHANNEL', 'KOUNT_SHIPPING_METHOD', 'KOUNT_ENVIRONMENT', 'STRIPE_WEBHOOK_SECRET']))
      expect(JSON.stringify(body)).not.toContain('kount-secret-key')
      expect(JSON.stringify(body)).not.toContain(WEBHOOK_SECRET)

      const envField = body.fields.find((f) => f.key === 'KOUNT_ENVIRONMENT')
      expect(envField.options).toEqual([{ value: 'SANDBOX', label: 'Sandbox' }, { value: 'PRODUCTION', label: 'Production' }])
      expect(envField.defaultValue).toBe('SANDBOX')
      expect(body.fields.map((f) => f.key)).not.toEqual(expect.arrayContaining(['KOUNT_TOKEN_URL']))
    })

    it('rejects an unknown environment', async () => {
      const res = await put({ KOUNT_ENVIRONMENT: 'STAGING' })
      expect(res.status).toBe(400)
      expect((await parseJsonResponse(res)).error).toMatch(/KOUNT_ENVIRONMENT/)
    })

    it('Production sends token and order calls to the production hosts', async () => {
      env.KOUNT_ENVIRONMENT = 'PRODUCTION'
      const fetchMock = vi.fn(async (url) => (String(url).includes('/as/token')
        ? new Response(JSON.stringify({ access_token: 'tok', expires_in: 1200 }), { status: 200 })
        : new Response(JSON.stringify({ order: { orderId: 'K1', riskInquiry: { decision: 'APPROVE' } } }), { status: 200 })))
      vi.stubGlobal('fetch', fetchMock)
      const event = { id: 'evt_prod', type: 'checkout.session.completed', data: { object: SESSION } }
      expect((await executeRequest(app, await signedWebhook(event), env)).status).toBe(200)
      const urls = fetchMock.mock.calls.map(([u]) => String(u))
      expect(urls[0]).toBe('https://login.equifax.com/as/token')
      expect(urls[1]).toBe('https://api.kount.com/commerce/v2/orders?riskInquiry=true')
    })

    it('rejects invalid policy values with the same rules as env', async () => {
      const res = await put({ KOUNT_FALLBACK_DECISION: 'REVIEW' })
      expect(res.status).toBe(400)
      expect((await parseJsonResponse(res)).error).toMatch(/KOUNT_FALLBACK_DECISION/)
      expect((await put({ KOUNT_MAX_RETRIES: '7' })).status).toBe(400)
      expect((await put({ KOUNT_SHIPPING_METHOD: 'OVERNIGHT' })).status).toBe(400)
    })

    it('a saved value takes effect on the next operation; clearing it restores env', async () => {
      expect((await put({ KOUNT_ENVIRONMENT: 'PRODUCTION', KOUNT_FALLBACK_DECISION: 'DECLINE', KOUNT_MAX_RETRIES: '0', KOUNT_SHIPPING_METHOD: 'NEXT_DAY' })).status).toBe(200)
      let config = await parseJsonResponse(await executeRequest(app, createTestRequest('/api/kount/config'), env))
      expect(config.environment).toBe('PROD')

      const status = await parseJsonResponse(await executeRequest(app, createTestRequest('/api/admin/kount/status', { headers: createAdminHeaders(adminToken) }), env))
      expect(status).toEqual(expect.objectContaining({
        fallbackDecision: 'DECLINE',
        maxRetries: 0,
        shippingMethod: 'NEXT_DAY',
        holdingCheckouts: true,
        environment: 'PRODUCTION',
        tokenUrl: 'https://login.equifax.com/as/token',
        apiBaseUrl: 'https://api.kount.com',
      }))

      await put({ KOUNT_ENVIRONMENT: '' })
      config = await parseJsonResponse(await executeRequest(app, createTestRequest('/api/kount/config'), env))
      expect(config.environment).toBe('TEST')
    })
  })

  describe('POST /api/kount-webhook', () => {
    let signer
    beforeEach(async () => {
      signer = signer || await createSigner()
      env.KOUNT_WEBHOOK_PUBLIC_KEY = signer.publicKeyBase64
    })

    async function kountDelivery(body, { timestamp = new Date().toISOString(), signWith = signer } = {}) {
      const raw = JSON.stringify(body)
      return createTestRequest('/api/kount-webhook', {
        method: 'POST',
        body: raw,
        headers: {
          'Content-Type': 'application/json',
          'X-Event-Timestamp': timestamp,
          'X-Event-Signature': await signWith.sign(timestamp, raw),
        },
      })
    }

    async function reviewOrder() {
      vi.stubGlobal('fetch', kountFetch('REVIEW'))
      const res = await executeRequest(app, await signedWebhook({ id: 'evt_r', type: 'checkout.session.completed', data: { object: SESSION } }), env)
      expect(res.status).toBe(200)
    }

    it('returns 503 until the public key is configured', async () => {
      delete env.KOUNT_WEBHOOK_PUBLIC_KEY
      const res = await executeRequest(app, await kountDelivery(SAMPLE_EVENT), env)
      expect(res.status).toBe(503)
    })

    it('rejects a bad signature (401) and a stale timestamp (400)', async () => {
      const other = await createSigner()
      expect((await executeRequest(app, await kountDelivery(SAMPLE_EVENT, { signWith: other }), env)).status).toBe(401)
      const stale = new Date(Date.now() - 50 * 60 * 1000).toISOString()
      expect((await executeRequest(app, await kountDelivery(SAMPLE_EVENT, { timestamp: stale }), env)).status).toBe(400)
    })

    it('a portal APPROVE captures a REVIEW order and unblocks fulfillment', async () => {
      await reviewOrder()
      const res = await executeRequest(app, await kountDelivery({ ...SAMPLE_EVENT, id: 'evt-portal-1', kountOrderId: 'K1', merchantOrderId: 'order-1', newValue: 'APPROVE' }), env)
      expect(res.status).toBe(200)
      expect((await parseJsonResponse(res)).outcome).toBe('approved')
      expect(stripeMocks.paymentIntents.capture).toHaveBeenCalledTimes(1)

      // The status update went to Kount without echoing the decision back.
      const patch = fetch.mock.calls.find(([u, init]) => String(u).endsWith('/commerce/v2/orders/K1') && init.method === 'PATCH')
      const sent = JSON.parse(patch[1].body)
      expect(sent.transactions[0].transactionStatus).toBe('CAPTURED')
      expect(sent).not.toHaveProperty('riskInquiry')

      const adminToken = await createAdminToken(env, kv)
      const fulfill = await executeRequest(app, createTestRequest(`/api/admin/analytics/orders/${SESSION.id}/fulfill`, { method: 'POST', headers: createAdminHeaders(adminToken) }), env)
      expect(fulfill.status).toBe(200)
    })

    it('acknowledges events for unknown orders without side effects', async () => {
      const res = await executeRequest(app, await kountDelivery(SAMPLE_EVENT), env)
      expect(res.status).toBe(200)
      expect((await parseJsonResponse(res)).outcome).toBe('unknown_order')
      expect(stripeMocks.paymentIntents.cancel).not.toHaveBeenCalled()
    })

    it('returns 500 when the payment step fails so Kount retries', async () => {
      await reviewOrder()
      stripeMocks.paymentIntents.cancel.mockRejectedValueOnce(new Error('stripe down'))
      const body = { ...SAMPLE_EVENT, id: 'evt-portal-2', kountOrderId: 'K1', merchantOrderId: 'order-1', newValue: 'DECLINE' }
      expect((await executeRequest(app, await kountDelivery(body), env)).status).toBe(500)
      const retry = await executeRequest(app, await kountDelivery(body), env)
      expect((await parseJsonResponse(retry)).outcome).toBe('declined')
      expect(stripeMocks.paymentIntents.cancel).toHaveBeenCalledTimes(2)
    })
  })

  describe('read-only webhook URLs in Developer Settings', () => {
    it('shows the Kount and Stripe webhook URLs from the Site URL, and validates the public key', async () => {
      const adminToken = await createAdminToken(env, kv)
      const res = await executeRequest(app, createTestRequest('/api/admin/developer-settings', { headers: createAdminHeaders(adminToken) }), env)
      const body = await parseJsonResponse(res)
      expect(body.endpoints).toEqual([
        expect.objectContaining({ key: 'KOUNT_WEBHOOK_URL', url: 'https://test.workers.dev/api/kount-webhook' }),
        expect.objectContaining({ key: 'STRIPE_WEBHOOK_URL', url: 'https://test.workers.dev/api/stripe-webhook' }),
      ])
      expect(body.fields.map((f) => f.key)).not.toContain('KOUNT_WEBHOOK_URL') // display-only, not a setting

      const bad = await executeRequest(app, createTestRequest('/api/admin/developer-settings', {
        method: 'PUT',
        headers: createAdminHeaders(adminToken),
        body: JSON.stringify({ KOUNT_WEBHOOK_PUBLIC_KEY: 'not a key!' }),
      }), env)
      expect(bad.status).toBe(400)
    })
  })
})
