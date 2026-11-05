// Integration tests for admin analytics endpoints
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createTestApp, createTestRequest, executeRequest, parseJsonResponse, createAdminToken, createAdminHeaders } from '../utils/test-helpers.js'
import { createMockEnv, createMockKV } from '../setup.js'
import Stripe from 'stripe'

// Mock Stripe
vi.mock('stripe', () => {
  const mockCheckoutSessions = {
    list: vi.fn(),
    retrieve: vi.fn(),
    listLineItems: vi.fn()
  }

  const mockPaymentIntents = {
    list: vi.fn(),
    retrieve: vi.fn()
  }

  return {
    default: vi.fn(() => ({
      checkout: {
        sessions: mockCheckoutSessions
      },
      paymentIntents: mockPaymentIntents
    }))
  }
})

describe('Admin Analytics Endpoints', () => {
  let app
  let env
  let kv
  let adminToken
  let mockStripe

  beforeEach(async () => {
    app = await createTestApp()
    env = createMockEnv()
    kv = createMockKV()
    env.TEST_KV = kv
    adminToken = await createAdminToken(env, kv)
    mockStripe = new Stripe('sk_test_mock')
    vi.clearAllMocks()
  })

  describe('GET /api/admin/analytics', () => {
    it('should return analytics data', async () => {
      const mockPaymentIntents = {
        data: [
          { id: 'pi_1', amount: 2999, status: 'succeeded', created: Math.floor(Date.now() / 1000) },
          { id: 'pi_2', amount: 4999, status: 'succeeded', created: Math.floor(Date.now() / 1000) }
        ]
      }

      mockStripe.paymentIntents.list.mockResolvedValue(mockPaymentIntents)

      const request = createTestRequest('/api/admin/analytics', {
        method: 'GET',
        headers: createAdminHeaders(adminToken)
      })

      const response = await executeRequest(app, request, env)
      const data = await parseJsonResponse(response)

      expect(response.status).toBe(200)
      expect(data).toBeDefined()
      expect(typeof data).toBe('object')
    })

    it('should accept period query parameter', async () => {
      mockStripe.paymentIntents.list.mockResolvedValue({ data: [] })

      const request = createTestRequest('/api/admin/analytics?period=7d', {
        method: 'GET',
        headers: createAdminHeaders(adminToken)
      })

      const response = await executeRequest(app, request, env)
      expect(response.status).toBe(200)
    })

    it('should require authentication', async () => {
      const request = createTestRequest('/api/admin/analytics', {
        method: 'GET'
      })

      const response = await executeRequest(app, request, env)
      expect(response.status).toBe(401)
    })
  })

  describe('GET /api/admin/analytics/orders', () => {
    it('lists only orders whose payment was captured', async () => {
      const session = (id, paymentIntent) => ({ id, status: 'complete', payment_intent: paymentIntent, created: 1 })
      const statuses = { pi_captured: 'succeeded', pi_held: 'requires_capture', pi_declined: 'canceled' }
      mockStripe.checkout.sessions.list.mockResolvedValue({
        data: [session('cs_captured', 'pi_captured'), session('cs_held', 'pi_held'), session('cs_declined', 'pi_declined')],
        has_more: false
      })
      mockStripe.checkout.sessions.listLineItems.mockResolvedValue({ data: [] })
      mockStripe.paymentIntents.retrieve.mockImplementation(async (id) => ({ id, status: statuses[id] }))

      const request = createTestRequest('/api/admin/analytics/orders', {
        method: 'GET',
        headers: createAdminHeaders(adminToken)
      })

      const data = await parseJsonResponse(await executeRequest(app, request, env))

      expect(data.orders.map((order) => order.id)).toEqual(['cs_captured'])
    })

    describe('orders on hold for a Kount review', () => {
      const session = (id, paymentIntent) => ({ id, status: 'complete', payment_intent: paymentIntent, created: 1 })
      const listOrders = async (status) => {
        const request = createTestRequest(`/api/admin/analytics/orders?status=${status}`, {
          method: 'GET',
          headers: createAdminHeaders(adminToken)
        })
        return (await parseJsonResponse(await executeRequest(app, request, env))).orders
      }

      beforeEach(() => {
        mockStripe.checkout.sessions.list.mockResolvedValue({
          data: [
            session('cs_captured', 'pi_captured'),
            session('cs_review', 'pi_review'),
            session('cs_pending', 'pi_pending'),
            session('cs_refunded', 'pi_refunded')
          ],
          has_more: false
        })
        mockStripe.checkout.sessions.listLineItems.mockResolvedValue({ data: [] })
        mockStripe.paymentIntents.retrieve.mockImplementation(async (id) => ({
          pi_captured: { id, capture_method: 'manual', status: 'succeeded' },
          pi_review: { id, capture_method: 'manual', status: 'succeeded', metadata: { kount_decision: 'REVIEW' } },
          pi_refunded: { id, capture_method: 'manual', status: 'succeeded', metadata: { kount_decision: 'DECLINE' } },
          pi_pending: { id, capture_method: 'manual', status: 'requires_capture', metadata: {} }
        })[id])
      })

      it('lists them under on_hold, with their status', async () => {
        const orders = await listOrders('on_hold')

        expect(orders.map((order) => [order.id, order.order_status])).toEqual([['cs_review', 'on_hold']])
      })

      it('keeps them, and refunded orders, out of the orders ready to ship', async () => {
        const orders = await listOrders('open')

        expect(orders.map((order) => order.id)).toEqual(['cs_captured'])
      })

      it('includes them in all orders', async () => {
        const orders = await listOrders('all')

        expect(orders.map((order) => order.id).sort()).toEqual(['cs_captured', 'cs_review'])
      })
    })

    it('should return orders list', async () => {
      const mockSessions = {
        data: [
          {
            id: 'cs_1',
            amount_total: 2999,
            currency: 'usd',
            payment_status: 'paid',
            customer_details: { email: 'test@example.com' },
            created: Math.floor(Date.now() / 1000)
          }
        ],
        has_more: false
      }

      mockStripe.checkout.sessions.list.mockResolvedValue(mockSessions)

      const request = createTestRequest('/api/admin/analytics/orders', {
        method: 'GET',
        headers: createAdminHeaders(adminToken)
      })

      const response = await executeRequest(app, request, env)
      const data = await parseJsonResponse(response)

      expect(response.status).toBe(200)
      expect(data).toBeDefined()
      expect(Array.isArray(data.orders) || Array.isArray(data)).toBe(true)
    })

    it('should accept limit query parameter', async () => {
      mockStripe.checkout.sessions.list.mockResolvedValue({ data: [], has_more: false })

      const request = createTestRequest('/api/admin/analytics/orders?limit=10', {
        method: 'GET',
        headers: createAdminHeaders(adminToken)
      })

      const response = await executeRequest(app, request, env)
      expect(response.status).toBe(200)
    })

    it('should enforce maximum limit of 50', async () => {
      mockStripe.checkout.sessions.list.mockResolvedValue({ data: [], has_more: false })

      const request = createTestRequest('/api/admin/analytics/orders?limit=100', {
        method: 'GET',
        headers: createAdminHeaders(adminToken)
      })

      const response = await executeRequest(app, request, env)
      expect(response.status).toBe(200)

      // Verify limit was capped at 50
      expect(mockStripe.checkout.sessions.list).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 50
        })
      )
    })

    it('should accept cursor and direction parameters', async () => {
      mockStripe.checkout.sessions.list.mockResolvedValue({ data: [], has_more: false })

      const request = createTestRequest('/api/admin/analytics/orders?cursor=cs_123&direction=prev', {
        method: 'GET',
        headers: createAdminHeaders(adminToken)
      })

      const response = await executeRequest(app, request, env)
      expect(response.status).toBe(200)
    })

    it('should filter fulfilled orders when showFulfilled is false', async () => {
      const mockSessions = {
        data: [
          {
            id: 'cs_1',
            amount_total: 2999,
            payment_status: 'paid',
            created: Math.floor(Date.now() / 1000)
          }
        ],
        has_more: false
      }

      mockStripe.checkout.sessions.list.mockResolvedValue(mockSessions)

      // Set up a fulfilled order in KV
      await kv.put('order_fulfillment:cs_1', JSON.stringify({
        fulfilled: true,
        fulfilledAt: new Date().toISOString()
      }))

      const request = createTestRequest('/api/admin/analytics/orders?showFulfilled=false', {
        method: 'GET',
        headers: createAdminHeaders(adminToken)
      })

      const response = await executeRequest(app, request, env)
      expect(response.status).toBe(200)
    })

    it('should require authentication', async () => {
      const request = createTestRequest('/api/admin/analytics/orders', {
        method: 'GET'
      })

      const response = await executeRequest(app, request, env)
      expect(response.status).toBe(401)
    })
  })

  describe('POST /api/admin/analytics/orders/:orderId/fulfill', () => {
    describe('on the Kount site', () => {
      const fulfill = () => executeRequest(app, createTestRequest(
        'https://kount-poc-run-110301.bdrhoa.workers.dev/api/admin/analytics/orders/cs_review/fulfill',
        { method: 'POST', headers: createAdminHeaders(adminToken) }
      ), env)
      const paymentIntent = (overrides) => ({
        id: 'cs_review',
        payment_intent: { capture_method: 'manual', status: 'succeeded', metadata: { kount_decision: 'REVIEW' }, ...overrides }
      })

      it('refuses an order on hold', async () => {
        mockStripe.checkout.sessions.retrieve.mockResolvedValue(paymentIntent())

        const response = await fulfill()

        expect(response.status).toBe(409)
        expect(await kv.get('order_fulfillment:cs_review')).toBeNull()
      })

      it('refuses a refunded order', async () => {
        mockStripe.checkout.sessions.retrieve.mockResolvedValue(paymentIntent({ metadata: { kount_decision: 'DECLINE' } }))

        const response = await fulfill()

        expect(response.status).toBe(409)
      })

      it('allows an approved order', async () => {
        mockStripe.checkout.sessions.retrieve.mockResolvedValue(paymentIntent({ metadata: { kount_decision: 'APPROVE' } }))

        const response = await fulfill()

        expect(response.status).toBe(200)
      })
    })

    it('should mark an order as fulfilled', async () => {
      const orderId = 'cs_test123'

      const request = createTestRequest(`/api/admin/analytics/orders/${orderId}/fulfill`, {
        method: 'POST',
        headers: createAdminHeaders(adminToken)
      })

      const response = await executeRequest(app, request, env)
      const data = await parseJsonResponse(response)

      expect(response.status).toBe(200)
      expect(data.success).toBe(true)
      expect(data.fulfillment).toBeDefined()
      expect(data.fulfillment.fulfilled).toBe(true)
      expect(data.fulfillment.fulfilledAt).toBeDefined()

      // Verify fulfillment was stored in KV
      const fulfillmentKey = `order_fulfillment:${orderId}`
      const storedFulfillment = await kv.get(fulfillmentKey)
      expect(storedFulfillment).toBeTruthy()
      const parsed = JSON.parse(storedFulfillment)
      expect(parsed.fulfilled).toBe(true)
    })

    it('should require authentication', async () => {
      const request = createTestRequest('/api/admin/analytics/orders/cs_test123/fulfill', {
        method: 'POST'
      })

      const response = await executeRequest(app, request, env)
      expect(response.status).toBe(401)
    })
  })
})





