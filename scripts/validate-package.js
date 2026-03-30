#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const { runMonitoredScript } = require('./sentry-monitoring')

const packageRoot = path.join(__dirname, '..', 'package')
const MIN_ARCHIVE_DAYS = 365
const MAX_ARCHIVE_DAYS = 365
const MAX_ARCHIVE_GAP_DAYS = 7

runMonitoredScript('validate_package', main, {
  workflow: 'daily_publish',
  failureSignal: 'validate_package_failed'
}).catch((error) => {
  console.error(`validate-package: FAILED\n${error.stack || error.message}`)
  process.exitCode = 1
})

function main() {
  const currencies = readJSON('currencies.json')
  const meta = readJSON('meta.json')
  const snapshot = readJSON('snapshots/base-rates.json')
  const archiveManifest = readJSON('archive-manifest.json')

  const codes = Object.keys(currencies).sort()
  ensure(codes.length >= 100, `Expected >= 100 currencies in list, got ${codes.length}`)

  const fromCode = pickCode(codes, ['usd', 'eur', 'aed'])
  const toCode = pickCode(codes, ['eur', 'usd', 'gbp', 'myr'])

  const latestFrom = readJSON(`latest/${fromCode}.json`)
  const historyFrom = readJSON(`history/30d/${fromCode}.json`)

  ensure(isIsoDate(latestFrom.date), 'latest date is not ISO yyyy-mm-dd')
  ensure(latestFrom.from === fromCode, `latest from mismatch: expected ${fromCode}`)
  ensure(latestFrom.rates && typeof latestFrom.rates === 'object', 'latest rates missing')
  ensure(
    Number.isFinite(latestFrom.rates[toCode]) && latestFrom.rates[toCode] > 0,
    'latest sample rate missing'
  )

  ensure(historyFrom.from === fromCode, `history from mismatch: expected ${fromCode}`)
  ensure(Array.isArray(historyFrom.points), 'history points must be an array')
  ensure(
    historyFrom.points.length > 0 && historyFrom.points.length <= 30,
    `history points must be 1..30, got ${historyFrom.points.length}`
  )

  let previousDate = null
  for (const point of historyFrom.points) {
    ensure(isIsoDate(point.date), `Invalid point date: ${point.date}`)
    if (previousDate !== null) {
      ensure(previousDate <= point.date, 'history points must be ascending by date')
    }
    previousDate = point.date
    ensure(point.rates && typeof point.rates === 'object', `Missing rates map at ${point.date}`)
    ensure(
      Number.isFinite(point.rates[toCode]) && point.rates[toCode] > 0,
      `Missing sample pair rate at ${point.date}`
    )
  }

  ensure(isIsoDate(snapshot.date), 'snapshot date is not ISO yyyy-mm-dd')
  ensure(snapshot.base === 'eur', `snapshot base expected "eur", got "${snapshot.base}"`)
  ensure(snapshot.rates && typeof snapshot.rates === 'object', 'snapshot rates missing')
  ensure(Object.keys(snapshot.rates).length === codes.length, 'snapshot currency count mismatch')

  ensure(isIsoDate(meta.latestDate), 'meta latestDate invalid')
  ensure(meta.historyDays === 30, `meta historyDays must be 30, got ${meta.historyDays}`)
  ensure(meta.archiveMode === 'immutable', `meta archiveMode expected immutable, got ${meta.archiveMode}`)
  ensure(
    Array.isArray(meta.availableHistoryDates) &&
      meta.availableHistoryDates.length > 0 &&
      meta.availableHistoryDates.length <= 30,
    'meta availableHistoryDates must contain 1..30 entries'
  )

  // Numeric consistency check between snapshot-derived pair and latest pair.
  const fromBaseRate = snapshot.rates[fromCode]
  const toBaseRate = snapshot.rates[toCode]
  ensure(Number.isFinite(fromBaseRate) && fromBaseRate > 0, `snapshot missing base rate for ${fromCode}`)
  ensure(Number.isFinite(toBaseRate) && toBaseRate > 0, `snapshot missing base rate for ${toCode}`)
  const derivedLatestRate = toBaseRate / fromBaseRate
  const latestRate = latestFrom.rates[toCode]
  ensure(approximatelyEqual(derivedLatestRate, latestRate, 1e-8), 'snapshot-derived and latest sample rates diverge')

  // Minified files must parse too.
  ensure(isIsoDate(archiveManifest.earliestDate), 'archive earliestDate invalid')
  ensure(isIsoDate(archiveManifest.latestDate), 'archive latestDate invalid')
  ensure(Array.isArray(archiveManifest.availableDates), 'archive availableDates missing')
  ensure(archiveManifest.availableDates.length >= historyFrom.points.length, 'archive availableDates too short')
  ensure(
    archiveManifest.availableDates[0] === archiveManifest.earliestDate,
    'archive earliestDate does not match first available date'
  )
  ensure(
    archiveManifest.availableDates[archiveManifest.availableDates.length - 1] === archiveManifest.latestDate,
    'archive latestDate does not match last available date'
  )
  ensure(
    archiveManifest.latestDate === meta.latestDate,
    `archive latestDate must match meta latestDate, got ${archiveManifest.latestDate} vs ${meta.latestDate}`
  )
  ensure(
    Number.isInteger(archiveManifest.gapCount) && archiveManifest.gapCount >= 0,
    `archive gapCount must be a non-negative integer, got ${archiveManifest.gapCount}`
  )
  ensure(
    archiveManifest.availableDates.length >= MIN_ARCHIVE_DAYS - MAX_ARCHIVE_GAP_DAYS,
    `archive availableDates must contain at least ${MIN_ARCHIVE_DAYS - MAX_ARCHIVE_GAP_DAYS} dates, got ${archiveManifest.availableDates.length}`
  )
  ensure(
    archiveManifest.availableDates.length <= MAX_ARCHIVE_DAYS,
    `archive availableDates must not exceed ${MAX_ARCHIVE_DAYS} dates, got ${archiveManifest.availableDates.length}`
  )
  ensure(
    daysBetween(archiveManifest.earliestDate, archiveManifest.latestDate) + 1 >= MIN_ARCHIVE_DAYS,
    `archive date span must cover at least ${MIN_ARCHIVE_DAYS} days, got ${archiveManifest.earliestDate}..${archiveManifest.latestDate}`
  )
  ensure(
    daysBetween(archiveManifest.earliestDate, archiveManifest.latestDate) + 1 <= MAX_ARCHIVE_DAYS,
    `archive date span must not exceed ${MAX_ARCHIVE_DAYS} days, got ${archiveManifest.earliestDate}..${archiveManifest.latestDate}`
  )
  ensure(
    archiveManifest.gapCount <= MAX_ARCHIVE_GAP_DAYS,
    `archive gapCount must be <= ${MAX_ARCHIVE_GAP_DAYS}, got ${archiveManifest.gapCount}`
  )
  ensure(
    Array.isArray(archiveManifest.supportedCurrencies) &&
      archiveManifest.supportedCurrencies.includes(fromCode),
    'archive supportedCurrencies missing sample code'
  )
  readJSON(`archive/${meta.latestDate}.json`)
  readJSON(`archive/${meta.latestDate}.min.json`)
  readJSON(`archive-years/${meta.latestDate.slice(0, 4)}.json`)
  readJSON('archive-manifest.min.json')
  readJSON('currencies.min.json')
  readJSON('meta.min.json')
  readJSON('snapshots/base-rates.min.json')
  readJSON(`latest/${fromCode}.min.json`)
  readJSON(`history/30d/${fromCode}.min.json`)

  console.log(
    `validate-package: OK (${codes.length} currencies, history points=${historyFrom.points.length}, sample=${fromCode}->${toCode})`
  )
}

function readJSON(relativePath) {
  const fullPath = path.join(packageRoot, relativePath)
  const raw = fs.readFileSync(fullPath, 'utf8')
  return JSON.parse(raw)
}

function ensure(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function pickCode(allCodes, preferred) {
  for (const code of preferred) {
    if (allCodes.includes(code)) {
      return code
    }
  }
  return allCodes[0]
}

function approximatelyEqual(left, right, epsilon) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false
  const denom = Math.max(Math.abs(left), Math.abs(right), 1)
  return Math.abs(left - right) / denom <= epsilon
}

function daysBetween(start, end) {
  const startDate = new Date(`${start}T00:00:00Z`)
  const endDate = new Date(`${end}T00:00:00Z`)
  return Math.round((endDate - startDate) / (24 * 60 * 60 * 1000))
}
