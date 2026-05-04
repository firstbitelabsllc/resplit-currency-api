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

test('readVerificationDiagnostics parses Worker OTel headers from the verification route', async () => {
  const verifier = await import('../scripts/verify-grafana-tempo.mjs')
  const headers = new Headers({
    'x-resplit-otel-auth-source': 'OTEL_EXPORTER_OTLP_HEADERS',
    'x-resplit-otel-configured': '1',
    'x-resplit-otel-endpoint-source': 'OTEL_EXPORTER_OTLP_ENDPOINT',
    'x-resplit-otel-exporter-host': 'otlp-gateway-prod-us-east-2.grafana.net',
    'x-resplit-otel-exporter-path': '/otlp/v1/traces',
  })

  assert.deepEqual(verifier.readVerificationDiagnostics(headers), {
    authSource: 'OTEL_EXPORTER_OTLP_HEADERS',
    configured: true,
    endpointSource: 'OTEL_EXPORTER_OTLP_ENDPOINT',
    exporterHost: 'otlp-gateway-prod-us-east-2.grafana.net',
    exporterPath: '/otlp/v1/traces',
  })
})

test('formatMissingOtelConfigMessage makes missing Worker secrets explicit', async () => {
  const verifier = await import('../scripts/verify-grafana-tempo.mjs')

  assert.equal(
    verifier.formatMissingOtelConfigMessage({
      authSource: 'missing',
      configured: false,
      endpointSource: 'missing',
      exporterHost: null,
      exporterPath: null,
    }),
    'Verification route reports OTEL exporter not configured (endpointSource=missing, authSource=missing, exporter=unresolved)'
  )
})
