// Pure builders: Stripe Checkout objects -> Kount Payments Fraud v2 order bodies.
//
// No I/O here, so every mapping is unit-testable. Shapes follow the Commerce
// v2 OpenAPI (POST /commerce/v2/orders, PATCH /commerce/v2/orders/{orderId}).
// Monetary values are strings in the lowest denomination; item quantity is an
// integer (the published example uses a string, the declared type wins).
// Timestamp fields are deliberately omitted: the published schema pairs
// date-time with a literal pattern that rejects its own RFC 3339 examples.

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/

function str(value, max = 256) {
  if (value === null || value === undefined) return undefined
  const s = String(value).trim()
  return s ? s.slice(0, max) : undefined
}

function amount(value) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? String(Math.round(n)) : undefined
}

/** Drop undefined / empty-object keys so the body carries only known data. */
export function compact(value) {
  if (Array.isArray(value)) {
    return value.map(compact).filter((v) => v !== undefined)
  }
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      const c = compact(v)
      if (c === undefined) continue
      if (c && typeof c === 'object' && !Array.isArray(c) && Object.keys(c).length === 0) continue
      out[k] = c
    }
    return out
  }
  return value
}

export function splitName(full) {
  const s = str(full)
  if (!s) return undefined
  const idx = s.lastIndexOf(' ')
  if (idx <= 0) return { first: s }
  return { first: s.slice(0, idx), family: s.slice(idx + 1) }
}

export function mapAddress(address) {
  if (!address) return undefined
  return {
    line1: str(address.line1),
    line2: str(address.line2),
    city: str(address.city),
    region: str(address.state),
    postalCode: str(address.postal_code),
    countryCode: str(address.country, 2),
  }
}

/** Stripe cvc_check -> Kount cvvStatus. */
export function mapCvv(check) {
  if (check === 'pass') return 'MATCH'
  if (check === 'fail') return 'NO_MATCH'
  return 'UNKNOWN'
}

/**
 * Stripe address_line1_check / address_postal_code_check -> single AVS letter.
 * Only definite combinations are mapped; anything else is omitted rather than
 * guessed.
 */
export function mapAvs(checks) {
  const line = checks?.address_line1_check
  const zip = checks?.address_postal_code_check
  if (line === 'pass' && zip === 'pass') return 'Y'
  if (line === 'pass' && zip === 'fail') return 'A'
  if (line === 'fail' && zip === 'pass') return 'Z'
  if (line === 'fail' && zip === 'fail') return 'N'
  return undefined
}

/** Shipping details moved under collected_information in newer Stripe API versions. */
export function getShippingDetails(session) {
  return session?.collected_information?.shipping_details || session?.shipping_details || null
}

function lineItemsOf(session) {
  const data = session?.line_items?.data
  return Array.isArray(data) ? data : []
}

export function mapItems(session) {
  return lineItemsOf(session).map((li, index) => {
    const product = li.price?.product
    const productId = typeof product === 'string' ? product : product?.id
    const id = str(productId || li.price?.id || li.id || `item_${index}`, 128)
    return {
      id,
      name: str(typeof product === 'object' ? product?.name : li.description) || str(li.description),
      description: str(li.description),
      price: amount(li.price?.unit_amount ?? (li.quantity ? li.amount_subtotal / li.quantity : undefined)),
      quantity: Number.isInteger(li.quantity) ? li.quantity : 1,
      isDigital: false,
    }
  })
}

function itemQuantities(items) {
  return items.map((i) => ({ id: i.id, quantity: i.quantity }))
}

function cardOf(charge) {
  return charge?.payment_method_details?.card || null
}

function paymentFromCharge(charge) {
  const card = cardOf(charge)
  if (!card) return { type: 'NONE' }
  // Hosted Checkout never exposes the PAN. The card fingerprint is Stripe's
  // stable token for the card, which is what Kount's TOKEN type is for.
  return {
    type: card.fingerprint ? 'TOKEN' : 'CREDIT_CARD',
    paymentToken: str(card.fingerprint),
    last4: str(card.last4, 4),
    cardBrand: str(card.brand),
    expirationMonth: Number.isInteger(card.exp_month) ? card.exp_month : undefined,
    expirationYear: Number.isInteger(card.exp_year) ? card.exp_year : undefined,
  }
}

function billedPersonOf(session) {
  const cd = session?.customer_details
  if (!cd) return undefined
  return {
    name: splitName(cd.name),
    emailAddress: str(cd.email),
    phoneNumber: str(cd.phone),
    address: mapAddress(cd.address),
  }
}

function fulfillmentOf(session, items) {
  const ship = getShippingDetails(session)
  return [{
    type: 'SHIPPED',
    status: 'PENDING',
    shipping: { amount: amount(session?.total_details?.amount_shipping) },
    recipientPerson: ship
      ? { name: splitName(ship.name), phoneNumber: str(ship.phone), address: mapAddress(ship.address) }
      : undefined,
    items: itemQuantities(items),
  }]
}

function baseOrder(session, { merchantOrderId, channel }) {
  const meta = session?.metadata || {}
  const items = mapItems(session)
  const userIp = str(meta.kount_user_ip)
  return {
    items,
    order: {
      merchantOrderId,
      channel: str(channel),
      deviceSessionId: str(meta.kount_session_id, 64),
      userIp: userIp && IPV4.test(userIp) ? userIp : undefined,
      items,
      fulfillment: fulfillmentOf(session, items),
    },
  }
}

function transactionBase(session, items, charge, paymentIntentId) {
  return {
    processor: 'STRIPE',
    payment: paymentFromCharge(charge),
    subtotal: amount(session?.amount_subtotal),
    orderTotal: amount(session?.amount_total),
    currency: str(session?.currency, 3)?.toUpperCase(),
    tax: session?.total_details?.amount_tax
      ? { isTaxable: true, taxAmount: amount(session.total_details.amount_tax) }
      : undefined,
    billedPerson: billedPersonOf(session),
    merchantTransactionId: str(paymentIntentId),
    items: itemQuantities(items),
  }
}

/**
 * Post-authorization risk inquiry body for a completed hosted Checkout Session
 * whose PaymentIntent is authorized but not captured.
 *
 * @param {object} session  Checkout Session with line_items (price.product expanded)
 * @param {object} paymentIntent PaymentIntent with latest_charge expanded
 */
export function buildEvaluationOrder(session, paymentIntent, { channel } = {}) {
  const { items, order } = baseOrder(session, { merchantOrderId: session.id, channel })
  const charge = typeof paymentIntent?.latest_charge === 'object' ? paymentIntent.latest_charge : null
  const card = cardOf(charge)
  order.transactions = [{
    ...transactionBase(session, items, charge, paymentIntent?.id),
    transactionStatus: 'AUTHORIZED',
    authorizationStatus: {
      authResult: 'APPROVED',
      verificationResponse: card
        ? { cvvStatus: mapCvv(card.checks?.cvc_check), avsStatus: mapAvs(card.checks) }
        : undefined,
      processorAuthCode: str(charge?.authorization_code),
      processorTransactionId: str(charge?.id),
    },
  }]
  return compact(order)
}

/**
 * Classify a failed hosted-checkout charge.
 *
 * A Radar block happens before issuer authorization, so the authorization
 * result is UNKNOWN, not DECLINED. An issuer decline is DECLINED.
 */
export function classifyFailedCharge(charge) {
  const outcome = charge?.outcome || {}
  if (outcome.type === 'blocked') {
    return { kind: 'radar_block', authResult: 'UNKNOWN', declineCode: str(outcome.reason) ? `stripe_radar_${outcome.reason}` : 'stripe_radar_block' }
  }
  if (outcome.type === 'issuer_declined') {
    return { kind: 'issuer_decline', authResult: 'DECLINED', declineCode: str(charge?.failure_code === 'card_declined' ? (outcome.reason || 'card_declined') : (charge?.failure_code || outcome.reason)) }
  }
  return { kind: 'other', authResult: 'ERROR', declineCode: str(charge?.failure_code || outcome.reason) }
}

/**
 * Data-only body (riskInquiry=false) reporting one refused authorization
 * attempt. Each attempt is its own Kount order, keyed by session + charge.
 */
export function buildFailedAttemptOrder(session, charge, { channel } = {}) {
  const { items, order } = baseOrder(session, {
    merchantOrderId: `${session.id}:${charge.id}`,
    channel,
  })
  const cls = classifyFailedCharge(charge)
  const card = cardOf(charge)
  order.transactions = [{
    ...transactionBase(session, items, charge, typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id),
    orderTotal: amount(charge.amount ?? session?.amount_total),
    transactionStatus: 'REFUSED',
    authorizationStatus: {
      authResult: cls.authResult,
      declineCode: cls.declineCode,
      verificationResponse: { cvvStatus: mapCvv(card?.checks?.cvc_check), avsStatus: mapAvs(card?.checks) },
      processorTransactionId: str(charge.id),
    },
  }]
  return compact(order)
}

/** PATCH body reporting a payment status change on an evaluated order. */
export function buildStatusUpdate(merchantOrderId, transactionId, transactionStatus) {
  return compact({
    merchantOrderId,
    transactions: [{ transactionId, transactionStatus }],
  })
}
