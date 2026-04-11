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

test('sideload with valid whitelisted token reaches the handleGet stub (501)', async () => {
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

    assert.equal(response.status, 501)
    const body = await response.json()
    assert.equal(body.error, 'NOT_IMPLEMENTED')
    assert.match(body.message, /handleGet/)
  } finally {
    restoreFetch()
  }
})

test('sideload OPTIONS preflight returns 204 without requiring auth', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')

  const response = await handleRequest(
    new Request('https://example.workers.dev/sideload/photos', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://resplit.app',
        'access-control-request-method': 'GET',
        'x-request-id': 'req-sideload-preflight',
      },
    }),
    {}
  )

  assert.equal(response.status, 204)
  assert.equal(response.headers.get('x-request-id'), 'req-sideload-preflight')
  assert.equal(
    response.headers.get('access-control-allow-methods'),
    'GET, POST, DELETE, OPTIONS'
  )
})

test('GET /sideload/photos dispatches to handleList stub (501)', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')
  const { _resetJwkCacheForTests } = await import('../worker/src/sideload/auth.mjs')
  _resetJwkCacheForTests()

  const { privateKey, kid, jwks } = await getFixture()
  const restoreFetch = stubJwksFetch(jwks)
  try {
    const token = await signJwt({ privateKey, kid, payload: defaultClaims() })
    const response = await handleRequest(
      new Request('https://example.workers.dev/sideload/photos', {
        headers: {
          authorization: `Bearer ${token}`,
          'x-request-id': 'req-list-stub',
        },
      }),
      { SIWA_EXPECTED_AUDIENCE: EXPECTED_AUDIENCE }
    )

    assert.equal(response.status, 501)
    const body = await response.json()
    assert.equal(body.error, 'NOT_IMPLEMENTED')
    assert.match(body.message, /handleList/)
  } finally {
    restoreFetch()
  }
})

test('POST /sideload/photos/upload dispatches to handleUploadInit stub (501)', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')
  const { _resetJwkCacheForTests } = await import('../worker/src/sideload/auth.mjs')
  _resetJwkCacheForTests()

  const { privateKey, kid, jwks } = await getFixture()
  const restoreFetch = stubJwksFetch(jwks)
  try {
    const token = await signJwt({ privateKey, kid, payload: defaultClaims() })
    const response = await handleRequest(
      new Request('https://example.workers.dev/sideload/photos/upload', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-request-id': 'req-upload-init-stub',
        },
        body: JSON.stringify({ contentType: 'image/jpeg' }),
      }),
      { SIWA_EXPECTED_AUDIENCE: EXPECTED_AUDIENCE }
    )

    assert.equal(response.status, 501)
    const body = await response.json()
    assert.equal(body.error, 'NOT_IMPLEMENTED')
    assert.match(body.message, /handleUploadInit/)
  } finally {
    restoreFetch()
  }
})

test('DELETE /sideload/photos/:id dispatches to handleDelete stub (501)', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')
  const { _resetJwkCacheForTests } = await import('../worker/src/sideload/auth.mjs')
  _resetJwkCacheForTests()

  const { privateKey, kid, jwks } = await getFixture()
  const restoreFetch = stubJwksFetch(jwks)
  try {
    const token = await signJwt({ privateKey, kid, payload: defaultClaims() })
    const response = await handleRequest(
      new Request('https://example.workers.dev/sideload/photos/abc123', {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${token}`,
          'x-request-id': 'req-delete-stub',
        },
      }),
      { SIWA_EXPECTED_AUDIENCE: EXPECTED_AUDIENCE }
    )

    assert.equal(response.status, 501)
    const body = await response.json()
    assert.equal(body.error, 'NOT_IMPLEMENTED')
    assert.match(body.message, /handleDelete/)
  } finally {
    restoreFetch()
  }
})

test('POST /sideload/photos/:id/labels dispatches to handleSetLabels stub (501)', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')
  const { _resetJwkCacheForTests } = await import('../worker/src/sideload/auth.mjs')
  _resetJwkCacheForTests()

  const { privateKey, kid, jwks } = await getFixture()
  const restoreFetch = stubJwksFetch(jwks)
  try {
    const token = await signJwt({ privateKey, kid, payload: defaultClaims() })
    const response = await handleRequest(
      new Request('https://example.workers.dev/sideload/photos/abc123/labels', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-request-id': 'req-set-labels-stub',
        },
        body: JSON.stringify({ labels: { merchant: 'Starbucks' } }),
      }),
      { SIWA_EXPECTED_AUDIENCE: EXPECTED_AUDIENCE }
    )

    assert.equal(response.status, 501)
    const body = await response.json()
    assert.equal(body.error, 'NOT_IMPLEMENTED')
    assert.match(body.message, /handleSetLabels/)
  } finally {
    restoreFetch()
  }
})

test('PUT /sideload/photos/abc (unsupported method) returns 404 NOT_FOUND', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')
  const { _resetJwkCacheForTests } = await import('../worker/src/sideload/auth.mjs')
  _resetJwkCacheForTests()

  const { privateKey, kid, jwks } = await getFixture()
  const restoreFetch = stubJwksFetch(jwks)
  try {
    const token = await signJwt({ privateKey, kid, payload: defaultClaims() })
    const response = await handleRequest(
      new Request('https://example.workers.dev/sideload/photos/abc', {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'x-request-id': 'req-unsupported-method',
        },
      }),
      { SIWA_EXPECTED_AUDIENCE: EXPECTED_AUDIENCE }
    )

    assert.equal(response.status, 404)
    const body = await response.json()
    assert.equal(body.error, 'NOT_FOUND')
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
