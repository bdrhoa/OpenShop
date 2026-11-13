// Client-side checkout helpers.
//
// Stripe.js's redirectToCheckout() is deprecated. The server returns the
// hosted Checkout Session URL instead, and the browser simply navigates to it,
// so the storefront needs neither Stripe.js nor a publishable key.
import { getKountSessionId } from './kountDeviceCollection.js'

export function goToCheckout(session) {
  if (!session?.url) {
    throw new Error('Checkout is unavailable. Please try again.')
  }
  window.location.assign(session.url)
}

export async function redirectToCheckout(priceId) {
  const response = await fetch('/api/create-checkout-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ priceId, kountSessionId: getKountSessionId() }),
  })
  const session = await response.json().catch(() => ({}))
  if (!response.ok || session.error) {
    throw new Error(session.error || 'Error starting checkout. Please try again.')
  }
  goToCheckout(session)
}
