// Kount webhook verification fixtures: RSA-PSS/SHA-256 salt 32 over
// timestamp + original body bytes, freshness boundaries, exact ping match.
import { describe, it, expect, beforeAll } from 'vitest'
import {
  verifyKountSignature,
  checkFreshness,
  isExactTestPing,
  publicKeyFingerprint,
} from '../../../src/lib/kountWebhook.js'

const freshness = { maxAgeMs: 45 * 60 * 1000, maxFutureSkewMs: 5 * 60 * 1000 }

async function keyPair() {
  return crypto.subtle.generateKey(
    { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )
}

async function toPem(publicKey) {
  const der = new Uint8Array(await crypto.subtle.exportKey('spki', publicKey))
  const b64 = btoa(String.fromCharCode(...der))
  return `-----BEGIN PUBLIC KEY-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----`
}

async function sign(privateKey, timestamp, bodyBytes) {
  const ts = new TextEncoder().encode(timestamp)
  const msg = new Uint8Array(ts.length + bodyBytes.length)
  msg.set(ts)
  msg.set(bodyBytes, ts.length)
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'RSA-PSS', saltLength: 32 }, privateKey, msg))
  return btoa(String.fromCharCode(...sig))
}

describe('verifyKountSignature', () => {
  let pair
  let otherPair
  let pem
  const now = Date.parse('2026-11-20T12:00:00Z')
  const timestamp = '2026-11-20T11:59:00Z'
  const body = new TextEncoder().encode('{"eventType":"Order.StatusChange","kountOrderId":"K1","newValue":"APPROVE"}')

  beforeAll(async () => {
    pair = await keyPair()
    otherPair = await keyPair()
    pem = await toPem(pair.publicKey)
  })

  it('verifies the correct key over the original bytes', async () => {
    const signature = await sign(pair.privateKey, timestamp, body)
    const res = await verifyKountSignature({ rawBody: body, signature, timestamp, publicKeyPem: pem, nowMs: now, freshness })
    expect(res).toMatchObject({ ok: true, reason: 'verified' })
  })

  it('reports cryptographic mismatch for a different key of the same size', async () => {
    const signature = await sign(otherPair.privateKey, timestamp, body)
    const res = await verifyKountSignature({ rawBody: body, signature, timestamp, publicKeyPem: pem, nowMs: now, freshness })
    expect(res.reason).toBe('signature_mismatch')
  })

  it('rejects altered body bytes', async () => {
    const signature = await sign(pair.privateKey, timestamp, body)
    const altered = new TextEncoder().encode('{"eventType":"Order.StatusChange","kountOrderId":"K1","newValue":"DECLINE"}')
    const res = await verifyKountSignature({ rawBody: altered, signature, timestamp, publicKeyPem: pem, nowMs: now, freshness })
    expect(res.reason).toBe('signature_mismatch')
  })

  it('reports a malformed PEM as a key parse failure', async () => {
    const signature = await sign(pair.privateKey, timestamp, body)
    const res = await verifyKountSignature({ rawBody: body, signature, timestamp, publicKeyPem: '-----BEGIN PUBLIC KEY-----\nnot*base64\n-----END PUBLIC KEY-----', nowMs: now, freshness })
    expect(res.reason).toBe('key_parse_failure')
  })

  it('reports invalid signature encoding', async () => {
    const res = await verifyKountSignature({ rawBody: body, signature: '%%%not-base64%%%', timestamp, publicKeyPem: pem, nowMs: now, freshness })
    expect(res.reason).toBe('signature_decode_failure')
  })

  it('distinguishes missing headers and unconfigured key', async () => {
    expect((await verifyKountSignature({ rawBody: body, signature: null, timestamp, publicKeyPem: pem, nowMs: now, freshness })).reason).toBe('missing_signature_header')
    expect((await verifyKountSignature({ rawBody: body, signature: 'x', timestamp: null, publicKeyPem: pem, nowMs: now, freshness })).reason).toBe('missing_timestamp_header')
    expect((await verifyKountSignature({ rawBody: body, signature: 'x', timestamp, publicKeyPem: undefined, nowMs: now, freshness })).reason).toBe('not_configured')
  })

  it('reports a correctly signed but old delivery as expired, not a signature failure', async () => {
    const old = '2026-11-20T10:00:00Z'
    const signature = await sign(pair.privateKey, old, body)
    const res = await verifyKountSignature({ rawBody: body, signature, timestamp: old, publicKeyPem: pem, nowMs: now, freshness })
    expect(res.reason).toBe('expired')
  })

  it('computes a stable key fingerprint and null for junk', async () => {
    const fp = await publicKeyFingerprint(pem)
    expect(fp).toMatch(/^[0-9a-f]{16}$/)
    expect(await publicKeyFingerprint(pem.replace(/\n/g, ' '))).toBe(fp)
    expect(await publicKeyFingerprint('junk')).toBeNull()
  })
})

describe('checkFreshness boundaries', () => {
  const now = 1000000000
  it('accepts age exactly at the past boundary', () => {
    expect(checkFreshness(now - freshness.maxAgeMs, now, freshness).ok).toBe(true)
  })
  it('expires one millisecond beyond the past boundary', () => {
    expect(checkFreshness(now - freshness.maxAgeMs - 1, now, freshness).reason).toBe('expired')
  })
  it('accepts exactly at the future skew boundary', () => {
    expect(checkFreshness(now + freshness.maxFutureSkewMs, now, freshness).ok).toBe(true)
  })
  it('rejects beyond the future skew boundary', () => {
    expect(checkFreshness(now + freshness.maxFutureSkewMs + 1, now, freshness).reason).toBe('future_timestamp_rejected')
  })
})

describe('isExactTestPing', () => {
  it('matches only the exact allowlisted event type', () => {
    expect(isExactTestPing({ eventType: 'Webhook.TestPing' })).toBe(true)
    expect(isExactTestPing({ eventType: 'Order.TestPingInjected' })).toBe(false)
    expect(isExactTestPing({ eventType: 'Order.StatusChange' })).toBe(false)
    expect(isExactTestPing({ eventType: 'webhook.testping' })).toBe(false)
  })
  it('refuses a "ping" that names an order', () => {
    expect(isExactTestPing({ eventType: 'Webhook.TestPing', kountOrderId: 'K1' })).toBe(false)
  })
})
