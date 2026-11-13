// Admin analytics routes
import { Hono } from 'hono'
import { AnalyticsService } from '../../services/AnalyticsService.js'
import { StripeService } from '../../services/StripeService.js'
import { getKVNamespace } from '../../utils/kv.js'
import { asyncHandler } from '../../middleware/errorHandler.js'
import { resolveSetting } from '../../services/DeveloperSettingsService.js'
import { FraudReviewService } from '../../services/FraudReviewService.js'
import { APIError } from '../../utils/errors.js'

const router = new Hono()

// Get analytics
router.get('/', asyncHandler(async (c) => {
  const period = c.req.query('period') || '30d'
  const stripeService = new StripeService(
    await resolveSetting(getKVNamespace(c.env), c.env, 'STRIPE_SECRET_KEY'),
    await resolveSetting(getKVNamespace(c.env), c.env, 'SITE_URL'),
  )
  const kvNamespace = getKVNamespace(c.env)
  const analyticsService = new AnalyticsService(stripeService, kvNamespace)
  const analytics = await analyticsService.getAnalytics(period)
  return c.json(analytics)
}))

// Get orders
router.get('/orders', asyncHandler(async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') || '25', 10), 50)
  const direction = c.req.query('direction') || 'next'
  const cursor = c.req.query('cursor') || undefined
  const showFulfilled = c.req.query('showFulfilled') === 'true'
  const fulfillmentStatus = c.req.query('status') || (showFulfilled ? 'fulfilled' : 'open')

  const stripeService = new StripeService(
    await resolveSetting(getKVNamespace(c.env), c.env, 'STRIPE_SECRET_KEY'),
    await resolveSetting(getKVNamespace(c.env), c.env, 'SITE_URL'),
  )
  const analyticsService = new AnalyticsService(stripeService)
  const kvNamespace = getKVNamespace(c.env)

  const orders = await analyticsService.getOrders({
    limit,
    direction,
    cursor,
    showFulfilled,
    fulfillmentStatus,
    kvNamespace
  })

  // Kount REVIEW orders are captured but must not ship until a reviewer
  // approves; declined or unresolved orders never ship.
  if (kvNamespace && Array.isArray(orders.orders)) {
    const fraud = new FraudReviewService({ kv: kvNamespace })
    await Promise.all(orders.orders.map(async (order) => {
      order.fraudReview = await fraud.getFulfillmentStatus(order.id)
    }))
  }

  return c.json(orders)
}))

// Mark order as fulfilled
router.post('/orders/:orderId/fulfill', asyncHandler(async (c) => {
  const orderId = c.req.param('orderId')
  const kvNamespace = getKVNamespace(c.env)
  
  if (!kvNamespace) {
    throw new Error('KV namespace not available')
  }

  const fraudStatus = await new FraudReviewService({ kv: kvNamespace }).getFulfillmentStatus(orderId)
  if (!fraudStatus.fulfillable) {
    throw new APIError(`This order cannot be fulfilled while its fraud review status is "${fraudStatus.state}".`, 409)
  }

  const fulfillmentKey = `order_fulfillment:${orderId}`
  const fulfillmentData = {
    fulfilled: true,
    fulfilledAt: new Date().toISOString(),
    fulfilledBy: 'admin'
  }

  await kvNamespace.put(fulfillmentKey, JSON.stringify(fulfillmentData))
  return c.json({ success: true, fulfillment: fulfillmentData })
}))

export default router

