// KountClient: token lifecycle, retry policy (p-retry) and evaluation fallback,
// exercised against a mocked transport.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { KountClient, clearKountTokenCache } from '../../../src/services/KountClient.js'
import { buildKountConfig } from '../../../src/config/kount.js'

const TOKEN_URL = 'https://login-uat.equifax.com/as/token'

function json(body, status = 200, headers = {}) {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function tokenResponse(token = 'tok-1', expiresIn = 1200) {
  return json({ access_token: token, expires_in: expiresIn, token_type: 'Bearer' })
}

const REVIEW_BODY = { order: { orderId: 'K1', riskInquiry: { decision: 'REVIEW' }, transactions: [{ transactionId: 'K1#0' }] } }
const APPROVE_BODY = { order: { orderId: 'K2', riskInquiry: { decision: 'APPROVE' } } }

/**
 * Transport mock: token requests always succeed unless overridden; order
 * requests consume `responses` in order (a function may throw to simulate a
 * network failure).
 */
function makeTransport(responses, { token } = {}) {
  const calls = []
  const queue = [...responses]
  const fetchImpl = vi.fn(async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url) === TOKEN_URL) {
      return token ? token(calls.filter((c) => c.url === TOKEN_URL).length) : tokenResponse()
    }
    const next = queue.shift()
    if (!next) throw new Error('unexpected request')
    return typeof next === 'function' ? next(init) : next
  })
  return { fetchImpl, calls, orderCalls: () => calls.filter((c) => c.url !== TOKEN_URL), tokenCalls: () => calls.filter((c) => c.url === TOKEN_URL) }
}

function makeClient(transport, overrides = {}, deps = {}) {
  const config = buildKountConfig({ KOUNT_CLIENT_ID: 'client', KOUNT_API_KEY: 'portal-key', ...overrides })
  const sleep = vi.fn(async () => {})
  const client = new KountClient(config, { fetchImpl: transport.fetchImpl, minBackoffMs: 1, maxBackoffMs: 2, sleep, ...deps })
  return { client, sleep }
}

beforeEach(() => {
  clearKountTokenCache()
})

describe('token lifecycle', () => {
  it('requests a client_credentials token with the raw portal key after Basic', async () => {
    const t = makeTransport([json(APPROVE_BODY)])
    const { client } = makeClient(t)
    await client.evaluateOrder({ merchantOrderId: 'o' })
    const tokenCall = t.tokenCalls()[0]
    expect(tokenCall.init.headers.Authorization).toBe('Basic portal-key')
    expect(tokenCall.init.body).toBe('grant_type=client_credentials&scope=k1_integration_api')
    expect(t.orderCalls()[0].init.headers.Authorization).toBe('Bearer tok-1')
    expect(t.orderCalls()[0].url).toBe('https://api-sandbox.kount.com/commerce/v2/orders?riskInquiry=true')
  })

  it('reuses a cached token until shortly before expiry', async () => {
    const t = makeTransport([json(APPROVE_BODY), json(APPROVE_BODY)])
    const { client } = makeClient(t)
    await client.evaluateOrder({})
    await client.evaluateOrder({})
    expect(t.tokenCalls()).toHaveLength(1)
  })

  it('refreshes early when the cached token is about to expire', async () => {
    const t = makeTransport([json(APPROVE_BODY), json(APPROVE_BODY)], { token: (n) => tokenResponse(`tok-${n}`, 30) })
    const { client } = makeClient(t)
    await client.evaluateOrder({})
    await client.evaluateOrder({})
    expect(t.tokenCalls()).toHaveLength(2)
    expect(t.orderCalls()[1].init.headers.Authorization).toBe('Bearer tok-2')
  })

  it('coalesces concurrent token refreshes', async () => {
    const t = makeTransport([json(APPROVE_BODY), json(APPROVE_BODY), json(APPROVE_BODY)])
    const { client } = makeClient(t)
    await Promise.all([client.evaluateOrder({}), client.evaluateOrder({}), client.evaluateOrder({})])
    expect(t.tokenCalls()).toHaveLength(1)
  })

  it('on Commerce 401 invalidates the token and refreshes within the same budget', async () => {
    const t = makeTransport([json({ error: { code: 401 } }, 401), json(APPROVE_BODY)], { token: (n) => tokenResponse(`tok-${n}`) })
    const { client } = makeClient(t, { KOUNT_MAX_RETRIES: '2' })
    const res = await client.evaluateOrder({})
    expect(res.attempts).toBe(2)
    expect(t.tokenCalls()).toHaveLength(2)
    expect(t.orderCalls()[1].init.headers.Authorization).toBe('Bearer tok-2')
  })

  it('does not repeatedly retry rejected token credentials', async () => {
    const t = makeTransport([], { token: () => json({ error: 'invalid_client' }, 401) })
    const { client } = makeClient(t, { KOUNT_MAX_RETRIES: '3' })
    await expect(client.evaluateOrder({})).rejects.toMatchObject({ kind: 'token_rejected', attempts: 1 })
    expect(t.tokenCalls()).toHaveLength(1)
  })
})

describe('retry policy', () => {
  it('KOUNT_MAX_RETRIES=0 makes exactly one attempt', async () => {
    const t = makeTransport([json({}, 503)])
    const { client } = makeClient(t, { KOUNT_MAX_RETRIES: '0' })
    await expect(client.evaluateOrder({})).rejects.toMatchObject({ kind: 'transient_http', status: 503, attempts: 1 })
    expect(t.orderCalls()).toHaveLength(1)
  })

  it('KOUNT_MAX_RETRIES=3 makes four attempts before exhaustion', async () => {
    const t = makeTransport([json({}, 500), json({}, 502), json({}, 503), json({}, 504)])
    const { client } = makeClient(t, { KOUNT_MAX_RETRIES: '3' })
    await expect(client.evaluateOrder({})).rejects.toMatchObject({ status: 504, attempts: 4 })
    expect(t.orderCalls()).toHaveLength(4)
  })

  it('recovers from transient failures (network, 408, 429)', async () => {
    const t = makeTransport([
      () => { throw new TypeError('fetch failed') },
      json({}, 408),
      json({}, 429),
      json(REVIEW_BODY),
    ])
    const { client } = makeClient(t, { KOUNT_MAX_RETRIES: '3' })
    const res = await client.evaluateOrder({})
    expect(res.attempts).toBe(4)
    expect(res.body.order.riskInquiry.decision).toBe('REVIEW')
  })

  it('does not retry permanent 4xx rejections', async () => {
    const t = makeTransport([json({ error: { code: 400, message: 'bad' } }, 400, { 'x-correlation-id': 'corr-1' })])
    const { client } = makeClient(t, { KOUNT_MAX_RETRIES: '3' })
    await expect(client.evaluateOrder({})).rejects.toMatchObject({ kind: 'rejected', status: 400, attempts: 1, correlationId: 'corr-1' })
  })

  it('uses randomized exponential backoff (jitter)', async () => {
    const random = vi.spyOn(Math, 'random')
    const t = makeTransport([json({}, 500), json({}, 500), json(APPROVE_BODY)])
    const { client } = makeClient(t, { KOUNT_MAX_RETRIES: '2' })
    await client.evaluateOrder({})
    expect(random).toHaveBeenCalled()
    random.mockRestore()
  })

  it('honours Retry-After by waiting at least that long', async () => {
    const t = makeTransport([json({}, 429, { 'retry-after': '2' }), json(APPROVE_BODY)])
    const { client, sleep } = makeClient(t, { KOUNT_MAX_RETRIES: '1' })
    await client.evaluateOrder({})
    const waited = sleep.mock.calls.reduce((sum, [ms]) => sum + ms, 0)
    expect(waited).toBeGreaterThanOrEqual(2000 - 2) // minus the backoff p-retry already applies
  })

  it('stops instead of retrying early when Retry-After exceeds the deadline', async () => {
    const t = makeTransport([json({}, 503, { 'retry-after': '60' }), json(APPROVE_BODY)])
    const { client, sleep } = makeClient(t, { KOUNT_MAX_RETRIES: '3' })
    await expect(client.evaluateOrder({})).rejects.toMatchObject({ kind: 'retry_after_exceeds_deadline', attempts: 1 })
    expect(sleep).not.toHaveBeenCalled()
    expect(t.orderCalls()).toHaveLength(1)
  })

  it('enforces the total operation deadline including token time', async () => {
    let clock = 0
    const t = makeTransport([
      () => { clock += 600; return json({}, 503) },
      () => { clock += 600; return json({}, 503) },
      json(APPROVE_BODY),
    ])
    const { client } = makeClient(t, { KOUNT_MAX_RETRIES: '3' }, { now: () => clock, deadlineMs: 1000 })
    await expect(client.evaluateOrder({})).rejects.toBeDefined()
    expect(t.orderCalls().length).toBeLessThan(3)
  })

  it('times out a hung attempt and flags a possibly duplicated POST on replay', async () => {
    const hang = (init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))
    const t = makeTransport([hang, json(APPROVE_BODY)])
    const { client } = makeClient(t, { KOUNT_MAX_RETRIES: '1' }, { attemptTimeoutMs: 5 })
    const res = await client.evaluateOrder({})
    expect(res.attempts).toBe(2)
    expect(res.possibleDuplicate).toBe(true)
  })

  it('applies the same policy to Update Order (PATCH)', async () => {
    const t = makeTransport([json({}, 502), json({ order: { orderId: 'K1' } })])
    const { client } = makeClient(t, { KOUNT_MAX_RETRIES: '1' })
    const res = await client.updateOrder('K1', { transactions: [] })
    expect(res.attempts).toBe(2)
    expect(t.orderCalls()[0].init.method).toBe('PATCH')
    expect(t.orderCalls()[0].url).toBe('https://api-sandbox.kount.com/commerce/v2/orders/K1')
  })
})

describe('evaluateWithFallback', () => {
  it('returns a Kount decision with provenance', async () => {
    const t = makeTransport([json(REVIEW_BODY, 200, { 'x-correlation-id': 'c-1' })])
    const { client } = makeClient(t)
    const result = await client.evaluateWithFallback({})
    expect(result).toEqual(expect.objectContaining({ decision: 'REVIEW', decisionSource: 'kount', kountOrderId: 'K1', kountTransactionId: 'K1#0', correlationId: 'c-1', attempts: 1 }))
    expect(result).not.toHaveProperty('fallbackReason')
  })

  it('REVIEW is a valid decision and never triggers fallback', async () => {
    const t = makeTransport([json(REVIEW_BODY)])
    const { client } = makeClient(t, { KOUNT_FALLBACK_DECISION: 'DECLINE' })
    expect((await client.evaluateWithFallback({})).decision).toBe('REVIEW')
  })

  it('applies APPROVE fallback after retries are exhausted', async () => {
    const t = makeTransport([json({}, 500), json({}, 500), json({}, 500)])
    const { client } = makeClient(t, { KOUNT_MAX_RETRIES: '2' })
    const result = await client.evaluateWithFallback({})
    expect(result).toEqual(expect.objectContaining({ decision: 'APPROVE', decisionSource: 'fallback', fallbackReason: 'transient_http', attempts: 3 }))
  })

  it('applies DECLINE fallback on permanent rejection without retrying', async () => {
    const t = makeTransport([json({}, 400)])
    const { client } = makeClient(t, { KOUNT_MAX_RETRIES: '3', KOUNT_FALLBACK_DECISION: 'DECLINE' })
    const result = await client.evaluateWithFallback({})
    expect(result).toEqual(expect.objectContaining({ decision: 'DECLINE', decisionSource: 'fallback', fallbackReason: 'rejected', attempts: 1 }))
  })

  it('applies fallback for missing, unknown and malformed decisions without retrying', async () => {
    for (const [body, reason] of [
      [{ order: { orderId: 'K' } }, 'missing_decision'],
      [{ order: { orderId: 'K', riskInquiry: { decision: 'DECLINED' } } }, 'unknown_decision'],
    ]) {
      clearKountTokenCache()
      const t = makeTransport([json(body)])
      const { client } = makeClient(t, { KOUNT_MAX_RETRIES: '3' })
      const result = await client.evaluateWithFallback({})
      expect(result).toEqual(expect.objectContaining({ decisionSource: 'fallback', fallbackReason: reason, attempts: 1 }))
      expect(t.orderCalls()).toHaveLength(1)
    }

    const t = makeTransport([new Response('not json', { status: 200 })])
    const { client } = makeClient(t)
    expect((await client.evaluateWithFallback({})).fallbackReason).toBe('malformed_response')
  })
})

describe('fetchWebhookPublicKey', () => {
  const KEY = 'MII' + 'A'.repeat(300)
  const ensUrl = 'https://app-sandbox.kount.com/api/developer/ens/client/client/public-key'
  const run = async (response) => {
    clearKountTokenCache()
    const t = makeTransport([response])
    const { client } = makeClient(t)
    const result = await client.fetchWebhookPublicKey().catch((e) => e)
    return { result, url: t.orderCalls()[0]?.url }
  }

  it('reads the reference shape { publicKey, validUntil } from the Sandbox ENS URL', async () => {
    const { result, url } = await run(json({ publicKey: KEY, validUntil: '2027-01-01T00:00:00Z' }))
    expect(url).toBe(ensUrl)
    expect(result).toEqual(expect.objectContaining({ publicKeys: [KEY], validUntil: '2027-01-01T00:00:00Z' }))
  })

  it('reads other likely shapes', async () => {
    expect((await run(json({ data: { public_key: KEY } }))).result.publicKeys).toEqual([KEY])
    expect((await run(json({ keys: [{ key: KEY }, { key: KEY + 'B' }] }))).result.publicKeys).toHaveLength(2)
    expect((await run(json([{ publicKey: KEY }]))).result.publicKeys).toEqual([KEY])
    expect((await run(new Response(`-----BEGIN PUBLIC KEY-----\n${KEY}\n-----END PUBLIC KEY-----`, { status: 200, headers: { 'content-type': 'text/plain' } }))).result.publicKeys).toHaveLength(1)
  })

  it('describes an unrecognised shape without exposing values', async () => {
    const { result } = await run(json({ status: 'ok', certificate: { pem: 1 }, id: 7 }))
    expect(result.kind).toBe('malformed')
    expect(result.shape).toBe('json {status:string, certificate:object, id:number}')
  })
})
