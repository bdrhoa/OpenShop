// Kount service - Payments Fraud v2 risk evaluation for held Stripe payments.
//
// Hosted Stripe Checkout authorizes the card on Stripe's page, so the order is
// evaluated after authorization and before capture. That is when the email,
// addresses and card details first exist. Only a decision in
// KOUNT_CAPTURE_DECISIONS releases the funds.
import {
  KOUNT_CAPTURE_DECISIONS,
  KOUNT_CHANNEL,
  KOUNT_DECISIONS,
  KOUNT_DECISION_METADATA_KEY,
  KOUNT_ORDERS_URL,
  KOUNT_ORDER_ID_METADATA_KEY,
  KOUNT_REQUEST_TIMEOUT_MS,
  KOUNT_SESSION_METADATA_KEY,
  KOUNT_TOKEN_SCOPE,
  KOUNT_TOKEN_URL,
  KOUNT_USER_IP_METADATA_KEY,
} from '../config/kount.js'
import { APIError } from '../utils/errors.js'

const TOKEN_REFRESH_MARGIN_MS = 60 * 1000
const IPV4_PATTERN = /^(\d{1,3}\.){3}\d{1,3}$/

// Stripe's card brand names, where they differ from Kount's.
const KOUNT_CARD_BRANDS = { amex: 'americanexpress' }

const CVV_STATUS = { pass: 'MATCH', fail: 'NO_MATCH' }

let cachedToken = null

/** Clears the token shared across requests in this isolate. */
export function resetKountTokenCache() {
  cachedToken = null
}

function unavailable(reason) {
  // Callers must treat this as "no decision"; it must never read as an approval.
  console.error(`[KountService] ${reason}`)
  return new APIError('Risk evaluation is unavailable', 503)
}

export class KountService {
  constructor(apiKey) {
    this.apiKey = apiKey
  }

  async getToken() {
    if (cachedToken?.apiKey === this.apiKey && Date.now() < cachedToken.refreshAt) {
      return cachedToken.value
    }

    const response = await fetch(KOUNT_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${this.apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: KOUNT_TOKEN_SCOPE }),
      signal: AbortSignal.timeout(KOUNT_REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw unavailable(`token request failed with HTTP ${response.status}`)
    }

    const { access_token: value, expires_in: expiresIn } = await response.json()
    if (!value) {
      throw unavailable('token response had no access_token')
    }
    cachedToken = {
      apiKey: this.apiKey,
      value,
      refreshAt: Date.now() + Number(expiresIn) * 1000 - TOKEN_REFRESH_MARGIN_MS,
    }
    return value
  }

  /**
   * Run a risk inquiry.
   * @param {object} order Kount OrderPostBody
   * @returns {Promise<{orderId: string, decision: 'APPROVE'|'DECLINE'|'REVIEW'}>}
   */
  async evaluateOrder(order) {
    const response = await fetch(`${KOUNT_ORDERS_URL}?riskInquiry=true`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await this.getToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(order),
      signal: AbortSignal.timeout(KOUNT_REQUEST_TIMEOUT_MS),
    })

    if (!response.ok) {
      if (response.status === 401) resetKountTokenCache()
      const correlationId = response.headers.get('x-correlation-id')
      throw unavailable(`order evaluation failed with HTTP ${response.status} (correlation ${correlationId})`)
    }

    const { order: evaluated } = await response.json()
    const inquiry = [evaluated?.riskInquiry].flat()[0]
    if (!evaluated?.orderId || !KOUNT_DECISIONS.includes(inquiry?.decision)) {
      throw unavailable('order evaluation returned no usable decision')
    }
    return { orderId: evaluated.orderId, decision: inquiry.decision }
  }
}

function toPerson({ name, email, phone, address }) {
  const nameParts = (name || '').trim().split(/\s+/).filter(Boolean)
  const family = nameParts.length > 1 ? nameParts.pop() : undefined
  return {
    ...(nameParts.length > 0 && { name: { first: nameParts.join(' '), family } }),
    ...(email && { emailAddress: email }),
    ...(phone && { phoneNumber: phone }),
    ...(address && {
      address: {
        line1: address.line1 ?? undefined,
        line2: address.line2 ?? undefined,
        city: address.city ?? undefined,
        region: address.state ?? undefined,
        countryCode: address.country ?? undefined,
        postalCode: address.postal_code ?? undefined,
      },
    }),
  }
}

/** AVS code from Stripe's separate street and postal code checks. */
function toAvsStatus({ address_line1_check: street, address_postal_code_check: postal } = {}) {
  if (street === 'pass' && postal === 'pass') return 'Y'
  if (street === 'pass') return 'A'
  if (postal === 'pass') return 'Z'
  if (street === 'fail' || postal === 'fail') return 'N'
  return 'U'
}

function toKountItem(lineItem) {
  const product = lineItem.price?.product
  return {
    id: lineItem.price?.id,
    name: lineItem.description,
    ...(product?.description && { description: product.description }),
    price: String(lineItem.price?.unit_amount ?? 0),
    quantity: lineItem.quantity,
    isDigital: false,
  }
}

/**
 * Map a completed Checkout Session with a held payment to a Kount order.
 * Timestamps are left out: the API's date-time pattern contradicts its own
 * examples, and Kount records when the order arrives.
 */
export function buildKountOrder(session, lineItems) {
  const paymentIntent = session.payment_intent
  const charge = paymentIntent.latest_charge
  const card = charge.payment_method_details?.card
  const shipping = session.collected_information?.shipping_details ?? paymentIntent.shipping
  const email = session.customer_details?.email ?? charge.billing_details?.email
  const userIp = session.metadata?.[KOUNT_USER_IP_METADATA_KEY]
  const deviceSessionId = session.metadata?.[KOUNT_SESSION_METADATA_KEY]
  const items = lineItems.map(toKountItem)
  const itemQuantities = items.map(({ id, quantity }) => ({ id, quantity }))

  return {
    merchantOrderId: session.id,
    channel: KOUNT_CHANNEL,
    ...(deviceSessionId && { deviceSessionId }),
    ...(IPV4_PATTERN.test(userIp ?? '') && { userIp }),
    items,
    fulfillment: [{
      type: 'SHIPPED',
      status: 'PENDING',
      items: itemQuantities,
      ...(shipping && { recipientPerson: toPerson({ ...shipping, email }) }),
    }],
    transactions: [{
      processor: 'STRIPE',
      merchantTransactionId: paymentIntent.id,
      subtotal: String(session.amount_subtotal),
      orderTotal: String(session.amount_total),
      currency: session.currency.toUpperCase(),
      ...(session.total_details?.amount_tax > 0 && {
        tax: { isTaxable: true, taxAmount: String(session.total_details.amount_tax) },
      }),
      transactionStatus: 'AUTHORIZED',
      billedPerson: toPerson({ ...charge.billing_details, email }),
      items: itemQuantities,
      // Stripe never exposes the card number, so the fingerprint is the payment token.
      payment: {
        type: 'TOKEN',
        ...(card?.fingerprint && { paymentToken: card.fingerprint }),
        ...(card?.brand && { cardBrand: KOUNT_CARD_BRANDS[card.brand] ?? card.brand }),
        ...(card?.iin && { bin: card.iin }),
        ...(card?.last4 && { last4: card.last4 }),
        ...(card?.exp_month && { expirationMonth: card.exp_month }),
        ...(card?.exp_year && { expirationYear: card.exp_year }),
      },
      authorizationStatus: {
        authResult: 'APPROVED',
        verificationResponse: {
          cvvStatus: CVV_STATUS[card?.checks?.cvc_check] ?? 'UNKNOWN',
          avsStatus: toAvsStatus(card?.checks),
        },
        processorTransactionId: charge.id,
      },
    }],
  }
}

/**
 * Evaluate a completed checkout and capture or cancel its held payment. Safe to
 * repeat: Stripe retries webhooks, a saved decision is not evaluated again, and
 * a payment that is no longer held is left alone.
 * @returns {Promise<{decision?: string, outcome: 'captured'|'canceled'|'skipped'}>}
 */
export async function settleHeldCheckout({ stripeService, kountService, sessionId }) {
  const session = await stripeService.getCheckoutSessionForRiskEvaluation(sessionId)
  const paymentIntent = session.payment_intent
  if (paymentIntent?.capture_method !== 'manual' || paymentIntent.status !== 'requires_capture') {
    return { outcome: 'skipped' }
  }

  let decision = paymentIntent.metadata?.[KOUNT_DECISION_METADATA_KEY]
  if (!decision) {
    const lineItems = await stripeService.getCheckoutSessionLineItems(sessionId)
    const result = await kountService.evaluateOrder(buildKountOrder(session, lineItems.data))
    decision = result.decision
    await stripeService.updatePaymentIntentMetadata(paymentIntent.id, {
      [KOUNT_ORDER_ID_METADATA_KEY]: result.orderId,
      [KOUNT_DECISION_METADATA_KEY]: decision,
      ...(session.metadata?.[KOUNT_SESSION_METADATA_KEY] && {
        [KOUNT_SESSION_METADATA_KEY]: session.metadata[KOUNT_SESSION_METADATA_KEY],
      }),
    })
  }

  if (KOUNT_CAPTURE_DECISIONS.includes(decision)) {
    await stripeService.capturePaymentIntent(paymentIntent.id)
    return { decision, outcome: 'captured' }
  }
  await stripeService.cancelPaymentIntentAsFraudulent(paymentIntent.id)
  return { decision, outcome: 'canceled' }
}
