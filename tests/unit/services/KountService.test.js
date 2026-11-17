import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  KountService,
  KountApiError,
  clearKountTokenCache,
  parseOrderResponse,
  isKountEnabled,
} from '../../../src/services/KountService.js'

const cfg = { apiKey: 'portal-key', tokenUrl: 'https://login-uat.equifax.com/as/token', apiUrl: 'https://api-sandbox.kount.com' }

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

function tokenResponse(expiresIn = 1200) {
  return json(200, { access_token: 'jwt-1', expires_in: expiresIn })
}

describe('KountService', () => {
  let now
  beforeEach(() => {
    clearKountTokenCache()
    now = 1000000
  })

  function service(fetchImpl) {
    return new KountService(cfg, { fetch: fetchImpl, now: () => now, sleep: async () => {} })
  }

  it('requests a client_credentials token with the portal key as Basic credential', async () => {
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse())
    await service(fetchMock).getToken()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(cfg.tokenUrl)
    expect(init.headers.Authorization).toBe('Basic portal-key')
    expect(init.body).toBe('grant_type=client_credentials&scope=k1_integration_api')
  })

  it('reuses the cached token and refreshes shortly before expiry', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => tokenResponse(600))
    const svc = service(fetchMock)
    await svc.getToken()
    await svc.getToken()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    now += 600000 - 30000 // inside the 60 s refresh margin
    await svc.getToken()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent refreshes into one request', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => tokenResponse())
    const svc = service(fetchMock)
    await Promise.all([svc.getToken(), svc.getToken(), svc.getToken()])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('recovers after a failed refresh', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(500, {}))
      .mockResolvedValueOnce(tokenResponse())
    const svc = service(fetchMock)
    await expect(svc.getToken()).rejects.toMatchObject({ phase: 'before_send', retryable: true })
    await expect(svc.getToken()).resolves.toBe('jwt-1')
  })

  it('posts an evaluation and parses the decision', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(json(200, { order: { orderId: 'K1', riskInquiry: { decision: 'REVIEW', omniscore: 42, device: { id: 'dev' } }, transactions: [{ transactionId: 'K1#0' }] } }, { 'X-Correlation-Id': 'corr-1' }))
    const result = await service(fetchMock).postOrder({ merchantOrderId: 'cs_1' }, { riskInquiry: true })
    expect(fetchMock.mock.calls[1][0]).toBe('https://api-sandbox.kount.com/commerce/v2/orders?riskInquiry=true')
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer jwt-1')
    expect(result).toEqual({ orderId: 'K1', decision: 'REVIEW', omniscore: 42, deviceId: 'dev', transactionId: 'K1#0', correlationId: 'corr-1' })
  })

  it('retries a 429 with bounded attempts', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(json(429, {}))
      .mockResolvedValueOnce(json(200, { order: { orderId: 'K1', riskInquiry: { decision: 'APPROVE' } } }))
    const result = await service(fetchMock).postOrder({ merchantOrderId: 'cs_1' }, { riskInquiry: true })
    expect(result.decision).toBe('APPROVE')
  })

  it('does not re-POST after an uncertain failure (no response)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
    const err = await service(fetchMock).postOrder({ merchantOrderId: 'cs_1' }, { riskInquiry: true }).catch((e) => e)
    expect(err).toBeInstanceOf(KountApiError)
    expect(err.uncertain).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('treats HTTP 500 as uncertain and 400 as a definite rejection', async () => {
    const svc500 = service(vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(json(500, {})))
    const e500 = await svc500.postOrder({}, { riskInquiry: true }).catch((e) => e)
    expect(e500.uncertain).toBe(true)

    clearKountTokenCache()
    const svc400 = service(vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(json(400, { error: { message: 'bad' } })))
    const e400 = await svc400.postOrder({}, { riskInquiry: true }).catch((e) => e)
    expect(e400.uncertain).toBe(false)
    expect(e400.retryable).toBe(false)
    expect(e400.message).not.toMatch(/bad/) // provider messages are not echoed
  })

  it('retries an idempotent PATCH after an uncertain failure', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(json(502, {}))
      .mockResolvedValueOnce(json(200, {}))
    await service(fetchMock).updateOrder('K1', { merchantOrderId: 'cs_1' })
    expect(fetchMock.mock.calls[2][0]).toBe('https://api-sandbox.kount.com/commerce/v2/orders/K1')
    expect(fetchMock.mock.calls[2][1].method).toBe('PATCH')
  })
})

describe('helpers', () => {
  it('never maps an unknown decision to approval', () => {
    expect(parseOrderResponse({ order: { riskInquiry: { decision: 'DECLINED' } } }).decision).toBeNull()
    expect(parseOrderResponse(null).decision).toBeNull()
  })

  it('requires the Stripe webhook secret before enabling the payment hold', () => {
    expect(isKountEnabled({ clientId: 'c', apiKey: 'k' })).toBe(false)
    expect(isKountEnabled({ clientId: 'c', apiKey: 'k', stripeWebhookSecret: 'whsec' })).toBe(true)
  })
})
