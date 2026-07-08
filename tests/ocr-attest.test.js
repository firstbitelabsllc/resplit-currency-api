import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyAssertion, AttestError } from '../worker/src/ocr/attest.mjs'

const APP_ID = 'QSL6XFT438.com.superfit.Resplit'

// --- tiny CBOR + DER encoders (test-side only) -------------------------------

function cborBytes(b) {
  const len = b.length
  let head
  if (len < 24) head = Uint8Array.of(0x40 | len)
  else if (len < 256) head = Uint8Array.of(0x58, len)
  else head = Uint8Array.of(0x59, (len >> 8) & 0xff, len & 0xff)
  return concat(head, b)
}
function cborText(s) {
  const b = new TextEncoder().encode(s)
  return concat(Uint8Array.of(0x60 | b.length), b)
}
function cborAssertion(signatureDer, authData) {
  // map(2) { "signature": bstr, "authenticatorData": bstr }
  return concat(
    Uint8Array.of(0xa2),
    cborText('signature'), cborBytes(signatureDer),
    cborText('authenticatorData'), cborBytes(authData),
  )
}
function concat(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const a of arrs) { out.set(a, off); off += a.length }
  return out
}
// raw r||s (64 bytes) -> DER SEQUENCE{ INTEGER r, INTEGER s }
function rawToDer(raw) {
  const enc = (b) => {
    let i = 0
    while (i < b.length - 1 && b[i] === 0) i++
    let v = b.subarray(i)
    if (v[0] & 0x80) v = concat(Uint8Array.of(0x00), v)
    return concat(Uint8Array.of(0x02, v.length), v)
  }
  const r = enc(raw.subarray(0, 32))
  const s = enc(raw.subarray(32, 64))
  const body = concat(r, s)
  return concat(Uint8Array.of(0x30, body.length), body)
}
const sha256 = async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b))
const bytesToB64 = (bytes) => {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

function makeKV() {
  const store = new Map()
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null },
    async put(k, v) { store.set(k, v) },
    async delete(k) { store.delete(k) },
  }
}

async function buildAuthData(signCount) {
  const rpIdHash = await sha256(new TextEncoder().encode(APP_ID))
  const ad = new Uint8Array(37)
  ad.set(rpIdHash, 0)
  ad[32] = 0x00
  new DataView(ad.buffer).setUint32(33, signCount)
  return ad
}

async function buildAssertion(privateKey, clientData, signCount) {
  const authData = await buildAuthData(signCount)
  const clientDataHash = await sha256(clientData)
  const signedData = concat(authData, clientDataHash)
  const rawSig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, signedData))
  const der = rawToDer(rawSig)
  return bytesToB64(cborAssertion(der, authData))
}

test('verifyAssertion accepts a genuine ES256 assertion and enforces monotonic counter', async () => {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey))
  const keyId = 'test-key-id'
  const kv = makeKV()
  await kv.put(`attest:${keyId}`, JSON.stringify({ publicKeyB64: bytesToB64(spki), signCount: 0 }))

  const clientData = new TextEncoder().encode('fake-image-bytes')

  // First valid assertion (signCount=1) passes.
  const a1 = await buildAssertion(keyPair.privateKey, clientData, 1)
  const r1 = await verifyAssertion({ keyId, assertionB64: a1, clientData, appId: APP_ID, kv })
  assert.equal(r1.ok, true)
  assert.equal(JSON.parse(kv.store.get(`attest:${keyId}`)).signCount, 1)

  // Replay at the same counter is rejected.
  const a1again = await buildAssertion(keyPair.privateKey, clientData, 1)
  await assert.rejects(
    () => verifyAssertion({ keyId, assertionB64: a1again, clientData, appId: APP_ID, kv }),
    (e) => e instanceof AttestError && e.code === 'REPLAY',
  )

  // Higher counter passes.
  const a2 = await buildAssertion(keyPair.privateKey, clientData, 2)
  const r2 = await verifyAssertion({ keyId, assertionB64: a2, clientData, appId: APP_ID, kv })
  assert.equal(r2.ok, true)
})

test('verifyAssertion rejects a signature from the wrong key', async () => {
  const realKey = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const attackerKey = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', realKey.publicKey))
  const keyId = 'real-key'
  const kv = makeKV()
  await kv.put(`attest:${keyId}`, JSON.stringify({ publicKeyB64: bytesToB64(spki), signCount: 0 }))

  const clientData = new TextEncoder().encode('img')
  const forged = await buildAssertion(attackerKey.privateKey, clientData, 1) // signed by attacker
  await assert.rejects(
    () => verifyAssertion({ keyId, assertionB64: forged, clientData, appId: APP_ID, kv }),
    (e) => e instanceof AttestError && e.code === 'SIG',
  )
})

test('verifyAssertion rejects an unknown (unregistered) key', async () => {
  const kv = makeKV()
  await assert.rejects(
    () => verifyAssertion({ keyId: 'nope', assertionB64: 'AA==', clientData: new Uint8Array([1]), appId: APP_ID, kv }),
    (e) => e instanceof AttestError && e.code === 'UNKNOWN_KEY',
  )
})

test('verifyAssertion rejects when the request body (clientData) is tampered', async () => {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey))
  const keyId = 'k'
  const kv = makeKV()
  await kv.put(`attest:${keyId}`, JSON.stringify({ publicKeyB64: bytesToB64(spki), signCount: 0 }))

  const signedOver = new TextEncoder().encode('original-image')
  const assertion = await buildAssertion(keyPair.privateKey, signedOver, 1)
  const tampered = new TextEncoder().encode('swapped-image')
  await assert.rejects(
    () => verifyAssertion({ keyId, assertionB64: assertion, clientData: tampered, appId: APP_ID, kv }),
    (e) => e instanceof AttestError && e.code === 'SIG',
  )
})
