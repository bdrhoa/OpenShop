// Public checkout routes
import { Hono } from 'hono'
import { StripeService } from '../../services/StripeService.js'
import { asyncHandler } from '../../middleware/errorHandler.js'
import { ValidationError, APIError } from '../../utils/errors.js'
import { parseJsonBody, getClientIp } from '../../utils/request.js'
import { resolveSetting } from '../../services/DeveloperSettingsService.js'
import { getKVNamespace } from '../../utils/kv.js'
import { CART_MAX_ITEMS, CART_MAX_ITEM_QUANTITY } from '../../config/index.js'
import { resolveKountConfig } from '../../services/KountConfigService.js'
import { FraudOrderStore } from '../../services/FraudOrderStore.js'

const router = new Hono()

// Kount device session IDs: alphanumeric plus - and _, at most 32 chars.
const KOUNT_SESSION_ID = /^[A-Za-z0-9_-]{1,32}$/

/**
 * Fraud screening options for a new Checkout Session, or null when Kount is
 * not configured. Invalid Kount configuration is an error, not "off": a
 * misconfiguration must not silently disable screening.
 */
async function fraudScreeningFor(c, body) {
  let config
  try {
    config = await resolveKountConfig(getKVNamespace(c.env), c.env)
  } catch (error) {
    console.error(`[checkout] Kount configuration invalid: ${error.message}`)
    throw new APIError('Checkout is temporarily unavailable.', 503)
  }
  if (!config.enabled) return null
  const candidate = typeof body.kountSessionId === 'string' ? body.kountSessionId.trim() : ''
  if (candidate && !KOUNT_SESSION_ID.test(candidate)) {
    throw new ValidationError('Invalid device session ID')
  }
  return { deviceSessionId: candidate || undefined }
}

async function saveFraudContext(c, session, fraudScreening) {
  if (!fraudScreening) return
  const ip = getClientIp(c)
  await new FraudOrderStore(getKVNamespace(c.env)).saveCheckoutContext(session.id, {
    deviceSessionId: fraudScreening.deviceSessionId || null,
    userIp: ip === 'unknown' ? null : ip,
  })
}

// Browser configuration for Kount device data collection. The client ID is
// not a secret (it is embedded in the collector request); the API key and
// webhook settings are never exposed here.
router.get('/kount/config', asyncHandler(async (c) => {
  try {
    const config = await resolveKountConfig(getKVNamespace(c.env), c.env)
    return c.json({
      enabled: config.enabled,
      clientId: config.enabled ? config.clientId : null,
      environment: config.ddcEnvironment,
    })
  } catch {
    return c.json({ enabled: false, clientId: null, environment: null })
  }
}))

// Create checkout session (single item)
router.post('/create-checkout-session', asyncHandler(async (c) => {
  const body = await parseJsonBody(c)
  const { priceId } = body
  
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
  const fraudScreening = await fraudScreeningFor(c, body)
  const session = await stripeService.createCheckoutSession(trimmedPriceId, { fraudScreening })
  await saveFraudContext(c, session, fraudScreening)
  return c.json({ sessionId: session.id, url: session.url })
}))

// Create cart checkout session
router.post('/create-cart-checkout-session', asyncHandler(async (c) => {
  const body = await parseJsonBody(c)
  const { items } = body
  
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
  const fraudScreening = await fraudScreeningFor(c, body)
  const session = await stripeService.createCartCheckoutSession(normalizedItems, { fraudScreening })
  await saveFraudContext(c, session, fraudScreening)
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

export default router

