const test = require('node:test')
const assert = require('node:assert/strict')
const {
  getFixture,
  signJwt,
  stubJwksFetch,
  defaultClaims,
} = require('./helpers/siwa-fixture')

const EXPECTED_AUDIENCE = 'com.leokwan.resplit'

test('sideload prefix without auth returns 401 AUTH_MISSING', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')
  const { _resetJwkCacheForTests } = await import('../worker/src/sideload/auth.mjs')
  _resetJwkCacheForTests()

  const response = await handleRequest(
    new Request('https://example.workers.dev/sideload/photos/abc', {
      headers: { 'x-request-id': 'req-sideload-noauth' },
    }),
    { SIWA_EXPECTED_AUDIENCE: EXPECTED_AUDIENCE }
  )

  assert.equal(response.status, 401)
  assert.equal(response.headers.get('x-request-id'), 'req-sideload-noauth')
  const body = await response.json()
  assert.equal(body.error, 'AUTH_MISSING')
})

test('root-level unknown route still returns the top-level NOT_FOUND', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')

  const response = await handleRequest(
    new Request('https://example.workers.dev/unknown', {
      headers: { 'x-request-id': 'req-root-404' },
    }),
    {}
  )

  assert.equal(response.status, 404)
  const body = await response.json()
  assert.equal(body.error, 'NOT_FOUND')
  assert.equal(body.message, 'Route not found')
})

test('FX /quote route is not swallowed by the sideload dispatch', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')

  const response = await handleRequest(
    new Request('https://example.workers.dev/quote?from=AED&to=USD', {
      headers: { 'x-request-id': 'req-quote-regression' },
    }),
    {}
  )

  assert.equal(response.status, 400)
  const body = await response.json()
  assert.equal(body.error, 'INVALID_QUERY')
})

test('sideload with valid whitelisted token reaches the NOT_FOUND stub', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')
  const { _resetJwkCacheForTests } = await import('../worker/src/sideload/auth.mjs')
  _resetJwkCacheForTests()

  const { privateKey, kid, jwks } = await getFixture()
  const restoreFetch = stubJwksFetch(jwks)
  try {
    const token = await signJwt({
      privateKey,
      kid,
      payload: defaultClaims(),
    })
    const response = await handleRequest(
      new Request('https://example.workers.dev/sideload/photos/abc', {
        headers: {
          authorization: `Bearer ${token}`,
          'x-request-id': 'req-sideload-auth-ok',
        },
      }),
      { SIWA_EXPECTED_AUDIENCE: EXPECTED_AUDIENCE }
    )

    assert.equal(response.status, 404)
    const body = await response.json()
    assert.equal(body.error, 'NOT_FOUND')
    assert.equal(body.message, 'Sideload route not found')
  } finally {
    restoreFetch()
  }
})

test('sideload with non-whitelisted email returns 403 FORBIDDEN_NOT_WHITELISTED', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')
  const { _resetJwkCacheForTests } = await import('../worker/src/sideload/auth.mjs')
  _resetJwkCacheForTests()

  const { privateKey, kid, jwks } = await getFixture()
  const restoreFetch = stubJwksFetch(jwks)
  try {
    const token = await signJwt({
      privateKey,
      kid,
      payload: defaultClaims({ email: 'stranger@example.com' }),
    })
    const response = await handleRequest(
      new Request('https://example.workers.dev/sideload/photos/abc', {
        headers: {
          authorization: `Bearer ${token}`,
          'x-request-id': 'req-sideload-forbidden',
        },
      }),
      { SIWA_EXPECTED_AUDIENCE: EXPECTED_AUDIENCE }
    )

    assert.equal(response.status, 403)
    const body = await response.json()
    assert.equal(body.error, 'FORBIDDEN_NOT_WHITELISTED')
  } finally {
    restoreFetch()
  }
})

test('sideload with expired token returns 401 AUTH_EXPIRED', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')
  const { _resetJwkCacheForTests } = await import('../worker/src/sideload/auth.mjs')
  _resetJwkCacheForTests()

  const { privateKey, kid, jwks } = await getFixture()
  const restoreFetch = stubJwksFetch(jwks)
  try {
    const nowSec = Math.floor(Date.now() / 1000)
    const token = await signJwt({
      privateKey,
      kid,
      payload: defaultClaims({ iat: nowSec - 7200, exp: nowSec - 3600 }),
    })
    const response = await handleRequest(
      new Request('https://example.workers.dev/sideload/photos/abc', {
        headers: {
          authorization: `Bearer ${token}`,
          'x-request-id': 'req-sideload-expired',
        },
      }),
      { SIWA_EXPECTED_AUDIENCE: EXPECTED_AUDIENCE }
    )

    assert.equal(response.status, 401)
    const body = await response.json()
    assert.equal(body.error, 'AUTH_EXPIRED')
  } finally {
    restoreFetch()
  }
})
