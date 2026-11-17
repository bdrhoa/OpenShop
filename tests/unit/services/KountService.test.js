import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  KountService,
  KountApiError,
  clearKountTokenCache,
  parseOrderResponse,
  isKountEnabled,
  backoffDelay,
  parseRetryAfter,
  parseMaxRetries,
  parseFallbackDecision,
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

  let sleep
  beforeEach(() => {
    sleep = vi.fn(async () => {})
  })

  function service(fetchImpl, { maxRetries = 2, random = () => 0.5 } = {}) {
    return new KountService({ ...cfg, maxRetries }, { fetch: fetchImpl, now: () => now, sleep, random })
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

  it('retries timeouts with exponentially growing, jittered waits', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
      .mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
      .mockResolvedValueOnce(json(200, { order: { orderId: 'K1', riskInquiry: { decision: 'APPROVE' } } }))
    const result = await service(fetchMock).postOrder({ merchantOrderId: 'cs_1' }, { riskInquiry: true })
    expect(result.decision).toBe('APPROVE')
    expect(fetchMock).toHaveBeenCalledTimes(4)
    // random() = 0.5 over windows of 250 ms and 500 ms
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([125, 250])
  })

  it('stops after maxRetries and reports how many attempts were made', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(tokenResponse()).mockImplementation(async () => json(500, {}))
    const err = await service(fetchMock, { maxRetries: 3 }).postOrder({}, { riskInquiry: true }).catch((e) => e)
    expect(err).toBeInstanceOf(KountApiError)
    expect(err.uncertain).toBe(true)
    expect(err.attempts).toBe(4)
    expect(sleep).toHaveBeenCalledTimes(3)
  })

  it('makes a single attempt when maxRetries is 0', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(json(503, {}))
    const err = await service(fetchMock, { maxRetries: 0 }).postOrder({}, { riskInquiry: true }).catch((e) => e)
    expect(err.attempts).toBe(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('does not retry a definite 4xx rejection', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(json(400, { error: { message: 'bad' } }))
    const err = await service(fetchMock).postOrder({}, { riskInquiry: true }).catch((e) => e)
    expect(err.retryable).toBe(false)
    expect(err.uncertain).toBe(false)
    expect(err.attempts).toBe(1)
    expect(err.message).not.toMatch(/bad/) // provider messages are not echoed
  })

  it('honors Retry-After, and gives up when it exceeds the backoff cap', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(json(429, {}, { 'Retry-After': '2' }))
      .mockResolvedValueOnce(json(200, { order: { orderId: 'K1', riskInquiry: { decision: 'REVIEW' } } }))
    await service(fetchMock).postOrder({}, { riskInquiry: true })
    expect(sleep).toHaveBeenCalledWith(2000)

    sleep.mockClear()
    const slow = vi.fn().mockResolvedValueOnce(json(429, {}, { 'Retry-After': '60' }))
    const err = await service(slow).postOrder({}, { riskInquiry: true }).catch((e) => e)
    expect(err.status).toBe(429)
    expect(sleep).not.toHaveBeenCalled()
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

describe('backoff and settings helpers', () => {
  it('grows the jitter window exponentially up to the cap', () => {
    const top = () => 0.999999
    expect([0, 1, 2, 3, 4, 5].map((n) => backoffDelay(n, { random: top }))).toEqual([249, 499, 999, 1999, 3999, 3999])
    expect(backoffDelay(2, { random: () => 0 })).toBe(0)
  })

  it('parses Retry-After seconds and HTTP dates', () => {
    expect(parseRetryAfter('3')).toBe(3000)
    expect(parseRetryAfter('Tue, 17 Nov 2026 12:00:05 GMT', Date.parse('2026-11-17T12:00:00Z'))).toBe(5000)
    expect(parseRetryAfter('')).toBeUndefined()
  })

  it('clamps retries to 0-3 and defaults invalid settings', () => {
    expect(parseMaxRetries('0')).toBe(0)
    expect(parseMaxRetries(3)).toBe(3)
    expect(parseMaxRetries('9')).toBe(3)
    expect(parseMaxRetries('-1')).toBe(2)
    expect(parseMaxRetries(undefined)).toBe(2)
    expect(parseFallbackDecision('decline')).toBe('DECLINE')
    expect(parseFallbackDecision('REVIEW')).toBe('APPROVE')
    expect(parseFallbackDecision(undefined)).toBe('APPROVE')
  })
})

describe('helpers', () => {
  it('accepts riskInquiry as an object or a one-element array', () => {
    const inquiry = { decision: 'DECLINE', device: { id: 'dev-1' } }
    expect(parseOrderResponse({ order: { riskInquiry: [inquiry] } })).toMatchObject({ decision: 'DECLINE', deviceId: 'dev-1' })
    expect(parseOrderResponse({ order: { riskInquiry: inquiry } })).toMatchObject({ decision: 'DECLINE', deviceId: 'dev-1' })
  })

  it('never maps an unknown decision to approval', () => {
    expect(parseOrderResponse({ order: { riskInquiry: { decision: 'DECLINED' } } }).decision).toBeNull()
    expect(parseOrderResponse(null).decision).toBeNull()
  })

  it('requires the Stripe webhook secret before enabling the payment hold', () => {
    expect(isKountEnabled({ clientId: 'c', apiKey: 'k' })).toBe(false)
    expect(isKountEnabled({ clientId: 'c', apiKey: 'k', stripeWebhookSecret: 'whsec' })).toBe(true)
  })
})
