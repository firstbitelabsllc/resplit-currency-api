const test = require('node:test')
const assert = require('node:assert/strict')

test('parseArgs keeps local worker smoke defaults', async () => {
  const verifier = await import('../scripts/verify-grafana-tempo.mjs')

  const options = verifier.parseArgs([
    '--base-url',
    'http://127.0.0.1:8787',
    '--request-id',
    'req-123',
  ])

  assert.equal(options.baseUrl, 'http://127.0.0.1:8787')
  assert.equal(options.requestId, 'req-123')
  assert.equal(options.path, '/coverage')
  assert.equal(options.serviceName, 'resplit-currency-api-worker')
})

test('buildVerificationUrl targets coverage with stable query params', async () => {
  const verifier = await import('../scripts/verify-grafana-tempo.mjs')

  const url = verifier.buildVerificationUrl({
    anchorDate: '2026-04-22',
    baseUrl: 'http://127.0.0.1:8787',
    days: 7,
    from: 'AED',
    path: '/coverage',
    to: 'USD',
  })

  assert.equal(
    url.toString(),
    'http://127.0.0.1:8787/coverage?from=AED&to=USD&anchorDate=2026-04-22&days=7'
  )
})

test('buildSpanQuery scopes the Tempo search to service name and the verification span', async () => {
  const verifier = await import('../scripts/verify-grafana-tempo.mjs')

  assert.equal(
    verifier.buildSpanQuery({
      expectedSpan: 'resplit.fx.coverage.verify.req-123',
      serviceName: 'resplit-currency-api-worker',
    }),
    '{ resource.service.name = "resplit-currency-api-worker" && span:name = "resplit.fx.coverage.verify.req-123" }'
  )
})
