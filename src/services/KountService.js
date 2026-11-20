// Kount Payments Fraud v2: payload mapping, decisions and reporting calls.
//
// OpenShop uses hosted Stripe Checkout, which gives the merchant no hook
// before card authorization. So this is a post-authorization integration:
// Checkout authorizes with capture_method=manual, then the Stripe webhook
// evaluates the order with Kount before anything is captured.
import { KOUNT_DECISIONS } from '../config/kount.js'
import { KountClient, KountApiError } from './KountClient.js'

const CARD_BRANDS = {
  visa: 'visa',
  mastercard: 'mastercard',
  amex: 'americanexpress',
  discover: 'discover',
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/

function str(value) {
  return value === undefined || value === null ? undefined : String(value)
}

function compact(obj) {
  if (Array.isArray(obj)) return obj.map(compact)
  if (!obj || typeof obj !== 'object') return obj
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue
    const c = compact(v)
    if (c && typeof c === 'object' && !Array.isArray(c) && Object.keys(c).length === 0) continue
    out[k] = c
  }
  return out
}

function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return undefined
  if (parts.length === 1) return { first: parts[0] }
  return { first: parts[0], family: parts.slice(1).join(' ') }
}

function mapAddress(a) {
  if (!a) return undefined
  return {
    line1: a.line1,
    line2: a.line2,
    city: a.city,
    region: a.state,
    countryCode: a.country,
    postalCode: a.postal_code,
  }
}

function mapCvv(check) {
  if (check === 'pass') return 'MATCH'
  if (check === 'fail') return 'NO_MATCH'
  return 'UNKNOWN'
}

/**
 * Approximate AVS letter from Stripe's separate line1 / postal checks.
 * Only definite pass/fail combinations are mapped; otherwise omitted.
 */
export function mapAvs(line1Check, postalCheck) {
  const l = line1Check
  const p = postalCheck
  if (l === 'pass' && p === 'pass') return 'Y'
  if (l === 'pass' && p === 'fail') return 'A'
  if (l === 'fail' && p === 'pass') return 'Z'
  if (l === 'fail' && p === 'fail') return 'N'
  return undefined
}

/**
 * Payment mapping per the maintainer payment policy. Hosted Checkout never
 * exposes the PAN, so KHASH is impossible here. Stripe's card `fingerprint`
 * is stable for the same card number within one Stripe account (and mode),
 * so it is used as a persistent TOKEN. BIN is not exposed by Stripe and is
 * never inferred.
 */
export function mapPayment(card) {
  if (!card) return { type: 'NONE' }
  const base = {
    last4: card.last4,
    cardBrand: CARD_BRANDS[card.brand],
    expirationMonth: card.exp_month,
    expirationYear: card.exp_year,
  }
  if (card.fingerprint) return { type: 'TOKEN', paymentToken: card.fingerprint, ...base }
  if (card.last4) return { type: 'CREDIT_CARD', ...base }
  return { type: 'NONE' }
}

function cardFromPaymentIntent(pi) {
  const charge = typeof pi?.latest_charge === 'object' ? pi.latest_charge : null
  return {
    charge,
    card: charge?.payment_method_details?.card
      || (typeof pi?.payment_method === 'object' ? pi.payment_method?.card : null)
      || null,
  }
}

/**
 * Build the Evaluate Order body for a completed (authorized, uncaptured)
 * Stripe Checkout Session.
 */
export function buildEvaluationPayload({ session, paymentIntent, lineItems, deviceSessionId, userIp, channel }) {
  const { charge, card } = cardFromPaymentIntent(paymentIntent)
  const customer = session.customer_details || {}
  const shipping = session.collected_information?.shipping_details || session.shipping_details || null
  const currency = String(session.currency || paymentIntent?.currency || 'usd').toUpperCase()

  const items = (lineItems || []).map((li) => ({
    id: li.price?.id || li.id,
    name: li.description || li.price?.nickname || 'Item',
    description: li.description,
    price: str(li.price?.unit_amount ?? (li.quantity ? Math.round((li.amount_subtotal || 0) / li.quantity) : li.amount_subtotal)),
    quantity: Number(li.quantity) || 1,
    isDigital: false,
    externalProductId: typeof li.price?.product === 'string' ? li.price.product : li.price?.product?.id,
  }))

  const itemRefs = items.map((i) => ({ id: i.id, quantity: i.quantity }))
  const checks = card?.checks || {}

  return compact({
    merchantOrderId: session.id,
    channel,
    deviceSessionId,
    userIp: userIp && IPV4.test(userIp) ? userIp : undefined,
    items,
    fulfillment: [{
      type: 'SHIPPED',
      shipping: { amount: str(session.total_details?.amount_shipping), provider: 'FBM' },
      recipientPerson: shipping ? {
        name: splitName(shipping.name),
        phoneNumber: customer.phone,
        emailAddress: customer.email,
        address: mapAddress(shipping.address),
      } : undefined,
      items: itemRefs,
    }],
    transactions: [{
      processor: 'STRIPE',
      payment: mapPayment(card),
      subtotal: str(session.amount_subtotal),
      orderTotal: str(session.amount_total),
      currency,
      tax: session.total_details?.amount_tax ? { isTaxable: true, taxAmount: str(session.total_details.amount_tax) } : undefined,
      billedPerson: {
        name: splitName(customer.name),
        phoneNumber: customer.phone,
        emailAddress: customer.email,
        address: mapAddress(customer.address),
      },
      transactionStatus: 'AUTHORIZED',
      authorizationStatus: {
        authResult: 'APPROVED',
        verificationResponse: {
          cvvStatus: mapCvv(checks.cvc_check),
          avsStatus: mapAvs(checks.address_line1_check, checks.address_postal_code_check),
        },
        processorAuthCode: card?.authorization_code,
        processorTransactionId: charge?.id || paymentIntent?.id,
      },
      merchantTransactionId: paymentIntent?.id,
      items: itemRefs,
    }],
  })
}

/**
 * Data-only body for a failed hosted-checkout attempt.
 *   issuer decline → REFUSED / DECLINED
 *   Radar block    → REFUSED / UNKNOWN  (blocked before issuer authorization)
 */
export function buildFailedAttemptPayload({ paymentIntent, deviceSessionId, channel }) {
  const charge = typeof paymentIntent.latest_charge === 'object' ? paymentIntent.latest_charge : null
  const err = paymentIntent.last_payment_error || {}
  const card = charge?.payment_method_details?.card || err.payment_method?.card || null
  const radarBlocked = charge?.outcome?.type === 'blocked'
  const declineCode = radarBlocked
    ? `stripe_radar_${charge?.outcome?.reason || 'block'}`
    : (err.decline_code || err.code)
  const amount = str(paymentIntent.amount)

  return compact({
    merchantOrderId: `${paymentIntent.id}:${charge?.id || 'attempt'}`,
    channel,
    deviceSessionId,
    transactions: [{
      processor: 'STRIPE',
      payment: mapPayment(card),
      subtotal: amount,
      orderTotal: amount,
      currency: String(paymentIntent.currency || 'usd').toUpperCase(),
      transactionStatus: 'REFUSED',
      authorizationStatus: {
        authResult: radarBlocked ? 'UNKNOWN' : 'DECLINED',
        declineCode,
        verificationResponse: { cvvStatus: mapCvv(card?.checks?.cvc_check) },
        processorTransactionId: charge?.id,
      },
      merchantTransactionId: paymentIntent.id,
    }],
  })
}

/**
 * Interpret an Evaluate Order response.
 *
 * The pinned schema describes `riskInquiry` as an object; reference examples
 * return an array. Both are accepted and the conflict is reported.
 */
export function parseEvaluationResponse(body) {
  if (!body || typeof body !== 'object' || !body.order || typeof body.order !== 'object') {
    return { status: 'malformed_response' }
  }
  const order = body.order
  let inquiry = order.riskInquiry
  let shapeConflict = false
  if (Array.isArray(inquiry)) {
    shapeConflict = true
    inquiry = inquiry.find((r) => r && typeof r === 'object' && 'decision' in r) || inquiry[0]
  }
  const transactionId = Array.isArray(order.transactions) ? order.transactions[0]?.transactionId : undefined
  const common = {
    kountOrderId: order.orderId,
    kountTransactionId: transactionId,
    deviceId: inquiry?.device?.id,
    omniscore: inquiry?.omniscore,
    shapeConflict,
  }
  if (!inquiry || inquiry.decision === undefined || inquiry.decision === null) {
    return { status: 'missing_decision', ...common }
  }
  if (!KOUNT_DECISIONS.includes(inquiry.decision)) {
    return { status: 'unknown_decision', ...common }
  }
  return { status: 'usable_decision', decision: inquiry.decision, ...common }
}

export class KountService {
  constructor(config, deps = {}) {
    this.config = config
    this.client = deps.client ?? new KountClient(config, deps)
  }

  /**
   * Evaluate with riskInquiry=true. Always returns a decision: Kount's, or
   * the configured fallback (attributed as such) when no usable decision is
   * obtained. REVIEW is a valid Kount decision and never triggers fallback.
   */
  async evaluate(payload) {
    let response
    try {
      response = await this.client.request({
        method: 'POST',
        path: this.config.ordersPath,
        query: { riskInquiry: true },
        body: payload,
        operation: 'evaluate_order',
      })
    } catch (error) {
      const reason = error instanceof KountApiError
        ? (error.status ? `http_${error.status}` : `transport_${error.phase}`)
        : 'unexpected_error'
      return this.fallback(reason, {
        attempts: error?.attempts ?? null,
        correlationId: error?.correlationId ?? null,
        possibleDuplicate: Boolean(error?.possibleDuplicate),
      })
    }

    const parsed = parseEvaluationResponse(response.body)
    const meta = {
      attempts: response.attempts,
      correlationId: response.correlationId,
      possibleDuplicate: response.possibleDuplicate,
      kountOrderId: parsed.kountOrderId,
      kountTransactionId: parsed.kountTransactionId,
      deviceId: parsed.deviceId,
      omniscore: parsed.omniscore,
      shapeConflict: parsed.shapeConflict,
    }
    if (parsed.status !== 'usable_decision') return this.fallback(parsed.status, meta)
    return { decision: parsed.decision, decisionSource: 'kount', fallbackReason: null, ...meta }
  }

  fallback(reason, meta = {}) {
    console.warn(`[Kount] evaluation fallback ${this.config.fallbackDecision} reason=${reason} attempts=${meta.attempts ?? '?'} correlation=${meta.correlationId ?? 'none'}`)
    return {
      decision: this.config.fallbackDecision,
      decisionSource: 'fallback',
      fallbackReason: reason,
      ...meta,
    }
  }

  /** Data-only order POST (riskInquiry=false). Errors propagate: never an approval. */
  async reportDataOnly(payload) {
    const res = await this.client.request({
      method: 'POST',
      path: this.config.ordersPath,
      query: { riskInquiry: false },
      body: payload,
      operation: 'data_only_order',
    })
    if (!res.body?.order) {
      throw new KountApiError('Kount data-only response had no order acknowledgment', { operation: 'data_only_order' })
    }
    return { kountOrderId: res.body.order.orderId, correlationId: res.correlationId, possibleDuplicate: res.possibleDuplicate }
  }

  /** PATCH a transaction status (CAPTURED, CANCELED, REFUNDED, REFUND_FAILED). */
  async updateTransactionStatus({ kountOrderId, kountTransactionId, merchantOrderId, transactionStatus }) {
    const res = await this.client.request({
      method: 'PATCH',
      path: `${this.config.ordersPath}/${encodeURIComponent(kountOrderId)}`,
      body: compact({
        merchantOrderId,
        transactions: [{ transactionId: kountTransactionId, transactionStatus }],
      }),
      operation: 'update_order',
    })
    return { correlationId: res.correlationId }
  }
}
