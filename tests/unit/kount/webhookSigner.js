// Test helper: an RSA-PSS key pair that signs Kount-style webhook deliveries
// (signature over X-Event-Timestamp + raw body, SHA-256, 32-byte salt).

function toBase64(buffer) {
  return Buffer.from(new Uint8Array(buffer)).toString('base64')
}

export async function createSigner() {
  const { publicKey, privateKey } = await crypto.subtle.generateKey(
    { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )
  const publicKeyBase64 = toBase64(await crypto.subtle.exportKey('spki', publicKey))
  const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${publicKeyBase64.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----`

  async function sign(timestamp, body) {
    const message = new TextEncoder().encode(`${timestamp}${body}`)
    return toBase64(await crypto.subtle.sign({ name: 'RSA-PSS', saltLength: 32 }, privateKey, message))
  }

  return { publicKeyBase64, publicKeyPem, sign }
}

// Sample event from Kount's webhook documentation / k360pf reference.
export const SAMPLE_EVENT = {
  id: 'f276e154-23ef-4366-933b-e1f12e159901',
  eventType: 'Order.StatusChange',
  apiVersion: 'v1',
  clientId: '900900',
  kountOrderId: '8V6CFF359HS5QQ6G',
  merchantOrderId: 'qjlm9gvol6olejcs',
  orderCreationDate: '2022-05-24T23:13:02Z',
  eventDate: '2022-05-24T23:18:00Z',
  fieldName: 'status',
  oldValue: 'REVIEW',
  newValue: 'DECLINE',
}
