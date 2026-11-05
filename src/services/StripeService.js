// Stripe service - handles Stripe operations
import Stripe from 'stripe'
import { SHIPPING_COUNTRIES } from '../config/index.js'
import {
  KOUNT_DECISION_METADATA_KEY,
  KOUNT_DECLINE_DECISION,
  KOUNT_REVIEW_DECISION,
  KOUNT_SESSION_METADATA_KEY,
  KOUNT_USER_IP_METADATA_KEY,
  ORDER_STATUS_ON_HOLD,
  ORDER_STATUS_REFUNDED,
} from '../config/kount.js'
import { APIError } from '../utils/errors.js'

// Reserved local-dev sentinel from scripts/dev/build-local-config.mjs (.dev.vars).
// Exact match only: skips remote Stripe sync offline; every other key behaves normally.
export const LOCAL_NO_NETWORK_STRIPE_KEY = 'sk_test_local_no_network'

/**
 * True when no Stripe secret key is configured.
 *
 * A store with no key runs in catalogue-only mode: products can be created
 * and edited (KV writes proceed, with placeholder Stripe ids), but checkout
 * is refused. This lets a store be built out before payment credentials
 * exist, which is the usual order of operations when setting one up.
 */
export function isStripeConfigured(secretKey) {
  return typeof secretKey === 'string' && secretKey.trim() !== ''
}

/** Placeholder ids written to KV while no Stripe account is connected. */
export const UNLINKED_PRODUCT_ID = 'prod_unlinked'
export const UNLINKED_PRICE_ID = 'price_unlinked'

let warnedNoNetworkOnce = false
function warnNoNetworkOnce() {
  if (!warnedNoNetworkOnce) {
    console.warn('[StripeService] STRIPE_SECRET_KEY is the local no-network sentinel; skipping remote Stripe sync (KV writes continue)')
    warnedNoNetworkOnce = true
  }
}

let warnedNotConfiguredOnce = false
function warnNotConfiguredOnce() {
  if (!warnedNotConfiguredOnce) {
    console.warn('[StripeService] No STRIPE_SECRET_KEY set; running in catalogue-only mode (products save to KV, checkout is disabled)')
    warnedNotConfiguredOnce = true
  }
}

/** Stripe session metadata allows at most 50 keys. */
export const STRIPE_METADATA_KEY_LIMIT = 50

/**
 * Per-item keys are item_N_name / variant1 / variant2 (up to 3).
 * Reserve 3 summary keys + 2 overflow keys so the worst case stays at 50:
 * 3 + 2 + (15 * 3) = 50.
 */
export const CART_METADATA_DETAILED_ITEM_LIMIT = 15

function clipMeta(value) {
  return String(value || '').slice(0, 500)
}

/** Session metadata that the Kount evaluation reads after payment. */
function kountMetadata(kount) {
  return {
    ...(kount?.sessionId && { [KOUNT_SESSION_METADATA_KEY]: kount.sessionId }),
    ...(kount?.userIp && { [KOUNT_USER_IP_METADATA_KEY]: kount.userIp }),
  }
}

/** Authorize only, so nothing is charged until Kount has evaluated the order. */
function kountPaymentIntentData(kount) {
  return kount ? { payment_intent_data: { capture_method: 'manual' } } : {}
}

/** The state of an order placed on a held payment. Undefined for automatic capture. */
export function orderStatus(paymentIntent) {
  if (paymentIntent?.capture_method !== 'manual') return undefined
  if (paymentIntent.status === 'canceled') return 'declined'
  const decision = paymentIntent.metadata?.[KOUNT_DECISION_METADATA_KEY]
  if (decision === KOUNT_REVIEW_DECISION) return ORDER_STATUS_ON_HOLD
  if (paymentIntent.status === 'succeeded') {
    return decision === KOUNT_DECLINE_DECISION ? ORDER_STATUS_REFUNDED : 'confirmed'
  }
  return 'pending'
}

/**
 * Cart checkout metadata that never exceeds Stripe's 50-key limit.
 * @param {Array<{name?: string, quantity?: number, selectedVariant?: {name?: string}, selectedVariant2?: {name?: string}}>} items
 * @param {{sessionId?: string, userIp?: string}} [kount] Its keys take the place of one detailed item, keeping the worst case within the limit.
 */
export function buildCartCheckoutMetadata(items, kount) {
  const list = Array.isArray(items) ? items : []
  const metadata = {
    order_type: 'cart_checkout',
    item_count: String(list.length),
    total_quantity: String(list.reduce((sum, item) => sum + (Number(item.quantity) || 1), 0)),
  }

  const extraMetadata = kountMetadata(kount)
  const detailedItemLimit = CART_METADATA_DETAILED_ITEM_LIMIT - (Object.keys(extraMetadata).length > 0 ? 1 : 0)
  const detailed = list.slice(0, detailedItemLimit)
  detailed.forEach((item, index) => {
    metadata[`item_${index}_name`] = clipMeta(item.name || `Item ${index + 1}`)
    if (item.selectedVariant?.name) {
      metadata[`item_${index}_variant1`] = clipMeta(item.selectedVariant.name)
    }
    if (item.selectedVariant2?.name) {
      metadata[`item_${index}_variant2`] = clipMeta(item.selectedVariant2.name)
    }
  })

  if (list.length > detailedItemLimit) {
    metadata.metadata_truncated = 'true'
    metadata.overflow_item_count = String(list.length - detailedItemLimit)
  }

  return { ...metadata, ...extraMetadata }
}

export class StripeService {
  constructor(secretKey, siteUrl) {
    this.secretKey = secretKey
    this.isConfigured = isStripeConfigured(secretKey)
    this.isLocalNoNetwork = secretKey === LOCAL_NO_NETWORK_STRIPE_KEY
    // Constructing Stripe with an empty key throws ("Neither apiKey nor
    // config.authenticator provided"), which previously surfaced as a 500 on
    // every product write. Skip the client entirely when unconfigured; the
    // methods below no-op and checkout refuses with a clear message.
    this.stripe = this.isConfigured ? new Stripe(secretKey) : null
    this.siteUrl = siteUrl
  }

  /** Whether remote Stripe calls should be skipped for this instance. */
  get skipsRemoteSync() {
    return !this.isConfigured || this.isLocalNoNetwork
  }

  /** Emit the one-time warning matching why sync is being skipped. */
  warnSkip() {
    if (!this.isConfigured) warnNotConfiguredOnce()
    else warnNoNetworkOnce()
  }

  /**
   * Refuse checkout when no Stripe account is connected.
   *
   * Product writes degrade gracefully in catalogue-only mode, but taking
   * money must not: without a key there is no account to charge, and the
   * placeholder price ids in KV do not exist in Stripe. Failing here with an
   * explicit message beats a TypeError on a null client.
   */
  assertCheckoutAvailable() {
    if (!this.isConfigured) {
      throw new APIError('This store is not accepting payments yet.', 503)
    }
  }

  /**
   * Create a Stripe product
   */
  async createProduct(productData) {
    if (this.skipsRemoteSync) {
      this.warnSkip()
      return {
        id: this.isConfigured ? 'prod_local_no_network' : UNLINKED_PRODUCT_ID,
        name: productData.name,
        active: true,
      }
    }

    const stripeImages = Array.isArray(productData.images)
      ? productData.images
      : (productData.imageUrl ? [productData.imageUrl] : [])

    const productParams = {
      name: productData.name,
      images: stripeImages.slice(0, 8),
      type: 'good',
      tax_code: 'txcd_99999999', // Physical goods tax code
    }

    if (productData.description && String(productData.description).trim() !== '') {
      productParams.description = String(productData.description)
    }

    return await this.stripe.products.create(productParams)
  }

  /**
   * Update a Stripe product
   */
  async updateProduct(productId, updates) {
    if (this.skipsRemoteSync) {
      this.warnSkip()
      return { id: productId }
    }

    const updateParams = {
      name: updates.name,
      images: updates.images?.slice(0, 8) || [],
    }
    
    if (typeof updates.description === 'string') {
      const trimmed = updates.description.trim()
      if (trimmed) {
        updateParams.description = trimmed
      }
    }
    
    return await this.stripe.products.update(productId, updateParams)
  }

  /**
   * Archive a Stripe product
   */
  async archiveProduct(productId) {
    if (this.skipsRemoteSync) {
      this.warnSkip()
      return { id: productId, active: false }
    }
    return await this.stripe.products.update(productId, { active: false })
  }

  /**
   * Create a Stripe price
   */
  async createPrice(params) {
    if (this.skipsRemoteSync) {
      this.warnSkip()
      return { id: this.isConfigured ? 'price_local_no_network' : UNLINKED_PRICE_ID }
    }
    return await this.stripe.prices.create({
      unit_amount: Math.round(params.amount * 100),
      currency: params.currency,
      product: params.productId,
      nickname: params.nickname,
      metadata: params.metadata || {},
    })
  }

  /**
   * Archive a Stripe price
   */
  async archivePrice(priceId) {
    if (this.skipsRemoteSync) {
      this.warnSkip()
      return { id: priceId, active: false }
    }
    return await this.stripe.prices.update(priceId, { active: false })
  }

  /**
   * Create checkout session for single item
   * @param {string} priceId
   * @param {{sessionId?: string, userIp?: string}} [kount] Set on the Kount site: the payment is held for evaluation.
   */
  async createCheckoutSession(priceId, kount) {
    this.assertCheckoutAvailable()
    return await this.stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'payment',
      shipping_address_collection: {
        allowed_countries: SHIPPING_COUNTRIES,
      },
      billing_address_collection: 'required',
      success_url: `${this.siteUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${this.siteUrl}/`,
      ...(kount && { metadata: kountMetadata(kount) }),
      ...kountPaymentIntentData(kount),
    })
  }

  /**
   * Create checkout session for cart
   * @param {Array} items
   * @param {{sessionId?: string, userIp?: string}} [kount] Set on the Kount site: the payment is held for evaluation.
   */
  async createCartCheckoutSession(items, kount) {
    this.assertCheckoutAvailable()
    const lineItems = items.map(item => {
      // When using price IDs, you cannot set description, name, images, etc. directly
      // These must come from the price object itself
      const lineItem = {
        price: item.stripePriceId,
        quantity: item.quantity || 1,
      }

      // Note: Description, name, and images are not allowed when using price IDs
      // If you need custom descriptions, you would need to use price_data instead
      // For now, we'll rely on the product information stored in Stripe

      return lineItem
    })

    return await this.stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      shipping_address_collection: {
        allowed_countries: SHIPPING_COUNTRIES,
      },
      billing_address_collection: 'required',
      success_url: `${this.siteUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${this.siteUrl}/`,
      metadata: buildCartCheckoutMetadata(items, kount),
      ...kountPaymentIntentData(kount),
    })
  }

  /**
   * Get checkout session details
   */
  async getCheckoutSession(sessionId) {
    this.assertCheckoutAvailable()
    const session = await this.stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['payment_intent'],
    })
    return {
      id: session.id,
      amount_total: session.amount_total,
      currency: session.currency,
      customer_email: session.customer_details?.email,
      payment_status: session.payment_status,
      status: session.status,
      order_status: orderStatus(session.payment_intent),
      created: session.created,
    }
  }

  /**
   * Checkout session with the payment, charge and card details Kount needs
   */
  async getCheckoutSessionForRiskEvaluation(sessionId) {
    return await this.stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['payment_intent.latest_charge'],
    })
  }

  /**
   * Verify a webhook delivery. Workers needs the async, SubtleCrypto-based check.
   */
  async constructWebhookEvent(rawBody, signature, webhookSecret) {
    return await this.stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      webhookSecret,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    )
  }

  /**
   * Merge metadata onto a payment intent
   */
  async updatePaymentIntentMetadata(paymentIntentId, metadata) {
    return await this.stripe.paymentIntents.update(paymentIntentId, { metadata })
  }

  /**
   * Capture a held payment
   */
  async capturePaymentIntent(paymentIntentId) {
    return await this.stripe.paymentIntents.capture(paymentIntentId, {}, {
      idempotencyKey: `capture_${paymentIntentId}`,
    })
  }

  /**
   * Release a held payment that failed risk evaluation
   */
  async cancelPaymentIntentAsFraudulent(paymentIntentId) {
    return await this.stripe.paymentIntents.cancel(paymentIntentId, {
      cancellation_reason: 'fraudulent',
    }, {
      idempotencyKey: `cancel_${paymentIntentId}`,
    })
  }

  /**
   * Refund a captured payment that a Kount reviewer declined
   */
  async refundPaymentIntentAsFraudulent(paymentIntentId) {
    try {
      return await this.stripe.refunds.create({
        payment_intent: paymentIntentId,
        reason: 'fraudulent',
      }, {
        idempotencyKey: `refund_${paymentIntentId}`,
      })
    } catch (error) {
      // A repeat delivery after the idempotency key has expired.
      if (error.code === 'charge_already_refunded') return null
      throw error
    }
  }

  /**
   * List checkout sessions with pagination
   */
  async listCheckoutSessions(options = {}) {
    const params = {
      limit: Math.min(options.limit || 25, 50),
    }
    
    if (options.cursor) {
      if (options.direction === 'prev') {
        params.ending_before = options.cursor
      } else {
        params.starting_after = options.cursor
      }
    }
    
    return await this.stripe.checkout.sessions.list(params)
  }

  /**
   * Get line items for a checkout session
   */
  async getCheckoutSessionLineItems(sessionId) {
    return await this.stripe.checkout.sessions.listLineItems(sessionId, { 
      limit: 100, 
      expand: ['data.price.product'] 
    })
  }

  /**
   * Get payment intent with shipping details
   */
  async getPaymentIntent(paymentIntentId) {
    return await this.stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ['shipping']
    })
  }

  /**
   * List payment intents for analytics
   */
  async listPaymentIntents(startDate) {
    return await this.stripe.paymentIntents.list({
      created: { gte: Math.floor(startDate.getTime() / 1000) },
      limit: 100,
    })
  }
}

