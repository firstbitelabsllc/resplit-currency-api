#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')

const {
  applyDeterministicCurrencyDerivations,
  createFxApiPairHistorySource,
  enumerateDates,
  loadRequiredCodes,
  missingCodes,
  normalizeRatesMap,
} = require('./audit-history-backfill-sources')

if (require.main === module) {
  main().then((exitCode) => {
    process.exitCode = exitCode
  }).catch((error) => {
    console.error(`backfill-history-snapshots: FAILED\n${error.stack || error.message}`)
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
  const dates = enumerateDates(options.from, options.to)
  const referencePath = path.resolve(cwd, options.reference)
  const requiredCodes = loadRequiredCodes(referencePath)
  const archiveDir = path.resolve(cwd, options.archiveDir)

  if (options.source !== 'fxapi-pair-history') {
    throw new Error(`Unsupported --source ${options.source}; only fxapi-pair-history is allowed`)
  }

  const source = createFxApiPairHistorySource({
    dates,
    fetchImpl,
    requiredCodes,
    timeoutMs: options.timeoutMs,
  })

  const results = []
  for (const date of dates) {
    const filePath = path.join(archiveDir, `${date}.json`)
    const existing = fs.existsSync(filePath)
    if (existing && !options.overwrite) {
      results.push({ date, status: 'skipped-existing', filePath })
      continue
    }

    const fetched = await source.fetchRates(date)
    const derived = applyDeterministicCurrencyDerivations(normalizeRatesMap(fetched.rates))
    const missing = missingCodes(requiredCodes, derived.rates)
    if (!fetched.ok || missing.length > 0) {
      results.push({
        date,
        status: 'blocked',
        filePath,
        error: fetched.error,
        missing,
      })
      continue
    }

    const payload = {
      date,
      base: 'eur',
      rates: sortRatesByRequiredCodes(derived.rates, requiredCodes),
    }

    if (!options.dryRun) {
      fs.mkdirSync(archiveDir, { recursive: true })
      fs.writeFileSync(filePath, JSON.stringify(payload))
    }
    results.push({
      date,
      status: options.dryRun ? 'would-write' : 'wrote',
      filePath,
      count: Object.keys(payload.rates).length,
      derivations: derived.derivations,
    })
  }

  stdout.write(formatBackfillReport(results, options))

  const blocked = results.filter((result) => result.status === 'blocked')
  if (blocked.length > 0) {
    stderr.write(`backfill-history-snapshots: ${blocked.length}/${dates.length} date(s) blocked by incomplete source coverage\n`)
    return 2
  }

  stdout.write('backfill-history-snapshots: OK, archive backfill inputs are complete\n')
  return 0
}

function parseArgs(argv, cwd = process.cwd()) {
  const options = {
    archiveDir: 'snapshot-archive',
    dryRun: false,
    from: null,
    overwrite: false,
    reference: null,
    source: 'fxapi-pair-history',
    timeoutMs: 15_000,
    to: null,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--archive-dir') {
      options.archiveDir = argv[++index]
    } else if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--from') {
      options.from = argv[++index]
    } else if (arg === '--overwrite') {
      options.overwrite = true
    } else if (arg === '--reference') {
      options.reference = argv[++index]
    } else if (arg === '--source') {
      options.source = argv[++index]
    } else if (arg === '--timeout-ms') {
      options.timeoutMs = Number(argv[++index])
    } else if (arg === '--to') {
      options.to = argv[++index]
    } else if (arg === '--help' || arg === '-h') {
      throw new Error(usage())
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage()}`)
    }
  }

  const today = new Date().toISOString().slice(0, 10)
  options.to ||= today
  options.from ||= dateDaysBeforeUTC(options.to, 29)

  assertISODate(options.from, '--from')
  assertISODate(options.to, '--to')
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error(`--timeout-ms must be a positive number, got ${options.timeoutMs}`)
  }
  options.reference ||= findLatestSnapshotPath(cwd, options.archiveDir)
  return options
}

function usage() {
  return [
    'Usage: node scripts/backfill-history-snapshots.js [--from yyyy-mm-dd] [--to yyyy-mm-dd]',
    '       [--reference snapshot-archive/yyyy-mm-dd.json] [--archive-dir snapshot-archive]',
    '       [--source fxapi-pair-history] [--dry-run] [--overwrite] [--timeout-ms 15000]',
    '',
    'Writes missing snapshot-archive/yyyy-mm-dd.json files only when a complete single',
    'historical source covers the current package currency set for that date.',
  ].join('\n')
}

function formatBackfillReport(results, options) {
  const action = options.dryRun ? 'dry-run' : 'write'
  const lines = [`History snapshot backfill (${action}): ${results.length} date(s), source=${options.source}`]
  for (const result of results) {
    if (result.status === 'blocked') {
      const missing = result.missing.length > 0 ? result.missing.join(',') : 'none'
      const error = result.error ? `; error=${result.error}` : ''
      lines.push(`${result.date}: blocked; missing=${missing}${error}`)
      continue
    }

    const derived = result.derivations?.length
      ? `; derived=${result.derivations.map((derivation) => `${derivation.code}<-${derivation.sourceCode}`).join(',')}`
      : ''
    const count = Number.isFinite(result.count) ? `; count=${result.count}` : ''
    lines.push(`${result.date}: ${result.status}${count}${derived}`)
  }
  return `${lines.join('\n')}\n`
}

function sortRatesByRequiredCodes(rates, requiredCodes) {
  const payload = {}
  for (const code of requiredCodes) {
    payload[code] = rates[code]
  }
  return payload
}

function findLatestSnapshotPath(cwd, archiveDir) {
  const resolvedArchiveDir = path.resolve(cwd, archiveDir)
  const latest = fs.readdirSync(resolvedArchiveDir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort()
    .at(-1)
  if (!latest) {
    throw new Error(`No snapshot archive JSON files found in ${resolvedArchiveDir}`)
  }
  return path.join(archiveDir, latest)
}

function dateDaysBeforeUTC(anchorDate, daysBefore) {
  const date = new Date(`${anchorDate}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - daysBefore)
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
  formatBackfillReport,
  main,
  parseArgs,
  sortRatesByRequiredCodes,
}
