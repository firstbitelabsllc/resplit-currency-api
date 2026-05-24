#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')

const defaultSourceDefinitions = [
  {
    name: 'resplit-dated-pages',
    urlForDate: (date) => `https://${date}.resplit-currency-api.pages.dev/snapshots/base-rates.json`,
    parseRates: parseResplitSnapshot,
  },
  {
    name: 'fawaz-currency-api',
    urlForDate: (date) => `https://${date}.currency-api.pages.dev/v1/currencies/eur.json`,
    parseRates: (payload) => payload?.eur,
  },
  {
    name: 'fxratesapi',
    urlForDate: (date) => `https://api.fxratesapi.com/historical?date=${date}&base=EUR`,
    parseRates: (payload) => payload?.rates,
  },
  {
    name: 'frankfurter',
    urlForDate: (date) => `https://api.frankfurter.app/${date}?from=EUR`,
    parseRates: parseFrankfurterRates,
  },
]

if (require.main === module) {
  main().then((exitCode) => {
    process.exitCode = exitCode
  }).catch((error) => {
    console.error(`audit-history-backfill-sources: FAILED\n${error.stack || error.message}`)
    process.exitCode = 1
  })
}

async function main({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  fetchImpl = globalThis.fetch,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const options = parseArgs(argv, cwd)
  const referencePath = path.resolve(cwd, options.reference)
  const requiredCodes = loadRequiredCodes(referencePath)
  const dates = enumerateDates(options.from, options.to)
  const sources = createNetworkSources(defaultSourceDefinitions, fetchImpl, {
    timeoutMs: options.timeoutMs,
  })
  const audit = await buildBackfillAudit({
    dates,
    requiredCodes,
    sources,
  })

  if (options.json) {
    stdout.write(`${JSON.stringify(audit, null, 2)}\n`)
  } else {
    stdout.write(formatAuditReport(audit))
  }

  if (audit.incompleteDateCount > 0) {
    stderr.write(
      `audit-history-backfill-sources: no complete single source for ${audit.incompleteDateCount}/${audit.dateCount} date(s)\n`
    )
    return 2
  }

  stdout.write('audit-history-backfill-sources: OK, every date has at least one complete single-source candidate\n')
  return 0
}

function parseArgs(argv, cwd = process.cwd()) {
  const options = {
    from: null,
    to: null,
    reference: null,
    json: false,
    timeoutMs: 15_000,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') {
      options.json = true
    } else if (arg === '--from') {
      options.from = argv[++index]
    } else if (arg === '--to') {
      options.to = argv[++index]
    } else if (arg === '--reference') {
      options.reference = argv[++index]
    } else if (arg === '--timeout-ms') {
      options.timeoutMs = Number(argv[++index])
    } else if (arg === '--help' || arg === '-h') {
      throw new Error(usage())
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage()}`)
    }
  }

  const today = new Date().toISOString().slice(0, 10)
  options.to ||= today
  options.from ||= dateDaysBeforeUTC(options.to, 29)
  options.reference ||= findLatestSnapshotPath(cwd)

  assertISODate(options.from, '--from')
  assertISODate(options.to, '--to')
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error(`--timeout-ms must be a positive number, got ${options.timeoutMs}`)
  }
  return options
}

function usage() {
  return [
    'Usage: node scripts/audit-history-backfill-sources.js [--from yyyy-mm-dd] [--to yyyy-mm-dd]',
    '       [--reference snapshot-archive/yyyy-mm-dd.json] [--json] [--timeout-ms 15000]',
    '',
    'Read-only audit. It reports whether any single historical source can cover the full',
    'current package currency set for each date. It does not write snapshot archives.',
  ].join('\n')
}

function findLatestSnapshotPath(cwd) {
  const archiveDir = path.join(cwd, 'snapshot-archive')
  const latest = fs.readdirSync(archiveDir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort()
    .at(-1)
  if (!latest) {
    throw new Error(`No snapshot archive JSON files found in ${archiveDir}`)
  }
  return path.join('snapshot-archive', latest)
}

function loadRequiredCodes(referencePath) {
  const payload = JSON.parse(fs.readFileSync(referencePath, 'utf8'))
  const rates = parseResplitSnapshot(payload)
  const codes = Object.keys(rates)
    .map((code) => code.toLowerCase())
    .sort()
  if (codes.length === 0) {
    throw new Error(`Reference snapshot has no rates: ${referencePath}`)
  }
  return codes
}

function createNetworkSources(sourceDefinitions, fetchImpl, { timeoutMs }) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('global fetch is unavailable; use Node 18+')
  }

  return sourceDefinitions.map((source) => ({
    name: source.name,
    fetchRates: async (date) => {
      const url = source.urlForDate(date)
      try {
        const response = await fetchImpl(url, {
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!response.ok) {
          return {
            name: source.name,
            url,
            ok: false,
            error: `HTTP ${response.status}`,
            rates: {},
          }
        }

        const payload = await response.json()
        return {
          name: source.name,
          url,
          ok: true,
          rates: normalizeRatesMap(source.parseRates(payload)),
        }
      } catch (error) {
        return {
          name: source.name,
          url,
          ok: false,
          error: error.message,
          rates: {},
        }
      }
    },
  }))
}

async function buildBackfillAudit({ dates, requiredCodes, sources }) {
  const dateResults = []

  for (const date of dates) {
    dateResults.push(await auditDate({ date, requiredCodes, sources }))
  }

  return {
    requiredCodeCount: requiredCodes.length,
    dateCount: dates.length,
    incompleteDateCount: dateResults.filter((result) => result.completeSources.length === 0).length,
    dates: dateResults,
  }
}

async function auditDate({ date, requiredCodes, sources }) {
  const sourceResults = []
  const unionRates = {}

  for (const source of sources) {
    const result = await source.fetchRates(date)
    const rates = normalizeRatesMap(result.rates)
    Object.assign(unionRates, rates)
    const missing = missingCodes(requiredCodes, rates)
    sourceResults.push({
      name: result.name || source.name,
      url: result.url,
      ok: Boolean(result.ok),
      count: Object.keys(rates).length,
      missingCount: missing.length,
      missing,
      error: result.error,
    })
  }

  const unionMissing = missingCodes(requiredCodes, unionRates)

  return {
    date,
    completeSources: sourceResults
      .filter((result) => result.ok && result.missingCount === 0)
      .map((result) => result.name),
    unionCount: Object.keys(unionRates).length,
    unionMissingCount: unionMissing.length,
    unionMissing,
    sourceResults,
  }
}

function formatAuditReport(audit) {
  const lines = [
    `Backfill source audit: ${audit.dateCount} date(s), ${audit.requiredCodeCount} required currency codes`,
  ]

  for (const result of audit.dates) {
    const complete = result.completeSources.length > 0
      ? result.completeSources.join(', ')
      : 'none'
    const unionMissing = result.unionMissing.length > 0
      ? formatCodeList(result.unionMissing)
      : 'none'
    lines.push(
      `${result.date}: complete=${complete}; unionMissing=${unionMissing}; unionCount=${result.unionCount}`
    )
    for (const source of result.sourceResults) {
      const status = source.ok ? 'ok' : `error=${source.error || 'unknown'}`
      const missing = source.missing.length > 0 ? formatCodeList(source.missing) : 'none'
      lines.push(
        `  - ${source.name}: ${status}; count=${source.count}; missing=${missing}`
      )
    }
  }

  return `${lines.join('\n')}\n`
}

function formatCodeList(codes, limit = 12) {
  if (codes.length <= limit) {
    return codes.join(',')
  }
  return `${codes.slice(0, limit).join(',')}...+${codes.length - limit}`
}

function normalizeRatesMap(rates) {
  if (!rates || typeof rates !== 'object' || Array.isArray(rates)) {
    return {}
  }

  const normalized = {}
  for (const [code, value] of Object.entries(rates)) {
    const numberValue = Number(value)
    if (/^[a-zA-Z]{3}$/.test(code) && Number.isFinite(numberValue) && numberValue > 0) {
      normalized[code.toLowerCase()] = numberValue
    }
  }
  return normalized
}

function parseResplitSnapshot(payload) {
  return payload?.rates || {}
}

function parseFrankfurterRates(payload) {
  if (!payload?.rates) {
    return {}
  }
  return {
    eur: 1,
    ...payload.rates,
  }
}

function missingCodes(requiredCodes, rates) {
  const available = new Set(Object.keys(rates).map((code) => code.toLowerCase()))
  return requiredCodes.filter((code) => !available.has(code))
}

function enumerateDates(from, to) {
  assertISODate(from, '--from')
  assertISODate(to, '--to')
  const dates = []
  const cursor = new Date(`${from}T00:00:00Z`)
  const end = new Date(`${to}T00:00:00Z`)
  if (cursor > end) {
    throw new Error(`--from must be <= --to, got ${from} > ${to}`)
  }

  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return dates
}

function dateDaysBeforeUTC(anchorDate, daysAgo) {
  assertISODate(anchorDate, 'anchorDate')
  const date = new Date(`${anchorDate}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - daysAgo)
  return date.toISOString().slice(0, 10)
}

function assertISODate(value, fieldName) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid ${fieldName}: ${value}`)
  }
  const parsed = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid ${fieldName}: ${value}`)
  }
}

module.exports = {
  auditDate,
  buildBackfillAudit,
  createNetworkSources,
  defaultSourceDefinitions,
  enumerateDates,
  formatAuditReport,
  loadRequiredCodes,
  main,
  missingCodes,
  normalizeRatesMap,
  parseArgs,
}
