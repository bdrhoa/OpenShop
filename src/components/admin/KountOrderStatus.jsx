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
  if (kount?.onHold) return 'bg-[var(--admin-warning-bg,var(--admin-bg-elevated))] text-[var(--admin-warning,var(--admin-text-primary))]'
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
 * Kount details inside the order modal. Read-only: a review hold is lifted
 * only by the reviewer's decision in the Kount portal (signed webhook), never
 * from OpenShop. Fulfillment is also enforced on the server.
 */
export function KountOrderPanel({ kount }) {
  if (!kount) return null
  const pendingReports = (kount.reporting || []).filter((r) => r.state !== 'confirmed')

  return (
    <div className="rounded-lg border border-[var(--admin-border-primary)] p-4 text-sm space-y-1.5">
      <div className="font-semibold text-[var(--admin-text-primary)]">Fraud screening (Kount)</div>
      <div className="text-[var(--admin-text-secondary)]">{decisionText(kount)}</div>
      {kount.onHold && (
        <div role="status" className="rounded-md bg-[var(--admin-bg-elevated)] p-2 text-[var(--admin-text-primary)]">
          <strong>On hold</strong> since {kount.hold?.since ? new Date(kount.hold.since).toLocaleString() : 'evaluation'}.
          A reviewer must approve or decline this order in the Kount portal. It is released automatically when
          Kount&apos;s webhook arrives; it cannot be released from OpenShop.
        </div>
      )}
      {kount.hold?.status === 'released' && (
        <div className="text-[var(--admin-text-secondary)]">
          Hold released {kount.hold.releasedAt ? new Date(kount.hold.releasedAt).toLocaleString() : ''} ({String(kount.hold.outcome || '').replace(/_/g, ' ')}).
        </div>
      )}
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
      {!kount.fulfillmentAllowed && !kount.onHold && (
        <div className="text-[var(--admin-text-secondary)]">Fulfillment is blocked until the order is approved and the payment is captured.</div>
      )}
    </div>
  )
}
