// Route registration - imports and registers all routes
import { Hono } from 'hono'

// Public routes
import productsRouter from './public/products.js'
import collectionsRouter from './public/collections.js'
import storefrontRouter from './public/storefront.js'
import checkoutRouter from './public/checkout.js'
import imageProxyRouter from './public/imageProxy.js'
import storeSettingsRouter, { contactEmailRouter } from './public/storeSettings.js'
import imagesRouter from './public/images.js'
import pagesRouter from './public/pages.js'
import webhooksRouter from './public/webhooks.js'

// Admin routes
import authRouter from './admin/auth.js'
import adminProductsRouter from './admin/products.js'
import adminCollectionsRouter from './admin/collections.js'
import analyticsRouter from './admin/analytics.js'
import mediaRouter from './admin/media.js'
import storageRouter from './admin/storage.js'
import settingsRouter from './admin/settings.js'
import aiRouter from './admin/ai.js'
import agentRouter, { setAgentApp } from './admin/agent.js'
import { isStripeConfigured } from '../services/StripeService.js'
import { resolveSetting } from '../services/DeveloperSettingsService.js'
import { getKVNamespace } from '../utils/kv.js'
import developerSettingsRouter from './admin/developer-settings.js'
import fraudReviewsRouter from './admin/fraudReviews.js'
import { resolveKountSettings } from '../services/FraudReviewService.js'
import { KOUNT_SANDBOX } from '../config/kount.js'

/**
 * Register all routes on the app
 * @param {Hono} app - Hono app instance
 */
export function registerRoutes(app) {
  // Give the agent route access to the full app so its tools can invoke
  // existing admin endpoints in-process (auth, Stripe sync, limits all apply).
  setAgentApp(app)

  // Health check
  app.get('/api/health', (c) => {
    return c.json({ status: 'healthy', timestamp: new Date().toISOString() })
  })

  // Whether the store can take money yet.
  //
  // Public because the storefront needs it to decide whether to render a Buy
  // button, and it reveals nothing sensitive: only that a key is or is not
  // present, never the key itself. Resolved through Developer Settings so a
  // key set in the admin panel enables checkout without a redeploy.
  app.get('/api/payments-status', async (c) => {
    const kv = getKVNamespace(c.env)
    const stripeKey = await resolveSetting(kv, c.env, 'STRIPE_SECRET_KEY')
    const kount = await resolveKountSettings(kv, c.env)
    // The Kount client ID is not a secret: the device collection SDK sends
    // it from the browser. The API key never leaves the Worker.
    return c.json({
      paymentsEnabled: isStripeConfigured(stripeKey),
      fraudPrevention: kount.enabled
        ? { provider: 'kount', clientId: kount.clientId, environment: KOUNT_SANDBOX.collectorEnvironment }
        : null,
    })
  })

  // Public API routes
  app.route('/api/products', productsRouter)
  app.route('/api/collections', collectionsRouter)
  app.route('/api/storefront', storefrontRouter)
  app.route('/api', checkoutRouter) // /api/create-checkout-session, etc.
  app.route('/api', webhooksRouter) // /api/stripe-webhook, /api/kount-webhook
  app.route('/api/image-proxy', imageProxyRouter)
  app.route('/api/store-settings', storeSettingsRouter)
  app.route('/api/contact-email', contactEmailRouter)
  app.route('/api/images', imagesRouter)
  app.route('/api/storefront/pages', pagesRouter)

  // Admin API routes
  app.route('/api/admin', authRouter) // /api/admin/login
  app.route('/api/admin/products', adminProductsRouter)
  app.route('/api/admin/collections', adminCollectionsRouter)
  app.route('/api/admin/analytics', analyticsRouter)
  app.route('/api/admin/media', mediaRouter)
  app.route('/api/admin/storage', storageRouter)
  app.route('/api/admin', settingsRouter) // /api/admin/storefront/theme, etc.
  app.route('/api/admin/ai', aiRouter)
  app.route('/api/admin/agent', agentRouter) // /api/admin/agent/chat, /models
  app.route('/api/admin/developer-settings', developerSettingsRouter)
  app.route('/api/admin/fraud-reviews', fraudReviewsRouter)
}
