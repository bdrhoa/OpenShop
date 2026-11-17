// Browser-side Kount device data collection (src/lib/kount.js).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const sdk = vi.hoisted(() => ({ kountSDK: vi.fn() }))
vi.mock('@kount/kount-web-client-sdk', () => ({ default: sdk.kountSDK }))

import {
  startKountCollection,
  withKountSession,
  getKountSessionId,
  resetKountCollection,
} from '../../src/lib/kount.js'

function configResponse(body) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
}

describe('Kount device data collection (browser)', () => {
  beforeEach(() => {
    resetKountCollection()
    sdk.kountSDK.mockReset()
    vi.stubGlobal('window', {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('starts the SDK with the client ID and the checkout session ID, once per page', async () => {
    vi.stubGlobal('fetch', configResponse({ ddcEnabled: true, clientId: '900900', environment: 'TEST' }))
    sdk.kountSDK.mockImplementation((config) => {
      queueMicrotask(() => config.callbacks['collect-end']())
      return {}
    })

    expect(await startKountCollection()).toBe('complete')
    await startKountCollection()

    expect(sdk.kountSDK).toHaveBeenCalledTimes(1)
    const [config, sessionId] = sdk.kountSDK.mock.calls[0]
    expect(config).toMatchObject({ clientID: '900900', environment: 'TEST', isSinglePageApp: true })
    expect(sessionId).toMatch(/^[a-f0-9]{32}$/)
    expect(sessionId).toBe(getKountSessionId())
  })

  it('does not load the SDK when no client ID is configured', async () => {
    vi.stubGlobal('fetch', configResponse({ ddcEnabled: false, clientId: null }))
    expect(await startKountCollection()).toBe('disabled')
    expect(sdk.kountSDK).not.toHaveBeenCalled()
  })

  it('reports a failed start instead of throwing', async () => {
    vi.stubGlobal('fetch', configResponse({ ddcEnabled: true, clientId: '900900' }))
    sdk.kountSDK.mockReturnValue(null)
    expect(await startKountCollection()).toBe('failed')
  })

  it('checkout waits for collection to finish, but not forever', async () => {
    vi.stubGlobal('fetch', configResponse({ ddcEnabled: true, clientId: '900900' }))
    sdk.kountSDK.mockReturnValue({}) // collect-end never fires
    const started = Date.now()
    const body = await withKountSession({ priceId: 'price_1' }, { waitMs: 50 })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(body).toEqual({ priceId: 'price_1', kountSessionId: getKountSessionId() })
  })
})
