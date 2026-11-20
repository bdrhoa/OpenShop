// KV persistence for Kount fraud screening state.
//
// One record per Stripe Checkout Session (the merchant order). Keys:
//
//   fraud:order:<cs_id>              the record (see docs/generated/kv-data-model.md)
//   fraud:pi:<pi_id>                 → cs_id (refund / payment event correlation)
//   fraud:kount:<kount order id>     → cs_id (Kount webhook correlation)
//   fraud:checkout:<cs_id>           pre-checkout context (device session, IP), 7d TTL
//   fraud:pending:<cs_id>            marker: record has unconfirmed Kount reports
//   fraud:deferred:<event key>       verified Kount reviewer event for an order not yet saved
//   fraud:attempt:<pi_id>:<charge>   failed-attempt data-only report state
//   fraud:event:<source>:<event id>  processed-event marker (30d TTL)
//   fraud:recovery:last-run          last scheduled recovery run summary
//
// LIMITATION: Workers KV has no compare-and-swap, so the evaluation claim
// below is best-effort, not an atomic lock. Payment side effects are made
// idempotent with Stripe idempotency keys, so a race cannot double-capture
// or double-refund; it can, at worst, send a duplicate Kount evaluation.
// A Durable Object would make the claim atomic (tracked in tech debt).

const ORDER = 'fraud:order:'
const PI = 'fraud:pi:'
const KOUNT = 'fraud:kount:'
const CHECKOUT = 'fraud:checkout:'
const PENDING = 'fraud:pending:'
const DEFERRED = 'fraud:deferred:'
const ATTEMPT = 'fraud:attempt:'
const EVENT = 'fraud:event:'
export const RECOVERY_LAST_RUN_KEY = 'fraud:recovery:last-run'

const EVENT_TTL_SECONDS = 30 * 24 * 3600
const CHECKOUT_TTL_SECONDS = 7 * 24 * 3600

export const FRAUD_KEY_PREFIXES = { ORDER, PI, KOUNT, CHECKOUT, PENDING, DEFERRED, ATTEMPT, EVENT }

async function getJson(kv, key) {
  const raw = await kv.get(key)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    console.error(`[FraudOrderStore] corrupt JSON at ${key.split(':').slice(0, 2).join(':')}`)
    return null
  }
}

export class FraudOrderStore {
  constructor(kv, { now = () => Date.now() } = {}) {
    this.kv = kv
    this.now = now
  }

  iso() {
    return new Date(this.now()).toISOString()
  }

  // ---- pre-checkout context ------------------------------------------------

  async saveCheckoutContext(checkoutSessionId, ctx) {
    await this.kv.put(`${CHECKOUT}${checkoutSessionId}`, JSON.stringify({ ...ctx, savedAt: this.iso() }), {
      expirationTtl: CHECKOUT_TTL_SECONDS,
    })
  }

  getCheckoutContext(checkoutSessionId) {
    return getJson(this.kv, `${CHECKOUT}${checkoutSessionId}`)
  }

  // ---- order records -------------------------------------------------------

  getOrder(checkoutSessionId) {
    return getJson(this.kv, `${ORDER}${checkoutSessionId}`)
  }

  async getOrderByPaymentIntent(paymentIntentId) {
    const cs = await this.kv.get(`${PI}${paymentIntentId}`)
    return cs ? this.getOrder(cs) : null
  }

  async getOrderByKountOrderId(kountOrderId) {
    const cs = await this.kv.get(`${KOUNT}${kountOrderId}`)
    return cs ? this.getOrder(cs) : null
  }

  async saveOrder(record) {
    record.updatedAt = this.iso()
    const writes = [
      this.kv.put(`${ORDER}${record.checkoutSessionId}`, JSON.stringify(record)),
    ]
    if (record.paymentIntentId) {
      writes.push(this.kv.put(`${PI}${record.paymentIntentId}`, record.checkoutSessionId))
    }
    if (record.evaluation?.kountOrderId) {
      writes.push(this.kv.put(`${KOUNT}${record.evaluation.kountOrderId}`, record.checkoutSessionId))
    }
    const hasPending = (record.reports || []).some((r) => r.state === 'pending' || r.state === 'unknown')
    writes.push(hasPending
      ? this.kv.put(`${PENDING}${record.checkoutSessionId}`, this.iso())
      : this.kv.delete(`${PENDING}${record.checkoutSessionId}`))
    await Promise.all(writes)
    return record
  }

  newOrder({ checkoutSessionId, paymentIntentId, deviceSessionId }) {
    const now = this.iso()
    return {
      checkoutSessionId,
      paymentIntentId,
      attemptId: paymentIntentId,
      deviceSessionId: deviceSessionId || null,
      createdAt: now,
      updatedAt: now,
      evaluation: { state: 'not_started' },
      payment: { state: 'authorized' },
      review: null,
      fulfillmentAllowed: false,
      buyerStatus: 'processing',
      reports: [],
      conflicts: [],
    }
  }

  /**
   * Best-effort claim of the evaluation for one order. Writes the in-flight
   * state with a random owner, then reads back to see whose write landed.
   */
  async claimEvaluation(record, owner) {
    record.evaluation = { state: 'in_flight', owner, startedAt: this.iso() }
    await this.saveOrder(record)
    const after = await this.getOrder(record.checkoutSessionId)
    return after?.evaluation?.owner === owner
  }

  listPendingOrderIds(limit = 50) {
    return this.listSuffixes(PENDING, limit)
  }

  async listSuffixes(prefix, limit) {
    const res = await this.kv.list({ prefix, limit })
    return (res.keys || []).map((k) => k.name.slice(prefix.length))
  }

  // ---- failed attempts (data-only reports) ---------------------------------

  getAttempt(id) {
    return getJson(this.kv, `${ATTEMPT}${id}`)
  }

  saveAttempt(id, attempt) {
    attempt.updatedAt = this.iso()
    // Confirmed reports expire; pending/unknown/rejected stay for recovery
    // or operator attention.
    const options = attempt.state === 'confirmed' ? { expirationTtl: EVENT_TTL_SECONDS } : undefined
    return this.kv.put(`${ATTEMPT}${id}`, JSON.stringify(attempt), options)
  }

  listAttemptIds(limit = 50) {
    return this.listSuffixes(ATTEMPT, limit)
  }

  // ---- deferred reviewer events --------------------------------------------

  saveDeferred(key, event) {
    return this.kv.put(`${DEFERRED}${key}`, JSON.stringify({ ...event, deferredAt: this.iso() }))
  }

  getDeferred(key) {
    return getJson(this.kv, `${DEFERRED}${key}`)
  }

  deleteDeferred(key) {
    return this.kv.delete(`${DEFERRED}${key}`)
  }

  listDeferredKeys(limit = 50) {
    return this.listSuffixes(DEFERRED, limit)
  }

  // ---- processed-event markers ---------------------------------------------

  async isEventProcessed(source, eventId) {
    return Boolean(await this.kv.get(`${EVENT}${source}:${eventId}`))
  }

  markEventProcessed(source, eventId) {
    return this.kv.put(`${EVENT}${source}:${eventId}`, this.iso(), { expirationTtl: EVENT_TTL_SECONDS })
  }

  // ---- recovery telemetry --------------------------------------------------

  saveRecoveryRun(summary) {
    return this.kv.put(RECOVERY_LAST_RUN_KEY, JSON.stringify({ ...summary, at: this.iso() }))
  }

  getRecoveryRun() {
    return getJson(this.kv, RECOVERY_LAST_RUN_KEY)
  }
}

/** Admin/browser-safe summary of a fraud record (no PII, no payloads). */
export function summarizeFraudRecord(record) {
  if (!record) return null
  return {
    decision: record.evaluation?.decision ?? null,
    decisionSource: record.evaluation?.decisionSource ?? null,
    fallbackReason: record.evaluation?.fallbackReason ?? null,
    evaluationState: record.evaluation?.state ?? null,
    kountOrderId: record.evaluation?.kountOrderId ?? null,
    paymentState: record.payment?.state ?? null,
    reviewStatus: record.review?.status ?? null,
    fulfillmentAllowed: Boolean(record.fulfillmentAllowed),
    buyerStatus: record.buyerStatus ?? null,
    pendingReports: (record.reports || []).filter((r) => r.state !== 'confirmed').length,
    conflicts: (record.conflicts || []).length,
  }
}
