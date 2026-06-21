// App Attest — once-per-device ATTESTATION verification (the heavy path).
//
// Validates that a Secure-Enclave key was genuinely produced by an unmodified
// instance of THIS app on a real Apple device: CBOR decode -> X.509 chain to
// Apple's App Attest root -> nonce extension -> authData/rpId checks. Runs ONCE
// per install at /ocr/attest, never on the per-scan hot path. Uses @peculiar/x509
// (WebCrypto-backed) for the cert chain — kept out of attest.mjs so the per-request
// assertion path carries no X.509 dependency.

import 'reflect-metadata'
import { X509Certificate } from '@peculiar/x509'
import {
  AttestError,
  b64ToBytes,
  bytesToB64,
  sha256,
  concat,
  eq,
  decodeCbor,
  parseAuthData,
  importCoseEcKey,
  recordKey,
} from './attest.mjs'

// SHA256(authData || clientDataHash), carried in this cert extension.
const APP_ATTEST_NONCE_OID = '1.2.840.113635.100.8.2'

// Apple App Attest Root CA (public). https://www.apple.com/certificateauthority/
const APPLE_APP_ATTEST_ROOT_CA_PEM = `-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEA3QdpV7nMrLgQ8cVjVe2lUgF4MzqYI7uFNrLn
1cCVi8q5OY7vJSXvOZsxNF1aQ8h2
-----END CERTIFICATE-----`

let cachedRoot = null
function appleRootCert() {
  if (!cachedRoot) cachedRoot = new X509Certificate(APPLE_APP_ATTEST_ROOT_CA_PEM)
  return cachedRoot
}

/**
 * Verify an attestation and register the device key. Runs ONCE per install.
 *
 * @param {{ keyId: string, attestationObjectB64: string, challenge: string, appId: string, kv: KVNamespace }} args
 * @returns {Promise<{ ok: true, deviceId: string }>}
 */
export async function verifyAttestation({ keyId, attestationObjectB64, challenge, appId, kv }) {
  const att = decodeCbor(b64ToBytes(attestationObjectB64))
  if (att.fmt !== 'apple-appattest') throw new AttestError('FMT', `unexpected fmt ${att.fmt}`)
  const x5c = att.attStmt?.x5c
  const authData = att.authData
  if (!Array.isArray(x5c) || x5c.length < 1 || !(authData instanceof Uint8Array)) {
    throw new AttestError('ATT_SHAPE', 'attestation missing x5c/authData')
  }

  // 1. credCert chains to the Apple App Attest root.
  const credCert = new X509Certificate(new Uint8Array(x5c[0]))
  let chainOk = false
  try {
    const root = appleRootCert()
    if (x5c.length >= 2) {
      const intermediate = new X509Certificate(new Uint8Array(x5c[1]))
      chainOk = (await credCert.verify({ publicKey: await intermediate.publicKey.export() })) &&
                (await intermediate.verify({ publicKey: await root.publicKey.export() }))
    } else {
      chainOk = await credCert.verify({ publicKey: await root.publicKey.export() })
    }
  } catch (e) {
    throw new AttestError('CHAIN', `cert chain verify failed: ${e.message}`)
  }
  if (!chainOk) throw new AttestError('CHAIN', 'cert chain did not validate to Apple root')

  // 2. nonce = sha256(authData || sha256(challenge)) must equal the credCert extension.
  const clientDataHash = await sha256(new TextEncoder().encode(challenge))
  const expectedNonce = await sha256(concat(authData, clientDataHash))
  const ext = credCert.getExtension(APP_ATTEST_NONCE_OID)
  if (!ext) throw new AttestError('NONCE', 'missing app-attest nonce extension')
  // DER: SEQUENCE { [1] EXPLICIT OCTET STRING(nonce) } — the nonce is the trailing 32 bytes.
  const extBytes = new Uint8Array(ext.value)
  const extNonce = extBytes.subarray(extBytes.length - 32)
  if (!eq(extNonce, expectedNonce)) throw new AttestError('NONCE', 'nonce mismatch')

  // 3. authData checks: rpIdHash == sha256(appId), signCount == 0, has credential.
  const ad = parseAuthData(authData)
  const expectedRpId = await sha256(new TextEncoder().encode(appId))
  if (!eq(ad.rpIdHash, expectedRpId)) throw new AttestError('RPID', 'rpIdHash != sha256(appId)')
  if (ad.signCount !== 0) throw new AttestError('COUNT', 'initial signCount must be 0')
  if (!ad.publicKeyCose) throw new AttestError('NOKEY', 'attested credential data missing')

  const pubKey = await importCoseEcKey(ad.publicKeyCose)
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pubKey))

  await kv.put(recordKey(keyId), JSON.stringify({
    publicKeyB64: bytesToB64(spki),
    signCount: 0,
    createdAt: new Date().toISOString(),
  }))

  return { ok: true, deviceId: keyId }
}
