#!/usr/bin/env node

/**
 * Push publish-pipeline metrics to Grafana Cloud via OTLP-HTTP/JSON (Phase 3).
 *
 * Runs after "Validate generated artifacts" in .github/workflows/run.yml as a
 * continue-on-error step: it is a hard no-op (exit 0) whenever the OTLP endpoint
 * or auth env is absent, so it never blocks a publish and never fails CI while
 * Grafana credentials are still being provisioned.
 *
 * Metric contract (matches grafana/dashboards/resplit-fx.json):
 *   fx_snapshot_age_seconds       gauge   age of the freshly published snapshot
 *   fx_source_available{source}   gauge   1 = source contributed, 0 = absent
 *   fx_currencies_count           gauge   published currency count
 *   fx_publish_duration_seconds   gauge   wall time of the publish job (optional)
 *
 * We use OTLP-HTTP/JSON (not Prometheus remote-write): the repo already
 * standardizes on OTLP for the Worker, and hand-rolling snappy-framed protobuf
 * remote-write from a CI step is needlessly fragile.
 */

const fs = require('node:fs')
const path = require('node:path')

const KNOWN_SOURCES = ['er-api', 'frankfurter']
const DEFAULT_META_PATH = path.join('package', 'meta.json')
const DEFAULT_SERVICE_NAME = 'resplit-fx-pipeline'
const DEFAULT_TIMEOUT_MS = 10000

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    // Never hard-fail the publish on a telemetry hiccup — mirror continue-on-error.
    console.warn(`push-pipeline-metrics: non-fatal error: ${error.message}`)
    process.exitCode = 0
  })
}

async function main(argv, deps = {}) {
  const env = deps.env || process.env
  const now = deps.now ? new Date(deps.now()) : new Date()
  const fetchImpl = deps.fetch || global.fetch

  const options = parseArgs(argv, env)
  const config = resolveOtlpConfig(env)
  if (!config.endpoint || !config.authorization) {
    console.log(
      `push-pipeline-metrics: skipped — OTLP not configured (missing ${!config.endpoint ? 'endpoint' : ''}${!config.endpoint && !config.authorization ? ' + ' : ''}${!config.authorization ? 'authorization' : ''}). No-op.`
    )
    return
  }

  const meta = readMeta(options.metaPath)
  if (!meta) {
    console.warn(`push-pipeline-metrics: no meta at ${options.metaPath}; nothing to push.`)
    return
  }

  const payload = buildOtlpMetricsPayload({
    meta,
    publishDurationSeconds: options.publishDurationSeconds,
    now,
    knownSources: KNOWN_SOURCES,
    serviceName: config.serviceName
  })

  if (typeof fetchImpl !== 'function') {
    console.warn('push-pipeline-metrics: fetch unavailable in this runtime; skipping.')
    return
  }

  const result = await postOtlp(fetchImpl, config, payload, options.timeoutMs)
  if (result.ok) {
    console.log(`push-pipeline-metrics: OK — pushed ${countDataPoints(payload)} data point(s) to ${config.endpoint}`)
  } else {
    console.warn(`push-pipeline-metrics: push failed (HTTP ${result.status ?? 'n/a'}): ${result.error ?? 'unknown'}`)
  }
}

function parseArgs(argv, env = process.env) {
  const options = {
    metaPath: env.FX_META_PATH || DEFAULT_META_PATH,
    publishDurationSeconds: numberOrNull(env.FX_PUBLISH_DURATION_SECONDS),
    timeoutMs: positiveNumber(Number(env.GRAFANA_OTLP_TIMEOUT_MS), DEFAULT_TIMEOUT_MS)
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--meta') {
      options.metaPath = argv[++index]
    } else if (arg === '--publish-duration-seconds') {
      options.publishDurationSeconds = numberOrNull(argv[++index])
    }
  }
  return options
}

/**
 * Resolve the Grafana Cloud OTLP endpoint + auth header from env. Supports either
 * a ready-made Authorization header or an instance-id/token pair (Grafana Cloud
 * OTLP uses HTTP Basic with `instanceID:apiToken`).
 */
function resolveOtlpConfig(env = process.env) {
  let endpoint = firstEnv(env, ['GRAFANA_OTLP_METRICS_ENDPOINT', 'GRAFANA_OTLP_ENDPOINT'])
  if (endpoint && !/\/v1\/metrics$/.test(endpoint)) {
    endpoint = `${endpoint.replace(/\/+$/, '')}/v1/metrics`
  }

  let authorization = firstEnv(env, ['GRAFANA_OTLP_AUTHORIZATION'])
  if (!authorization) {
    const instanceId = firstEnv(env, ['GRAFANA_OTLP_INSTANCE_ID', 'GRAFANA_CLOUD_INSTANCE_ID'])
    const token = firstEnv(env, ['GRAFANA_OTLP_API_TOKEN', 'GRAFANA_CLOUD_API_TOKEN'])
    if (instanceId && token) {
      authorization = `Basic ${Buffer.from(`${instanceId}:${token}`).toString('base64')}`
    }
  }

  return {
    endpoint: endpoint || null,
    authorization: authorization || null,
    serviceName: env.FX_OTEL_SERVICE_NAME || DEFAULT_SERVICE_NAME
  }
}

function readMeta(metaPath) {
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Build an OTLP-HTTP/JSON ExportMetricsServiceRequest for the publish metrics.
 * Pure + deterministic given (meta, now) so it can be unit-tested without network.
 */
function buildOtlpMetricsPayload({ meta, publishDurationSeconds, now, knownSources = KNOWN_SOURCES, serviceName = DEFAULT_SERVICE_NAME }) {
  const timeUnixNano = String(BigInt(now.getTime()) * 1000000n)
  const metrics = []

  const ageSeconds = snapshotAgeSeconds(meta, now)
  if (ageSeconds != null) {
    metrics.push(gaugeMetric('fx_snapshot_age_seconds', 'Age of the most recently published FX snapshot.', 's', [gaugePoint(ageSeconds, timeUnixNano)]))
  }

  const currencyCount = numberOrNull(meta.currencyCount)
  if (currencyCount != null) {
    metrics.push(gaugeMetric('fx_currencies_count', 'Number of currencies in the latest published snapshot.', '1', [gaugePoint(currencyCount, timeUnixNano)]))
  }

  const publishedSources = Array.isArray(meta.sources) ? meta.sources.map(String) : []
  const sourcePoints = knownSources.map((source) =>
    gaugePoint(publishedSources.includes(source) ? 1 : 0, timeUnixNano, [stringAttr('source', source)])
  )
  if (sourcePoints.length > 0) {
    metrics.push(gaugeMetric('fx_source_available', 'Per-source availability for the latest publish (1 = contributed).', '1', sourcePoints))
  }

  if (publishDurationSeconds != null) {
    metrics.push(gaugeMetric('fx_publish_duration_seconds', 'Wall time of the publish (generate+validate) job.', 's', [gaugePoint(publishDurationSeconds, timeUnixNano)]))
  }

  return {
    resourceMetrics: [
      {
        resource: { attributes: [stringAttr('service.name', serviceName)] },
        scopeMetrics: [{ scope: { name: serviceName }, metrics }]
      }
    ]
  }
}

function snapshotAgeSeconds(meta, now) {
  // Prefer generatedAt (exact publish instant); fall back to latestDate at 00:00Z.
  const stamp = meta.generatedAt || (meta.latestDate ? `${meta.latestDate}T00:00:00Z` : null)
  if (!stamp) return null
  const then = new Date(stamp)
  if (Number.isNaN(then.getTime())) return null
  return Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000))
}

function gaugeMetric(name, description, unit, dataPoints) {
  return { name, description, unit, gauge: { dataPoints } }
}

function gaugePoint(value, timeUnixNano, attributes = []) {
  return { asDouble: value, timeUnixNano, attributes }
}

function stringAttr(key, value) {
  return { key, value: { stringValue: String(value) } }
}

function countDataPoints(payload) {
  let count = 0
  for (const rm of payload.resourceMetrics || []) {
    for (const sm of rm.scopeMetrics || []) {
      for (const metric of sm.metrics || []) {
        count += metric.gauge?.dataPoints?.length || 0
      }
    }
  }
  return count
}

async function postOtlp(fetchImpl, config, payload, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT_MS)
  try {
    const response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: config.authorization
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    })
    if (!response.ok) {
      const text = await safeText(response)
      return { ok: false, status: response.status, error: text || `HTTP ${response.status}` }
    }
    return { ok: true, status: response.status }
  } catch (error) {
    return { ok: false, status: null, error: error.message }
  } finally {
    clearTimeout(timer)
  }
}

async function safeText(response) {
  try {
    return (await response.text()).slice(0, 300)
  } catch {
    return null
  }
}

function firstEnv(env, names) {
  for (const name of names) {
    if (env[name]) return env[name]
  }
  return null
}

function numberOrNull(value) {
  if (value == null || value === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function positiveNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

module.exports = {
  KNOWN_SOURCES,
  buildOtlpMetricsPayload,
  resolveOtlpConfig,
  snapshotAgeSeconds,
  countDataPoints,
  parseArgs
}
