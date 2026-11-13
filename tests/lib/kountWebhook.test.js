import { describe, it, expect, beforeAll } from 'vitest'
import {
  verifyKountSignature,
  parseEventTimestamp,
  isTimestampFresh,
  parseKountWebhookEvent,
  publicKeyToDer,
} from '../../src/lib/kountWebhook.js'

function toBase64(buffer) {
  return Buffer.from(new Uint8Array(buffer)).toString('base64')
}

let keyPair
let publicKeyPem

beforeAll(async () => {
  keyPair = await crypto.subtle.generateKey(
    { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )
  const spki = await crypto.subtle.exportKey('spki', keyPair.publicKey)
  publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${toBase64(spki).match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----`
})

async function sign(timestamp, body) {
  const sig = await crypto.subtle.sign(
    { name: 'RSA-PSS', saltLength: 32 },
    keyPair.privateKey,
    new TextEncoder().encode(`${timestamp}${body}`),
  )
  return toBase64(sig)
}

describe('verifyKountSignature', () => {
  it('accepts a valid RSA-PSS signature over timestamp + body', async () => {
    const timestamp = new Date().toISOString()
    const rawBody = '{"eventType":"Order.StatusChange"}'
    const signature = await sign(timestamp, rawBody)
    await expect(verifyKountSignature({ publicKey: publicKeyPem, timestamp, rawBody, signature })).resolves.toBe(true)
  })

  it('accepts a bare base64 SPKI key', async () => {
    const timestamp = '1700000000'
    const rawBody = '{}'
    const signature = await sign(timestamp, rawBody)
    const bare = publicKeyPem.replace(/-----[A-Z ]+-----|\n/g, '')
    await expect(verifyKountSignature({ publicKey: bare, timestamp, rawBody, signature })).resolves.toBe(true)
  })

  it('rejects a tampered body, a different timestamp, and garbage signatures', async () => {
    const timestamp = new Date().toISOString()
    const signature = await sign(timestamp, '{"a":1}')
    await expect(verifyKountSignature({ publicKey: publicKeyPem, timestamp, rawBody: '{"a":2}', signature })).resolves.toBe(false)
    await expect(verifyKountSignature({ publicKey: publicKeyPem, timestamp: 'x', rawBody: '{"a":1}', signature })).resolves.toBe(false)
    await expect(verifyKountSignature({ publicKey: publicKeyPem, timestamp, rawBody: '{"a":1}', signature: '%%%' })).resolves.toBe(false)
    await expect(verifyKountSignature({ publicKey: publicKeyPem, timestamp, rawBody: '{"a":1}', signature: '' })).resolves.toBe(false)
  })

  it('throws on a missing key', () => {
    expect(() => publicKeyToDer('')).toThrow(/not configured/)
  })
})

describe('timestamps', () => {
  it('parses ISO, epoch seconds, and epoch milliseconds', () => {
    expect(parseEventTimestamp('2026-11-13T00:00:00Z')).toBe(Date.parse('2026-11-13T00:00:00Z'))
    expect(parseEventTimestamp('1700000000')).toBe(1700000000000)
    expect(parseEventTimestamp('1700000000123')).toBe(1700000000123)
    expect(parseEventTimestamp('nope')).toBeNull()
    expect(parseEventTimestamp(undefined)).toBeNull()
  })

  it('enforces the 45-minute window', () => {
    const now = Date.now()
    expect(isTimestampFresh(now - 44 * 60 * 1000, now)).toBe(true)
    expect(isTimestampFresh(now - 46 * 60 * 1000, now)).toBe(false)
    expect(isTimestampFresh(null, now)).toBe(false)
  })
})

describe('parseKountWebhookEvent', () => {
  it('reads the k360pf status-change sample shape', () => {
    expect(parseKountWebhookEvent({
      eventType: 'Order.StatusChange', fieldName: 'status', kountOrderId: 'K1', merchantOrderId: 'cs_1', newValue: 'APPROVE',
    })).toEqual({ eventType: 'Order.StatusChange', kountOrderId: 'K1', merchantOrderId: 'cs_1', decision: 'APPROVE' })
  })

  it('normalizes DECLINED and reads data-nested payloads', () => {
    const event = parseKountWebhookEvent({ eventType: 'Order.Update', data: { orderId: 'K2', fieldName: 'status', newValue: 'DECLINED' } })
    expect(event.decision).toBe('DECLINE')
    expect(event.kountOrderId).toBe('K2')
  })

  it('ignores non-decision field changes', () => {
    expect(parseKountWebhookEvent({ fieldName: 'notes', newValue: 'APPROVE' }).decision).toBeNull()
  })
})
