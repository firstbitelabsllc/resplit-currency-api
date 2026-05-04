#!/usr/bin/env node

import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  readFileSync,
} from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {
  fileURLToPath,
  pathToFileURL,
} from 'node:url'

import { FX_OTEL_SERVICE_NAME } from '../worker/src/otel.mjs'
import {
  buildFxCoverageVerificationSpanName,
  FX_OTEL_VERIFY_HEADER,
} from '../worker/src/otel-verification.mjs'

const DEFAULT_BASE_URL = 'http://127.0.0.1:8787'
const DEFAULT_PATH = '/coverage'
const DEFAULT_FROM = 'AED'
const DEFAULT_TO = 'USD'
const DEFAULT_DAYS = 7
const DEFAULT_GRAFANA_STACK_URL = 'https://firstbitelabs.grafana.net'
const DEFAULT_TEMPO_DATASOURCE_UID = 'grafanacloud-traces'
const DEFAULT_SINCE = '15m'
const DEFAULT_TIMEOUT_MS = 90_000
const DEFAULT_POLL_INTERVAL_MS = 5_000

function usage() {
  console.error(`Usage: node scripts/verify-grafana-tempo.mjs [options]

Optional:
  --base-url <value>         Base URL for the Worker you want to probe (default: ${DEFAULT_BASE_URL})
  --path <value>             Route to hit before polling Tempo (default: ${DEFAULT_PATH})
  --from <value>             Coverage base currency (default: ${DEFAULT_FROM})
  --to <value>               Coverage quote currency (default: ${DEFAULT_TO})
  --anchor-date <value>      Coverage anchor date in YYYY-MM-DD (default: today UTC)
  --days <value>             Coverage lookback window (default: ${DEFAULT_DAYS})
  --request-id <value>       Override the x-request-id / span suffix (default: random UUID)
  --service <value>          service.name to query (default: ${FX_OTEL_SERVICE_NAME})
  --since <value>            Grafana search lookback window (default: ${DEFAULT_SINCE})
  --timeout-ms <value>       Poll timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})
  --poll-interval-ms <value> Poll interval in milliseconds (default: ${DEFAULT_POLL_INTERVAL_MS})
  --stack-url <value>        Grafana Cloud stack URL (default: ${DEFAULT_GRAFANA_STACK_URL})
  --datasource-uid <value>   Tempo datasource uid (default: ${DEFAULT_TEMPO_DATASOURCE_UID})
  --skip-hit                 Skip the Worker request and only poll Tempo
`)
}

export function parseArgs(argv) {
  const options = {
    anchorDate: new Date().toISOString().slice(0, 10),
    baseUrl: DEFAULT_BASE_URL,
    datasourceUid: DEFAULT_TEMPO_DATASOURCE_UID,
    days: DEFAULT_DAYS,
    from: DEFAULT_FROM,
    path: DEFAULT_PATH,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    requestId: crypto.randomUUID(),
    serviceName: FX_OTEL_SERVICE_NAME,
    since: DEFAULT_SINCE,
    skipHit: false,
    stackUrl: DEFAULT_GRAFANA_STACK_URL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    to: DEFAULT_TO,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--base-url') {
      options.baseUrl = argv[index + 1]
      index += 1
      continue
    }

    if (arg === '--path') {
      options.path = argv[index + 1]
      index += 1
      continue
    }

    if (arg === '--from') {
      options.from = argv[index + 1]
      index += 1
      continue
    }

    if (arg === '--to') {
      options.to = argv[index + 1]
      index += 1
      continue
    }

    if (arg === '--anchor-date') {
      options.anchorDate = argv[index + 1]
      index += 1
      continue
    }

    if (arg === '--days') {
      options.days = Number.parseInt(argv[index + 1], 10)
      index += 1
      continue
    }

    if (arg === '--request-id') {
      options.requestId = argv[index + 1]
      index += 1
      continue
    }

    if (arg === '--service') {
      options.serviceName = argv[index + 1]
      index += 1
      continue
    }

    if (arg === '--since') {
      options.since = argv[index + 1]
      index += 1
      continue
    }

    if (arg === '--timeout-ms') {
      options.timeoutMs = Number.parseInt(argv[index + 1], 10)
      index += 1
      continue
    }

    if (arg === '--poll-interval-ms') {
      options.pollIntervalMs = Number.parseInt(argv[index + 1], 10)
      index += 1
      continue
    }

    if (arg === '--stack-url') {
      options.stackUrl = argv[index + 1]
      index += 1
      continue
    }

    if (arg === '--datasource-uid') {
      options.datasourceUid = argv[index + 1]
      index += 1
      continue
    }

    if (arg === '--skip-hit') {
      options.skipHit = true
      continue
    }

    if (arg === '--help' || arg === '-h') {
      usage()
      process.exit(0)
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  if (!Number.isFinite(options.days) || options.days <= 0) {
    throw new Error('--days must be a positive integer')
  }

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive integer')
  }

  if (!Number.isFinite(options.pollIntervalMs) || options.pollIntervalMs <= 0) {
    throw new Error('--poll-interval-ms must be a positive integer')
  }

  return options
}

function attrValue(value) {
  return (
    value?.stringValue ??
    value?.boolValue ??
    value?.intValue ??
    value?.doubleValue ??
    value?.arrayValue ??
    value?.kvlistValue ??
    null
  )
}

function attrsToRecord(attributes = []) {
  return attributes.reduce((record, attribute) => {
    record[attribute.key] = attrValue(attribute.value)
    return record
  }, {})
}

function escapeTraceQlLiteral(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

export function buildSpanQuery({ expectedSpan, serviceName }) {
  return `{ resource.service.name = "${escapeTraceQlLiteral(serviceName)}" && span:name = "${escapeTraceQlLiteral(expectedSpan)}" }`
}

function buildServiceQuery({ serviceName }) {
  return `{ resource.service.name = "${escapeTraceQlLiteral(serviceName)}" }`
}

export function buildVerificationUrl({
  anchorDate,
  baseUrl,
  days,
  from,
  path: routePath,
  to,
}) {
  const url = new URL(routePath, baseUrl)
  url.searchParams.set('from', from)
  url.searchParams.set('to', to)
  url.searchParams.set('anchorDate', anchorDate)
  url.searchParams.set('days', String(days))
  return url
}

function parseMaybeJson(value) {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

export function readVerificationDiagnostics(headers) {
  const configured = headers.get('x-resplit-otel-configured')
  if (configured === null) {
    return null
  }

  return {
    authSource: headers.get('x-resplit-otel-auth-source') ?? 'missing',
    configured: configured === '1',
    endpointSource: headers.get('x-resplit-otel-endpoint-source') ?? 'missing',
    exporterHost: headers.get('x-resplit-otel-exporter-host'),
    exporterPath: headers.get('x-resplit-otel-exporter-path'),
  }
}

export function formatMissingOtelConfigMessage(diagnostics) {
  const exporterTarget = diagnostics.exporterHost
    ? `exporter=${diagnostics.exporterHost}${diagnostics.exporterPath ?? ''}`
    : 'exporter=unresolved'

  return `Verification route reports OTEL exporter not configured (endpointSource=${diagnostics.endpointSource}, authSource=${diagnostics.authSource}, ${exporterTarget})`
}

function parseEnvFile(contents) {
  const parsed = {}

  for (const line of contents.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u)
    if (!match) {
      continue
    }

    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    parsed[match[1]] = value
  }

  return parsed
}

function resolveCanonicalRepoRoot(repoRoot) {
  try {
    const gitCommonDir = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    ).trim()
    return path.resolve(gitCommonDir, '..')
  } catch {
    return null
  }
}

function loadRepoEnv(repoRoot, canonicalRepoRoot) {
  const candidatePaths = [path.join(repoRoot, '.env.local')]

  if (canonicalRepoRoot) {
    candidatePaths.push(path.join(canonicalRepoRoot, '.env.local'))
  }

  for (const candidatePath of candidatePaths) {
    if (!existsSync(candidatePath)) {
      continue
    }

    const parsed = parseEnvFile(readFileSync(candidatePath, 'utf8'))
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) {
        process.env[key] = value
      }
    }
  }
}

async function searchTempo({
  datasourceUid,
  query,
  since,
  stackUrl,
  token,
}) {
  const url = new URL(
    `/api/datasources/proxy/uid/${datasourceUid}/api/search`,
    stackUrl
  )
  url.searchParams.set('q', query)
  url.searchParams.set('since', since)

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  if (!response.ok) {
    throw new Error(
      `Grafana Tempo search failed (${response.status}): ${await response.text()}`
    )
  }

  return response.json()
}

async function fetchTrace({
  datasourceUid,
  stackUrl,
  token,
  traceId,
}) {
  const url = new URL(
    `/api/datasources/proxy/uid/${datasourceUid}/api/traces/${traceId}`,
    stackUrl
  )
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  if (!response.ok) {
    throw new Error(
      `Grafana trace fetch failed (${response.status}): ${await response.text()}`
    )
  }

  return response.json()
}

function extractSpans(tracePayload) {
  return (tracePayload.batches ?? []).flatMap(batch =>
    (batch.scopeSpans ?? []).flatMap(scope => scope.spans ?? [])
  )
}

function newestTrace(traces) {
  return [...traces].sort((left, right) => {
    const leftStart = BigInt(left.startTimeUnixNano ?? '0')
    const rightStart = BigInt(right.startTimeUnixNano ?? '0')
    return rightStart > leftStart ? 1 : rightStart < leftStart ? -1 : 0
  })[0]
}

async function hitVerificationUrl({
  requestId,
  verificationUrl,
}) {
  const response = await fetch(verificationUrl, {
    headers: {
      [FX_OTEL_VERIFY_HEADER]: '1',
      'x-request-id': requestId,
    },
  })
  const bodyText = await response.text()

  if (!response.ok) {
    throw new Error(
      `Verification route failed (${response.status}): ${bodyText}`
    )
  }

  return {
    diagnostics: readVerificationDiagnostics(response.headers),
    payload: parseMaybeJson(bodyText),
    status: response.status,
    verificationUrl,
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const canonicalRepoRoot = resolveCanonicalRepoRoot(repoRoot)
  loadRepoEnv(repoRoot, canonicalRepoRoot)

  const grafanaToken = process.env.GRAFANA_CLOUD_STACK_SA_TOKEN
  if (!grafanaToken) {
    throw new Error('GRAFANA_CLOUD_STACK_SA_TOKEN is required to query Grafana Tempo')
  }

  const expectedSpan = buildFxCoverageVerificationSpanName(options.requestId)
  const verificationUrl = buildVerificationUrl(options)

  let routePayload = null
  if (!options.skipHit) {
    routePayload = await hitVerificationUrl({
      requestId: options.requestId,
      verificationUrl,
    })

    if (routePayload.diagnostics && !routePayload.diagnostics.configured) {
      throw new Error(formatMissingOtelConfigMessage(routePayload.diagnostics))
    }
  }

  const startedAt = Date.now()
  const spanQuery = buildSpanQuery({
    expectedSpan,
    serviceName: options.serviceName,
  })

  while (Date.now() - startedAt <= options.timeoutMs) {
    const result = await searchTempo({
      datasourceUid: options.datasourceUid,
      query: spanQuery,
      since: options.since,
      stackUrl: options.stackUrl,
      token: grafanaToken,
    })

    if ((result.traces ?? []).length > 0) {
      const matchedTrace = newestTrace(result.traces)
      const tracePayload = await fetchTrace({
        datasourceUid: options.datasourceUid,
        stackUrl: options.stackUrl,
        token: grafanaToken,
        traceId: matchedTrace.traceID,
      })
      const resourceAttributes = attrsToRecord(
        tracePayload.batches?.[0]?.resource?.attributes ?? []
      )
      const spans = extractSpans(tracePayload)
      const verificationSpan = spans.find(span => span.name === expectedSpan)

      console.log(
        JSON.stringify(
          {
            baseUrl: options.baseUrl,
            expectedSpan,
            matchedTraceId: matchedTrace.traceID,
            matchedTraceStartUnixNano: matchedTrace.startTimeUnixNano,
            requestId: options.requestId,
            resourceAttributes: {
              'service.name': resourceAttributes['service.name'],
              'service.namespace': resourceAttributes['service.namespace'],
              'service.version': resourceAttributes['service.version'],
            },
            routePayload,
            spanNames: spans.map(span => span.name),
            verificationSpanAttributes: attrsToRecord(
              verificationSpan?.attributes ?? []
            ),
          },
          null,
          2
        )
      )
      return
    }

    await sleep(options.pollIntervalMs)
  }

  const fallbackResult = await searchTempo({
    datasourceUid: options.datasourceUid,
    query: buildServiceQuery({
      serviceName: options.serviceName,
    }),
    since: options.since,
    stackUrl: options.stackUrl,
    token: grafanaToken,
  })

  if ((fallbackResult.traces ?? []).length === 0) {
    throw new Error(
      `No Tempo traces found for service ${options.serviceName} within ${options.timeoutMs}ms`
    )
  }

  const matchedTrace = newestTrace(fallbackResult.traces)
  const tracePayload = await fetchTrace({
    datasourceUid: options.datasourceUid,
    stackUrl: options.stackUrl,
    token: grafanaToken,
    traceId: matchedTrace.traceID,
  })

  throw new Error(
    `Tempo traces exist for ${options.serviceName}, but not ${expectedSpan}. Observed spans: ${extractSpans(
      tracePayload
    )
      .map(span => span.name)
      .join(', ')}`
  )
}

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null

if (entryHref === import.meta.url) {
  main().catch(error => {
    console.error(error.message)
    process.exit(1)
  })
}
