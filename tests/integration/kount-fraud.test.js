// Route-level tests for Kount fraud screening: webhook processors, the
// fulfillment gate, Developer Settings parity, and checkout wiring.
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest'
import {
  createTestApp,
  createTestRequest,
  executeRequest,
  parseJsonResponse,
  createAdminToken,
  createAdminHeaders,
} from '../utils/test-helpers.js'
import { createMockEnv, createMockKV } from '../setup.js'
import { FraudOrderStore } from '../../src/services/FraudOrderStore.js'
import { clearKountTokenCache } from '../../src/services/KountClient.js'

const stripeMock = vi.hoisted(() => ({
  checkout: { sessions: { create: vi.fn(), retrieve: vi.fn(), list: vi.fn(), listLineItems: vi.fn() } },
  paymentIntents: { retrieve: vi.fn(), capture: vi.fn(), cancel: vi.fn(), list: vi.fn() },
  refunds: { create: vi.fn() },
  webhooks: { constructEventAsync: vi.fn() },
}))

vi.mock('stripe', () => {
  const Stripe = vi.fn(() => stripeMock)
  Stripe.createSubtleCryptoProvider = vi.fn(() => ({}))
  return { default: Stripe }
})

async function rsaKey() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )
  const der = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))
  const pem = `-----BEGIN PUBLIC KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PUBLIC KEY-----`
  return { pair, pem }
}

async function signedKountRequest(privateKey, bodyObj, timestamp = new Date().toISOString()) {
  const body = JSON.stringify(bodyObj)
  const bytes = new TextEncoder().encode(timestamp + body)
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'RSA-PSS', saltLength: 32 }, privateKey, bytes))
  return createTestRequest('/api/webhooks/kount', {
    method: 'POST',
    body,
    headers: {
      'Content-Type': 'application/json',
      'X-Event-Signature': btoa(String.fromCharCode(...sig)),
      'X-Event-Timestamp': timestamp,
    },
  })
}

describe('Kount fraud screening routes', () => {
  let app
  let env
  let kv
  let key

  beforeAll(async () => {
    key = await rsaKey()
  })

  beforeEach(async () => {
    app = await createTestApp()
    env = createMockEnv()
    kv = createMockKV()
    env.TEST_KV = kv
    vi.clearAllMocks()
    clearKountTokenCache()
  })

  function enableKount(extra = {}) {
    Object.assign(env, {
      KOUNT_CLIENT_ID: 'client-1',
      KOUNT_API_KEY: 'apikey',
      KOUNT_WEBHOOK_PUBLIC_KEY: key.pem,
      STRIPE_WEBHOOK_SECRET: 'whsec_test',
      ...extra,
    })
  }

  describe('POST /api/webhooks/kount', () => {
    it('accepts the exact unsigned portal ping as a no-op', async () => {
      enableKount()
      const res = await executeRequest(app, createTestRequest('/api/webhooks/kount', { method: 'POST', body: { eventType: 'Webhook.TestPing' } }), env)
      expect(res.status).toBe(200)
      expect((await parseJsonResponse(res)).outcome).toBe('test_ping')
    })

    it('rejects unsigned business events and look-alike pings', async () => {
      enableKount()
      for (const eventType of ['Order.StatusChange', 'Order.TestPingInjected']) {
        const res = await executeRequest(app, createTestRequest('/api/webhooks/kount', { method: 'POST', body: { eventType, kountOrderId: 'K1', newValue: 'APPROVE' } }), env)
        expect(res.status).toBe(401)
      }
    })

    it('keeps the route but rejects signed events safely when no key is configured', async () => {
      enableKount({ KOUNT_WEBHOOK_PUBLIC_KEY: '' })
      const req = await signedKountRequest(key.pair.privateKey, { eventType: 'Order.StatusChange' })
      const res = await executeRequest(app, req, env)
      expect(res.status).toBe(503)
    })

    it('rejects a bad signature', async () => {
      enableKount()
      const other = await rsaKey()
      const req = await signedKountRequest(other.pair.privateKey, { eventType: 'Order.StatusChange', kountOrderId: 'K1', fieldName: 'status', newValue: 'APPROVE' })
      const res = await executeRequest(app, req, env)
      expect(res.status).toBe(401)
      expect((await parseJsonResponse(res)).error).toBe('signature_mismatch')
    })

    it('rejects an expired delivery', async () => {
      enableKount()
      const req = await signedKountRequest(key.pair.privateKey, { eventType: 'Order.StatusChange' }, new Date(Date.now() - 46 * 60000).toISOString())
      const res = await executeRequest(app, req, env)
      expect((await parseJsonResponse(res)).error).toBe('expired')
    })

    it('applies a verified reviewer approval and suppresses the duplicate', async () => {
      enableKount()
      const store = new FraudOrderStore(kv)
      const rec = store.newOrder({ checkoutSessionId: 'cs_review', paymentIntentId: 'pi_review' })
      rec.evaluation = { state: 'complete', decision: 'REVIEW', kountOrderId: 'K-REV', kountTransactionId: 'T' }
      rec.payment = { state: 'captured' }
      rec.review = { status: 'open' }
      await store.saveOrder(rec)

      const body = { id: 'evt-77', eventType: 'Order.StatusChange', kountOrderId: 'K-REV', merchantOrderId: 'cs_review', fieldName: 'status', oldValue: 'REVIEW', newValue: 'APPROVE' }
      const res = await executeRequest(app, await signedKountRequest(key.pair.privateKey, body), env)
      expect(res.status).toBe(200)
      expect((await parseJsonResponse(res)).outcome).toBe('review_approved')
      expect((await store.getOrder('cs_review')).fulfillmentAllowed).toBe(true)

      const dup = await executeRequest(app, await signedKountRequest(key.pair.privateKey, body), env)
      expect((await parseJsonResponse(dup)).outcome).toBe('duplicate')
    })
  })

  describe('POST /api/webhooks/stripe', () => {
    it('reports not_configured without a webhook secret', async () => {
      const res = await executeRequest(app, createTestRequest('/api/webhooks/stripe', { method: 'POST', body: {}, headers: { 'stripe-signature': 't=1,v1=x' } }), env)
      expect(res.status).toBe(503)
    })

    it('rejects a bad Stripe signature', async () => {
      enableKount()
      stripeMock.webhooks.constructEventAsync.mockRejectedValueOnce(new Error('bad sig'))
      const res = await executeRequest(app, createTestRequest('/api/webhooks/stripe', { method: 'POST', body: {}, headers: { 'stripe-signature': 't=1,v1=x' } }), env)
      expect(res.status).toBe(400)
    })

    it('also accepts Stripe deliveries at /api/stripe-webhook', async () => {
      enableKount()
      stripeMock.webhooks.constructEventAsync.mockRejectedValueOnce(new Error('bad sig'))
      const res = await executeRequest(app, createTestRequest('/api/stripe-webhook', { method: 'POST', body: {}, headers: { 'stripe-signature': 't=1,v1=x' } }), env)
      // Reaches the Stripe handler (signature check), not a 404.
      expect(res.status).toBe(400)
    })

    it('evaluates a completed checkout with Kount and captures on APPROVE', async () => {
      enableKount()
      stripeMock.webhooks.constructEventAsync.mockResolvedValueOnce({
        id: 'evt_s1',
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_s1', mode: 'payment', payment_intent: 'pi_s1', currency: 'usd', amount_total: 500, amount_subtotal: 500 } },
      })
      stripeMock.paymentIntents.retrieve.mockResolvedValue({ id: 'pi_s1', status: 'requires_capture', metadata: { kount_screening: '1' }, latest_charge: null })
      stripeMock.checkout.sessions.listLineItems.mockResolvedValue({ data: [] })
      stripeMock.paymentIntents.capture.mockResolvedValue({ id: 'pi_s1', status: 'succeeded' })

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        if (String(url).startsWith('https://login-uat.equifax.com')) {
          return new Response(JSON.stringify({ access_token: 't', expires_in: 600 }), { status: 200 })
        }
        if (String(url).includes('/commerce/v2/orders/')) return new Response('{}', { status: 200 })
        return new Response(JSON.stringify({ order: { orderId: 'K9', riskInquiry: { decision: 'APPROVE' }, transactions: [{ transactionId: 'T9' }] } }), { status: 200 })
      })
      try {
        const res = await executeRequest(app, createTestRequest('/api/webhooks/stripe', { method: 'POST', body: {}, headers: { 'stripe-signature': 't=1,v1=x' } }), env)
        expect(res.status).toBe(200)
        expect((await parseJsonResponse(res)).outcome).toBe('approved')
        expect(stripeMock.paymentIntents.capture).toHaveBeenCalledWith('pi_s1', {}, { idempotencyKey: 'openshop-kount-capture-pi_s1' })
        const evaluateCall = fetchSpy.mock.calls.find(([u]) => String(u).includes('riskInquiry=true'))
        expect(String(evaluateCall[0])).toBe('https://api-sandbox.kount.com/commerce/v2/orders?riskInquiry=true')
      } finally {
        fetchSpy.mockRestore()
      }
    })

    it('never captures a held payment unscreened when Kount is turned off', async () => {
      env.STRIPE_WEBHOOK_SECRET = 'whsec_test'
      stripeMock.webhooks.constructEventAsync.mockResolvedValueOnce({
        id: 'evt_s2', type: 'checkout.session.completed', data: { object: { id: 'cs_s2', mode: 'payment', payment_intent: 'pi_s2' } },
      })
      stripeMock.paymentIntents.retrieve.mockResolvedValue({ id: 'pi_s2', status: 'requires_capture', metadata: { kount_screening: '1' } })
      const res = await executeRequest(app, createTestRequest('/api/webhooks/stripe', { method: 'POST', body: {}, headers: { 'stripe-signature': 't=1,v1=x' } }), env)
      expect(res.status).toBe(503)
      expect(stripeMock.paymentIntents.capture).not.toHaveBeenCalled()
    })
  })

  describe('checkout wiring', () => {
    it('creates a manual-capture session with the device session ID when Kount is on', async () => {
      enableKount()
      stripeMock.checkout.sessions.create.mockResolvedValue({ id: 'cs_new', url: 'https://checkout.stripe.com/x' })
      const res = await executeRequest(app, createTestRequest('/api/create-checkout-session', {
        method: 'POST', body: { priceId: 'price_123', kountSessionId: 'abcDEF0123' }, headers: { 'CF-Connecting-IP': '192.0.2.44' },
      }), env)
      expect(res.status).toBe(200)
      const params = stripeMock.checkout.sessions.create.mock.calls[0][0]
      expect(params.payment_intent_data).toEqual({
        capture_method: 'manual',
        metadata: { kount_screening: '1', kount_device_session_id: 'abcDEF0123' },
      })
      expect(await new FraudOrderStore(kv).getCheckoutContext('cs_new')).toMatchObject({ deviceSessionId: 'abcDEF0123', userIp: '192.0.2.44' })
    })

    it('leaves sessions unchanged when Kount is off', async () => {
      stripeMock.checkout.sessions.create.mockResolvedValue({ id: 'cs_plain', url: 'u' })
      await executeRequest(app, createTestRequest('/api/create-checkout-session', { method: 'POST', body: { priceId: 'price_123' } }), env)
      expect(stripeMock.checkout.sessions.create.mock.calls[0][0].payment_intent_data).toBeUndefined()
    })

    it('rejects a malformed device session ID', async () => {
      enableKount()
      const res = await executeRequest(app, createTestRequest('/api/create-checkout-session', { method: 'POST', body: { priceId: 'price_1', kountSessionId: 'bad id!' } }), env)
      expect(res.status).toBe(400)
    })

    it('exposes only the non-secret client ID for device collection', async () => {
      enableKount()
      const data = await parseJsonResponse(await executeRequest(app, createTestRequest('/api/kount/config'), env))
      expect(data).toEqual({ enabled: true, clientId: 'client-1', environment: 'TEST' })
      expect(JSON.stringify(data)).not.toContain('apikey')
    })
  })

  describe('admin', () => {
    let headers
    beforeEach(async () => {
      headers = createAdminHeaders(await createAdminToken(env, kv))
    })

    it('blocks fulfillment of a held order on the server', async () => {
      const store = new FraudOrderStore(kv)
      const rec = store.newOrder({ checkoutSessionId: 'cs_held', paymentIntentId: 'pi_held' })
      rec.evaluation = { state: 'complete', decision: 'REVIEW' }
      await store.saveOrder(rec)
      const res = await executeRequest(app, createTestRequest('/api/admin/analytics/orders/cs_held/fulfill', { method: 'POST', headers }), env)
      expect(res.status).toBe(409)
      expect(await kv.get('order_fulfillment:cs_held')).toBeNull()
    })

    it('allows fulfillment once screening allows it', async () => {
      const store = new FraudOrderStore(kv)
      const rec = store.newOrder({ checkoutSessionId: 'cs_ok', paymentIntentId: 'pi_ok' })
      rec.fulfillmentAllowed = true
      await store.saveOrder(rec)
      const res = await executeRequest(app, createTestRequest('/api/admin/analytics/orders/cs_ok/fulfill', { method: 'POST', headers }), env)
      expect(res.status).toBe(200)
    })

    it('shows webhook URLs and Kount settings without secrets', async () => {
      enableKount()
      const data = await parseJsonResponse(await executeRequest(app, createTestRequest('/api/admin/developer-settings', { headers }), env))
      expect(data.fraud.webhooks.kount).toBe('https://test.workers.dev/api/webhooks/kount')
      expect(data.fraud.webhooks.stripe).toBe('https://test.workers.dev/api/webhooks/stripe')
      expect(data.fraud.kount).toMatchObject({ enabled: true, maxRetries: 2, fallbackDecision: 'APPROVE' })
      const keys = data.fields.map((f) => f.key)
      for (const k of ['KOUNT_CLIENT_ID', 'KOUNT_API_KEY', 'KOUNT_MAX_RETRIES', 'KOUNT_FALLBACK_DECISION', 'KOUNT_WEBHOOK_PUBLIC_KEY', 'KOUNT_CHANNEL', 'KOUNT_ENVIRONMENT', 'STRIPE_WEBHOOK_SECRET']) {
        expect(keys).toContain(k)
      }
      const apiKey = data.fields.find((f) => f.key === 'KOUNT_API_KEY')
      expect(apiKey.value).toBeUndefined()
      expect(JSON.stringify(data)).not.toContain('apikey')
      expect(JSON.stringify(data)).not.toContain('whsec_test')
    })

    it('saves the webhook key in the bare base64 form the Kount portal shows', async () => {
      const bare = key.pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '').replace(/\s+/g, '')
      const res = await executeRequest(app, createTestRequest('/api/admin/developer-settings', {
        method: 'PUT', headers, body: { KOUNT_WEBHOOK_PUBLIC_KEY: bare },
      }), env)
      expect(res.status).toBe(200)
      expect((await parseJsonResponse(res)).fraud.kount.webhookKeyFingerprint).toMatch(/^[0-9a-f]{16}$/)
    })

    it('validates Kount settings with the same rules as ENV and saves nothing on error', async () => {
      const bad = await executeRequest(app, createTestRequest('/api/admin/developer-settings', {
        method: 'PUT', headers, body: { KOUNT_CHANNEL: 'ok', KOUNT_FALLBACK_DECISION: 'MAYBE' },
      }), env)
      expect(bad.status).toBe(400)
      expect(await kv.get('developer:settings')).toBeNull()

      const good = await executeRequest(app, createTestRequest('/api/admin/developer-settings', {
        method: 'PUT', headers, body: { KOUNT_MAX_RETRIES: '3', KOUNT_FALLBACK_DECISION: 'DECLINE' },
      }), env)
      const data = await parseJsonResponse(good)
      // The UI value applies to the next operation (KV overrides ENV).
      expect(data.fraud.kount).toMatchObject({ maxRetries: 3, fallbackDecision: 'DECLINE' })
    })
  })
})
