const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildCloudflareDestinationsReport,
  missingCloudflareConfig,
  parseArgs,
  readWranglerExpectations,
  sanitizeDestination,
} = require('../scripts/verify-cloudflare-otel-destinations.js')

test('parseArgs reads Cloudflare verifier env without leaking token into config names', () => {
  const options = parseArgs(['--wrangler-env', 'production'], {
    CLOUDFLARE_ACCOUNT_ID: 'account-123',
    CLOUDFLARE_API_TOKEN: 'secret-token',
    CLOUDFLARE_API_BASE_URL: 'https://api.cloudflare.test/client/v4/',
  })

  assert.equal(options.accountId, 'account-123')
  assert.equal(options.token, 'secret-token')
  assert.equal(options.wranglerEnv, 'production')
  assert.equal(options.apiBaseUrl, 'https://api.cloudflare.test/client/v4')
  assert.deepEqual(missingCloudflareConfig(options), [])
})

test('readWranglerExpectations extracts first-party logs and traces destinations', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-cf-otel-'))
  const wranglerPath = path.join(repoDir, 'wrangler.jsonc')
  fs.writeFileSync(wranglerPath, JSON.stringify({
    name: 'resplit-fx',
    observability: {
      logs: { enabled: true, destinations: ['grafana-logs-prod'] },
      traces: { enabled: true, destinations: ['grafana-traces-prod'] },
    },
  }))

  const expectations = readWranglerExpectations(wranglerPath, '')

  assert.equal(expectations.workerName, 'resplit-fx')
  assert.equal(expectations.scope, 'top-level')
  assert.deepEqual(expectations.expected, [
    { stream: 'logs', name: 'grafana-logs-prod', dataset: 'opentelemetry-logs' },
    { stream: 'traces', name: 'grafana-traces-prod', dataset: 'opentelemetry-traces' },
  ])
})

test('buildCloudflareDestinationsReport stays yellow when read-only Cloudflare config is missing', async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-cf-otel-'))
  const wranglerPath = writeWrangler(repoDir)
  const report = await buildCloudflareDestinationsReport({
    wranglerPath,
    wranglerEnv: '',
    workerName: '',
    accountId: null,
    token: null,
    apiBaseUrl: 'https://api.cloudflare.test/client/v4',
    timeoutMs: 1000,
  }, {
    now: () => '2026-05-25T10:30:00.000Z',
    fetch: async () => {
      throw new Error('should not call Cloudflare without read config')
    },
  })

  assert.equal(report.status, 'yellow')
  assert.equal(report.worker, 'resplit-fx')
  assert.deepEqual(report.cloudflare.missingConfig, ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'])
  assert.deepEqual(report.checks.map(check => check.id), ['wrangler-otel-destinations', 'cloudflare-read-config'])
  assert.equal(report.checks.find(check => check.id === 'cloudflare-read-config').status, 'yellow')
  assert.match(report.summary, /Missing Cloudflare read config/)
})

test('buildCloudflareDestinationsReport returns green when dashboard destinations match wrangler', async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-cf-otel-'))
  const wranglerPath = writeWrangler(repoDir)
  const calls = []
  const report = await buildCloudflareDestinationsReport({
    wranglerPath,
    wranglerEnv: '',
    workerName: '',
    accountId: 'account-123',
    token: 'secret-token',
    apiBaseUrl: 'https://api.cloudflare.test/client/v4',
    timeoutMs: 1000,
  }, {
    now: () => '2026-05-25T10:30:00.000Z',
    fetch: async (url, options = {}) => {
      calls.push({ url: String(url), options })
      return jsonResponse({
        success: true,
        result: [
          cloudflareDestination('grafana-logs-prod', 'opentelemetry-logs'),
          cloudflareDestination('grafana-traces-prod', 'opentelemetry-traces'),
        ],
      })
    },
  })

  assert.equal(report.status, 'green')
  assert.equal(report.cloudflare.destinationCount, 2)
  assert.deepEqual(report.checks.map(check => check.status), ['green', 'green', 'green', 'green'])
  assert.equal(report.summary, 'Cloudflare Workers Observability destinations match wrangler.jsonc.')
  assert.equal(JSON.stringify(report).includes('secret-token'), false)
  assert.equal(JSON.stringify(report).includes('Basic abc123'), false)
  assert.equal(calls[0].options.headers.authorization, 'Bearer secret-token')
  assert.match(calls[0].url, /workers\/observability\/destinations/)
})

test('buildCloudflareDestinationsReport redacts headers and flags dataset mismatches', async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-cf-otel-'))
  const wranglerPath = writeWrangler(repoDir)
  const report = await buildCloudflareDestinationsReport({
    wranglerPath,
    wranglerEnv: '',
    workerName: '',
    accountId: 'account-123',
    token: 'secret-token',
    apiBaseUrl: 'https://api.cloudflare.test/client/v4',
    timeoutMs: 1000,
  }, {
    now: () => '2026-05-25T10:30:00.000Z',
    fetch: async () => jsonResponse({
      success: true,
      result: [
        cloudflareDestination('grafana-logs-prod', 'opentelemetry-traces'),
        cloudflareDestination('grafana-traces-prod', 'opentelemetry-traces'),
      ],
    }),
  })

  assert.equal(report.status, 'red')
  assert.match(report.summary, /dataset=opentelemetry-traces, expected opentelemetry-logs/)
  assert.equal(JSON.stringify(report).includes('Basic abc123'), false)
  assert.deepEqual(report.destinations[0].configuration.headerNames, ['Authorization'])
})

test('sanitizeDestination preserves destination shape without header values', () => {
  const sanitized = sanitizeDestination(cloudflareDestination('grafana-logs-prod', 'opentelemetry-logs'))

  assert.equal(sanitized.name, 'grafana-logs-prod')
  assert.equal(sanitized.configuration.urlHost, 'otlp-gateway-prod-us-east-2.grafana.net')
  assert.deepEqual(sanitized.configuration.headerNames, ['Authorization'])
  assert.equal(JSON.stringify(sanitized).includes('Basic abc123'), false)
})

function writeWrangler(repoDir) {
  const wranglerPath = path.join(repoDir, 'wrangler.jsonc')
  fs.writeFileSync(wranglerPath, JSON.stringify({
    name: 'resplit-fx',
    observability: {
      logs: { enabled: true, destinations: ['grafana-logs-prod'] },
      traces: { enabled: true, destinations: ['grafana-traces-prod'] },
    },
  }))
  return wranglerPath
}

function cloudflareDestination(name, logpushDataset) {
  return {
    name,
    slug: `${name}-slug`,
    enabled: true,
    scripts: ['resplit-fx'],
    configuration: {
      type: 'logpush',
      logpushDataset,
      url: 'https://otlp-gateway-prod-us-east-2.grafana.net/otlp/v1/logs',
      headers: {
        Authorization: 'Basic abc123',
      },
      jobStatus: {
        last_complete: '2026-05-25T10:20:00Z',
        last_error: null,
        error_message: null,
      },
    },
  }
}

function jsonResponse(json, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(json),
  }
}
