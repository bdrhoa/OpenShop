import { describe, it, expect, beforeEach, vi } from 'vitest'
import { KountService, KountError, resetKountTokenCache, normalizeApiKey } from '../../../src/services/KountService.js'

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

const TOKEN_URL = 'https://login-uat.equifax.com/as/token'
const ORDERS_URL = 'https://api-sandbox.kount.com/commerce/v2/orders?riskInquiry=true'

// No real waiting between attempts in tests.
const NO_DELAY = { startingDelay: 0, maxDelay: 0 }

function makeService(handler, { maxRetries } = {}) {
  const fetchImpl = vi.fn(handler)
  const service = new KountService({ clientId: 'client', apiKey: 'synthetic-key', fetchImpl, maxRetries, backoffOptions: NO_DELAY })
  return { service, fetchImpl }
}

const evaluateBody = { order: { orderId: 'K1', transactions: [{ transactionId: 'K1#0' }], riskInquiry: { decision: 'APPROVE' } } }

describe('KountService', () => {
  beforeEach(() => resetKountTokenCache())

  it('requests a token with Basic auth and the k1_integration_api scope', async () => {
    const { service, fetchImpl } = makeService(async (url, init) => {
      if (url === TOKEN_URL) {
        expect(init.headers.Authorization).toBe('Basic synthetic-key')
        expect(init.body).toContain('grant_type=client_credentials')
        expect(init.body).toContain('scope=k1_integration_api')
        return jsonResponse(200, { access_token: 'tok1', expires_in: 1200 })
      }
      expect(init.headers.Authorization).toBe('Bearer tok1')
      return jsonResponse(200, evaluateBody)
    })

    const result = await service.evaluateOrder({ merchantOrderId: 'cs_1' })
    expect(result).toMatchObject({ kountOrderId: 'K1', transactionId: 'K1#0', decision: 'APPROVE' })
    expect(fetchImpl).toHaveBeenCalledWith(ORDERS_URL, expect.objectContaining({ method: 'POST' }))
  })

  it('reuses a cached token and shares one in-flight refresh', async () => {
    let tokenCalls = 0
    const { service } = makeService(async (url) => {
      if (url === TOKEN_URL) {
        tokenCalls++
        return jsonResponse(200, { access_token: 'tok', expires_in: 1200 })
      }
      return jsonResponse(200, evaluateBody)
    })
    await Promise.all([service.getAccessToken(), service.getAccessToken(), service.getAccessToken()])
    await service.evaluateOrder({ merchantOrderId: 'cs_1' })
    expect(tokenCalls).toBe(1)
  })

  it('refreshes a token that is about to expire', async () => {
    let tokenCalls = 0
    const { service } = makeService(async () => {
      tokenCalls++
      return jsonResponse(200, { access_token: `tok${tokenCalls}`, expires_in: 30 })
    })
    await service.getAccessToken()
    await service.getAccessToken()
    expect(tokenCalls).toBe(2)
  })

  it('refreshes once on 401 and resends', async () => {
    let tokenCalls = 0
    let orderCalls = 0
    const { service } = makeService(async (url) => {
      if (url === TOKEN_URL) {
        tokenCalls++
        return jsonResponse(200, { access_token: `tok${tokenCalls}`, expires_in: 1200 })
      }
      orderCalls++
      return orderCalls === 1 ? jsonResponse(401, {}) : jsonResponse(200, evaluateBody)
    })
    await expect(service.evaluateOrder({})).resolves.toMatchObject({ decision: 'APPROVE' })
    expect(tokenCalls).toBe(2)
  })

  it('retries 429 with backoff', async () => {
    let orderCalls = 0
    const { service } = makeService(async (url) => {
      if (url === TOKEN_URL) return jsonResponse(200, { access_token: 'tok', expires_in: 1200 })
      orderCalls++
      return orderCalls < 3 ? jsonResponse(429, {}, { 'Retry-After': '0' }) : jsonResponse(200, evaluateBody)
    })
    await expect(service.evaluateOrder({})).resolves.toMatchObject({ decision: 'APPROVE' })
    expect(orderCalls).toBe(3)
  })

  it('retries network failures and timeouts, then reports exhaustion (default 3 retries)', async () => {
    let orderCalls = 0
    const { service } = makeService(async (url) => {
      if (url === TOKEN_URL) return jsonResponse(200, { access_token: 'tok', expires_in: 1200 })
      orderCalls++
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    })
    const error = await service.evaluateOrder({}).catch((e) => e)
    expect(error).toBeInstanceOf(KountError)
    expect(error).toMatchObject({ uncertain: true, exhausted: true, attempts: 4 })
    expect(orderCalls).toBe(4)
  })

  it('honors the configured retry count', async () => {
    for (const [maxRetries, expectedCalls] of [[0, 1], [1, 2], [5, 6]]) {
      resetKountTokenCache()
      let orderCalls = 0
      const { service } = makeService(async (url) => {
        if (url === TOKEN_URL) return jsonResponse(200, { access_token: 'tok', expires_in: 1200 })
        orderCalls++
        return jsonResponse(503, {})
      }, { maxRetries })
      const error = await service.evaluateOrder({}).catch((e) => e)
      expect(orderCalls).toBe(expectedCalls)
      expect(error).toMatchObject({ status: 503, exhausted: true, attempts: expectedCalls })
    }
  })

  it('recovers when a retry succeeds after 5xx', async () => {
    let orderCalls = 0
    const { service } = makeService(async (url) => {
      if (url === TOKEN_URL) return jsonResponse(200, { access_token: 'tok', expires_in: 1200 })
      orderCalls++
      return orderCalls < 3 ? jsonResponse(500, {}) : jsonResponse(200, evaluateBody)
    })
    await expect(service.evaluateOrder({})).resolves.toMatchObject({ decision: 'APPROVE' })
    expect(orderCalls).toBe(3)
  })

  it('does not retry a 400 and keeps the correlation id', async () => {
    let orderCalls = 0
    const { service } = makeService(async (url) => {
      if (url === TOKEN_URL) return jsonResponse(200, { access_token: 'tok', expires_in: 1200 })
      orderCalls++
      return jsonResponse(400, {}, { 'X-Correlation-Id': 'corr-1' })
    })
    const error = await service.evaluateOrder({}).catch((e) => e)
    expect(orderCalls).toBe(1)
    expect(error).toMatchObject({ status: 400, uncertain: false, exhausted: false, correlationId: 'corr-1' })
  })

  it('uses exponential backoff with full jitter between attempts', async () => {
    const delays = []
    const realSetTimeout = globalThis.setTimeout
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms, ...args) => {
      delays.push(ms)
      return realSetTimeout(fn, 0, ...args)
    })
    try {
      const fetchImpl = vi.fn(async (url) => url === TOKEN_URL
        ? jsonResponse(200, { access_token: 'tok', expires_in: 1200 })
        : jsonResponse(503, {}))
      const service = new KountService({ clientId: 'client', apiKey: 'synthetic-key', fetchImpl, maxRetries: 3 })
      await service.evaluateOrder({}).catch(() => {})
    } finally {
      spy.mockRestore()
    }
    const backoffDelays = delays.filter((ms) => typeof ms === 'number' && ms > 0 && ms <= 2000)
    // Full jitter: each wait is random in [0, 250 * 2^n], capped at 2s.
    expect(backoffDelays.length).toBeLessThanOrEqual(3)
    backoffDelays.forEach((ms, i) => expect(ms).toBeLessThanOrEqual(250 * 2 ** (i + 1)))
  })

  it('retries token requests on 5xx but not credential errors', async () => {
    let calls = 0
    const { service: flaky } = makeService(async () => {
      calls++
      return calls < 2 ? jsonResponse(502, {}) : jsonResponse(200, { access_token: 'tok', expires_in: 1200 })
    })
    await expect(flaky.getAccessToken()).resolves.toBe('tok')
    expect(calls).toBe(2)
    resetKountTokenCache()
  })

  it('does not retry token credential errors', async () => {
    const { service, fetchImpl } = makeService(async () => jsonResponse(401, {}))
    await expect(service.getAccessToken()).rejects.toThrow(/401/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('refuses to run without credentials', async () => {
    const service = new KountService({ clientId: '', apiKey: '' })
    await expect(service.getAccessToken()).rejects.toThrow(/not configured/)
  })

  it('normalizes pasted API keys', () => {
    expect(normalizeApiKey('  "Basic abc def"  ')).toBe('abcdef')
  })
})
