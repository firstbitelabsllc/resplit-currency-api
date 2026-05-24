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
  const options = parseArgs(argv)
  const referencePath = path.resolve(cwd, options.reference)
  const outputDir = path.resolve(cwd, options.outputDir)
  const requiredCodes = loadRequiredCodes(referencePath)
  const dates = enumerateDates(options.from, options.to)
  const snapshots = await buildBackfillSnapshots({
    dates,
    fetchImpl,
    requiredCodes,
    timeoutMs: options.timeoutMs,
  })

  const incomplete = snapshots.filter((snapshot) => snapshot.missing.length > 0 || snapshot.error)
  if (incomplete.length > 0) {
    for (const snapshot of incomplete) {
      const missing = snapshot.missing.length > 0 ? snapshot.missing.join(',') : 'none'
      stderr.write(`${snapshot.date}: incomplete missing=${missing}${snapshot.error ? ` error=${snapshot.error}` : ''}\n`)
    }
    stderr.write(`backfill-history-snapshots: refused to write ${incomplete.length}/${snapshots.length} incomplete snapshot(s)\n`)
    return 2
  }

  if (!options.write) {
    stdout.write(
      `backfill-history-snapshots: ready to write ${snapshots.length} complete snapshot(s) to ${path.relative(cwd, outputDir) || '.'} (dry-run; pass --write)\n`
    )
    for (const snapshot of snapshots) {
      stdout.write(`${snapshot.date}: count=${Object.keys(snapshot.rates).length}; derived=${formatDerivations(snapshot.derivations)}\n`)
    }
    return 0
  }

  fs.mkdirSync(outputDir, { recursive: true })
  for (const snapshot of snapshots) {
    const filePath = path.join(outputDir, `${snapshot.date}.json`)
    if (!options.overwrite && fs.existsSync(filePath)) {
      throw new Error(`${path.relative(cwd, filePath)} already exists; pass --overwrite to replace it`)
    }
    fs.writeFileSync(
      filePath,
      `${JSON.stringify({
        date: snapshot.date,
        base: 'eur',
        rates: snapshot.rates,
      }, null, 2)}\n`
    )
    stdout.write(`wrote ${path.relative(cwd, filePath)} count=${Object.keys(snapshot.rates).length}; derived=${formatDerivations(snapshot.derivations)}\n`)
  }

  return 0
}

function parseArgs(argv) {
  const options = {
    from: null,
    outputDir: 'snapshot-archive',
    overwrite: false,
    reference: null,
    timeoutMs: 15_000,
    to: null,
    write: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--from') {
      options.from = argv[++index]
    } else if (arg === '--to') {
      options.to = argv[++index]
    } else if (arg === '--reference') {
      options.reference = argv[++index]
    } else if (arg === '--output-dir') {
      options.outputDir = argv[++index]
    } else if (arg === '--timeout-ms') {
      options.timeoutMs = Number(argv[++index])
    } else if (arg === '--write') {
      options.write = true
    } else if (arg === '--overwrite') {
      options.overwrite = true
    } else if (arg === '--help' || arg === '-h') {
      throw new Error(usage())
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage()}`)
    }
  }

  if (!options.from || !options.to) {
    throw new Error(`--from and --to are required\n${usage()}`)
  }
  if (!options.reference) {
    throw new Error(`--reference is required so the backfill uses an explicit package contract\n${usage()}`)
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error(`--timeout-ms must be a positive number, got ${options.timeoutMs}`)
  }
  return options
}

function usage() {
  return [
    'Usage: node scripts/backfill-history-snapshots.js --from yyyy-mm-dd --to yyyy-mm-dd',
    '       --reference snapshot-archive/yyyy-mm-dd.json [--output-dir snapshot-archive]',
    '       [--timeout-ms 15000] [--write] [--overwrite]',
    '',
    'Builds complete EUR-base snapshot archive files from the fxapi.app pair-history',
    'source plus explicit 1:1 currency derivations. Dry-run is the default.',
  ].join('\n')
}

async function buildBackfillSnapshots({
  dates,
  fetchImpl,
  requiredCodes,
  timeoutMs,
}) {
  const source = createFxApiPairHistorySource({
    dates,
    fetchImpl,
    requiredCodes,
    timeoutMs,
  })
  const snapshots = []

  for (const date of dates) {
    const result = await source.fetchRates(date)
    const derivationResult = applyDeterministicCurrencyDerivations(normalizeRatesMap(result.rates))
    const missing = missingCodes(requiredCodes, derivationResult.rates)
    snapshots.push({
      date,
      derivations: derivationResult.derivations,
      error: result.ok ? null : result.error || 'source failed',
      missing,
      rates: pickRequiredRates(requiredCodes, derivationResult.rates),
    })
  }

  return snapshots
}

function pickRequiredRates(requiredCodes, rates) {
  const output = {}
  for (const code of requiredCodes) {
    if (Number.isFinite(rates[code]) && rates[code] > 0) {
      output[code] = rates[code]
    }
  }
  return output
}

function formatDerivations(derivations) {
  return derivations.length > 0
    ? derivations.map((derivation) => `${derivation.code}<-${derivation.sourceCode}`).join(',')
    : 'none'
}

module.exports = {
  buildBackfillSnapshots,
  main,
  parseArgs,
  pickRequiredRates,
}
