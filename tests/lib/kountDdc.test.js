import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { KOUNT_DDC_HOST, isValidKountSessionId } from '../../src/config/kount.js'

const sdkInstance = { NewSession: vi.fn() }
const kountSDK = vi.fn(() => sdkInstance)
vi.mock('@kount/kount-web-client-sdk', () => ({ default: kountSDK }))

const DAY_MS = 24 * 60 * 60 * 1000
const STORAGE_KEY = 'openshop-kount-session'

function createStorage() {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }
}

// A fresh module instance is what a full page load gets, such as returning from Stripe.
async function loadPage({ hostname = KOUNT_DDC_HOST, pathname = '/' } = {}) {
  vi.stubGlobal('window', { location: { hostname, pathname } })
  vi.resetModules()
  return import('../../src/lib/kountDdc.js')
}

describe('Kount DDC client', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('localStorage', createStorage())
    vi.stubEnv('VITE_KOUNT_CLIENT_ID', '123456')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('starts the SDK on first load with a Kount-valid session ID', async () => {
    const ddc = await loadPage({ pathname: '/products/abc' })
    await ddc.startKountDdc()

    expect(kountSDK).toHaveBeenCalledTimes(1)
    const [config, sessionId] = kountSDK.mock.calls[0]
    expect(config).toEqual({ clientID: '123456', environment: 'TEST', isSinglePageApp: true })
    expect(sessionId).toHaveLength(32)
    expect(isValidKountSessionId(sessionId)).toBe(true)
  })

  it('starts only once per page load', async () => {
    const ddc = await loadPage()
    await ddc.startKountDdc()
    await ddc.startKountDdc()
    expect(kountSDK).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['another site', { hostname: 'kount-poc-base.bdrhoa.workers.dev' }],
    ['a lookalike host', { hostname: `evil.${KOUNT_DDC_HOST}` }],
    ['local development', { hostname: 'localhost' }],
  ])('does nothing on %s', async (_, page) => {
    const ddc = await loadPage(page)
    await ddc.startKountDdc()

    expect(kountSDK).not.toHaveBeenCalled()
    expect(ddc.getKountSessionId()).toBeNull()
    expect(ddc.withKountSession({ priceId: 'price_1' })).toEqual({ priceId: 'price_1' })
    expect(globalThis.localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('does nothing without a client ID', async () => {
    vi.stubEnv('VITE_KOUNT_CLIENT_ID', '')
    const ddc = await loadPage()
    await ddc.startKountDdc()
    expect(kountSDK).not.toHaveBeenCalled()
  })

  it('does not collect on admin pages', async () => {
    const ddc = await loadPage({ pathname: '/admin/products' })
    await ddc.startKountDdc()
    expect(kountSDK).not.toHaveBeenCalled()
  })

  it('keeps the same session ID across full page loads', async () => {
    const landing = await loadPage()
    await landing.startKountDdc()
    const sessionId = landing.getKountSessionId()

    const returnFromStripe = await loadPage({ pathname: '/success' })
    await returnFromStripe.startKountDdc()

    expect(kountSDK.mock.calls[1][1]).toBe(sessionId)
    expect(returnFromStripe.getKountSessionId()).toBe(sessionId)
  })

  it('adds the session ID to checkout requests', async () => {
    const ddc = await loadPage()
    await ddc.startKountDdc()
    expect(ddc.withKountSession({ priceId: 'price_1' })).toEqual({
      priceId: 'price_1',
      kountSessionId: kountSDK.mock.calls[0][1],
    })
  })

  it('starts a new session ID after a long absence', async () => {
    vi.useFakeTimers()
    const firstVisit = await loadPage()
    await firstVisit.startKountDdc()
    const sessionId = firstVisit.getKountSessionId()

    vi.advanceTimersByTime(DAY_MS + 1)
    const secondVisit = await loadPage()
    await secondVisit.startKountDdc()

    expect(secondVisit.getKountSessionId()).not.toBe(sessionId)
  })

  it('rotates after the order that used the current session ID', async () => {
    const ddc = await loadPage({ pathname: '/success' })
    await ddc.startKountDdc()
    const orderSessionId = ddc.getKountSessionId()

    await ddc.rotateKountSessionAfterOrder(orderSessionId)

    const nextSessionId = ddc.getKountSessionId()
    expect(nextSessionId).not.toBe(orderSessionId)
    expect(sdkInstance.NewSession).toHaveBeenCalledWith(nextSessionId)
  })

  it('does not rotate again when the success page is reloaded', async () => {
    const ddc = await loadPage({ pathname: '/success' })
    await ddc.startKountDdc()
    const orderSessionId = ddc.getKountSessionId()
    await ddc.rotateKountSessionAfterOrder(orderSessionId)
    const nextSessionId = ddc.getKountSessionId()

    const reloaded = await loadPage({ pathname: '/success' })
    await reloaded.startKountDdc()
    sdkInstance.NewSession.mockClear()
    await reloaded.rotateKountSessionAfterOrder(orderSessionId)

    expect(reloaded.getKountSessionId()).toBe(nextSessionId)
    expect(sdkInstance.NewSession).not.toHaveBeenCalled()
  })

  it('keeps working when storage is blocked', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
    })
    const ddc = await loadPage()
    await ddc.startKountDdc()
    expect(ddc.getKountSessionId()).toBe(kountSDK.mock.calls[0][1])
  })

  it('does not break the storefront when the SDK fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    kountSDK.mockImplementationOnce(() => { throw new Error('sdk failure') })
    const ddc = await loadPage()
    await expect(ddc.startKountDdc()).resolves.toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('isValidKountSessionId', () => {
  it.each(['abc', 'a-b_C9', 'a'.repeat(32)])('accepts %s', (value) => {
    expect(isValidKountSessionId(value)).toBe(true)
  })

  it.each(['', 'a'.repeat(33), 'has space', 'semi;colon', null, undefined, 42])('rejects %s', (value) => {
    expect(isValidKountSessionId(value)).toBe(false)
  })
})
