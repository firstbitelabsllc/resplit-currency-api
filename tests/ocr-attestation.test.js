import { test } from 'node:test'
import assert from 'node:assert/strict'
import 'reflect-metadata'
import { X509CertificateGenerator, Extension } from '@peculiar/x509'
import { verifyAttestation } from '../worker/src/ocr/attestation.mjs'
import { verifyAssertion, AttestError } from '../worker/src/ocr/attest.mjs'

const APP_ID = 'QSL6XFT438.com.superfit.Resplit'
const NONCE_OID = '1.2.840.113635.100.8.2'

// --- helpers (test-side only) ------------------------------------------------

function concat(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const a of arrs) { out.set(a, off); off += a.length }
  return out
}
const sha256 = async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b))
const bytesToB64 = (bytes) => {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

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
function cborAttestation(credCertDer, authData) {
  // map(3) { "fmt": "apple-appattest", "attStmt": { "x5c": [bstr] }, "authData": bstr }
  return concat(
    Uint8Array.of(0xa3),
    cborText('fmt'), cborText('apple-appattest'),
    cborText('attStmt'), concat(
      Uint8Array.of(0xa1),
      cborText('x5c'), Uint8Array.of(0x81), cborBytes(credCertDer),
    ),
    cborText('authData'), cborBytes(authData),
  )
}
function cborAssertion(signatureDer, authData) {
  return concat(
    Uint8Array.of(0xa2),
    cborText('signature'), cborBytes(signatureDer),
    cborText('authenticatorData'), cborBytes(authData),
  )
}
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

function makeKV() {
  const store = new Map()
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null },
    async put(k, v) { store.set(k, v) },
  }
}

// authData for attestation: rpIdHash(32) | flags(1) | signCount(4) |
// aaguid(16) | credIdLen(2) | credentialId(32)
async function buildAttestAuthData({ aaguid, credentialId, signCount = 0 }) {
  const rpIdHash = await sha256(new TextEncoder().encode(APP_ID))
  const head = new Uint8Array(37)
  head.set(rpIdHash, 0)
  head[32] = 0x40 // AT flag
  new DataView(head.buffer).setUint32(33, signCount)
  const credIdLen = Uint8Array.of(0, credentialId.length)
  return concat(head, aaguid, credIdLen, credentialId)
}

const AAGUID_DEV = new TextEncoder().encode('appattestdevelop')

// Build a synthetic-but-structurally-genuine attestation: real ECDSA chain
// (test root -> credCert), real nonce extension, keyId = SHA256(cred public
// key point) exactly as DCAppAttestService derives it.
async function buildAttestation({ challenge, keyIdOverride, credentialIdOverride, aaguid = AAGUID_DEV }) {
  const rootKeys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const credKeys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const credPoint = new Uint8Array(await crypto.subtle.exportKey('raw', credKeys.publicKey))
  const keyIdBytes = keyIdOverride ?? await sha256(credPoint)
  const keyId = bytesToB64(keyIdBytes)

  const authData = await buildAttestAuthData({ aaguid, credentialId: credentialIdOverride ?? keyIdBytes })
  const clientDataHash = await sha256(new TextEncoder().encode(challenge))
  const nonce = await sha256(concat(authData, clientDataHash))
  // extnValue content: SEQUENCE { [1] EXPLICIT { OCTET STRING(nonce) } }
  const nonceExt = concat(Uint8Array.of(0x30, 0x24, 0xa1, 0x22, 0x04, 0x20), nonce)

  const notBefore = new Date(Date.now() - 60_000)
  const notAfter = new Date(Date.now() + 3600_000)
  const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' }
  const rootCert = await X509CertificateGenerator.create({
    serialNumber: '01',
    subject: 'CN=Test App Attest Root',
    issuer: 'CN=Test App Attest Root',
    notBefore, notAfter,
    signingAlgorithm: alg,
    publicKey: rootKeys.publicKey,
    signingKey: rootKeys.privateKey,
  })
  const credCert = await X509CertificateGenerator.create({
    serialNumber: '02',
    subject: 'CN=Test credCert',
    issuer: 'CN=Test App Attest Root',
    notBefore, notAfter,
    signingAlgorithm: alg,
    publicKey: credKeys.publicKey,
    signingKey: rootKeys.privateKey,
    extensions: [new Extension(NONCE_OID, false, nonceExt.buffer.slice(nonceExt.byteOffset, nonceExt.byteOffset + nonceExt.byteLength))],
  })

  const attestationObjectB64 = bytesToB64(cborAttestation(new Uint8Array(credCert.rawData), authData))
  return { keyId, keyIdBytes, credKeys, attestationObjectB64, rootCertPem: rootCert.toString('pem') }
}

// --- tests -------------------------------------------------------------------

test('verifyAttestation registers the credCert key and the record verifies a real-contract assertion', async () => {
  const kv = makeKV()
  const challenge = 'test-challenge'
  const built = await buildAttestation({ challenge })

  const reg = await verifyAttestation({
    keyId: built.keyId,
    attestationObjectB64: built.attestationObjectB64,
    challenge,
    appId: APP_ID,
    kv,
    rootCertPem: built.rootCertPem,
  })
  assert.equal(reg.ok, true)

  const record = JSON.parse(kv.store.get(`attest:${built.keyId}`))
  assert.equal(record.signCount, 0)
  assert.equal(record.environment, 'development')
  const expectedSpki = new Uint8Array(await crypto.subtle.exportKey('spki', built.credKeys.publicKey))
  assert.equal(record.publicKeyB64, bytesToB64(expectedSpki))

  // Round-trip: an assertion signed under Apple's contract (message = nonce)
  // by the attested key must verify against the record register just stored.
  const clientData = new TextEncoder().encode('receipt-image-bytes')
  const rpIdHash = await sha256(new TextEncoder().encode(APP_ID))
  const assertAuthData = new Uint8Array(37)
  assertAuthData.set(rpIdHash, 0)
  new DataView(assertAuthData.buffer).setUint32(33, 1)
  const clientDataHash = await sha256(clientData)
  const nonce = await sha256(concat(assertAuthData, clientDataHash))
  const rawSig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, built.credKeys.privateKey, nonce))
  const assertionB64 = bytesToB64(cborAssertion(rawToDer(rawSig), assertAuthData))

  const res = await verifyAssertion({ keyId: built.keyId, assertionB64, clientData, appId: APP_ID, kv })
  assert.equal(res.ok, true)
})

test('verifyAttestation rejects a client-supplied keyId that is not SHA256(credCert public key)', async () => {
  const kv = makeKV()
  const challenge = 'c'
  const bogusKeyId = new Uint8Array(32).fill(7)
  // credentialId matches the bogus keyId, so the nonce is internally consistent;
  // only the credCert-pubkey binding can catch it.
  const built = await buildAttestation({ challenge, keyIdOverride: bogusKeyId, credentialIdOverride: bogusKeyId })

  await assert.rejects(
    () => verifyAttestation({
      keyId: built.keyId,
      attestationObjectB64: built.attestationObjectB64,
      challenge,
      appId: APP_ID,
      kv,
      rootCertPem: built.rootCertPem,
    }),
    (e) => e instanceof AttestError && e.code === 'KEYID',
  )
  assert.equal(kv.store.size, 0)
})

test('verifyAttestation rejects when authData credentialId does not match keyId', async () => {
  const kv = makeKV()
  const challenge = 'c'
  const built = await buildAttestation({ challenge, credentialIdOverride: new Uint8Array(32).fill(9) })

  await assert.rejects(
    () => verifyAttestation({
      keyId: built.keyId,
      attestationObjectB64: built.attestationObjectB64,
      challenge,
      appId: APP_ID,
      kv,
      rootCertPem: built.rootCertPem,
    }),
    (e) => e instanceof AttestError && e.code === 'KEYID',
  )
  assert.equal(kv.store.size, 0)
})

test('verifyAttestation rejects an unknown aaguid environment', async () => {
  const kv = makeKV()
  const challenge = 'c'
  const built = await buildAttestation({ challenge, aaguid: new Uint8Array(16).fill(1) })

  await assert.rejects(
    () => verifyAttestation({
      keyId: built.keyId,
      attestationObjectB64: built.attestationObjectB64,
      challenge,
      appId: APP_ID,
      kv,
      rootCertPem: built.rootCertPem,
    }),
    (e) => e instanceof AttestError && e.code === 'AAGUID',
  )
})

test('verifyAttestation rejects a chain that does not reach the Apple root when no override is given', async () => {
  const kv = makeKV()
  const challenge = 'c'
  const built = await buildAttestation({ challenge })

  await assert.rejects(
    () => verifyAttestation({
      keyId: built.keyId,
      attestationObjectB64: built.attestationObjectB64,
      challenge,
      appId: APP_ID,
      kv,
    }),
    (e) => e instanceof AttestError && e.code === 'CHAIN',
  )
})
