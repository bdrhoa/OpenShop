// Integration tests for checkout process
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestApp, createTestRequest, executeRequest, parseJsonResponse, createStripePriceId, createStripeSessionId, createTestCartItems } from '../utils/test-helpers.js'
import { createMockEnv, createMockKV } from '../setup.js'
import Stripe from 'stripe'
import { resetKountTokenCache } from '../../src/services/KountService.js'

// Mock Stripe
vi.mock('stripe', () => {
  const mockCheckoutSessions = {
    create: vi.fn(),
    retrieve: vi.fn(),
    listLineItems: vi.fn()
  }
  const mockPaymentIntents = {
    update: vi.fn(),
    capture: vi.fn(),
    cancel: vi.fn()
  }
  const mockWebhooks = {
    constructEventAsync: vi.fn()
  }

  const StripeMock = vi.fn(() => ({
    checkout: {
      sessions: mockCheckoutSessions
    },
    paymentIntents: mockPaymentIntents,
    webhooks: mockWebhooks
  }))
  StripeMock.createSubtleCryptoProvider = vi.fn()

  return { default: StripeMock }
})

describe('Checkout Process', () => {
  let app
  let env
  let kv
  let mockStripe

  beforeEach(async () => {
    app = await createTestApp()
    env = createMockEnv()
    kv = createMockKV()
    env.TEST_KV = kv

    // Reset Stripe mock
    mockStripe = new Stripe('sk_test_mock')
    vi.clearAllMocks()
  })

  describe('Kount session ID', () => {
    const ddcSite = 'https://kount-poc-run-110301.bdrhoa.workers.dev'
    const kountSessionId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
    const createdMetadata = () => mockStripe.checkout.sessions.create.mock.calls[0][0].metadata

    beforeEach(() => {
      mockStripe.checkout.sessions.create.mockResolvedValue({
        id: createStripeSessionId(),
        url: 'https://checkout.stripe.com/test'
      })
    })

    it('stores the ID on single-item checkout for the DDC site', async () => {
      const request = createTestRequest(`${ddcSite}/api/create-checkout-session`, {
        method: 'POST',
        body: { priceId: createStripePriceId(), kountSessionId }
      })

      const response = await executeRequest(app, request, env)

      expect(response.status).toBe(200)
      expect(createdMetadata()).toEqual({ kount_session_id: kountSessionId })
      expect(mockStripe.checkout.sessions.create.mock.calls[0][0].payment_intent_data).toEqual({ capture_method: 'manual' })
    })

    it('records the IPv4 address of the buyer for the risk evaluation', async () => {
      const request = createTestRequest(`${ddcSite}/api/create-checkout-session`, {
        method: 'POST',
        headers: { 'CF-Connecting-IP': '203.0.113.7' },
        body: { priceId: createStripePriceId(), kountSessionId }
      })

      await executeRequest(app, request, env)

      expect(createdMetadata().kount_user_ip).toBe('203.0.113.7')
    })

    it('stores the ID on cart checkout for the DDC site', async () => {
      const request = createTestRequest(`${ddcSite}/api/create-cart-checkout-session`, {
        method: 'POST',
        body: { items: createTestCartItems(), kountSessionId }
      })

      const response = await executeRequest(app, request, env)

      expect(response.status).toBe(200)
      expect(createdMetadata().kount_session_id).toBe(kountSessionId)
      expect(mockStripe.checkout.sessions.create.mock.calls[0][0].payment_intent_data).toEqual({ capture_method: 'manual' })
    })

    it('ignores the ID on other sites', async () => {
      const request = createTestRequest('https://kount-poc-base.bdrhoa.workers.dev/api/create-cart-checkout-session', {
        method: 'POST',
        body: { items: createTestCartItems(), kountSessionId }
      })

      const response = await executeRequest(app, request, env)

      expect(response.status).toBe(200)
      expect(createdMetadata().kount_session_id).toBeUndefined()
      expect(mockStripe.checkout.sessions.create.mock.calls[0][0].payment_intent_data).toBeUndefined()
    })

    it('completes checkout without an invalid ID', async () => {
      const request = createTestRequest(`${ddcSite}/api/create-cart-checkout-session`, {
        method: 'POST',
        body: { items: createTestCartItems(), kountSessionId: 'not valid!' }
      })

      const response = await executeRequest(app, request, env)

      expect(response.status).toBe(200)
      expect(createdMetadata().kount_session_id).toBeUndefined()
      // Still held: only a Kount decision may capture it.
      expect(mockStripe.checkout.sessions.create.mock.calls[0][0].payment_intent_data).toEqual({ capture_method: 'manual' })
    })
  })

  describe('POST /api/stripe-webhook', () => {
    const ddcSite = 'https://kount-poc-run-110301.bdrhoa.workers.dev'
    const sessionId = 'cs_test_webhook'
    const paymentIntentId = 'pi_test_webhook'
    let fetchMock

    const heldSession = {
      id: sessionId,
      currency: 'usd',
      amount_subtotal: 2500,
      amount_total: 2500,
      metadata: { kount_session_id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' },
      customer_details: { email: 'buyer@example.com' },
      payment_intent: {
        id: paymentIntentId,
        capture_method: 'manual',
        status: 'requires_capture',
        metadata: {},
        latest_charge: { id: 'ch_test', billing_details: {}, payment_method_details: {} }
      }
    }

    const webhookRequest = (site = ddcSite, headers = { 'stripe-signature': 't=1,v1=abc' }) =>
      createTestRequest(`${site}/api/stripe-webhook`, { method: 'POST', headers, body: { id: 'evt_test' } })

    const kountDecision = (decision) => {
      fetchMock.mockImplementation(async (url) => (String(url).includes('/as/token')
        ? new Response(JSON.stringify({ access_token: 'token', expires_in: 1200 }))
        : new Response(JSON.stringify({ order: { orderId: 'KOUNT1', riskInquiry: { decision } } }))))
    }

    beforeEach(() => {
      resetKountTokenCache()
      env.STRIPE_WEBHOOK_SECRET = 'whsec_test'
      env.KOUNT_API_KEY = 'kount_key'
      fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      mockStripe.webhooks.constructEventAsync.mockResolvedValue({
        type: 'checkout.session.completed',
        data: { object: { id: sessionId } }
      })
      mockStripe.checkout.sessions.retrieve.mockResolvedValue(heldSession)
      mockStripe.checkout.sessions.listLineItems.mockResolvedValue({ data: [] })
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it.each(['APPROVE', 'REVIEW'])('captures the held payment on %s', async (decision) => {
      kountDecision(decision)

      const response = await executeRequest(app, webhookRequest(), env)

      expect(response.status).toBe(200)
      expect(mockStripe.paymentIntents.capture).toHaveBeenCalledTimes(1)
      expect(mockStripe.paymentIntents.cancel).not.toHaveBeenCalled()
    })

    it('cancels the held payment on DECLINE', async () => {
      kountDecision('DECLINE')

      const response = await executeRequest(app, webhookRequest(), env)

      expect(response.status).toBe(200)
      expect(mockStripe.paymentIntents.cancel).toHaveBeenCalledTimes(1)
      expect(mockStripe.paymentIntents.capture).not.toHaveBeenCalled()
    })

    it('sends the DDC session ID to Kount as deviceSessionId', async () => {
      kountDecision('APPROVE')

      await executeRequest(app, webhookRequest(), env)

      const orderCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/v2/orders'))
      expect(JSON.parse(orderCall[1].body).deviceSessionId).toBe(heldSession.metadata.kount_session_id)
    })

    it('fails so Stripe retries, and leaves the payment held, when Kount is down', async () => {
      fetchMock.mockImplementation(async () => new Response('', { status: 500 }))

      const response = await executeRequest(app, webhookRequest(), env)

      expect(response.status).toBe(503)
      expect(mockStripe.paymentIntents.capture).not.toHaveBeenCalled()
      expect(mockStripe.paymentIntents.cancel).not.toHaveBeenCalled()
    })

    it('rejects a delivery with an invalid signature', async () => {
      mockStripe.webhooks.constructEventAsync.mockRejectedValue(new Error('bad signature'))

      const response = await executeRequest(app, webhookRequest(), env)

      expect(response.status).toBe(400)
      expect(mockStripe.checkout.sessions.retrieve).not.toHaveBeenCalled()
    })

    it('rejects a delivery with no signature', async () => {
      const response = await executeRequest(app, webhookRequest(ddcSite, {}), env)

      expect(response.status).toBe(400)
    })

    it('refuses to run until its secrets are configured', async () => {
      delete env.KOUNT_API_KEY

      const response = await executeRequest(app, webhookRequest(), env)

      expect(response.status).toBe(503)
    })

    it('does not exist on other sites', async () => {
      const response = await executeRequest(app, webhookRequest('https://kount-poc-base.bdrhoa.workers.dev'), env)

      expect(response.status).toBe(404)
    })

    it('ignores other events', async () => {
      mockStripe.webhooks.constructEventAsync.mockResolvedValue({ type: 'charge.updated', data: { object: {} } })

      const response = await executeRequest(app, webhookRequest(), env)

      expect(response.status).toBe(200)
      expect(mockStripe.checkout.sessions.retrieve).not.toHaveBeenCalled()
    })
  })

  describe('POST /api/create-checkout-session', () => {
    it('should create a checkout session with valid priceId', async () => {
      const priceId = createStripePriceId()
      const sessionId = createStripeSessionId()

      mockStripe.checkout.sessions.create.mockResolvedValue({
        id: sessionId,
        url: 'https://checkout.stripe.com/test'
      })

      const request = createTestRequest('/api/create-checkout-session', {
        method: 'POST',
        body: { priceId }
      })

      const response = await executeRequest(app, request, env)
      const data = await parseJsonResponse(response)

      expect(response.status).toBe(200)
      expect(data.sessionId).toBe(sessionId)
      expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          line_items: [{ price: priceId, quantity: 1 }],
          mode: 'payment'
        })
      )
    })

    it('should return 400 for malformed JSON', async () => {
      const request = createTestRequest('/api/create-checkout-session', {
        method: 'POST',
        body: '{not-json',
        headers: { 'Content-Type': 'application/json' }
      })

      const response = await executeRequest(app, request, env)
      const data = await parseJsonResponse(response)

      expect(response.status).toBe(400)
      expect(data.error).toMatch(/JSON/i)
    })

    it('should return 400 for missing priceId', async () => {
      const request = createTestRequest('/api/create-checkout-session', {
        method: 'POST',
        body: {}
      })

      const response = await executeRequest(app, request, env)
      const data = await parseJsonResponse(response)

      expect(response.status).toBe(400)
      expect(data.error).toContain('price ID')
    })

    it('should return 400 for invalid priceId format', async () => {
      const request = createTestRequest('/api/create-checkout-session', {
        method: 'POST',
        body: { priceId: 'invalid_price_id' }
      })

      const response = await executeRequest(app, request, env)
      const data = await parseJsonResponse(response)

      expect(response.status).toBe(400)
      expect(data.error).toContain('Invalid price ID format')
    })

    it('should return 400 for empty priceId', async () => {
      const request = createTestRequest('/api/create-checkout-session', {
        method: 'POST',
        body: { priceId: '' }
      })

      const response = await executeRequest(app, request, env)
      const data = await parseJsonResponse(response)

      expect(response.status).toBe(400)
      expect(data.error).toContain('price ID')
    })

    it('should return 400 for priceId that is too long', async () => {
      const longPriceId = 'price_' + 'a'.repeat(300)
      const request = createTestRequest('/api/create-checkout-session', {
        method: 'POST',
        body: { priceId: longPriceId }
      })

      const response = await executeRequest(app, request, env)
      const data = await parseJsonResponse(response)

      expect(response.status).toBe(400)
      expect(data.error).toContain('too long')
    })

    it('should trim whitespace from priceId', async () => {
      const priceId = createStripePriceId()
      const sessionId = createStripeSessionId()

      mockStripe.checkout.sessions.create.mockResolvedValue({
        id: sessionId
      })

      const request = createTestRequest('/api/create-checkout-session', {
        method: 'POST',
        body: { priceId: `  ${priceId}  ` }
      })

      const response = await executeRequest(app, request, env)
      expect(response.status).toBe(200)
      expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          line_items: [{ price: priceId.trim(), quantity: 1 }]
        })
      )
    })
  })

  describe('POST /api/create-cart-checkout-session', () => {
    it('should create a cart checkout session with valid items', async () => {
      const items = createTestCartItems(2)
      const sessionId = createStripeSessionId()

      mockStripe.checkout.sessions.create.mockResolvedValue({
        id: sessionId,
        url: 'https://checkout.stripe.com/test'
      })

      const request = createTestRequest('/api/create-cart-checkout-session', {
        method: 'POST',
        body: { items }
      })

      const response = await executeRequest(app, request, env)
      const data = await parseJsonResponse(response)

      expect(response.status).toBe(200)
      expect(data.sessionId).toBe(sessionId)
      expect(mockStripe.checkout.sessions.create).toHaveBeenCalled()
      const callArgs = mockStripe.checkout.sessions.create.mock.calls[0][0]
      expect(callArgs.line_items).toHaveLength(2)
      expect(callArgs.metadata.item_count).toBe('2')
    })

    it('should return 400 for missing items array', async () => {
      const request = createTestRequest('/api/create-cart-checkout-session', {
        method: 'POST',
        body: {}
      })

      const response = await executeRequest(app, request, env)
      const data = await parseJsonResponse(response)

      expect(response.status).toBe(400)
      expect(data.error).toContain('Cart items')
    })

    it('should return 400 for empty items array', async () => {
      const request = createTestRequest('/api/create-cart-checkout-session', {
        method: 'POST',
        body: { items: [] }
      })

      const response = await executeRequest(app, request, env)
      const data = await parseJsonResponse(response)

      expect(response.status).toBe(400)
      expect(data.error).toContain('Cart items')
    })

    it('should return 400 for cart size exceeding limit', async () => {
      const items = createTestCartItems(101)
      const request = createTestRequest('/api/create-cart-checkout-session', {
        method: 'POST',
        body: { items }
      })

      const response = await executeRequest(app, request, env)
      const data = await parseJsonResponse(response)

      expect(response.status).toBe(400)
      expect(data.error).toContain('exceeds maximum')
    })

    it('should return 400 for invalid item format', async () => {
      const request = createTestRequest('/api/create-cart-checkout-session', {
        method: 'POST',
        body: { items: [null] }
      })

      const response = await executeRequest(app, request, env)
      const data = await parseJsonResponse(response)

      expect(response.status).toBe(400)
      expect(data.error).toContain('Invalid cart item format')
    })

    it('should return 400 for item without priceId', async () => {
      const request = createTestRequest('/api/create-cart-checkout-session', {
        method: 'POST',
        body: { items: [{ quantity: 1 }] }
      })

      const response = await executeRequest(app, request, env)
      const data = await parseJsonResponse(response)

      expect(response.status).toBe(400)
      expect(data.error).toContain('Invalid price ID')
    })

    it('should return 400 for invalid priceId format in item', async () => {
      const request = createTestRequest('/api/create-cart-checkout-session', {
        method: 'POST',
        body: { items: [{ priceId: 'invalid', quantity: 1 }] }
      })

      const response = await executeRequest(app, request, env)
      const data = await parseJsonResponse(response)

      expect(response.status).toBe(400)
      expect(data.error).toContain('Invalid price ID')
    })

    it('should support backward compatibility with stripePriceId', async () => {
      const items = [{
        stripePriceId: createStripePriceId(),
        quantity: 2
      }]
      const sessionId = createStripeSessionId()

      mockStripe.checkout.sessions.create.mockResolvedValue({
        id: sessionId
      })

      const request = createTestRequest('/api/create-cart-checkout-session', {
        method: 'POST',
        body: { items }
      })

      const response = await executeRequest(app, request, env)
      const data = await parseJsonResponse(response)

      expect(response.status).toBe(200)
      expect(data.sessionId).toBe(sessionId)
    })

    it('should normalize quantity from string to integer', async () => {
      const items = [{
        priceId: createStripePriceId(),
        quantity: '3'
      }]
      const sessionId = createStripeSessionId()

      mockStripe.checkout.sessions.create.mockResolvedValue({
        id: sessionId
      })

      const request = createTestRequest('/api/create-cart-checkout-session', {
        method: 'POST',
        body: { items }
      })

      const response = await executeRequest(app, request, env)
      const _data = await parseJsonResponse(response)

      expect(response.status).toBe(200)
      const callArgs = mockStripe.checkout.sessions.create.mock.calls[0][0]
      expect(callArgs.line_items[0].quantity).toBe(3)
    })

    it('should default quantity to 1 when not provided', async () => {
      const items = [{
        priceId: createStripePriceId()
      }]
      const sessionId = createStripeSessionId()

      mockStripe.checkout.sessions.create.mockResolvedValue({
        id: sessionId
      })

      const request = createTestRequest('/api/create-cart-checkout-session', {
        method: 'POST',
        body: { items }
      })

      const response = await executeRequest(app, request, env)
      const _data = await parseJsonResponse(response)

      expect(response.status).toBe(200)
      const callArgs = mockStripe.checkout.sessions.create.mock.calls[0][0]
      expect(callArgs.line_items[0].quantity).toBe(1)
    })

    it('should return 400 for quantity less than 1', async () => {
      const request = createTestRequest('/api/create-cart-checkout-session', {
        method: 'POST',
        body: { items: [{ priceId: createStripePriceId(), quantity: 0 }] }
      })

      const response = await executeRequest(app, request, env)
      const data = await parseJsonResponse(response)

      expect(response.status).toBe(400)
      expect(data.error).toContain('Invalid quantity')
    })

    it('should return 400 for quantity greater than 100', async () => {
      const request = createTestRequest('/api/create-cart-checkout-session', {
        method: 'POST',
        body: { items: [{ priceId: createStripePriceId(), quantity: 101 }] }
      })

      const response = await executeRequest(app, request, env)
      const data = await parseJsonResponse(response)

      expect(response.status).toBe(400)
      expect(data.error).toContain('Invalid quantity')
    })

    it('should include variant information in metadata', async () => {
      const items = [{
        priceId: createStripePriceId(),
        quantity: 1,
        name: 'Test Product',
        selectedVariant: { name: 'Size: Large' },
        selectedVariant2: { name: 'Color: Red' }
      }]
      const sessionId = createStripeSessionId()

      mockStripe.checkout.sessions.create.mockResolvedValue({
        id: sessionId
      })

      const request = createTestRequest('/api/create-cart-checkout-session', {
        method: 'POST',
        body: { items }
      })

      const response = await executeRequest(app, request, env)
      const _data = await parseJsonResponse(response)

      expect(response.status).toBe(200)
      const callArgs = mockStripe.checkout.sessions.create.mock.calls[0][0]
      expect(callArgs.metadata.item_0_name).toBe('Test Product')
      expect(callArgs.metadata.item_0_variant1).toBe('Size: Large')
      expect(callArgs.metadata.item_0_variant2).toBe('Color: Red')
    })

    it('should handle multiple items with correct quantities', async () => {
      const items = [
        { priceId: createStripePriceId(), quantity: 2 },
        { priceId: createStripePriceId(), quantity: 3 }
      ]
      const sessionId = createStripeSessionId()

      mockStripe.checkout.sessions.create.mockResolvedValue({
        id: sessionId
      })

      const request = createTestRequest('/api/create-cart-checkout-session', {
        method: 'POST',
        body: { items }
      })

      const response = await executeRequest(app, request, env)
      const _data = await parseJsonResponse(response)

      expect(response.status).toBe(200)
      const callArgs = mockStripe.checkout.sessions.create.mock.calls[0][0]
      expect(callArgs.line_items[0].quantity).toBe(2)
      expect(callArgs.line_items[1].quantity).toBe(3)
      expect(callArgs.metadata.total_quantity).toBe('5')
    })
  })

  describe('GET /api/checkout-session/:sessionId', () => {
    it('should retrieve checkout session details', async () => {
      const sessionId = createStripeSessionId()
      const mockSession = {
        id: sessionId,
        amount_total: 2999,
        currency: 'usd',
        customer_details: { email: 'test@example.com' },
        payment_status: 'paid',
        created: Math.floor(Date.now() / 1000)
      }

      mockStripe.checkout.sessions.retrieve.mockResolvedValue(mockSession)

      const request = createTestRequest(`/api/checkout-session/${sessionId}`)
      const response = await executeRequest(app, request, env)
      const data = await parseJsonResponse(response)

      expect(response.status).toBe(200)
      expect(data.id).toBe(sessionId)
      expect(data.amount_total).toBe(2999)
      expect(data.currency).toBe('usd')
      expect(data.customer_email).toBe('test@example.com')
      expect(data.payment_status).toBe('paid')
      expect(mockStripe.checkout.sessions.retrieve).toHaveBeenCalledWith(sessionId, { expand: ['payment_intent'] })
    })

    it('should return 400 for invalid sessionId format', async () => {
      const request = createTestRequest('/api/checkout-session/invalid_session_id')
      const response = await executeRequest(app, request, env)
      const data = await parseJsonResponse(response)

      expect(response.status).toBe(400)
      expect(data.error).toContain('Invalid session ID format')
    })

    it('should return 400 for sessionId without cs_ prefix', async () => {
      const request = createTestRequest('/api/checkout-session/price_test123')
      const response = await executeRequest(app, request, env)
      const data = await parseJsonResponse(response)

      expect(response.status).toBe(400)
      expect(data.error).toContain('Invalid session ID format')
    })

    it('should return 400 for sessionId that is too long', async () => {
      const longSessionId = 'cs_' + 'a'.repeat(300)
      const request = createTestRequest(`/api/checkout-session/${longSessionId}`)
      const response = await executeRequest(app, request, env)
      const data = await parseJsonResponse(response)

      expect(response.status).toBe(400)
      expect(data.error).toContain('too long')
    })

    it('should trim whitespace from sessionId', async () => {
      const sessionId = createStripeSessionId()
      mockStripe.checkout.sessions.retrieve.mockResolvedValue({
        id: sessionId,
        amount_total: 1000,
        currency: 'usd',
        payment_status: 'unpaid',
        created: Math.floor(Date.now() / 1000)
      })

      const request = createTestRequest(`/api/checkout-session/  ${sessionId}  `)
      const response = await executeRequest(app, request, env)

      expect(response.status).toBe(200)
      expect(mockStripe.checkout.sessions.retrieve).toHaveBeenCalledWith(sessionId.trim(), { expand: ['payment_intent'] })
    })
  })
})





