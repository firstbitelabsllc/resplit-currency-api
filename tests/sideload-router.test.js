const test = require('node:test')
const assert = require('node:assert/strict')

test('sideload prefix dispatches to the sideload router', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')

  const response = await handleRequest(
    new Request('https://example.workers.dev/sideload/photos/abc', {
      headers: { 'x-request-id': 'req-sideload-test' },
    }),
    {}
  )

  assert.equal(response.status, 404)
  assert.equal(response.headers.get('x-request-id'), 'req-sideload-test')
  const body = await response.json()
  assert.equal(body.error, 'NOT_FOUND')
  assert.equal(body.message, 'Sideload route not found')
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
