// Public checkout routes
import { Hono } from 'hono'
import { StripeService } from '../../services/StripeService.js'
import { KountService, settleHeldCheckout } from '../../services/KountService.js'
import { processKountOrderEvent, verifyKountWebhook } from '../../services/KountWebhookService.js'
import { asyncHandler } from '../../middleware/errorHandler.js'
import { APIError, NotFoundError, ValidationError } from '../../utils/errors.js'
import { getClientIp, parseJsonBody } from '../../utils/request.js'
import { resolveSetting } from '../../services/DeveloperSettingsService.js'
import { getKVNamespace } from '../../utils/kv.js'
import { CART_MAX_ITEMS, CART_MAX_ITEM_QUANTITY } from '../../config/index.js'
import { isKountDdcHost, isValidKountSessionId } from '../../config/kount.js'

const router = new Hono()

function isKountSite(c) {
  return isKountDdcHost(new URL(c.req.url).hostname)
}

// Undefined on other sites, which keep automatic capture. A bad session ID must
// never block a sale, so it is dropped: the order is still held and evaluated.
function resolveKountCheckout(c, sessionId) {
  if (!isKountSite(c)) return undefined
  const clientIp = getClientIp(c)
  return {
    sessionId: isValidKountSessionId(sessionId) ? sessionId : undefined,
    userIp: clientIp === 'unknown' ? undefined : clientIp,
  }
}

// Create checkout session (single item)
router.post('/create-checkout-session', asyncHandler(async (c) => {
  const { priceId, kountSessionId } = await parseJsonBody(c)
  
  // Validate and trim priceId
  if (!priceId || typeof priceId !== 'string') {
    throw new ValidationError('Valid price ID is required')
  }
  
  const trimmedPriceId = priceId.trim()
  
  if (trimmedPriceId.length === 0) {
    throw new ValidationError('Valid price ID is required')
  }
  
  // Validate priceId format (Stripe price IDs start with price_)
  if (!trimmedPriceId.startsWith('price_')) {
    throw new ValidationError('Invalid price ID format')
  }
  
  // Limit priceId length to prevent DoS
  if (trimmedPriceId.length > 255) {
    throw new ValidationError('Price ID is too long')
  }

  const stripeService = new StripeService(
    await resolveSetting(getKVNamespace(c.env), c.env, 'STRIPE_SECRET_KEY'),
    await resolveSetting(getKVNamespace(c.env), c.env, 'SITE_URL'),
  )
  const session = await stripeService.createCheckoutSession(trimmedPriceId, resolveKountCheckout(c, kountSessionId))
  return c.json({ sessionId: session.id, url: session.url })
}))

// Create cart checkout session
router.post('/create-cart-checkout-session', asyncHandler(async (c) => {
  const { items, kountSessionId } = await parseJsonBody(c)
  
  // Validate items array
  if (!items || !Array.isArray(items) || items.length === 0) {
    throw new ValidationError('Cart items are required')
  }
  
  // Limit cart size to prevent DoS
  if (items.length > CART_MAX_ITEMS) {
    throw new ValidationError('Cart size exceeds maximum allowed items')
  }
  
  // Validate and normalize each item
  const normalizedItems = items.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new ValidationError(`Invalid cart item format at index ${index}`)
    }
    
    // Support both priceId and stripePriceId (for backward compatibility)
    const priceId = item.stripePriceId || item.priceId
    if (!priceId || typeof priceId !== 'string' || !priceId.startsWith('price_')) {
      throw new ValidationError(`Invalid price ID in cart item at index ${index}`)
    }
    
    // Validate and normalize quantity
    let quantity = item.quantity
    if (quantity === undefined || quantity === null) {
      quantity = 1
    }
    
    // Convert to integer if it's a number string
    quantity = Number.parseInt(quantity, 10)
    
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > CART_MAX_ITEM_QUANTITY) {
      throw new ValidationError(`Invalid quantity in cart item at index ${index} (must be 1-${CART_MAX_ITEM_QUANTITY}, got ${quantity})`)
    }
    
    // Return normalized item
    return {
      ...item,
      stripePriceId: priceId.trim(),
      quantity: quantity
    }
  })

  const stripeService = new StripeService(
    await resolveSetting(getKVNamespace(c.env), c.env, 'STRIPE_SECRET_KEY'),
    await resolveSetting(getKVNamespace(c.env), c.env, 'SITE_URL'),
  )
  const session = await stripeService.createCartCheckoutSession(normalizedItems, resolveKountCheckout(c, kountSessionId))
  return c.json({ sessionId: session.id, url: session.url })
}))

// Get checkout session details
router.get('/checkout-session/:sessionId', asyncHandler(async (c) => {
  const sessionId = c.req.param('sessionId')
  
  // Validate and trim sessionId
  if (!sessionId || typeof sessionId !== 'string') {
    throw new ValidationError('Invalid session ID format')
  }
  
  const trimmedSessionId = sessionId.trim()
  
  // Validate sessionId format (Stripe session IDs start with cs_)
  if (!trimmedSessionId.startsWith('cs_')) {
    throw new ValidationError('Invalid session ID format')
  }
  
  // Limit sessionId length to prevent DoS
  if (trimmedSessionId.length > 255) {
    throw new ValidationError('Session ID is too long')
  }
  
  const stripeService = new StripeService(
    await resolveSetting(getKVNamespace(c.env), c.env, 'STRIPE_SECRET_KEY'),
    await resolveSetting(getKVNamespace(c.env), c.env, 'SITE_URL'),
  )
  const session = await stripeService.getCheckoutSession(trimmedSessionId)
  return c.json(session)
}))

// Stripe webhook: evaluates a held payment with Kount, then captures or cancels it.
// REVIEW captures, and the order stays on hold until the Kount webhook resolves it.
// Any failure returns an error so Stripe retries. Until then the payment stays
// held, and an authorization that is never captured expires uncharged.
router.post('/stripe-webhook', asyncHandler(async (c) => {
  if (!isKountSite(c)) {
    throw new NotFoundError('Not found')
  }

  const signature = c.req.header('stripe-signature')
  if (!signature) {
    throw new ValidationError('Missing Stripe signature')
  }
  if (!c.env.STRIPE_WEBHOOK_SECRET || !c.env.KOUNT_API_KEY) {
    throw new APIError('Webhook is not configured', 503)
  }

  const stripeService = new StripeService(
    await resolveSetting(getKVNamespace(c.env), c.env, 'STRIPE_SECRET_KEY'),
    await resolveSetting(getKVNamespace(c.env), c.env, 'SITE_URL'),
  )
  stripeService.assertCheckoutAvailable()

  let event
  try {
    event = await stripeService.constructWebhookEvent(await c.req.text(), signature, c.env.STRIPE_WEBHOOK_SECRET)
  } catch {
    throw new ValidationError('Invalid Stripe signature')
  }

  if (event.type === 'checkout.session.completed') {
    await settleHeldCheckout({
      stripeService,
      kountService: new KountService(c.env.KOUNT_API_KEY),
      sessionId: event.data.object.id,
    })
  }

  return c.json({ received: true })
}))

// Kount webhook: resolves an order on hold for review, releasing it to ship or
// refunding its payment. Any failure returns an error so Kount retries, and the
// order stays on hold until then.
router.post('/kount-webhook', asyncHandler(async (c) => {
  if (!isKountSite(c)) {
    throw new NotFoundError('Not found')
  }
  if (!c.env.KOUNT_WEBHOOK_PUBLIC_KEY || !c.env.KOUNT_API_KEY) {
    throw new APIError('Webhook is not configured', 503)
  }

  const rawBody = await c.req.text()
  const verified = await verifyKountWebhook({
    rawBody,
    signature: c.req.header('x-event-signature'),
    timestamp: c.req.header('x-event-timestamp'),
    publicKey: c.env.KOUNT_WEBHOOK_PUBLIC_KEY,
  })
  if (!verified) {
    throw new ValidationError('Invalid Kount signature')
  }

  let event
  try {
    event = JSON.parse(rawBody)
  } catch {
    throw new ValidationError('Invalid Kount event')
  }

  const stripeService = new StripeService(
    await resolveSetting(getKVNamespace(c.env), c.env, 'STRIPE_SECRET_KEY'),
    await resolveSetting(getKVNamespace(c.env), c.env, 'SITE_URL'),
  )
  stripeService.assertCheckoutAvailable()

  const result = await processKountOrderEvent({
    stripeService,
    kountService: new KountService(c.env.KOUNT_API_KEY),
    event,
  })
  return c.json({ received: true, outcome: result.outcome })
}))

export default router

