import { describe, it, expect, beforeAll } from 'vitest'
import {
  verifyKountSignature,
  parseReviewResolution,
  parseEventTimestamp,
} from '../../../src/services/KountWebhookService.js'

function toPem(buf) {
  const b64 = Buffer.from(buf).toString('base64').match(/.{1,64}/g).join('\n')
  return `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----`
}

describe('verifyKountSignature', () => {
  let keyPair, publicKey
  const now = Date.parse('2026-11-17T12:00:00Z')
  const timestamp = '2026-11-17T11:59:00Z'
  const rawBody = JSON.stringify({ eventType: 'Order.StatusChange', merchantOrderId: 'cs_1', newValue: 'APPROVE' })

  async function sign(ts, body, saltLength = 32) {
    const sig = await crypto.subtle.sign({ name: 'RSA-PSS', saltLength }, keyPair.privateKey, new TextEncoder().encode(`${ts}${body}`))
    return Buffer.from(sig).toString('base64')
  }

  beforeAll(async () => {
    keyPair = await crypto.subtle.generateKey(
      { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )
    publicKey = toPem(await crypto.subtle.exportKey('spki', keyPair.publicKey))
  })

  it('accepts a valid signature over timestamp + body', async () => {
    const signature = await sign(timestamp, rawBody)
    expect(await verifyKountSignature({ publicKey, signature, timestamp, rawBody, now })).toEqual({ ok: true })
  })

  it('rejects a tampered body', async () => {
    const signature = await sign(timestamp, rawBody)
    expect(await verifyKountSignature({ publicKey, signature, timestamp, rawBody: rawBody.replace('APPROVE', 'DECLINE'), now }))
      .toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('rejects a timestamp outside the 45-minute window', async () => {
    const old = '2026-11-17T11:00:00Z'
    const signature = await sign(old, rawBody)
    expect(await verifyKountSignature({ publicKey, signature, timestamp: old, rawBody, now }))
      .toEqual({ ok: false, reason: 'stale_timestamp' })
  })

  it('reports missing configuration and headers', async () => {
    expect((await verifyKountSignature({ publicKey: '', signature: 'x', timestamp, rawBody, now })).reason).toBe('not_configured')
    expect((await verifyKountSignature({ publicKey, signature: '', timestamp, rawBody, now })).reason).toBe('missing_headers')
  })
})

describe('parseReviewResolution', () => {
  it('extracts a reviewer decision', () => {
    expect(parseReviewResolution({ eventType: 'Order.StatusChange', fieldName: 'status', kountOrderId: 'K1', merchantOrderId: 'cs_1', newValue: 'DECLINED' }))
      .toEqual({ merchantOrderId: 'cs_1', kountOrderId: 'K1', decision: 'DECLINE' })
  })

  it('ignores non-decision values, other events and foreign order IDs', () => {
    expect(parseReviewResolution({ eventType: 'Order.StatusChange', merchantOrderId: 'cs_1', newValue: 'REVIEW' })).toBeNull()
    expect(parseReviewResolution({ eventType: 'Order.NoteAdded', merchantOrderId: 'cs_1', newValue: 'APPROVE' })).toBeNull()
    expect(parseReviewResolution({ eventType: 'Order.StatusChange', merchantOrderId: 'other', newValue: 'APPROVE' })).toBeNull()
  })

  it('parses RFC 3339 and epoch timestamps', () => {
    expect(parseEventTimestamp('1700000000')).toBe(1700000000000)
    expect(parseEventTimestamp('2026-11-17T12:00:00Z')).toBe(Date.parse('2026-11-17T12:00:00Z'))
    expect(parseEventTimestamp('')).toBeNaN()
  })
})
