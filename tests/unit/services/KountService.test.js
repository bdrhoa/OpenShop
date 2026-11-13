import { describe, it, expect, beforeEach, vi } from 'vitest'
import { KountService, KountError, resetKountTokenCache, normalizeApiKey } from '../../../src/services/KountService.js'

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

const TOKEN_URL = 'https://login-uat.equifax.com/as/token'
const ORDERS_URL = 'https://api-sandbox.kount.com/commerce/v2/orders?riskInquiry=true'

function makeService(handler) {
  const fetchImpl = vi.fn(handler)
  const service = new KountService({ clientId: 'client', apiKey: 'synthetic-key', fetchImpl, sleepImpl: async () => {} })
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

  it('does not retry an order write after a network failure and marks it uncertain', async () => {
    let orderCalls = 0
    const { service } = makeService(async (url) => {
      if (url === TOKEN_URL) return jsonResponse(200, { access_token: 'tok', expires_in: 1200 })
      orderCalls++
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    })
    const error = await service.evaluateOrder({}).catch((e) => e)
    expect(error).toBeInstanceOf(KountError)
    expect(error.uncertain).toBe(true)
    expect(orderCalls).toBe(1)
  })

  it('marks 500 as uncertain and 400 as certain', async () => {
    for (const [status, uncertain] of [[500, true], [400, false]]) {
      resetKountTokenCache()
      const { service } = makeService(async (url) => url === TOKEN_URL
        ? jsonResponse(200, { access_token: 'tok', expires_in: 1200 })
        : jsonResponse(status, {}, { 'X-Correlation-Id': 'corr-1' }))
      const error = await service.evaluateOrder({}).catch((e) => e)
      expect(error.status).toBe(status)
      expect(error.uncertain).toBe(uncertain)
      expect(error.correlationId).toBe('corr-1')
    }
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
