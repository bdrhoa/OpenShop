// Admin: Kount fraud review records (read-only).
import { Hono } from 'hono'
import { asyncHandler } from '../../middleware/errorHandler.js'
import { createFraudReviewService, resolveKountSettings } from '../../services/FraudReviewService.js'
import { getKVNamespace } from '../../utils/kv.js'

const router = new Hono()

router.get('/', asyncHandler(async (c) => {
  const kv = getKVNamespace(c.env)
  const kount = await resolveKountSettings(kv, c.env)
  const service = await createFraudReviewService(kv, c.env)
  const records = await service.listRecords({ limit: 100 })
  return c.json({ enabled: kount.enabled, webhookConfigured: Boolean(kount.webhookPublicKey), records })
}))

export default router
