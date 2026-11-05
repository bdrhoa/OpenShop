import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { KOUNT_DDC_HOST, isValidKountSessionId } from '../../src/config/kount.js'

const kountSDK = vi.fn((_, sessionID) => ({
  sessionID,
  NewSession: vi.fn(function newSession(id) { this.sessionID = id }),
}))
vi.mock('@kount/kount-web-client-sdk', () => ({ default: kountSDK }))

const MINUTE_MS = 60 * 1000
const COOKIE_NAME = 'openshop_kount_session'

// Mimics a browser cookie jar, keeping attributes so tests can inspect them.
function createCookieJar() {
  const cookies = new Map()
  return {
    attributes: () => [...cookies.values()].map((cookie) => cookie.attributes).join('; '),
    clear: () => cookies.clear(),
    document: {
      get cookie() {
        return [...cookies.entries()].map(([name, { value }]) => `${name}=${value}`).join('; ')
      },
      set cookie(raw) {
        const [pair, ...attributes] = raw.split('; ')
        const [name, value] = pair.split('=')
        cookies.set(name, { value, attributes: attributes.join('; ') })
      },
    },
  }
}

// A fresh module instance is what a full page load gets, such as returning from Stripe.
async function loadPage({ hostname = KOUNT_DDC_HOST, pathname = '/' } = {}) {
  vi.stubGlobal('window', { location: { hostname, pathname } })
  vi.resetModules()
  return import('../../src/lib/kountDdc.js')
}

const latestSdk = () => kountSDK.mock.results.at(-1).value

describe('Kount DDC client', () => {
  let cookieJar

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    cookieJar = createCookieJar()
    vi.stubGlobal('document', cookieJar.document)
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
    expect(cookieJar.document.cookie).toBe('')
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

  it('uses a browser-session cookie so the ID ends with the browser', async () => {
    const ddc = await loadPage()
    await ddc.startKountDdc()

    expect(cookieJar.document.cookie).toContain(`${COOKIE_NAME}=${ddc.getKountSessionId()}.`)
    expect(cookieJar.attributes()).not.toMatch(/expires|max-age/i)
    expect(cookieJar.attributes()).toContain('Secure')
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

  it('uses the same session ID for several orders in one web session', async () => {
    const firstOrder = await loadPage()
    await firstOrder.startKountDdc()
    const firstBody = firstOrder.withKountSession({ priceId: 'price_1' })

    vi.advanceTimersByTime(5 * MINUTE_MS)
    const afterPayment = await loadPage({ pathname: '/success' })
    await afterPayment.startKountDdc()
    const secondBody = afterPayment.withKountSession({ priceId: 'price_2' })

    expect(secondBody.kountSessionId).toBe(firstBody.kountSessionId)
    expect(latestSdk().NewSession).not.toHaveBeenCalled()
  })

  it('starts a new session ID when the browser is closed and reopened', async () => {
    const beforeClose = await loadPage()
    await beforeClose.startKountDdc()
    const sessionId = beforeClose.getKountSessionId()

    cookieJar.clear()
    const afterReopen = await loadPage()
    await afterReopen.startKountDdc()

    expect(afterReopen.getKountSessionId()).not.toBe(sessionId)
  })

  it('keeps the ID at exactly 15 minutes and replaces it after that', async () => {
    const ddc = await loadPage()
    await ddc.startKountDdc()
    const sessionId = ddc.getKountSessionId()

    vi.advanceTimersByTime(15 * MINUTE_MS)
    expect(ddc.getKountSessionId()).toBe(sessionId)

    vi.advanceTimersByTime(1)
    expect(ddc.getKountSessionId()).not.toBe(sessionId)
  })

  it('counts age from creation, so activity does not extend the session', async () => {
    const ddc = await loadPage()
    await ddc.startKountDdc()
    const sessionId = ddc.getKountSessionId()

    for (let minute = 0; minute < 15; minute += 1) {
      vi.advanceTimersByTime(MINUTE_MS)
      ddc.withKountSession({ priceId: 'price_1' })
    }
    vi.advanceTimersByTime(1)

    expect(ddc.getKountSessionId()).not.toBe(sessionId)
  })

  it('starts a new ID on page load when the session is too old', async () => {
    const firstPage = await loadPage()
    await firstPage.startKountDdc()
    const sessionId = firstPage.getKountSessionId()

    vi.advanceTimersByTime(15 * MINUTE_MS + 1)
    const nextPage = await loadPage()
    await nextPage.startKountDdc()

    expect(kountSDK.mock.calls.at(-1)[1]).not.toBe(sessionId)
  })

  it('renews collection on an open page without waiting for checkout', async () => {
    const ddc = await loadPage()
    await ddc.startKountDdc()
    const sdk = latestSdk()

    vi.advanceTimersByTime(15 * MINUTE_MS + 1)

    expect(sdk.NewSession).toHaveBeenCalledTimes(1)
    expect(sdk.sessionID).toBe(ddc.getKountSessionId())

    vi.advanceTimersByTime(15 * MINUTE_MS + 1)
    expect(sdk.NewSession).toHaveBeenCalledTimes(2)
  })

  it('moves to a new ID created in another tab', async () => {
    const ddc = await loadPage()
    await ddc.startKountDdc()
    const sdk = latestSdk()

    cookieJar.document.cookie = `${COOKIE_NAME}=othertabsession.${Date.now()}; Path=/`

    expect(ddc.getKountSessionId()).toBe('othertabsession')
    expect(sdk.NewSession).toHaveBeenCalledWith('othertabsession')
  })

  it('ignores a malformed cookie', async () => {
    cookieJar.document.cookie = `${COOKIE_NAME}=not valid!.notatime; Path=/`
    const ddc = await loadPage()
    await ddc.startKountDdc()
    expect(isValidKountSessionId(ddc.getKountSessionId())).toBe(true)
  })

  it('keeps working when cookies are blocked', async () => {
    vi.stubGlobal('document', {
      get cookie() { throw new Error('blocked') },
      set cookie(_) { throw new Error('blocked') },
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
