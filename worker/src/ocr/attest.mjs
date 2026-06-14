// App Attest — per-request ASSERTION verification + shared primitives.
//
// This is the hot path: it runs on EVERY /ocr/scan and uses WebCrypto only (no
// X.509 dependency), so it stays cheap and inside the Workers CPU budget. The
// heavy once-per-device ATTESTATION (cert chain to Apple's root) lives in
// ./attestation.mjs and reuses the helpers exported here.
//
// Device records live in KV (`ATTEST_KV`):
//   attest:<keyId> -> { publicKeyB64(SPKI), signCount, createdAt }

export class AttestError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
    this.name = 'AttestError'
  }
}

// ---- small encoders (shared with attestation.mjs) ---------------------------

export const b64ToBytes = (s) => {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(norm)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
export const bytesToB64 = (bytes) => {
  let bin = ''
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i])
  return btoa(bin)
}
export const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
export const concat = (...arrs) => {
  const total = arrs.reduce((n, a) => n + a.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const a of arrs) { out.set(a, off); off += a.length }
  return out
}
export const eq = (a, b) => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

// ---- minimal CBOR decoder (App Attest subset) -------------------------------

export function decodeCbor(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let pos = 0
  const readArg = (info) => {
    if (info < 24) return info
    if (info === 24) return view.getUint8(pos++)
    if (info === 25) { const v = view.getUint16(pos); pos += 2; return v }
    if (info === 26) { const v = view.getUint32(pos); pos += 4; return v }
    if (info === 27) { const hi = view.getUint32(pos); const lo = view.getUint32(pos + 4); pos += 8; return hi * 2 ** 32 + lo }
    throw new AttestError('CBOR_BAD', `unsupported cbor arg ${info}`)
  }
  const read = () => {
    const b = view.getUint8(pos++)
    const major = b >> 5
    const info = b & 0x1f
    switch (major) {
    case 0: return readArg(info)
    case 1: return -1 - readArg(info)
    case 2: { const len = readArg(info); const out = bytes.subarray(pos, pos + len); pos += len; return out }
    case 3: { const len = readArg(info); const out = new TextDecoder().decode(bytes.subarray(pos, pos + len)); pos += len; return out }
    case 4: { const len = readArg(info); const arr = []; for (let i = 0; i < len; i++) arr.push(read()); return arr }
    case 5: { const len = readArg(info); const map = {}; for (let i = 0; i < len; i++) { const k = read(); map[k] = read() } return map }
    case 7: return readArg(info)
    default: throw new AttestError('CBOR_BAD', `unsupported cbor major ${major}`)
    }
  }
  return read()
}

// ---- authenticatorData parsing (WebAuthn layout) ----------------------------

export function parseAuthData(authData) {
  if (authData.length < 37) throw new AttestError('AUTHDATA_SHORT', 'authData too short')
  const rpIdHash = authData.subarray(0, 32)
  const flags = authData[32]
  const signCount = new DataView(authData.buffer, authData.byteOffset + 33, 4).getUint32(0)
  let rest = { rpIdHash, flags, signCount }
  if (authData.length > 37) {
    const aaguid = authData.subarray(37, 53)
    const credIdLen = new DataView(authData.buffer, authData.byteOffset + 53, 2).getUint16(0)
    const credentialId = authData.subarray(55, 55 + credIdLen)
    const publicKeyCose = authData.subarray(55 + credIdLen)
    rest = { ...rest, aaguid, credentialId, publicKeyCose }
  }
  return rest
}

// COSE_Key (EC2, P-256) -> raw uncompressed point -> CryptoKey
export async function importCoseEcKey(coseBytes) {
  const cose = decodeCbor(coseBytes)
  const x = cose[-2]
  const y = cose[-3]
  if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) {
    throw new AttestError('COSE_BAD', 'invalid COSE EC2 public key')
  }
  const raw = concat(new Uint8Array([0x04]), x, y)
  return crypto.subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify'])
}

// DER ECDSA (SEQUENCE { INTEGER r, INTEGER s }) -> raw 64-byte r||s.
function derToRawEcdsa(der) {
  let pos = 0
  if (der[pos++] !== 0x30) throw new AttestError('SIG', 'bad DER sig')
  if (der[pos] & 0x80) pos += 1 + (der[pos] & 0x7f); else pos++
  const readInt = () => {
    if (der[pos++] !== 0x02) throw new AttestError('SIG', 'bad DER int')
    const len = der[pos++]
    let val = der.subarray(pos, pos + len); pos += len
    while (val.length > 32 && val[0] === 0x00) val = val.subarray(1)
    const out = new Uint8Array(32)
    out.set(val, 32 - val.length)
    return out
  }
  const r = readInt()
  const s = readInt()
  return concat(r, s)
}

export const recordKey = (keyId) => `attest:${keyId}`

/**
 * Verify a per-request assertion against a registered key. Cheap (one ECDSA verify).
 *
 * @param {{ keyId: string, assertionB64: string, clientData: Uint8Array, appId: string, kv: KVNamespace }} args
 * @returns {Promise<{ ok: true, deviceId: string }>}
 */
export async function verifyAssertion({ keyId, assertionB64, clientData, appId, kv }) {
  const raw = await kv.get(recordKey(keyId))
  if (!raw) throw new AttestError('UNKNOWN_KEY', 'key not registered (attest first)')
  const record = JSON.parse(raw)

  const assertion = decodeCbor(b64ToBytes(assertionB64))
  const signature = assertion.signature
  const authData = assertion.authenticatorData
  if (!(signature instanceof Uint8Array) || !(authData instanceof Uint8Array)) {
    throw new AttestError('ASSERT_SHAPE', 'assertion missing signature/authenticatorData')
  }

  // App Attest signs the ES256 nonce = SHA256(authenticatorData || clientDataHash).
  // ECDSA-SHA256 hashes its message once, so hand WebCrypto (authenticatorData ||
  // clientDataHash) — it SHA-256's that into the nonce. Passing the pre-hashed nonce
  // would double-hash and reject every valid assertion.
  const clientDataHash = await sha256(clientData)
  const signedData = concat(authData, clientDataHash)

  const pubKey = await crypto.subtle.importKey(
    'spki', b64ToBytes(record.publicKeyB64),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
  )
  const rawSig = derToRawEcdsa(signature)
  const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pubKey, rawSig, signedData)
  if (!valid) throw new AttestError('SIG', 'assertion signature invalid')

  const ad = parseAuthData(authData)
  const expectedRpId = await sha256(new TextEncoder().encode(appId))
  if (!eq(ad.rpIdHash, expectedRpId)) throw new AttestError('RPID', 'assertion rpIdHash mismatch')
  if (ad.signCount <= record.signCount) throw new AttestError('REPLAY', 'signCount not monotonic')

  record.signCount = ad.signCount
  await kv.put(recordKey(keyId), JSON.stringify(record))
  return { ok: true, deviceId: keyId }
}
