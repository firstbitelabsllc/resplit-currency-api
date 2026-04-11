const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys'

function base64urlEncodeString(str) {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function base64urlEncodeBytes(bytes) {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

async function generateTestKeyPair() {
  return crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  )
}

async function exportJwk(publicKey, kid) {
  const jwk = await crypto.subtle.exportKey('jwk', publicKey)
  return { ...jwk, kid, use: 'sig', alg: 'RS256' }
}

async function signJwt({ privateKey, kid, payload }) {
  const header = { alg: 'RS256', kid, typ: 'JWT' }
  const headerB64 = base64urlEncodeString(JSON.stringify(header))
  const payloadB64 = base64urlEncodeString(JSON.stringify(payload))
  const signingInput = `${headerB64}.${payloadB64}`
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(signingInput)
  )
  const signatureB64 = base64urlEncodeBytes(new Uint8Array(signature))
  return `${signingInput}.${signatureB64}`
}

let fixturePromise
function getFixture() {
  if (!fixturePromise) {
    fixturePromise = (async () => {
      const { publicKey, privateKey } = await generateTestKeyPair()
      const kid = 'test-kid-2026-04-11'
      const jwk = await exportJwk(publicKey, kid)
      return { publicKey, privateKey, kid, jwks: { keys: [jwk] } }
    })()
  }
  return fixturePromise
}

function stubJwksFetch(jwks) {
  const originalFetch = global.fetch
  global.fetch = async input => {
    const url = typeof input === 'string' ? input : input.url
    if (url === APPLE_JWKS_URL) {
      return new Response(JSON.stringify(jwks), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }
  return () => {
    global.fetch = originalFetch
  }
}

function defaultClaims(overrides = {}) {
  const nowSec = Math.floor(Date.now() / 1000)
  return {
    iss: 'https://appleid.apple.com',
    aud: 'com.leokwan.resplit',
    sub: 'test.user.sub.000123',
    email: 'leojkwan@gmail.com',
    email_verified: true,
    iat: nowSec - 10,
    exp: nowSec + 600,
    ...overrides,
  }
}

module.exports = {
  APPLE_JWKS_URL,
  getFixture,
  signJwt,
  stubJwksFetch,
  defaultClaims,
  base64urlEncodeString,
  base64urlEncodeBytes,
}
