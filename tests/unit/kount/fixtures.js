// Synthetic Stripe objects shared by the Kount tests.
export const SESSION = {
  id: 'cs_test_kount',
  currency: 'usd',
  amount_subtotal: 2500,
  amount_total: 3000,
  total_details: { amount_tax: 200, amount_shipping: 300 },
  customer_details: {
    name: 'Ada Q Lovelace',
    email: 'buyer@example.test',
    address: { line1: '1 Test St', city: 'Boise', state: 'ID', country: 'US', postal_code: '83702' },
  },
  collected_information: {
    shipping_details: { name: 'Ada Lovelace', address: { line1: '2 Ship Rd', city: 'Boise', state: 'ID', country: 'US', postal_code: '83702' } },
  },
  metadata: { kount_hold: 'true', openshop_order_id: 'order-1' },
  payment_intent: 'pi_test_1',
}

export const CHARGE = {
  id: 'ch_test_1',
  authorization_code: '123456',
  payment_method_details: {
    card: { brand: 'visa', last4: '4242', fingerprint: 'fpTestCard4242', exp_month: 12, exp_year: 2030, funding: 'credit', checks: { cvc_check: 'pass', address_line1_check: 'pass', address_postal_code_check: 'pass' } },
  },
}

export const LINE_ITEMS = [
  { id: 'li_1', description: 'T-shirt', quantity: 2, amount_subtotal: 2500, price: { id: 'price_1', unit_amount: 1250, nickname: 'T-shirt - L', product: 'prod_1' } },
]
