// Admin: inspect and resolve Kount-screened orders.
//
// REVIEW orders (and evaluations parked in `error`) keep the card
// authorization held and fulfillment blocked until resolved here or by a
// Kount reviewer webhook. Card authorizations expire after about 7 days.
import { Hono } from 'hono'
import { asyncHandler } from '../../middleware/errorHandler.js'
import { getKVNamespace } from '../../utils/kv.js'
import { parseJsonBody } from '../../utils/request.js'
import { ValidationError, APIError } from '../../utils/errors.js'
import { createKountOrderService, KountOrderService, orderKey } from '../../services/KountOrderService.js'
import { KOUNT_ORDER_KV_PREFIX } from '../../config/kount.js'

const router = new Hono()

function checkoutIdParam(c) {
  const id = String(c.req.param('checkoutSessionId') || '').trim()
  if (!id.startsWith('cs_') || id.length > 255) {
    throw new ValidationError('Invalid checkout session ID')
  }
  return id
}

// List screened orders, optionally filtered by status (e.g. ?status=review).
router.get('/orders', asyncHandler(async (c) => {
  const kv = getKVNamespace(c.env)
  const status = c.req.query('status')
  const listed = await kv.list({ prefix: `${KOUNT_ORDER_KV_PREFIX}cs_` })
  const records = []
  for (const { name } of listed.keys.slice(0, 200)) {
    const raw = await kv.get(name)
    if (!raw) continue
    try {
      const record = JSON.parse(raw)
      if (!status || record.status === status) records.push(record)
    } catch {
      // skip corrupt entries
    }
  }
  records.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  return c.json({ orders: records })
}))

router.get('/orders/:checkoutSessionId', asyncHandler(async (c) => {
  const id = checkoutIdParam(c)
  const raw = await getKVNamespace(c.env).get(orderKey(id))
  if (!raw) return c.json({ error: 'Not found', status: 404 }, 404)
  return c.json({ order: JSON.parse(raw) })
}))

// Body: { "decision": "APPROVE" | "DECLINE" }
router.post('/orders/:checkoutSessionId/resolve', asyncHandler(async (c) => {
  const id = checkoutIdParam(c)
  const { decision } = await parseJsonBody(c)
  const { service } = await createKountOrderService(getKVNamespace(c.env), c.env)
  if (!(service instanceof KountOrderService)) {
    throw new APIError('Kount screening is not configured', 503)
  }
  const out = await service.resolve(id, String(decision || '').toUpperCase(), 'admin')
  return c.json({ order: out.record, duplicate: Boolean(out.duplicate), ignored: out.ignored ?? null })
}))

export default router
