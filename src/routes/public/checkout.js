// Public checkout routes
import { Hono } from 'hono'
import { StripeService } from '../../services/StripeService.js'
import { asyncHandler } from '../../middleware/errorHandler.js'
import { ValidationError } from '../../utils/errors.js'
import { parseJsonBody, getClientIp } from '../../utils/request.js'
import { resolveSetting } from '../../services/DeveloperSettingsService.js'
import { getKVNamespace } from '../../utils/kv.js'
import { CART_MAX_ITEMS, CART_MAX_ITEM_QUANTITY } from '../../config/index.js'
import { KOUNT_SESSION_ID_PATTERN } from '../../config/kount.js'
import { resolveKountConfig, isKountEnabled } from '../../services/KountService.js'
import { KountOrderService, buyerStatus } from '../../services/KountOrderService.js'

const router = new Hono()

/**
 * Kount screening options for a new Checkout Session, or null when Kount is
 * off. An invalid or missing device session ID does not block checkout: the
 * order is still evaluated, just without device data.
 */
async function kountCheckoutOptions(c, kountSessionId) {
  const cfg = await resolveKountConfig(getKVNamespace(c.env), c.env)
  if (!isKountEnabled(cfg)) return null
  const sessionId = typeof kountSessionId === 'string' && KOUNT_SESSION_ID_PATTERN.test(kountSessionId)
    ? kountSessionId
    : null
  const ip = getClientIp(c)
  return { sessionId, userIp: ip && ip !== 'unknown' ? ip : null }
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
  const session = await stripeService.createCheckoutSession(trimmedPriceId, {
    kount: await kountCheckoutOptions(c, kountSessionId),
  })
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
  const session = await stripeService.createCartCheckoutSession(normalizedItems, {
    kount: await kountCheckoutOptions(c, kountSessionId),
  })
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
  if (session.kountHold) {
    // Payment is held for fraud screening; report the buyer-facing state
    // instead of Stripe's payment_status (which reads "unpaid" until capture).
    const record = await new KountOrderService({ kv: getKVNamespace(c.env) }).get(trimmedSessionId)
    session.orderStatus = buyerStatus(record)
  } else {
    session.orderStatus = session.payment_status === 'paid' ? 'confirmed' : 'processing'
  }
  delete session.kountHold
  return c.json(session)
}))

export default router

