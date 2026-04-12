const test = require('node:test')
const assert = require('node:assert/strict')

function cfAccessRequest(url, options = {}) {
  const headers = {
    'Cf-Access-Authenticated-User-Email': 'leojkwan@gmail.com',
    'x-request-id': options.requestId || 'req-test',
    ...options.headers,
  }
  return new Request(url, { ...options, headers })
}

test('sideload prefix without CF Access header returns 401 AUTH_MISSING', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')

  const response = await handleRequest(
    new Request('https://example.workers.dev/sideload/photos/abc', {
      headers: { 'x-request-id': 'req-sideload-noauth' },
    }),
    {}
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

test('GET /sideload/photos/:id returns 404 when photo does not exist', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')

  const mockR2 = {
    get: async () => null,
    put: async () => ({}),
    delete: async () => {},
    list: async () => ({ delimitedPrefixes: [], truncated: false }),
    head: async () => null,
  }

  const response = await handleRequest(
    cfAccessRequest('https://example.workers.dev/sideload/photos/abc', {
      requestId: 'req-sideload-get-404',
    }),
    { SIDELOAD_R2: mockR2 }
  )

  assert.equal(response.status, 404)
  const body = await response.json()
  assert.equal(body.error, 'NOT_FOUND')
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

test('GET /sideload/photos returns empty list when no photos exist', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')

  const mockR2 = {
    list: async () => ({ delimitedPrefixes: [], truncated: false }),
    get: async () => null,
    put: async () => ({}),
    delete: async () => {},
    head: async () => null,
  }

  const response = await handleRequest(
    cfAccessRequest('https://example.workers.dev/sideload/photos', {
      requestId: 'req-list-empty',
    }),
    { SIDELOAD_R2: mockR2 }
  )

  assert.equal(response.status, 200)
  const body = await response.json()
  assert.deepEqual(body.photos, [])
})

test('POST /sideload/photos/upload validates missing required fields', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')

  const response = await handleRequest(
    cfAccessRequest('https://example.workers.dev/sideload/photos/upload', {
      method: 'POST',
      headers: {
        'Cf-Access-Authenticated-User-Email': 'leojkwan@gmail.com',
        'content-type': 'application/json',
        'x-request-id': 'req-upload-validate',
      },
      body: JSON.stringify({ contentType: 'image/jpeg' }),
    }),
    {}
  )

  assert.equal(response.status, 400)
  const body = await response.json()
  assert.equal(body.error, 'INVALID_SIZE')
})

test('POST /sideload/photos/upload returns photoId and uploadUrl on valid input', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')

  const mockR2 = {
    put: async () => ({ etag: 'mock-etag' }),
    get: async () => null,
    delete: async () => {},
    list: async () => ({ objects: [], truncated: false }),
  }

  const response = await handleRequest(
    cfAccessRequest('https://example.workers.dev/sideload/photos/upload', {
      method: 'POST',
      headers: {
        'Cf-Access-Authenticated-User-Email': 'leojkwan@gmail.com',
        'content-type': 'application/json',
        'x-request-id': 'req-upload-init-ok',
      },
      body: JSON.stringify({
        contentType: 'image/jpeg',
        size: 1024,
        sha256: 'a'.repeat(64),
        capturedAt: '2026-04-12T00:00:00Z',
        originalFilename: 'test.jpg',
      }),
    }),
    { SIDELOAD_R2: mockR2 }
  )

  assert.equal(response.status, 200)
  const body = await response.json()
  assert.ok(body.photoId, 'should return a photoId')
  assert.match(body.uploadUrl, /\/sideload\/photos\/.*\/_bytes/)
})

test('DELETE /sideload/photos/:id returns 204 (idempotent)', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')

  const mockR2 = {
    delete: async () => {},
    put: async () => ({}),
    get: async () => null,
    list: async () => ({ delimitedPrefixes: [], truncated: false }),
    head: async () => null,
  }

  const response = await handleRequest(
    cfAccessRequest('https://example.workers.dev/sideload/photos/abc123', {
      method: 'DELETE',
      requestId: 'req-delete-ok',
    }),
    { SIDELOAD_R2: mockR2 }
  )

  assert.equal(response.status, 204)
})

test('POST /sideload/photos/:id/labels sets labels when photo exists', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')

  let writtenKey = null
  const mockR2 = {
    head: async () => ({ size: 1024 }),
    put: async (key, body) => { writtenKey = key; return {} },
    get: async () => null,
    delete: async () => {},
    list: async () => ({ delimitedPrefixes: [], truncated: false }),
  }

  const response = await handleRequest(
    cfAccessRequest('https://example.workers.dev/sideload/photos/abc123/labels', {
      method: 'POST',
      headers: {
        'Cf-Access-Authenticated-User-Email': 'leojkwan@gmail.com',
        'content-type': 'application/json',
        'x-request-id': 'req-set-labels-ok',
      },
      body: JSON.stringify({ labels: { merchant: 'Starbucks' } }),
    }),
    { SIDELOAD_R2: mockR2 }
  )

  assert.equal(response.status, 200)
  const body = await response.json()
  assert.deepEqual(body.labels, { merchant: 'Starbucks' })
  assert.ok(body.updatedAt)
  assert.ok(writtenKey && writtenKey.endsWith('/labels.json'))
})

test('PUT /sideload/photos/abc (unsupported method) returns 404 NOT_FOUND', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')

  const response = await handleRequest(
    cfAccessRequest('https://example.workers.dev/sideload/photos/abc', {
      method: 'PUT',
      requestId: 'req-unsupported-method',
    }),
    {}
  )

  assert.equal(response.status, 404)
  const body = await response.json()
  assert.equal(body.error, 'NOT_FOUND')
})

test('sideload with non-whitelisted email returns 403 FORBIDDEN_NOT_WHITELISTED', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')

  const response = await handleRequest(
    new Request('https://example.workers.dev/sideload/photos/abc', {
      headers: {
        'Cf-Access-Authenticated-User-Email': 'stranger@example.com',
        'x-request-id': 'req-sideload-forbidden',
      },
    }),
    {}
  )

  assert.equal(response.status, 403)
  const body = await response.json()
  assert.equal(body.error, 'FORBIDDEN_NOT_WHITELISTED')
})
