const test = require('node:test')
const assert = require('node:assert/strict')

test('worker quote route returns request id on invalid query', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')

  const response = await handleRequest(
    new Request('https://example.workers.dev/quote?from=AED&to=USD', {
      headers: { 'x-request-id': 'req-invalid' },
    }),
    {}
  )

  assert.equal(response.status, 400)
  assert.equal(response.headers.get('x-request-id'), 'req-invalid')
  assert.deepEqual(await response.json(), {
    error: 'INVALID_QUERY',
    message: 'Expected from, to, and date query params',
  })
})

test('worker quote route returns cache headers and stable request id', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')
  const originalFetch = global.fetch
  global.fetch = async input => {
    const url = String(input)
    if (url.endsWith('/latest/aed.json')) {
      return new Response(JSON.stringify({
        date: '2026-02-23',
        from: 'aed',
        rates: { usd: 0.272295 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url.endsWith('/archive-manifest.min.json')) {
      return new Response('missing', { status: 500 })
    }
    throw new Error(`Unexpected URL: ${url}`)
  }

  try {
    const response = await handleRequest(
      new Request('https://example.workers.dev/quote?from=AED&to=USD&date=2026-02-23', {
        headers: { 'x-request-id': 'req-quote' },
      }),
      {
        ASSET_BASE_URL: 'https://example-assets.dev',
      }
    )

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-request-id'), 'req-quote')
    assert.equal(
      response.headers.get('cache-control'),
      'public, s-maxage=3600, stale-while-revalidate=86400'
    )
    assert.deepEqual(await response.json(), {
      from: 'AED',
      to: 'USD',
      requestedDate: '2026-02-23',
      resolvedDate: '2026-02-23',
      rate: 0.272295,
      resolutionKind: 'exact',
      warning: null,
    })
  } finally {
    global.fetch = originalFetch
  }
})

test('worker cron route rejects unauthorized requests', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')

  const response = await handleRequest(
    new Request('https://example.workers.dev/cron/fx-canary'),
    { CRON_SECRET: 'top-secret' }
  )

  assert.equal(response.status, 401)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), {
    error: 'UNAUTHORIZED',
    message: 'Missing or invalid cron authorization',
  })
})
