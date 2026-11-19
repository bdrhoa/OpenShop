// Admin analytics routes
import { Hono } from 'hono'
import { AnalyticsService } from '../../services/AnalyticsService.js'
import { StripeService } from '../../services/StripeService.js'
import { getKVNamespace } from '../../utils/kv.js'
import { asyncHandler } from '../../middleware/errorHandler.js'
import { resolveSetting } from '../../services/DeveloperSettingsService.js'
import { KountOrderService, summarizeRecord } from '../../services/KountOrderService.js'

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

  // Attach the Kount decision / review / payment state to held orders.
  if (kvNamespace && Array.isArray(orders?.orders)) {
    const kount = new KountOrderService({ kv: kvNamespace, stripe: null, config: null, client: null })
    await Promise.all(orders.orders.map(async (order) => {
      order.kount = summarizeRecord(await kount.getRecord(order.id).catch(() => null))
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

  // Server-side gate: a held order may only be fulfilled once Kount (or a
  // reviewer) approved it and the payment was captured.
  const kount = new KountOrderService({ kv: kvNamespace, stripe: null, config: null, client: null })
  const gate = await kount.isFulfillmentAllowed(orderId)
  if (!gate.allowed) {
    return c.json({
      error: 'This order cannot be fulfilled until it is approved and the payment is captured.',
      kount: summarizeRecord(gate.record),
    }, 409)
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

