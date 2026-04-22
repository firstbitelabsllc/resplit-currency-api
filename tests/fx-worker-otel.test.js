const test = require('node:test')
const assert = require('node:assert/strict')

test('normalizeFxTraceEndpoint appends /v1/traces to Grafana OTLP base endpoints', async () => {
  const otel = await import('../worker/src/otel.mjs')

  assert.equal(
    otel.normalizeFxTraceEndpoint('https://otlp-gateway-prod-us-east-2.grafana.net/otlp'),
    'https://otlp-gateway-prod-us-east-2.grafana.net/otlp/v1/traces'
  )
  assert.equal(
    otel.normalizeFxTraceEndpoint('https://otlp.example.com/v1/traces'),
    'https://otlp.example.com/v1/traces'
  )
})

test('parseFxOtelHeaders parses standard OTEL_EXPORTER_OTLP_HEADERS strings', async () => {
  const otel = await import('../worker/src/otel.mjs')

  assert.deepEqual(
    otel.parseFxOtelHeaders('Authorization=Basic abc123,X-Scope-OrgID=tenant-1'),
    {
      Authorization: 'Basic abc123',
      'X-Scope-OrgID': 'tenant-1',
    }
  )
  assert.equal(otel.parseFxOtelHeaders('Basic abc123'), null)
})

test('resolveFxOtelTraceConfig supports Grafana standard env vars', async () => {
  const otel = await import('../worker/src/otel.mjs')

  assert.deepEqual(
    otel.resolveFxOtelTraceConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp-gateway-prod-us-east-2.grafana.net/otlp',
      OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Basic grafana-token',
      SENTRY_RELEASE: 'sha-otel-123',
    }),
    {
      exporter: {
        url: 'https://otlp-gateway-prod-us-east-2.grafana.net/otlp/v1/traces',
        headers: {
          Authorization: 'Basic grafana-token',
        },
      },
      service: {
        name: 'resplit-currency-api-worker',
        namespace: 'resplit',
        version: 'sha-otel-123',
      },
    }
  )
})

test('resolveFxOtelTraceConfig supports repo alias env vars for Worker secrets', async () => {
  const otel = await import('../worker/src/otel.mjs')

  assert.deepEqual(
    otel.resolveFxOtelTraceConfig({
      OTEL_ENDPOINT: 'https://otlp-gateway-prod-us-east-2.grafana.net/otlp',
      OTEL_AUTH_HEADER: 'Basic grafana-token',
    }),
    {
      exporter: {
        url: 'https://otlp-gateway-prod-us-east-2.grafana.net/otlp/v1/traces',
        headers: {
          Authorization: 'Basic grafana-token',
        },
      },
      service: {
        name: 'resplit-currency-api-worker',
        namespace: 'resplit',
        version: undefined,
      },
    }
  )
})

test('resolveFxOtelTraceConfig returns null when endpoint or auth is missing', async () => {
  const otel = await import('../worker/src/otel.mjs')

  assert.equal(
    otel.resolveFxOtelTraceConfig({
      OTEL_ENDPOINT: 'https://otlp-gateway-prod-us-east-2.grafana.net/otlp',
    }),
    null
  )
  assert.equal(
    otel.resolveFxOtelTraceConfig({
      OTEL_AUTH_HEADER: 'Basic grafana-token',
    }),
    null
  )
})

test('coverage verification span naming is request-id scoped', async () => {
  const verification = await import('../worker/src/otel-verification.mjs')

  assert.equal(
    verification.buildFxCoverageVerificationSpanName('req-123'),
    'resplit.fx.coverage.verify.req-123'
  )
})

test('coverage verification only runs when the explicit header is present', async () => {
  const verification = await import('../worker/src/otel-verification.mjs')

  const enabledRequest = new Request('https://fx.resplit.app/coverage', {
    headers: {
      'x-resplit-otel-verify': '1',
    },
  })
  const disabledRequest = new Request('https://fx.resplit.app/coverage')

  assert.equal(verification.shouldEmitFxCoverageVerification(enabledRequest), true)
  assert.equal(verification.shouldEmitFxCoverageVerification(disabledRequest), false)
})
