// Pure mapping from a Stripe Checkout Session (with its PaymentIntent and
// charge) to a Kount Payments Fraud v2 Evaluate Order body.
//
// OpenShop uses hosted Stripe Checkout, which gives the merchant no hook
// before card authorization, so evaluation runs post-authorization and
// before capture. The authorization outcome is therefore sent with the
// initial evaluation.
//
// Notes on the published schema (see docs/KOUNT.md):
// - Timestamp fields are omitted: several date-time fields carry a literal
//   pattern that rejects their own RFC 3339 examples.
// - Item quantity is sent as an integer (the declared type), not the string
//   used in the reference example.
// - Monetary values are strings in the lowest currency denomination.
import { KOUNT_CHANNEL, KOUNT_DEVICE_SESSION_ID_PATTERN } from '../config/kount.js'

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

export function isIPv4(value) {
  return typeof value === 'string' && IPV4.test(value)
}

/** Returns the trimmed device session id, or null when it is unusable. */
export function normalizeDeviceSessionId(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return KOUNT_DEVICE_SESSION_ID_PATTERN.test(trimmed) ? trimmed : null
}

const CARD_BRANDS = {
  visa: 'visa',
  mastercard: 'mastercard',
  amex: 'americanexpress',
  discover: 'discover',
}

export function mapCardBrand(stripeBrand) {
  return CARD_BRANDS[stripeBrand] || undefined
}

/** Stripe cvc_check → Kount cvvStatus. */
export function mapCvvStatus(cvcCheck) {
  if (cvcCheck === 'pass') return 'MATCH'
  if (cvcCheck === 'fail') return 'NO_MATCH'
  return 'UNKNOWN'
}

/**
 * Stripe address_line1_check / address_postal_code_check → a single AVS
 * code. Only the unambiguous combinations are mapped; anything involving an
 * unchecked or unavailable result is omitted rather than guessed.
 */
export function mapAvsStatus(line1Check, postalCheck) {
  if (line1Check === 'pass' && postalCheck === 'pass') return 'Y'
  if (line1Check === 'pass' && postalCheck === 'fail') return 'A'
  if (line1Check === 'fail' && postalCheck === 'pass') return 'Z'
  if (line1Check === 'fail' && postalCheck === 'fail') return 'N'
  return undefined
}

function compact(obj) {
  if (Array.isArray(obj)) return obj.map(compact)
  if (!obj || typeof obj !== 'object') return obj
  const out = {}
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null || value === '') continue
    const next = compact(value)
    if (next && typeof next === 'object' && !Array.isArray(next) && Object.keys(next).length === 0) continue
    out[key] = next
  }
  return out
}

function splitName(fullName) {
  if (typeof fullName !== 'string' || !fullName.trim()) return undefined
  const parts = fullName.trim().split(/\s+/)
  if (parts.length === 1) return { first: parts[0] }
  return { first: parts[0], family: parts.slice(1).join(' ') }
}

function mapAddress(address) {
  if (!address) return undefined
  return {
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    region: address.state,
    postalCode: address.postal_code,
    countryCode: address.country,
  }
}

function amountString(value) {
  return Number.isInteger(value) && value >= 0 ? String(value) : undefined
}

/** Shipping details moved under collected_information in newer API versions. */
export function getShippingDetails(session) {
  return session?.collected_information?.shipping_details || session?.shipping_details || null
}

/**
 * Build the Evaluate Order body.
 *
 * @param {object} input
 * @param {object} input.session - Stripe Checkout Session
 * @param {object} input.paymentIntent - Stripe PaymentIntent (requires_capture)
 * @param {object} [input.charge] - The PaymentIntent's latest charge
 * @param {Array} [input.lineItems] - Checkout Session line items
 * @param {string} [input.deviceSessionId]
 * @param {string} [input.userIp]
 */
export function buildKountOrder({ session, paymentIntent, charge, lineItems = [], deviceSessionId, userIp }) {
  const currency = String(session.currency || paymentIntent?.currency || 'usd').toUpperCase()
  const customer = session.customer_details || {}
  const shipping = getShippingDetails(session)
  const card = charge?.payment_method_details?.card || {}
  const checks = card.checks || {}

  const items = lineItems.map((li, index) => {
    const product = li.price?.product
    const productId = typeof product === 'string' ? product : product?.id
    return {
      id: productId || li.price?.id || `item_${index}`,
      name: li.description || (typeof product === 'object' ? product?.name : undefined),
      price: amountString(li.price?.unit_amount ?? (li.quantity ? Math.round(li.amount_subtotal / li.quantity) : undefined)),
      quantity: Number.isInteger(li.quantity) ? li.quantity : 1,
      isDigital: false,
    }
  })

  const itemQuantities = items.map((item) => ({ id: item.id, quantity: item.quantity }))

  const transaction = {
    processor: 'STRIPE',
    merchantTransactionId: paymentIntent?.id,
    payment: {
      // Post-authorization: no raw card data is available, so send the
      // processor's stable card fingerprint as a token.
      type: card.fingerprint ? 'TOKEN' : 'NONE',
      paymentToken: card.fingerprint,
      last4: card.last4,
      cardBrand: mapCardBrand(card.brand),
      expirationMonth: card.exp_month,
      expirationYear: card.exp_year,
    },
    subtotal: amountString(session.amount_subtotal),
    orderTotal: amountString(session.amount_total ?? paymentIntent?.amount),
    currency,
    tax: session.total_details?.amount_tax
      ? { isTaxable: true, taxAmount: amountString(session.total_details.amount_tax) }
      : undefined,
    billedPerson: {
      name: splitName(customer.name),
      emailAddress: customer.email,
      phoneNumber: customer.phone,
      address: mapAddress(customer.address),
    },
    transactionStatus: 'AUTHORIZED',
    authorizationStatus: {
      authResult: 'APPROVED',
      verificationResponse: {
        cvvStatus: mapCvvStatus(checks.cvc_check),
        avsStatus: mapAvsStatus(checks.address_line1_check, checks.address_postal_code_check),
      },
      processorAuthCode: charge?.authorization_code,
      processorTransactionId: charge?.id || paymentIntent?.id,
    },
    items: itemQuantities,
  }

  const fulfillment = shipping
    ? [{
        type: 'SHIPPED',
        shipping: {
          amount: amountString(session.shipping_cost?.amount_total ?? session.total_details?.amount_shipping),
        },
        recipientPerson: {
          name: splitName(shipping.name),
          phoneNumber: shipping.phone,
          emailAddress: customer.email,
          address: mapAddress(shipping.address),
        },
        items: itemQuantities,
      }]
    : undefined

  return compact({
    merchantOrderId: session.id,
    channel: KOUNT_CHANNEL,
    deviceSessionId: normalizeDeviceSessionId(deviceSessionId) || undefined,
    userIp: isIPv4(userIp) ? userIp : undefined,
    items,
    fulfillment,
    transactions: [transaction],
  })
}

/** riskInquiry is documented as an object but some guidance indexes it. */
function firstRiskInquiry(order) {
  const ri = order?.riskInquiry
  return Array.isArray(ri) ? ri[0] : ri
}

/** Extract what OpenShop needs from an Evaluate Order response. */
export function parseEvaluateResponse(body) {
  const order = body?.order || {}
  const risk = firstRiskInquiry(order) || {}
  const decision = risk.decision || risk.policyManagement?.decision || null
  return {
    kountOrderId: order.orderId || null,
    transactionId: order.transactions?.[0]?.transactionId || null,
    decision: ['APPROVE', 'DECLINE', 'REVIEW'].includes(decision) ? decision : null,
    omniscore: typeof risk.omniscore === 'number' ? risk.omniscore : null,
    deviceId: risk.device?.id || null,
    warnings: Array.isArray(body?.warnings) ? body.warnings : [],
  }
}
