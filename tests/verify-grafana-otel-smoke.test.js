const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildGrafanaSmokeReport,
  extractLokiMatch,
  extractTempoMatch,
  missingGrafanaConfig,
  parseArgs,
  queryWindow,
} = require('../scripts/verify-grafana-otel-smoke.js')

test('parseArgs reads Grafana verifier env without leaking token into config names', () => {
  const options = parseArgs(['--skip-trigger', '--since-minutes', '15'], {
    GRAFANA_BASE_URL: 'https://example.grafana.net/',
    GRAFANA_API_TOKEN: 'secret-token',
    GRAFANA_TEMPO_DATASOURCE_UID: 'tempo-uid',
    GRAFANA_LOKI_DATASOURCE_UID: 'loki-uid',
  })

  assert.equal(options.baseUrl, 'https://example.grafana.net')
  assert.equal(options.token, 'secret-token')
  assert.equal(options.skipTrigger, true)
  assert.equal(options.sinceMinutes, 15)
  assert.deepEqual(missingGrafanaConfig(options), [])
})

test('buildGrafanaSmokeReport stays yellow when read-only Grafana config is missing', async () => {
  const report = await buildGrafanaSmokeReport({
    skipTrigger: true,
    triggerUrl: 'https://fx.resplit.app/health',
    baseUrl: null,
    token: null,
    tempoDatasourceUid: null,
    lokiDatasourceUid: null,
    tempoQuery: 'tempo-query',
    lokiQuery: 'loki-query',
    sinceMinutes: 60,
    timeoutMs: 1000,
    settleMs: 0,
  }, {
    now: () => '2026-05-25T05:30:00.000Z',
    fetch: async () => {
      throw new Error('should not query Grafana without config')
    },
  })

  assert.equal(report.status, 'yellow')
  assert.deepEqual(report.grafana.missingConfig, [
    'GRAFANA_BASE_URL',
    'GRAFANA_API_TOKEN',
    'GRAFANA_TEMPO_DATASOURCE_UID',
    'GRAFANA_LOKI_DATASOURCE_UID',
  ])
  assert.deepEqual(report.checks.map(check => check.id), [
    'worker-trigger',
    'grafana-read-config',
    'tempo-query',
    'loki-query',
  ])
  assert.equal(report.grafana.config.tokenConfigured, false)
  assert.equal(report.grafana.queryWindow.sinceMinutes, 60)
  assert.equal(report.checks.find(check => check.id === 'grafana-read-config').status, 'yellow')
  assert.match(report.checks.find(check => check.id === 'tempo-query').proof, /GRAFANA_TEMPO_DATASOURCE_UID/)
  assert.match(report.nextActions.join(' '), /missing Grafana base URL/)
  assert.match(report.summary, /Missing Grafana config/)
  assert.equal(JSON.stringify(report).includes('secret-token'), false)
})

test('buildGrafanaSmokeReport returns green when Tempo and Loki both match', async () => {
  const calls = []
  const report = await buildGrafanaSmokeReport({
    skipTrigger: false,
    triggerUrl: 'https://fx.resplit.app/health',
    baseUrl: 'https://example.grafana.net',
    token: 'secret-token',
    tempoDatasourceUid: 'tempo-uid',
    lokiDatasourceUid: 'loki-uid',
    tempoQuery: '{ resource.service.name =~ ".*resplit.*" }',
    lokiQuery: '{service_name=~".*resplit.*"}',
    sinceMinutes: 60,
    timeoutMs: 1000,
    settleMs: 0,
  }, {
    now: () => '2026-05-25T05:30:00.000Z',
    fetch: async (url, options = {}) => {
      calls.push({ url, options })
      if (url === 'https://fx.resplit.app/health') {
        return jsonResponse({ ok: true }, 200, { 'x-request-id': 'req_123' })
      }
      if (String(url).includes('/api/search?')) {
        return jsonResponse({
          traces: [{ traceID: '0123456789abcdef0123456789abcdef' }],
        })
      }
      if (String(url).includes('/loki/api/v1/query_range?')) {
        return jsonResponse({
          status: 'success',
          data: { result: [{ values: [['1', 'resplit log line']] }] },
        })
      }
      throw new Error(`unexpected URL: ${url}`)
    },
  })

  assert.equal(report.status, 'green')
  assert.equal(report.trigger.ok, true)
  assert.equal(report.trigger.requestId, 'req_123')
  assert.equal(report.grafana.tempo.matched, true)
  assert.equal(report.grafana.tempo.traceId, '0123456789abcdef0123456789abcdef')
  assert.equal(report.grafana.loki.matched, true)
  assert.equal(report.grafana.loki.resultCount, 1)
  assert.deepEqual(report.checks.map(check => check.status), ['green', 'green', 'green', 'green'])
  assert.deepEqual(report.nextActions, [])
  assert.equal(report.grafana.config.tokenConfigured, true)
  assert.equal(report.grafana.queryWindow.start, '2026-05-25T04:30:00.000Z')
  assert.equal(report.grafana.queryWindow.end, '2026-05-25T05:30:00.000Z')
  assert.equal(JSON.stringify(report).includes('secret-token'), false)

  const grafanaCalls = calls.filter(call => {
    const callUrl = new URL(String(call.url))
    return callUrl.protocol === 'https:' && callUrl.hostname === 'example.grafana.net'
  })
  assert.equal(grafanaCalls.length, 2)
  assert.equal(grafanaCalls.every(call => call.options.headers.authorization === 'Bearer secret-token'), true)
})

test('extractors understand common Tempo and Loki response shapes', () => {
  assert.deepEqual(extractTempoMatch({
    data: {
      traces: [{ traceId: 'abc123' }, { traceID: 'def456' }],
    },
  }), {
    matched: true,
    resultCount: 2,
    traceId: 'abc123',
  })

  assert.deepEqual(extractLokiMatch({
    data: {
      result: [
        { values: [['1', 'line one'], ['2', 'line two']] },
        { values: [] },
      ],
    },
  }), {
    matched: true,
    resultCount: 2,
  })
})

test('queryWindow emits Tempo seconds and Loki nanoseconds', () => {
  const window = queryWindow(new Date('2026-05-25T05:30:00.000Z'), 5)

  assert.equal(window.endSeconds - window.startSeconds, 300)
  assert.equal(BigInt(window.endNanoseconds) - BigInt(window.startNanoseconds), 300000000000n)
})

function jsonResponse(json, status = 200, headers = {}) {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  )
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: key => normalizedHeaders[String(key).toLowerCase()] || null,
    },
    text: async () => JSON.stringify(json),
  }
}
