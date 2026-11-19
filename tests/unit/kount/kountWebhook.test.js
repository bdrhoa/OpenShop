// Kount webhook signature verification and event parsing, with a locally
// generated RSA-PSS key pair standing in for the Kount portal key.
import { describe, it, expect, beforeAll } from 'vitest'
import {
  KountWebhookError,
  diagnoseKountSignature,
  keyFingerprint,
  isTestPing,
  normalizePublicKey,
  parseKountWebhookEvent,
  validatePublicKey,
  verifyKountWebhook,
} from '../../../src/lib/kountWebhook.js'
import { createSigner, SAMPLE_EVENT } from './webhookSigner.js'

let signer
let otherSigner
beforeAll(async () => {
  signer = await createSigner()
  otherSigner = await createSigner()
})

const NOW = Date.parse('2026-11-19T12:00:00Z')

async function verify(overrides = {}) {
  const timestamp = overrides.timestamp ?? '2026-11-19T11:59:00Z'
  const body = overrides.body ?? JSON.stringify(SAMPLE_EVENT)
  const signature = overrides.signature ?? await signer.sign(timestamp, body)
  return verifyKountWebhook({
    publicKey: overrides.publicKey ?? signer.publicKeyBase64,
    signature,
    timestamp,
    rawBody: new TextEncoder().encode(overrides.rawBody ?? body),
    now: overrides.now ?? NOW,
  })
}

async function expectError(promise, status, code) {
  await expect(promise).rejects.toBeInstanceOf(KountWebhookError)
  await expect(promise).rejects.toMatchObject({ status, code })
}

describe('verifyKountWebhook', () => {
  it('accepts a correctly signed, fresh delivery (timestamp + raw body, RSA-PSS 32-byte salt)', async () => {
    await expect(verify()).resolves.toBe(true)
  })

  it('accepts the key as PEM, including PEM pasted without line breaks', async () => {
    await expect(verify({ publicKey: signer.publicKeyPem })).resolves.toBe(true)
    await expect(verify({ publicKey: signer.publicKeyPem.replace(/\n/g, ' ') })).resolves.toBe(true)
  })

  it('rejects a tampered body', async () => {
    const body = JSON.stringify(SAMPLE_EVENT)
    await expectError(verify({ body, rawBody: body.replace('DECLINE', 'APPROVE') }), 401, 'invalid_signature')
  })

  it('rejects a signature that covers a different timestamp', async () => {
    const body = JSON.stringify(SAMPLE_EVENT)
    const signature = await signer.sign('2026-11-19T11:58:00Z', body)
    await expectError(verify({ body, signature, timestamp: '2026-11-19T11:59:00Z' }), 401, 'invalid_signature')
  })

  it('rejects a signature from a different key', async () => {
    const body = JSON.stringify(SAMPLE_EVENT)
    const signature = await otherSigner.sign('2026-11-19T11:59:00Z', body)
    await expectError(verify({ body, signature }), 401, 'invalid_signature')
  })

  it('enforces the 45-minute freshness window and a 5-minute future allowance', async () => {
    await expect(verify({ timestamp: '2026-11-19T11:16:00Z' })).resolves.toBe(true) // 44 min old
    await expectError(verify({ timestamp: '2026-11-19T11:14:00Z' }), 400, 'timestamp_too_old')
    await expectError(verify({ timestamp: '2026-11-19T12:06:00Z' }), 400, 'timestamp_too_new')
  })

  it('rejects missing headers, bad timestamps and empty bodies', async () => {
    await expectError(verifyKountWebhook({ publicKey: signer.publicKeyBase64, signature: 'x', timestamp: null, rawBody: new Uint8Array([1]) }), 400, 'missing_timestamp')
    await expectError(verifyKountWebhook({ publicKey: signer.publicKeyBase64, signature: null, timestamp: 't', rawBody: new Uint8Array([1]) }), 400, 'missing_signature')
    await expectError(verify({ timestamp: 'yesterday-ish' }), 400, 'invalid_timestamp')
    await expectError(verifyKountWebhook({ publicKey: signer.publicKeyBase64, signature: 'x', timestamp: 't', rawBody: new Uint8Array() }), 400, 'empty_body')
  })

  it('reports an unusable public key as a server error', async () => {
    await expectError(verify({ publicKey: 'MIIBnotakey' }), 500, 'bad_public_key')
  })
})

describe('diagnoseKountSignature', () => {
  const timestamp = '2026-11-19T19:39:09Z'
  const body = JSON.stringify(SAMPLE_EVENT)
  const raw = new TextEncoder().encode(body)

  it('reports the standard variant verifying with the right key', async () => {
    const d = await diagnoseKountSignature({ publicKey: signer.publicKeyBase64, signature: await signer.sign(timestamp, body), timestamp, rawBody: raw })
    expect(d.modulusBits).toBe(2048)
    expect(d.fingerprint).toBe(await keyFingerprint(signer.publicKeyPem))
    expect(d.verifies.pss32_timestampBody).toBe(true)
    expect(d.verifies.pss32_bodyOnly).toBe(false)
  })

  it('reports nothing verifying with the wrong key', async () => {
    const d = await diagnoseKountSignature({ publicKey: otherSigner.publicKeyBase64, signature: await signer.sign(timestamp, body), timestamp, rawBody: raw })
    expect(Object.values(d.verifies).some(Boolean)).toBe(false)
    expect(d.fingerprint).not.toBe(await keyFingerprint(signer.publicKeyBase64))
  })
})

describe('isTestPing', () => {
  it('recognises Kount portal test pings only', () => {
    expect(isTestPing({ eventType: 'Webhook.TestPing' })).toBe(true)
    expect(isTestPing({ eventType: 'webhook.testping' })).toBe(true)
    expect(isTestPing(SAMPLE_EVENT)).toBe(false)
    expect(isTestPing(null)).toBe(false)
  })
})

describe('validatePublicKey', () => {
  it('accepts base64 DER and PEM, rejects junk', () => {
    expect(validatePublicKey(signer.publicKeyBase64)).toBeNull()
    expect(validatePublicKey(signer.publicKeyPem)).toBeNull()
    expect(validatePublicKey('not a key!')).toMatch(/KOUNT_WEBHOOK_PUBLIC_KEY/)
    expect(validatePublicKey('aGVsbG8=')).toMatch(/DER/)
    expect(normalizePublicKey('-----BEGIN PUBLIC KEY-----\nAB CD\n-----END PUBLIC KEY-----')).toBe('ABCD')
  })
})

describe('parseKountWebhookEvent', () => {
  it('reads the Kount sample status-change event', () => {
    expect(parseKountWebhookEvent(SAMPLE_EVENT)).toEqual({
      eventId: 'f276e154-23ef-4366-933b-e1f12e159901',
      eventType: 'Order.StatusChange',
      kountOrderId: '8V6CFF359HS5QQ6G',
      merchantOrderId: 'qjlm9gvol6olejcs',
      oldValue: 'REVIEW',
      decision: 'DECLINE',
    })
  })

  it('only treats a status/decision change to APPROVE or DECLINE as actionable', () => {
    expect(parseKountWebhookEvent({ ...SAMPLE_EVENT, newValue: 'approve' }).decision).toBe('APPROVE')
    expect(parseKountWebhookEvent({ ...SAMPLE_EVENT, newValue: 'REVIEW' }).decision).toBeNull()
    expect(parseKountWebhookEvent({ ...SAMPLE_EVENT, fieldName: 'email', newValue: 'APPROVE' }).decision).toBeNull()
  })

  it('rejects non-object bodies', () => {
    expect(() => parseKountWebhookEvent([])).toThrow(KountWebhookError)
  })
})
