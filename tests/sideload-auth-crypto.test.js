const test = require('node:test')
const assert = require('node:assert/strict')

const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys'
const EXPECTED_AUDIENCE = 'com.leokwan.resplit'
const APPLE_ISSUER = 'https://appleid.apple.com'

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

function makeBearerRequest(token) {
  return new Request('https://example.workers.dev/sideload/photos', {
    headers: { authorization: `Bearer ${token}` },
  })
}

test('verifySIWAToken accepts a valid RS256 token and returns claims', async () => {
  const { verifySIWAToken, _resetJwkCacheForTests } = await import('../worker/src/sideload/auth.mjs')
  _resetJwkCacheForTests()
  const { privateKey, kid, jwks } = await getFixture()
  const restoreFetch = stubJwksFetch(jwks)
  try {
    const nowSec = Math.floor(Date.now() / 1000)
    const token = await signJwt({
      privateKey,
      kid,
      payload: {
        iss: APPLE_ISSUER,
        aud: EXPECTED_AUDIENCE,
        sub: 'test.user.sub.000123',
        email: 'leojkwan@gmail.com',
        email_verified: true,
        iat: nowSec - 10,
        exp: nowSec + 600,
      },
    })
    const claims = await verifySIWAToken(
      makeBearerRequest(token),
      { SIWA_EXPECTED_AUDIENCE: EXPECTED_AUDIENCE },
    )
    assert.equal(claims.sub, 'test.user.sub.000123')
    assert.equal(claims.email, 'leojkwan@gmail.com')
    assert.equal(claims.emailVerified, true)
  } finally {
    restoreFetch()
  }
})

test('verifySIWAToken rejects expired token with AUTH_EXPIRED', async () => {
  const { verifySIWAToken, AUTH_EXPIRED, _resetJwkCacheForTests } = await import('../worker/src/sideload/auth.mjs')
  _resetJwkCacheForTests()
  const { privateKey, kid, jwks } = await getFixture()
  const restoreFetch = stubJwksFetch(jwks)
  try {
    const nowSec = Math.floor(Date.now() / 1000)
    const token = await signJwt({
      privateKey,
      kid,
      payload: {
        iss: APPLE_ISSUER,
        aud: EXPECTED_AUDIENCE,
        sub: 'sub',
        email: 'leojkwan@gmail.com',
        email_verified: true,
        iat: nowSec - 7200,
        exp: nowSec - 3600,
      },
    })
    try {
      await verifySIWAToken(
        makeBearerRequest(token),
        { SIWA_EXPECTED_AUDIENCE: EXPECTED_AUDIENCE },
      )
      assert.fail('should have thrown')
    } catch (error) {
      assert.equal(error.code, AUTH_EXPIRED)
    }
  } finally {
    restoreFetch()
  }
})

test('verifySIWAToken rejects wrong audience with AUTH_AUDIENCE', async () => {
  const { verifySIWAToken, AUTH_AUDIENCE, _resetJwkCacheForTests } = await import('../worker/src/sideload/auth.mjs')
  _resetJwkCacheForTests()
  const { privateKey, kid, jwks } = await getFixture()
  const restoreFetch = stubJwksFetch(jwks)
  try {
    const nowSec = Math.floor(Date.now() / 1000)
    const token = await signJwt({
      privateKey,
      kid,
      payload: {
        iss: APPLE_ISSUER,
        aud: 'com.some.other.app',
        sub: 'sub',
        email: 'leojkwan@gmail.com',
        email_verified: true,
        iat: nowSec - 10,
        exp: nowSec + 600,
      },
    })
    try {
      await verifySIWAToken(
        makeBearerRequest(token),
        { SIWA_EXPECTED_AUDIENCE: EXPECTED_AUDIENCE },
      )
      assert.fail('should have thrown')
    } catch (error) {
      assert.equal(error.code, AUTH_AUDIENCE)
    }
  } finally {
    restoreFetch()
  }
})

test('verifySIWAToken rejects wrong issuer with AUTH_ISSUER', async () => {
  const { verifySIWAToken, AUTH_ISSUER, _resetJwkCacheForTests } = await import('../worker/src/sideload/auth.mjs')
  _resetJwkCacheForTests()
  const { privateKey, kid, jwks } = await getFixture()
  const restoreFetch = stubJwksFetch(jwks)
  try {
    const nowSec = Math.floor(Date.now() / 1000)
    const token = await signJwt({
      privateKey,
      kid,
      payload: {
        iss: 'https://evil.example.com',
        aud: EXPECTED_AUDIENCE,
        sub: 'sub',
        email: 'leojkwan@gmail.com',
        email_verified: true,
        iat: nowSec - 10,
        exp: nowSec + 600,
      },
    })
    try {
      await verifySIWAToken(
        makeBearerRequest(token),
        { SIWA_EXPECTED_AUDIENCE: EXPECTED_AUDIENCE },
      )
      assert.fail('should have thrown')
    } catch (error) {
      assert.equal(error.code, AUTH_ISSUER)
    }
  } finally {
    restoreFetch()
  }
})

test('verifySIWAToken rejects tampered signature with AUTH_INVALID', async () => {
  const { verifySIWAToken, AUTH_INVALID, _resetJwkCacheForTests } = await import('../worker/src/sideload/auth.mjs')
  _resetJwkCacheForTests()
  const { privateKey, kid, jwks } = await getFixture()
  const restoreFetch = stubJwksFetch(jwks)
  try {
    const nowSec = Math.floor(Date.now() / 1000)
    const token = await signJwt({
      privateKey,
      kid,
      payload: {
        iss: APPLE_ISSUER,
        aud: EXPECTED_AUDIENCE,
        sub: 'sub',
        email: 'leojkwan@gmail.com',
        email_verified: true,
        iat: nowSec - 10,
        exp: nowSec + 600,
      },
    })
    const parts = token.split('.')
    const tampered = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -4)}AAAA`
    try {
      await verifySIWAToken(
        makeBearerRequest(tampered),
        { SIWA_EXPECTED_AUDIENCE: EXPECTED_AUDIENCE },
      )
      assert.fail('should have thrown')
    } catch (error) {
      assert.equal(error.code, AUTH_INVALID)
    }
  } finally {
    restoreFetch()
  }
})

test('verifySIWAToken rejects unknown kid with AUTH_INVALID after refetch miss', async () => {
  const { verifySIWAToken, AUTH_INVALID, _resetJwkCacheForTests } = await import('../worker/src/sideload/auth.mjs')
  _resetJwkCacheForTests()
  const { privateKey, jwks } = await getFixture()
  const restoreFetch = stubJwksFetch(jwks)
  try {
    const nowSec = Math.floor(Date.now() / 1000)
    const token = await signJwt({
      privateKey,
      kid: 'kid-that-does-not-exist',
      payload: {
        iss: APPLE_ISSUER,
        aud: EXPECTED_AUDIENCE,
        sub: 'sub',
        email: 'leojkwan@gmail.com',
        email_verified: true,
        iat: nowSec - 10,
        exp: nowSec + 600,
      },
    })
    try {
      await verifySIWAToken(
        makeBearerRequest(token),
        { SIWA_EXPECTED_AUDIENCE: EXPECTED_AUDIENCE },
      )
      assert.fail('should have thrown')
    } catch (error) {
      assert.equal(error.code, AUTH_INVALID)
    }
  } finally {
    restoreFetch()
  }
})

test('verifySIWAToken rejects missing SIWA_EXPECTED_AUDIENCE with AUTH_AUDIENCE', async () => {
  const { verifySIWAToken, AUTH_AUDIENCE, _resetJwkCacheForTests } = await import('../worker/src/sideload/auth.mjs')
  _resetJwkCacheForTests()
  const { privateKey, kid, jwks } = await getFixture()
  const restoreFetch = stubJwksFetch(jwks)
  try {
    const nowSec = Math.floor(Date.now() / 1000)
    const token = await signJwt({
      privateKey,
      kid,
      payload: {
        iss: APPLE_ISSUER,
        aud: EXPECTED_AUDIENCE,
        sub: 'sub',
        email: 'leojkwan@gmail.com',
        email_verified: true,
        iat: nowSec - 10,
        exp: nowSec + 600,
      },
    })
    try {
      await verifySIWAToken(makeBearerRequest(token), {})
      assert.fail('should have thrown')
    } catch (error) {
      assert.equal(error.code, AUTH_AUDIENCE)
    }
  } finally {
    restoreFetch()
  }
})
