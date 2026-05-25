#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const DEFAULT_OUTPUT = path.join('reports', 'grafana-otel-smoke.json')
const DEFAULT_TRIGGER_URL = 'https://fx.resplit.app/health'
const DEFAULT_TEMPO_QUERY = '{ resource.service.name =~ ".*resplit.*" }'
const DEFAULT_LOKI_QUERY = '{service_name=~".*resplit.*"}'
const DEFAULT_SINCE_MINUTES = 60
const DEFAULT_TIMEOUT_MS = 10000
const DEFAULT_SETTLE_MS = 0

if (require.main === module) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`verify-grafana-otel-smoke: FAILED\n${error.stack || error.message}`)
    process.exitCode = 1
  })
}

async function main(argv, deps = {}) {
  const options = parseArgs(argv, process.env)
  if (options.help) {
    process.stdout.write(helpText())
    return
  }

  const report = await buildGrafanaSmokeReport(options, deps)
  writeJson(options.output, report)

  const summary = `${report.status}: tempo=${report.grafana.tempo.matched ? 'matched' : 'missing'} loki=${report.grafana.loki.matched ? 'matched' : 'missing'} output=${options.output}`
  if (options.printJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(`verify-grafana-otel-smoke: ${summary}\n`)
  }

  process.exitCode = report.status === 'green' ? 0 : report.status === 'yellow' ? 2 : 1
}

function parseArgs(argv, env = process.env) {
  const options = {
    help: false,
    printJson: false,
    output: env.GRAFANA_OTEL_SMOKE_OUTPUT || DEFAULT_OUTPUT,
    baseUrl: firstEnv(env, ['GRAFANA_BASE_URL', 'GRAFANA_URL', 'GRAFANA_CLOUD_URL']),
    token: firstEnv(env, ['GRAFANA_API_TOKEN', 'GRAFANA_SERVICE_ACCOUNT_TOKEN', 'GRAFANA_TOKEN']),
    tempoDatasourceUid: firstEnv(env, ['GRAFANA_TEMPO_DATASOURCE_UID', 'GRAFANA_TEMPO_UID', 'TEMPO_DATASOURCE_UID']),
    lokiDatasourceUid: firstEnv(env, ['GRAFANA_LOKI_DATASOURCE_UID', 'GRAFANA_LOKI_UID', 'LOKI_DATASOURCE_UID']),
    tempoQuery: env.GRAFANA_TEMPO_QUERY || DEFAULT_TEMPO_QUERY,
    lokiQuery: env.GRAFANA_LOKI_QUERY || DEFAULT_LOKI_QUERY,
    triggerUrl: env.GRAFANA_OTEL_TRIGGER_URL || DEFAULT_TRIGGER_URL,
    skipTrigger: truthy(env.GRAFANA_OTEL_SKIP_TRIGGER),
    sinceMinutes: Number(env.GRAFANA_OTEL_SINCE_MINUTES || DEFAULT_SINCE_MINUTES),
    timeoutMs: Number(env.GRAFANA_OTEL_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    settleMs: Number(env.GRAFANA_OTEL_SETTLE_MS || DEFAULT_SETTLE_MS),
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
    case '--help':
    case '-h':
      options.help = true
      break
    case '--json':
      options.printJson = true
      break
    case '--output':
      options.output = requireValue(argv, index, arg)
      index += 1
      break
    case '--base-url':
      options.baseUrl = requireValue(argv, index, arg)
      index += 1
      break
    case '--tempo-uid':
      options.tempoDatasourceUid = requireValue(argv, index, arg)
      index += 1
      break
    case '--loki-uid':
      options.lokiDatasourceUid = requireValue(argv, index, arg)
      index += 1
      break
    case '--tempo-query':
      options.tempoQuery = requireValue(argv, index, arg)
      index += 1
      break
    case '--loki-query':
      options.lokiQuery = requireValue(argv, index, arg)
      index += 1
      break
    case '--trigger-url':
      options.triggerUrl = requireValue(argv, index, arg)
      index += 1
      break
    case '--skip-trigger':
      options.skipTrigger = true
      break
    case '--since-minutes':
      options.sinceMinutes = Number(requireValue(argv, index, arg))
      index += 1
      break
    case '--timeout-ms':
      options.timeoutMs = Number(requireValue(argv, index, arg))
      index += 1
      break
    case '--settle-ms':
      options.settleMs = Number(requireValue(argv, index, arg))
      index += 1
      break
    default:
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  options.baseUrl = normalizeBaseUrl(options.baseUrl)
  options.sinceMinutes = positiveNumber(options.sinceMinutes, DEFAULT_SINCE_MINUTES)
  options.timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS)
  options.settleMs = Math.max(0, Number.isFinite(options.settleMs) ? options.settleMs : DEFAULT_SETTLE_MS)
  return options
}

function requireValue(argv, index, arg) {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${arg} requires a value`)
  }
  return value
}

function helpText() {
  return [
    'Usage: node scripts/verify-grafana-otel-smoke.js [options]',
    '',
    'Read-only Grafana Tempo/Loki smoke proof for the Resplit FX Worker.',
    'Writes reports/grafana-otel-smoke.json, which the reliability cockpit reads.',
    '',
    'Required env for green proof:',
    '  GRAFANA_BASE_URL or GRAFANA_URL',
    '  GRAFANA_API_TOKEN or GRAFANA_SERVICE_ACCOUNT_TOKEN',
    '  GRAFANA_TEMPO_DATASOURCE_UID',
    '  GRAFANA_LOKI_DATASOURCE_UID',
    '',
    'Useful env/options:',
    '  GRAFANA_OTEL_SMOKE_OUTPUT / --output',
    '  GRAFANA_TEMPO_QUERY / --tempo-query',
    '  GRAFANA_LOKI_QUERY / --loki-query',
    '  GRAFANA_OTEL_TRIGGER_URL / --trigger-url',
    '  --skip-trigger',
    '  --since-minutes 60',
    '',
  ].join('\n')
}

async function buildGrafanaSmokeReport(options, deps = {}) {
  const now = deps.now ? new Date(deps.now()) : new Date()
  const fetchImpl = deps.fetch || global.fetch
  const missingConfig = missingGrafanaConfig(options)
  const window = queryWindow(now, options.sinceMinutes)
  const sourceIdentity = deps.sourceIdentity || readSourceIdentity(deps.repoDir || process.cwd(), deps)
  const report = {
    checkedAt: now.toISOString(),
    status: 'yellow',
    worker: 'resplit-fx',
    sourceIdentity,
    trigger: {
      skipped: options.skipTrigger,
      url: options.skipTrigger ? null : options.triggerUrl,
      ok: false,
      status: null,
      requestId: null,
      error: null,
    },
    grafana: {
      baseUrl: options.baseUrl || null,
      missingConfig,
      config: {
        baseUrlConfigured: Boolean(options.baseUrl),
        tokenConfigured: Boolean(options.token),
        tempoDatasourceUidConfigured: Boolean(options.tempoDatasourceUid),
        lokiDatasourceUidConfigured: Boolean(options.lokiDatasourceUid),
      },
      queryWindow: {
        sinceMinutes: options.sinceMinutes,
        start: window.startIso,
        end: window.endIso,
      },
      tempo: {
        matched: false,
        datasourceUid: options.tempoDatasourceUid || null,
        query: options.tempoQuery,
        traceId: null,
        resultCount: 0,
        status: null,
        error: null,
      },
      loki: {
        matched: false,
        datasourceUid: options.lokiDatasourceUid || null,
        query: options.lokiQuery,
        resultCount: 0,
        status: null,
        error: null,
      },
    },
    checks: [],
    nextActions: [],
    summary: '',
  }

  if (typeof fetchImpl !== 'function') {
    report.status = 'red'
    report.summary = 'Fetch API is unavailable in this Node runtime.'
    report.checks = buildGrafanaSmokeChecks(report, options, missingConfig)
    report.nextActions = summarizeNextActions(report.checks)
    return report
  }

  if (!options.skipTrigger && options.triggerUrl) {
    report.trigger = await triggerWorker(fetchImpl, options)
    if (options.settleMs > 0) {
      await sleep(options.settleMs)
    }
  }

  if (missingConfig.length > 0) {
    report.summary = `Missing Grafana config: ${missingConfig.join(', ')}.`
    report.checks = buildGrafanaSmokeChecks(report, options, missingConfig)
    report.nextActions = summarizeNextActions(report.checks)
    return report
  }

  const [tempo, loki] = await Promise.all([
    queryTempo(fetchImpl, options, window),
    queryLoki(fetchImpl, options, window),
  ])
  report.grafana.tempo = { ...report.grafana.tempo, ...tempo }
  report.grafana.loki = { ...report.grafana.loki, ...loki }

  if (tempo.error || loki.error) {
    report.status = 'red'
    report.summary = `Grafana query failed: tempo=${tempo.error || 'ok'}; loki=${loki.error || 'ok'}.`
  } else if (tempo.matched && loki.matched) {
    report.status = 'green'
    report.summary = `Grafana Tempo and Loki both matched Resplit FX Worker telemetry in the last ${options.sinceMinutes} minute(s).`
  } else {
    report.status = 'yellow'
    report.summary = `Grafana queries ran, but telemetry is incomplete: tempo=${tempo.matched ? 'matched' : 'missing'}, loki=${loki.matched ? 'matched' : 'missing'}.`
  }

  report.checks = buildGrafanaSmokeChecks(report, options, missingConfig)
  report.nextActions = summarizeNextActions(report.checks)
  return report
}

async function triggerWorker(fetchImpl, options) {
  try {
    const response = await fetchWithTimeout(fetchImpl, options.triggerUrl, {
      timeoutMs: options.timeoutMs,
      headers: { accept: 'application/json,text/plain,*/*' },
    })
    return {
      skipped: false,
      url: options.triggerUrl,
      ok: response.ok,
      status: response.status,
      requestId: response.headers.get('x-request-id') || response.headers.get('cf-ray') || null,
      error: response.ok ? null : `trigger returned HTTP ${response.status}`,
    }
  } catch (error) {
    return {
      skipped: false,
      url: options.triggerUrl,
      ok: false,
      status: null,
      requestId: null,
      error: error.message,
    }
  }
}

async function queryTempo(fetchImpl, options, window) {
  const params = new URLSearchParams({
    q: options.tempoQuery,
    start: String(window.startSeconds),
    end: String(window.endSeconds),
    limit: '20',
  })
  const url = `${options.baseUrl}/api/datasources/proxy/uid/${encodeURIComponent(options.tempoDatasourceUid)}/api/search?${params.toString()}`
  const response = await fetchGrafanaJson(fetchImpl, url, options)
  if (response.error) {
    return { status: response.status, error: response.error }
  }
  return {
    status: response.status,
    error: null,
    ...extractTempoMatch(response.json),
  }
}

async function queryLoki(fetchImpl, options, window) {
  const params = new URLSearchParams({
    query: options.lokiQuery,
    start: String(window.startNanoseconds),
    end: String(window.endNanoseconds),
    limit: '20',
  })
  const url = `${options.baseUrl}/api/datasources/proxy/uid/${encodeURIComponent(options.lokiDatasourceUid)}/loki/api/v1/query_range?${params.toString()}`
  const response = await fetchGrafanaJson(fetchImpl, url, options)
  if (response.error) {
    return { status: response.status, error: response.error }
  }
  return {
    status: response.status,
    error: null,
    ...extractLokiMatch(response.json),
  }
}

async function fetchGrafanaJson(fetchImpl, url, options) {
  try {
    const response = await fetchWithTimeout(fetchImpl, url, {
      timeoutMs: options.timeoutMs,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${options.token}`,
      },
    })
    const text = await response.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      return { status: response.status, error: `HTTP ${response.status} returned non-JSON response` }
    }
    if (!response.ok) {
      return { status: response.status, error: json?.message || json?.error || `HTTP ${response.status}` }
    }
    return { status: response.status, json, error: null }
  } catch (error) {
    return { status: null, json: null, error: error.message }
  }
}

async function fetchWithTimeout(fetchImpl, url, options = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS)
  try {
    return await fetchImpl(url, {
      method: 'GET',
      headers: options.headers || {},
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }
}

function extractTempoMatch(json) {
  const traces = Array.isArray(json?.traces)
    ? json.traces
    : Array.isArray(json?.data?.traces)
      ? json.data.traces
      : Array.isArray(json?.data)
        ? json.data
        : []
  const first = traces[0] || {}
  const traceId = first.traceID || first.traceId || first.trace_id || first.id || null
  return {
    matched: traces.length > 0,
    resultCount: traces.length,
    traceId,
  }
}

function extractLokiMatch(json) {
  const result = Array.isArray(json?.data?.result) ? json.data.result : []
  const valueCount = result.reduce((sum, item) => sum + (Array.isArray(item.values) ? item.values.length : 0), 0)
  return {
    matched: result.length > 0 && valueCount > 0,
    resultCount: valueCount,
  }
}

function queryWindow(now, sinceMinutes) {
  const endMs = now.getTime()
  const startMs = endMs - sinceMinutes * 60 * 1000
  return {
    startSeconds: Math.floor(startMs / 1000),
    endSeconds: Math.floor(endMs / 1000),
    startNanoseconds: String(BigInt(startMs) * 1000000n),
    endNanoseconds: String(BigInt(endMs) * 1000000n),
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
  }
}

function buildGrafanaSmokeChecks(report, options, missingConfig) {
  const triggerStatus = options.skipTrigger
    ? 'yellow'
    : report.trigger.ok
      ? 'green'
      : 'red'
  const triggerProof = options.skipTrigger
    ? 'Worker trigger skipped by --skip-trigger.'
    : report.trigger.ok
      ? `Worker trigger returned HTTP ${report.trigger.status}${report.trigger.requestId ? ` with request id ${report.trigger.requestId}` : ''}.`
      : `Worker trigger did not produce a successful request${report.trigger.error ? `: ${report.trigger.error}` : '.'}`

  const configStatus = missingConfig.length > 0 ? 'yellow' : 'green'
  const configProof = missingConfig.length > 0
    ? `Missing ${missingConfig.join(', ')}.`
    : 'Grafana base URL, read token, Tempo UID, and Loki UID are configured; token is redacted.'

  return [
    {
      id: 'worker-trigger',
      label: 'Worker request trigger',
      status: triggerStatus,
      proof: triggerProof,
      nextAction: triggerStatus === 'green'
        ? 'Keep triggering the same Worker route before Grafana queries when you need fresh-request proof.'
        : 'Run without --skip-trigger after Cloudflare destinations exist so the smoke creates fresh trace and log candidates.',
    },
    {
      id: 'grafana-read-config',
      label: 'Grafana read configuration',
      status: configStatus,
      proof: configProof,
      nextAction: configStatus === 'green'
        ? 'Keep using read-only Grafana credentials; never commit tokens into git.'
        : 'Set the missing Grafana base URL and datasource UID env vars locally, with the read token kept out of reports and git.',
    },
    {
      id: 'tempo-query',
      label: 'Tempo trace query',
      status: classifyQueryCheck(report.grafana.tempo, missingConfig, ['GRAFANA_BASE_URL', 'GRAFANA_API_TOKEN', 'GRAFANA_TEMPO_DATASOURCE_UID']),
      proof: summarizeTempoProof(report.grafana.tempo, missingConfig),
      nextAction: report.grafana.tempo.matched
        ? 'Keep the trace id attached to the evidence artifact.'
        : 'Verify the Cloudflare traces destination and query window, then rerun until Tempo returns at least one trace.',
    },
    {
      id: 'loki-query',
      label: 'Loki log query',
      status: classifyQueryCheck(report.grafana.loki, missingConfig, ['GRAFANA_BASE_URL', 'GRAFANA_API_TOKEN', 'GRAFANA_LOKI_DATASOURCE_UID']),
      proof: summarizeLokiProof(report.grafana.loki, missingConfig),
      nextAction: report.grafana.loki.matched
        ? 'Keep the Loki result count attached to the evidence artifact.'
        : 'Verify the Cloudflare logs destination and LogQL selector, then rerun until Loki returns at least one log line.',
    },
  ]
}

function classifyQueryCheck(queryResult, missingConfig, blockers) {
  if (missingConfig.some(item => blockers.includes(item))) {
    return 'yellow'
  }
  if (queryResult.error) {
    return 'red'
  }
  return queryResult.matched ? 'green' : 'yellow'
}

function summarizeTempoProof(tempo, missingConfig) {
  const blockers = missingConfig.filter(item => ['GRAFANA_BASE_URL', 'GRAFANA_API_TOKEN', 'GRAFANA_TEMPO_DATASOURCE_UID'].includes(item))
  if (blockers.length > 0) {
    return `Tempo query blocked by missing config: ${blockers.join(', ')}.`
  }
  if (tempo.error) {
    return `Tempo query failed${tempo.status ? ` with HTTP ${tempo.status}` : ''}: ${tempo.error}.`
  }
  if (tempo.matched) {
    return `Tempo matched ${tempo.resultCount} trace result(s)${tempo.traceId ? `; trace id ${tempo.traceId}` : ''}.`
  }
  return 'Tempo query ran but returned no trace results.'
}

function summarizeLokiProof(loki, missingConfig) {
  const blockers = missingConfig.filter(item => ['GRAFANA_BASE_URL', 'GRAFANA_API_TOKEN', 'GRAFANA_LOKI_DATASOURCE_UID'].includes(item))
  if (blockers.length > 0) {
    return `Loki query blocked by missing config: ${blockers.join(', ')}.`
  }
  if (loki.error) {
    return `Loki query failed${loki.status ? ` with HTTP ${loki.status}` : ''}: ${loki.error}.`
  }
  if (loki.matched) {
    return `Loki matched ${loki.resultCount} log line(s).`
  }
  return 'Loki query ran but returned no log lines.'
}

function summarizeNextActions(checks) {
  return Array.from(new Set(
    checks
      .filter(check => check.status !== 'green')
      .map(check => check.nextAction)
      .filter(Boolean),
  ))
}

function readSourceIdentity(repoDir = process.cwd(), deps = {}) {
  const run = deps.execFileSync || execFileSync
  const git = args => String(run('git', ['-C', repoDir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })).trim()

  try {
    const root = git(['rev-parse', '--show-toplevel']) || repoDir
    const statusRows = git(['status', '--porcelain=v1', '--untracked-files=all'])
      .split('\n')
      .filter(Boolean)
    return {
      status: 'ok',
      repoPath: root,
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
      head: git(['rev-parse', '--short=12', 'HEAD']),
      headFull: git(['rev-parse', 'HEAD']),
      dirtyCount: statusRows.length,
    }
  } catch (error) {
    return {
      status: 'unavailable',
      repoPath: path.resolve(repoDir),
      branch: null,
      head: null,
      headFull: null,
      dirtyCount: null,
      error: error.message,
    }
  }
}

function missingGrafanaConfig(options) {
  const missing = []
  if (!options.baseUrl) missing.push('GRAFANA_BASE_URL')
  if (!options.token) missing.push('GRAFANA_API_TOKEN')
  if (!options.tempoDatasourceUid) missing.push('GRAFANA_TEMPO_DATASOURCE_UID')
  if (!options.lokiDatasourceUid) missing.push('GRAFANA_LOKI_DATASOURCE_UID')
  return missing
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function firstEnv(env, names) {
  for (const name of names) {
    if (env[name]) {
      return env[name]
    }
  }
  return null
}

function normalizeBaseUrl(value) {
  if (!value) {
    return null
  }
  return String(value).replace(/\/+$/, '')
}

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ''))
}

function positiveNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

module.exports = {
  buildGrafanaSmokeChecks,
  buildGrafanaSmokeReport,
  extractLokiMatch,
  extractTempoMatch,
  missingGrafanaConfig,
  parseArgs,
  queryWindow,
  readSourceIdentity,
}
