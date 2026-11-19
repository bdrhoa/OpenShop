import { useState } from 'react'
import { Button } from '../ui/button'
import { adminApiRequest } from '../../lib/auth'

const DECISION_LABELS = {
  APPROVE: 'Approved',
  DECLINE: 'Declined',
  REVIEW: 'In review',
}

const PAYMENT_LABELS = {
  authorized: 'Authorized (not captured)',
  captured: 'Captured',
  canceled: 'Authorization released',
  expired: 'Authorization expired',
}

function decisionText(kount) {
  if (!kount?.decision) return 'Kount: evaluating'
  let text = `Kount: ${DECISION_LABELS[kount.decision] || kount.decision}`
  if (kount.review?.status === 'approved') text = 'Kount: reviewer approved'
  if (kount.review?.status === 'declined') text = 'Kount: reviewer declined'
  if (kount.decisionSource === 'fallback') text += ' (fallback)'
  return text
}

function badgeTone(kount) {
  if (kount?.fulfillmentAllowed) return 'bg-[var(--admin-success-bg)] text-[var(--admin-success)]'
  if (kount?.decision === 'REVIEW' && kount.review?.status === 'open') return 'bg-[var(--admin-warning-bg,var(--admin-bg-elevated))] text-[var(--admin-warning,var(--admin-text-primary))]'
  return 'bg-[var(--admin-bg-elevated)] text-[var(--admin-text-secondary)]'
}

/** Small pill shown on each order row. */
export function KountBadge({ kount }) {
  if (!kount) return null
  return (
    <span className={`mb-1 inline-flex w-fit items-center rounded-full px-2 py-0.5 text-xs font-medium ${badgeTone(kount)}`}>
      {decisionText(kount)}
    </span>
  )
}

/**
 * Kount details and reviewer actions inside the order modal. Fulfillment is
 * also enforced on the server; this only explains why it is unavailable.
 */
export function KountOrderPanel({ orderId, kount, onChanged }) {
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState('')
  if (!kount) return null

  const review = async (decision) => {
    setBusy(decision)
    setError('')
    try {
      const res = await adminApiRequest(`/api/admin/kount/orders/${orderId}/review`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || 'Review failed')
      onChanged?.(body.kount)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  const canReview = kount.decision === 'REVIEW' && kount.review?.status === 'open' && kount.paymentState === 'authorized'
  const pendingReports = (kount.reporting || []).filter((r) => r.state !== 'confirmed')

  return (
    <div className="rounded-lg border border-[var(--admin-border-primary)] p-4 text-sm space-y-1.5">
      <div className="font-semibold text-[var(--admin-text-primary)]">Fraud screening (Kount)</div>
      <div className="text-[var(--admin-text-secondary)]">{decisionText(kount)}</div>
      {kount.decisionSource === 'fallback' && (
        <div className="text-[var(--admin-text-secondary)]">
          Kount returned no usable decision ({kount.fallbackReason}); the configured fallback was applied after {kount.attempts} attempt(s).
        </div>
      )}
      {kount.omniscore !== null && kount.omniscore !== undefined && (
        <div className="text-[var(--admin-text-secondary)]">Omniscore: {kount.omniscore}</div>
      )}
      <div className="text-[var(--admin-text-secondary)]">Payment: {PAYMENT_LABELS[kount.paymentState] || kount.paymentState || 'unknown'}</div>
      {kount.kountOrderId && <div className="text-xs text-[var(--admin-text-muted)] font-mono">Kount order {kount.kountOrderId}</div>}
      {pendingReports.length > 0 && (
        <div className="text-xs text-[var(--admin-text-muted)]">
          Kount status updates not yet confirmed: {pendingReports.map((r) => `${r.transactionStatus} (${r.state})`).join(', ')}
        </div>
      )}
      {!kount.fulfillmentAllowed && (
        <div className="text-[var(--admin-text-secondary)]">Fulfillment is blocked until the order is approved and the payment is captured.</div>
      )}
      {canReview && (
        <div className="flex gap-2 pt-2">
          <Button size="sm" onClick={() => review('APPROVE')} disabled={Boolean(busy)}>
            {busy === 'APPROVE' ? 'Capturing…' : 'Approve & capture'}
          </Button>
          <Button size="sm" variant="outline" onClick={() => review('DECLINE')} disabled={Boolean(busy)}>
            {busy === 'DECLINE' ? 'Releasing…' : 'Decline & release'}
          </Button>
        </div>
      )}
      {error && <p role="alert" className="text-[var(--admin-error)]">{error}</p>}
    </div>
  )
}
