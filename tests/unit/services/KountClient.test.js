// KountClient: token cache, bounded retries (p-retry), Retry-After, 401 refresh.
// All transport is mocked; no network.
import { describe, it, expect, beforeEach } from 'vitest'
import { KountClient, KountApiError, clearKountTokenCache, parseRetryAfter } from '../../../src/services/KountClient.js'
import { parseKountConfig } from '../../../src/config/kount.js'

function cfg(overrides = {}) {
  return {
    ...parseKountConfig({ KOUNT_CLIENT_ID: 'client-1', KOUNT_API_KEY: 'apikey' }),
    ...overrides,
  }
}

function json(status, body, headers = {}) {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

const TOKEN_URL = 'https://login-uat.equifax.com/as/token'

/** Scripted fetch: token endpoint always OK unless overridden; API follows `script`. */
function scriptedFetch(script, { tokenResponses } = {}) {
  const calls = { token: 0, api: 0, apiRequests: [] }
  const tokens = tokenResponses ? [...tokenResponses] : null
  const fetchImpl = async (url, init) => {
    if (url === TOKEN_URL) {
      calls.token += 1
      if (tokens) {
        const next = tokens.shift()
        if (next instanceof Error) throw next
        return next
      }
      return json(200, { access_token: `tok-${calls.token}`, expires_in: 600 })
    }
    calls.api += 1
    calls.apiRequests.push({ url, init })
    const step = script.shift()
    if (step instanceof Error) throw step
    return typeof step === 'function' ? step() : step
  }
  return { fetchImpl, calls }
}

const fast = { minTimeout: 1, maxTimeout: 2 }

describe('KountClient', () => {
  beforeEach(() => clearKountTokenCache())

  it('uses the Sandbox token endpoint with Basic API key and client_credentials scope', async () => {
    let tokenInit
    const fetchImpl = async (url, init) => {
      if (url === TOKEN_URL) {
        tokenInit = init
        return json(200, { access_token: 't', expires_in: 600 })
      }
      return json(200, { order: { orderId: 'K1' } })
    }
    await new KountClient(cfg(), { fetchImpl, ...fast }).request({ method: 'POST', path: '/commerce/v2/orders', body: {}, operation: 'evaluate_order' })
    expect(tokenInit.headers.Authorization).toBe('Basic apikey')
    expect(tokenInit.body).toContain('grant_type=client_credentials')
    expect(tokenInit.body).toContain('scope=k1_integration_api')
  })

  it('reuses the cached token across operations', async () => {
    const { fetchImpl, calls } = scriptedFetch([json(200, {}), json(200, {})])
    const client = new KountClient(cfg(), { fetchImpl, ...fast })
    await client.request({ method: 'PATCH', path: '/x', body: {}, operation: 'update_order' })
    await client.request({ method: 'PATCH', path: '/x', body: {}, operation: 'update_order' })
    expect(calls.token).toBe(1)
    expect(calls.api).toBe(2)
  })

  it('maxRetries=0 makes exactly one attempt', async () => {
    const { fetchImpl, calls } = scriptedFetch([json(503, {}), json(200, {})])
    const client = new KountClient(cfg({ maxRetries: 0 }), { fetchImpl, ...fast })
    await expect(client.request({ method: 'PATCH', path: '/x', body: {}, operation: 'update_order' }))
      .rejects.toMatchObject({ status: 503, attempts: 1 })
    expect(calls.api).toBe(1)
  })

  it('maxRetries=3 makes up to four attempts and then reports exhaustion', async () => {
    const { fetchImpl, calls } = scriptedFetch([json(500, {}), json(502, {}), json(503, {}), json(504, {})])
    const client = new KountClient(cfg({ maxRetries: 3 }), { fetchImpl, ...fast })
    await expect(client.request({ method: 'PATCH', path: '/x', body: {}, operation: 'update_order' }))
      .rejects.toMatchObject({ status: 504, attempts: 4 })
    expect(calls.api).toBe(4)
  })

  it('recovers from a transient failure', async () => {
    const { fetchImpl, calls } = scriptedFetch([new TypeError('fetch failed'), json(429, {}), json(200, { ok: 1 })])
    const client = new KountClient(cfg({ maxRetries: 2 }), { fetchImpl, ...fast })
    const res = await client.request({ method: 'GET', path: '/x', operation: 'get_order' })
    expect(res.body).toEqual({ ok: 1 })
    expect(res.attempts).toBe(3)
    expect(calls.api).toBe(3)
  })

  it('does not retry permanent 4xx errors', async () => {
    const { fetchImpl, calls } = scriptedFetch([json(400, { error: { message: 'bad' } }), json(200, {})])
    const client = new KountClient(cfg({ maxRetries: 3 }), { fetchImpl, ...fast })
    const err = await client.request({ method: 'POST', path: '/x', body: {}, operation: 'evaluate_order' }).catch((e) => e)
    expect(err).toBeInstanceOf(KountApiError)
    expect(err.status).toBe(400)
    expect(calls.api).toBe(1)
    // Error message never echoes the response body.
    expect(err.message).not.toContain('bad')
  })

  it('invalidates the token and refreshes on Commerce 401 within the same budget', async () => {
    const { fetchImpl, calls } = scriptedFetch([json(401, {}), json(200, { ok: true })])
    const client = new KountClient(cfg({ maxRetries: 1 }), { fetchImpl, ...fast })
    const res = await client.request({ method: 'PATCH', path: '/x', body: {}, operation: 'update_order' })
    expect(res.body).toEqual({ ok: true })
    expect(calls.token).toBe(2)
    const auths = calls.apiRequests.map((r) => r.init.headers.Authorization)
    expect(auths).toEqual(['Bearer tok-1', 'Bearer tok-2'])
  })

  it('does not retry invalid token credentials', async () => {
    const { fetchImpl, calls } = scriptedFetch([], { tokenResponses: [json(401, {}), json(401, {}), json(401, {})] })
    const client = new KountClient(cfg({ maxRetries: 3 }), { fetchImpl, ...fast })
    await expect(client.request({ method: 'PATCH', path: '/x', body: {}, operation: 'update_order' }))
      .rejects.toMatchObject({ operation: 'token', status: 401 })
    expect(calls.token).toBe(1)
    expect(calls.api).toBe(0)
  })

  it('honors Retry-After before the next attempt', async () => {
    const { fetchImpl } = scriptedFetch([json(429, {}, { 'retry-after': '0' }), json(200, {})])
    const started = Date.now()
    const client = new KountClient(cfg(), { fetchImpl, ...fast })
    await client.request({ method: 'PATCH', path: '/x', body: {}, operation: 'update_order' })
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('stops instead of retrying early when Retry-After exceeds the deadline', async () => {
    const { fetchImpl, calls } = scriptedFetch([json(429, {}, { 'retry-after': '120' }), json(200, {})])
    const client = new KountClient(cfg({ maxRetries: 3 }), { fetchImpl, ...fast })
    await expect(client.request({ method: 'PATCH', path: '/x', body: {}, operation: 'update_order' }))
      .rejects.toMatchObject({ status: 429 })
    expect(calls.api).toBe(1)
  })

  it('respects the total operation deadline', async () => {
    let t = 0
    const now = () => t
    const fetchImpl = async (url) => {
      if (url === TOKEN_URL) return json(200, { access_token: 'x', expires_in: 600 })
      t += 5000 // each attempt consumes 5s of a 9s budget
      return json(503, {})
    }
    const client = new KountClient(cfg({ maxRetries: 3 }), { fetchImpl, now, ...fast })
    const err = await client.request({ method: 'PATCH', path: '/x', body: {}, operation: 'update_order' }).catch((e) => e)
    expect(err).toBeInstanceOf(KountApiError)
    expect(err.attempts).toBeLessThanOrEqual(3)
  })

  it('flags a POST that timed out after send as a possible duplicate', async () => {
    const { fetchImpl } = scriptedFetch([new TypeError('network'), json(200, { order: {} })])
    const client = new KountClient(cfg(), { fetchImpl, ...fast })
    const res = await client.request({ method: 'POST', path: '/x', body: {}, operation: 'evaluate_order' })
    expect(res.possibleDuplicate).toBe(true)
  })

  it('parses Retry-After seconds and HTTP dates', () => {
    expect(parseRetryAfter('3', 0)).toBe(3000)
    expect(parseRetryAfter(new Date(10000).toUTCString(), 0)).toBe(10000)
    expect(parseRetryAfter('garbage', 0)).toBeNull()
  })
})
