// Public Kount configuration for browser device data collection (DDC).
//
// Returns only what the Kount web SDK needs: whether collection should run,
// the client ID (not a secret) and the collector environment. The API key is
// never exposed.
import { Hono } from 'hono'
import { getKVNamespace } from '../../utils/kv.js'
import { resolveKountConfig, shouldHoldForKount } from '../../services/KountOrderService.js'

const router = new Hono()

router.get('/config', async (c) => {
  try {
    const config = await resolveKountConfig(getKVNamespace(c.env), c.env)
    if (!shouldHoldForKount(config)) return c.json({ enabled: false })
    return c.json({
      enabled: true,
      clientId: config.clientId,
      environment: config.ddcEnvironment,
    })
  } catch (error) {
    console.error(`[Kount] ${error.message}`)
    return c.json({ enabled: false })
  }
})

export default router
