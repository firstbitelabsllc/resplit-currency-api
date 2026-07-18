const test = require('node:test')
const assert = require('node:assert/strict')

const {
  KNOWN_SOURCES,
  buildOtlpMetricsPayload,
  resolveOtlpConfig,
  snapshotAgeSeconds,
  countDataPoints
} = require('../scripts/push-pipeline-metrics')

const NOW = new Date('2026-07-03T13:05:00Z')

function metrics(payload) {
  return payload.resourceMetrics[0].scopeMetrics[0].metrics
}

function metricByName(payload, name) {
  return metrics(payload).find((m) => m.name === name)
}

test('resolveOtlpConfig no-ops when nothing is configured', () => {
  const config = resolveOtlpConfig({})
  assert.equal(config.endpoint, null)
  assert.equal(config.authorization, null)
})

test('resolveOtlpConfig appends /v1/metrics and builds Basic auth from instance id + token', () => {
  const config = resolveOtlpConfig({
    GRAFANA_OTLP_ENDPOINT: 'https://otlp-gateway-prod-us.grafana.net/otlp',
    GRAFANA_OTLP_INSTANCE_ID: '12345',
    GRAFANA_OTLP_API_TOKEN: 'secret-token'
  })
  assert.equal(config.endpoint, 'https://otlp-gateway-prod-us.grafana.net/otlp/v1/metrics')
  assert.equal(config.authorization, `Basic ${Buffer.from('12345:secret-token').toString('base64')}`)
})

test('resolveOtlpConfig honors a ready-made Authorization header and full metrics URL', () => {
  const config = resolveOtlpConfig({
    GRAFANA_OTLP_METRICS_ENDPOINT: 'https://example.grafana.net/otlp/v1/metrics',
    GRAFANA_OTLP_AUTHORIZATION: 'Basic abc123'
  })
  assert.equal(config.endpoint, 'https://example.grafana.net/otlp/v1/metrics')
  assert.equal(config.authorization, 'Basic abc123')
})

test('snapshotAgeSeconds uses generatedAt and never goes negative', () => {
  const age = snapshotAgeSeconds({ generatedAt: '2026-07-03T13:00:00Z' }, NOW)
  assert.equal(age, 300) // 5 minutes
  const future = snapshotAgeSeconds({ generatedAt: '2026-07-03T14:00:00Z' }, NOW)
  assert.equal(future, 0)
})

test('snapshotAgeSeconds falls back to latestDate at midnight UTC', () => {
  const age = snapshotAgeSeconds({ latestDate: '2026-07-03' }, NOW)
  assert.equal(age, 13 * 3600 + 5 * 60)
})

test('buildOtlpMetricsPayload emits the full metric contract for a healthy dual-source publish', () => {
  const payload = buildOtlpMetricsPayload({
    meta: {
      generatedAt: '2026-07-03T13:00:00Z',
      latestDate: '2026-07-03',
      currencyCount: 166,
      sources: ['er-api', 'frankfurter']
    },
    publishDurationSeconds: 12.5,
    now: NOW,
    knownSources: KNOWN_SOURCES
  })

  assert.equal(metricByName(payload, 'fx_snapshot_age_seconds').gauge.dataPoints[0].asDouble, 300)
  assert.equal(metricByName(payload, 'fx_currencies_count').gauge.dataPoints[0].asDouble, 166)
  assert.equal(metricByName(payload, 'fx_publish_duration_seconds').gauge.dataPoints[0].asDouble, 12.5)

  const sourcePoints = metricByName(payload, 'fx_source_available').gauge.dataPoints
  const bySource = Object.fromEntries(
    sourcePoints.map((p) => [p.attributes.find((a) => a.key === 'source').value.stringValue, p.asDouble])
  )
  assert.deepEqual(bySource, { 'er-api': 1, frankfurter: 1 })

  // service.name resource attribute present.
  assert.equal(
    payload.resourceMetrics[0].resource.attributes[0].value.stringValue,
    'resplit-fx-pipeline'
  )
})

test('buildOtlpMetricsPayload marks a down source as 0 (degraded publish)', () => {
  const payload = buildOtlpMetricsPayload({
    meta: { generatedAt: NOW.toISOString(), currencyCount: 30, sources: ['frankfurter'] },
    now: NOW,
    knownSources: KNOWN_SOURCES
  })
  const sourcePoints = metricByName(payload, 'fx_source_available').gauge.dataPoints
  const bySource = Object.fromEntries(
    sourcePoints.map((p) => [p.attributes.find((a) => a.key === 'source').value.stringValue, p.asDouble])
  )
  assert.deepEqual(bySource, { 'er-api': 0, frankfurter: 1 })
})

test('buildOtlpMetricsPayload omits publish duration when unknown', () => {
  const payload = buildOtlpMetricsPayload({
    meta: { generatedAt: NOW.toISOString(), currencyCount: 166, sources: ['er-api', 'frankfurter'] },
    publishDurationSeconds: null,
    now: NOW,
    knownSources: KNOWN_SOURCES
  })
  assert.equal(metricByName(payload, 'fx_publish_duration_seconds'), undefined)
  // age + currencies + source availability = 3 metric series.
  assert.equal(countDataPoints(payload), 1 + 1 + 2)
})
