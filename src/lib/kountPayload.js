// Pure mapping between Stripe objects and Kount Payments Fraud v2 payloads.
//
// No I/O here: services fetch Stripe data and call these builders, which keeps
// the field mapping unit-testable. Only data Stripe actually exposes is sent.
// Stripe never exposes the card number or BIN. The card is identified to
// Kount by Stripe's card fingerprint (stable per card within the Stripe
// account), sent as payment type TOKEN, which the Kount schema documents for
// post-authorization calls where the processor returns a token instead of
// card data. The BIN is omitted rather than invented. Timestamp fields are
// omitted as well: the published schema's date-time pattern rejects its own
// RFC 3339 examples (documented conflict "timestamp-pattern").
import { KOUNT_DECISIONS } from '../config/kount.js'

const KOUNT_CARD_BRANDS = {
  visa: 'visa',
  mastercard: 'mastercard',
  amex: 'americanexpress',
  discover: 'discover',
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/

function compact(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) continue
    out[k] = v
  }
  return out
}

/** Integer minor units as the uint64 string Kount expects. */
export function minorUnits(amount) {
  const n = Number(amount)
  return Number.isFinite(n) && n >= 0 ? String(Math.round(n)) : undefined
}

export function isIpv4(value) {
  return typeof value === 'string' && IPV4.test(value)
}

export function splitName(fullName) {
  const name = String(fullName || '').trim().replace(/\s+/g, ' ')
  if (!name) return undefined
  const idx = name.lastIndexOf(' ')
  return idx === -1 ? { first: name } : { first: name.slice(0, idx), family: name.slice(idx + 1) }
}

export function mapAddress(address) {
  if (!address) return undefined
  const mapped = compact({
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    region: address.state,
    countryCode: address.country,
    postalCode: address.postal_code,
  })
  return Object.keys(mapped).length ? mapped : undefined
}

function mapPerson({ name, email, phone, address }) {
  const person = compact({
    name: splitName(name),
    emailAddress: email,
    phoneNumber: phone,
    address: mapAddress(address),
  })
  return Object.keys(person).length ? person : undefined
}

function mapCvv(check) {
  if (check === 'pass') return 'MATCH'
  if (check === 'fail') return 'NO_MATCH'
  return 'UNKNOWN'
}

/**
 * Derive an AVS code from Stripe's per-field checks. Only the unambiguous
 * combinations are mapped; anything else is omitted.
 */
export function mapAvs(checks = {}) {
  const line1 = checks.address_line1_check
  const postal = checks.address_postal_code_check
  if (line1 === 'pass' && postal === 'pass') return 'Y'
  if (line1 === 'pass' && postal === 'fail') return 'A'
  if (line1 === 'fail' && postal === 'pass') return 'Z'
  if (line1 === 'fail' && postal === 'fail') return 'N'
  return undefined
}

/**
 * Payment object from a Stripe charge's card details.
 *
 * With a fingerprint: type TOKEN + paymentToken = fingerprint. Without one
 * (rare), fall back to CREDIT_CARD / DEBIT_CARD with no token, so a value is
 * never presented as a token when there is none.
 */
export function mapPayment(charge) {
  const card = charge?.payment_method_details?.card
  if (!card) return { type: 'NONE' }
  const fingerprint = typeof card.fingerprint === 'string' && card.fingerprint ? card.fingerprint : undefined
  return compact({
    type: fingerprint ? 'TOKEN' : (card.funding === 'debit' ? 'DEBIT_CARD' : 'CREDIT_CARD'),
    paymentToken: fingerprint,
    last4: card.last4,
    cardBrand: KOUNT_CARD_BRANDS[card.brand],
    expirationMonth: Number.isInteger(card.exp_month) ? card.exp_month : undefined,
    expirationYear: Number.isInteger(card.exp_year) ? card.exp_year : undefined,
  })
}

/** Kount items from Stripe Checkout line items. */
export function mapLineItems(lineItems = []) {
  return lineItems.map((li, index) => compact({
    id: li.price?.id || li.id || `item-${index + 1}`,
    name: li.description || li.price?.nickname || `Item ${index + 1}`,
    description: li.price?.nickname || undefined,
    price: minorUnits(li.price?.unit_amount ?? (li.quantity ? li.amount_subtotal / li.quantity : li.amount_subtotal)),
    quantity: Number.isInteger(li.quantity) ? li.quantity : 1,
    isDigital: false,
    sku: typeof li.price?.product === 'string' ? li.price.product : li.price?.product?.id,
  }))
}

function shippingDetails(session) {
  return session?.collected_information?.shipping_details || session?.shipping_details || null
}

/**
 * Evaluation payload for a post-authorization risk inquiry on a hosted
 * Stripe Checkout session whose PaymentIntent is authorized but not captured.
 */
export function buildEvaluationPayload({
  merchantOrderId,
  session,
  paymentIntent,
  charge,
  lineItems,
  deviceSessionId,
  userIp,
  channel,
}) {
  const items = mapLineItems(lineItems)
  const itemRefs = items.map((i) => ({ id: i.id, quantity: i.quantity }))
  const customer = session?.customer_details || {}
  const shipping = shippingDetails(session)
  const totals = session?.total_details || {}

  const transaction = compact({
    processor: 'STRIPE',
    merchantTransactionId: paymentIntent?.id,
    payment: mapPayment(charge),
    subtotal: minorUnits(session?.amount_subtotal),
    orderTotal: minorUnits(session?.amount_total ?? paymentIntent?.amount),
    currency: String(session?.currency || paymentIntent?.currency || 'usd').toUpperCase(),
    tax: totals.amount_tax ? { isTaxable: true, taxAmount: minorUnits(totals.amount_tax) } : undefined,
    billedPerson: mapPerson({
      name: customer.name || charge?.billing_details?.name,
      email: customer.email || charge?.billing_details?.email,
      phone: customer.phone || charge?.billing_details?.phone,
      address: customer.address || charge?.billing_details?.address,
    }),
    // Post-authorization flow: the authorization outcome is already known.
    transactionStatus: 'AUTHORIZED',
    authorizationStatus: compact({
      authResult: 'APPROVED',
      processorAuthCode: charge?.authorization_code,
      processorTransactionId: charge?.id,
      verificationResponse: compact({
        cvvStatus: charge?.payment_method_details?.card ? mapCvv(charge.payment_method_details.card.checks?.cvc_check) : undefined,
        avsStatus: mapAvs(charge?.payment_method_details?.card?.checks),
      }),
    }),
    items: itemRefs.length ? itemRefs : undefined,
  })

  const fulfillment = compact({
    type: 'SHIPPED',
    shipping: totals.amount_shipping !== undefined ? { amount: minorUnits(totals.amount_shipping) } : undefined,
    recipientPerson: shipping ? mapPerson({ name: shipping.name, address: shipping.address, email: customer.email, phone: customer.phone }) : undefined,
    items: itemRefs.length ? itemRefs : undefined,
    status: 'PENDING',
  })

  return compact({
    merchantOrderId,
    channel: channel || undefined,
    deviceSessionId: deviceSessionId || undefined,
    userIp: isIpv4(userIp) ? userIp : undefined,
    items: items.length ? items : undefined,
    transactions: [transaction],
    fulfillment: [fulfillment],
  })
}

/**
 * Classify a failed Stripe charge. A Radar block happens before the issuer
 * sees the authorization; an issuer decline carries a network decline code.
 */
export function classifyFailedCharge(charge, lastPaymentError) {
  const outcomeType = charge?.outcome?.type
  if (outcomeType === 'blocked') {
    return { kind: 'radar_block', authResult: 'UNKNOWN' }
  }
  return {
    kind: 'issuer_decline',
    authResult: 'DECLINED',
    declineCode: charge?.outcome?.network_decline_code || lastPaymentError?.decline_code || undefined,
  }
}

/** Data-only payload reporting a refused authorization attempt. */
export function buildFailedAttemptPayload({ merchantOrderId, paymentIntent, charge, deviceSessionId, userIp, channel }) {
  const failure = classifyFailedCharge(charge, paymentIntent?.last_payment_error)
  const transaction = compact({
    processor: 'STRIPE',
    merchantTransactionId: charge?.id || paymentIntent?.id,
    payment: mapPayment(charge),
    orderTotal: minorUnits(paymentIntent?.amount),
    currency: String(paymentIntent?.currency || 'usd').toUpperCase(),
    billedPerson: mapPerson({
      name: charge?.billing_details?.name,
      email: charge?.billing_details?.email,
      phone: charge?.billing_details?.phone,
      address: charge?.billing_details?.address,
    }),
    transactionStatus: 'REFUSED',
    authorizationStatus: compact({
      authResult: failure.authResult,
      declineCode: failure.declineCode,
      processorTransactionId: charge?.id,
    }),
  })
  return {
    failure,
    payload: compact({
      merchantOrderId,
      channel: channel || undefined,
      deviceSessionId: deviceSessionId || undefined,
      userIp: isIpv4(userIp) ? userIp : undefined,
      transactions: [transaction],
    }),
  }
}

/** PATCH body for a transaction status change, optionally with a reviewer decision. */
export function buildStatusUpdatePayload({ merchantOrderId, kountTransactionId, transactionStatus, decision }) {
  return compact({
    merchantOrderId,
    riskInquiry: decision ? { decision } : undefined,
    transactions: transactionStatus
      ? [compact({ transactionId: kountTransactionId, transactionStatus })]
      : undefined,
  })
}

/**
 * Interpret an Evaluate Order response body.
 *
 * The pinned schema describes `order.riskInquiry` as an object; reference
 * examples use an array. Both are accepted, and the array shape is flagged.
 * Every entry of an array is inspected rather than assuming index zero.
 *
 * @returns {{status: 'usable'|'missing_decision'|'unknown_decision'|'malformed_response', decision?: string, shapeConflict: boolean, kountOrderId?: string, kountTransactionId?: string, deviceId?: string, omniscore?: number}}
 */
export function parseEvaluationResponse(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 'malformed_response', shapeConflict: false }
  }
  const order = body.order
  if (!order || typeof order !== 'object') {
    return { status: 'missing_decision', shapeConflict: false }
  }

  const shapeConflict = Array.isArray(order.riskInquiry)
  const inquiries = shapeConflict ? order.riskInquiry : (order.riskInquiry ? [order.riskInquiry] : [])
  const withDecision = inquiries.filter((ri) => ri && ri.decision !== undefined && ri.decision !== null)

  const common = {
    shapeConflict,
    kountOrderId: typeof order.orderId === 'string' ? order.orderId : undefined,
    kountTransactionId: Array.isArray(order.transactions) ? order.transactions.find((t) => t?.transactionId)?.transactionId : undefined,
  }

  if (withDecision.length === 0) return { status: 'missing_decision', ...common }

  const decisions = [...new Set(withDecision.map((ri) => ri.decision))]
  if (decisions.length !== 1 || !KOUNT_DECISIONS.includes(decisions[0])) {
    return { status: 'unknown_decision', ...common }
  }

  const ri = withDecision[0]
  return {
    status: 'usable',
    decision: decisions[0],
    ...common,
    deviceId: inquiries.map((x) => x?.device?.id).find(Boolean),
    omniscore: typeof ri.omniscore === 'number' ? ri.omniscore : (ri.omniscore !== undefined ? Number(ri.omniscore) : undefined),
  }
}

/**
 * Parse a Retry-After header (delta-seconds or HTTP-date) into milliseconds.
 * Returns undefined when absent or unparseable.
 */
export function parseRetryAfter(header, now = Date.now()) {
  if (header === null || header === undefined || header === '') return undefined
  const text = String(header).trim()
  if (/^\d+$/.test(text)) return Number(text) * 1000
  const date = Date.parse(text)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, date - now)
}
