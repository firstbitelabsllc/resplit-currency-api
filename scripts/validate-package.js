#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const { runMonitoredScript } = require('./sentry-monitoring')
const {
  BASE_SELF_RATE_EPSILON,
  evaluateCrossSourceAgreement,
  findMissingCurrencyCodes
} = require('./lib/sources')

const packageRoot = process.env.CURRENCY_PACKAGE_ROOT || path.join(__dirname, '..', 'package')
const MIN_ARCHIVE_DAYS = 365
const MAX_ARCHIVE_DAYS = 365
const MAX_ARCHIVE_GAP_DAYS = 7
const HISTORY_DAYS = 30
const STRICT_HISTORY_COVERAGE = process.env.STRICT_HISTORY_COVERAGE === '1'

if (require.main === module) {
  runMonitoredScript('validate_package', main, {
    workflow: 'daily_publish',
    failureSignal: 'validate_package_failed'
  }).catch((error) => {
    console.error(`validate-package: FAILED\n${error.stack || error.message}`)
    process.exitCode = 1
  })
}

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
    historyFrom.points.length > 0 && historyFrom.points.length <= HISTORY_DAYS,
    `history/30d/${fromCode}.json points must contain 1..${HISTORY_DAYS} entries, got ${historyFrom.points.length}`
  )

  let previousDate = null
  const historyDates = []
  for (const point of historyFrom.points) {
    ensure(isIsoDate(point.date), `Invalid point date: ${point.date}`)
    if (previousDate !== null) {
      ensure(previousDate < point.date, 'history points must be strictly ascending by date')
    }
    previousDate = point.date
    historyDates.push(point.date)
    ensure(point.rates && typeof point.rates === 'object', `Missing rates map at ${point.date}`)
    ensure(
      Number.isFinite(point.rates[toCode]) && point.rates[toCode] > 0,
      `Missing sample pair rate at ${point.date}`
    )
  }

  ensure(isIsoDate(snapshot.date), 'snapshot date is not ISO yyyy-mm-dd')
  ensure(snapshot.base === 'eur', `snapshot base expected "eur", got "${snapshot.base}"`)
  ensure(snapshot.rates && typeof snapshot.rates === 'object', 'snapshot rates missing')
  ensure(
    Number.isFinite(snapshot.rates.eur) && approximatelyEqual(snapshot.rates.eur, 1, BASE_SELF_RATE_EPSILON),
    `snapshot EUR self-rate must equal 1, got ${snapshot.rates.eur}`
  )
  ensure(Object.keys(snapshot.rates).length === codes.length, 'snapshot currency count mismatch')

  ensure(isIsoDate(meta.latestDate), 'meta latestDate invalid')
  ensure(
    snapshot.date === meta.latestDate,
    `snapshot date must match meta latestDate, got ${snapshot.date} vs ${meta.latestDate}`
  )
  if (snapshot.publishedSource) {
    const publishedSource = Array.isArray(snapshot.sources)
      ? snapshot.sources.find((source) => source.source === snapshot.publishedSource)
      : null
    ensure(
      publishedSource?.date === snapshot.date,
      `published source date must match snapshot date, got ${publishedSource?.date || 'missing'} vs ${snapshot.date}`
    )
  }
  ensure(meta.historyDays === HISTORY_DAYS, `meta historyDays must be ${HISTORY_DAYS}, got ${meta.historyDays}`)
  ensure(meta.archiveMode === 'immutable', `meta archiveMode expected immutable, got ${meta.archiveMode}`)
  ensure(
    Array.isArray(meta.availableHistoryDates) &&
      meta.availableHistoryDates.length === historyDates.length,
    `meta availableHistoryDates must match history points length ${historyDates.length}, got ${
      Array.isArray(meta.availableHistoryDates) ? meta.availableHistoryDates.length : typeof meta.availableHistoryDates
    }`
  )
  ensure(
    arraysEqual(meta.availableHistoryDates, historyDates),
    'meta availableHistoryDates must match history point dates'
  )
  validateHistoryCoverage({
    dates: historyDates,
    latestDate: meta.latestDate,
    strict: STRICT_HISTORY_COVERAGE
  })

  // Numeric consistency check between snapshot-derived pair and latest pair.
  const fromBaseRate = snapshot.rates[fromCode]
  const toBaseRate = snapshot.rates[toCode]
  ensure(Number.isFinite(fromBaseRate) && fromBaseRate > 0, `snapshot missing base rate for ${fromCode}`)
  ensure(Number.isFinite(toBaseRate) && toBaseRate > 0, `snapshot missing base rate for ${toCode}`)
  const derivedLatestRate = toBaseRate / fromBaseRate
  const latestRate = latestFrom.rates[toCode]
  ensure(approximatelyEqual(derivedLatestRate, latestRate, 1e-8), 'snapshot-derived and latest sample rates diverge')

  // Value-sanity gate (2026-06-24): every check above is structural. The daily
  // publish is single-source (open.er-api.com), so a wrong-but-positive upstream
  // rate clears all of them and ships as authoritative to every multi-currency
  // split. Compare today's EUR-base table to the prior published day; a >2x
  // day-over-day jump is almost certainly a bad upstream value — refuse to
  // publish it. (Skips gracefully when there is no prior day to compare.)
  const priorSanityDates = archiveManifest.availableDates.filter((date) => date < meta.latestDate)
  const priorSanityDate = priorSanityDates.length ? priorSanityDates[priorSanityDates.length - 1] : null
  if (priorSanityDate) {
    const priorSnapshot = readJSON(`archive/${priorSanityDate}.json`)
    const missingCodes = findMissingCurrencyCodes(snapshot.rates, priorSnapshot.rates)
    ensure(
      missingCodes.length === 0,
      `currency-set continuity: snapshot missing ${missingCodes.length} trusted ${missingCodes.length === 1 ? 'currency' : 'currencies'} vs ${priorSanityDate}: ${missingCodes.slice(0, 12).join(', ')}`
    )
    const { gross, warns } = computeRateSanity(snapshot.rates, priorSnapshot.rates)
    warnIf(
      warns.length > 0,
      `rate-sanity: ${warns.length} currency(ies) moved >15% vs ${priorSanityDate}: ${warns
        .slice(0, 8)
        .map((w) => `${w.code} ${w.ratio.toFixed(2)}x`)
        .join(', ')}`
    )
    ensure(
      gross.length === 0,
      `rate-sanity: ${gross.length} currency(ies) jumped >2x vs ${priorSanityDate} — likely a bad upstream rate, refusing to publish: ${gross
        .slice(0, 8)
        .map((g) => `${g.code} ${g.prev}->${g.rate} (${g.ratio.toFixed(2)}x)`)
        .join(', ')}`
    )
  } else {
    warnIf(true, 'rate-sanity: no prior archived day before latestDate to compare — value gate skipped')
  }

  // Defense in depth for generated artifacts: currscript refuses a gross
  // disagreement before writing, and validation rejects any persisted snapshot
  // carrying the same bad comparison. Legacy/backfill snapshots have no
  // agreement metadata and remain valid.
  const { warns: crossWarns, refusals: crossRefusals } = evaluateCrossSourceAgreement(snapshot.agreement)
  warnIf(
    crossWarns.length > 0,
    `cross-source: ${crossWarns.length} intersection currency(ies) diverge beyond the warn band: ${crossWarns
      .slice(0, 8)
      .map((entry) => `${entry.code} ${(entry.relDiff * 100).toFixed(2)}%`)
      .join(', ')}`
  )
  ensure(
    crossRefusals.length === 0,
    `cross-source: ${crossRefusals.length} intersection currency(ies) disagree >5% between er-api and Frankfurter — likely a bad upstream rate, refusing to publish: ${crossRefusals
      .slice(0, 8)
      .map((entry) => `${entry.code} ${(entry.relDiff * 100).toFixed(2)}%`)
      .join(', ')}`
  )

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
  warnIf(
    archiveManifest.availableDates.length < MIN_ARCHIVE_DAYS - MAX_ARCHIVE_GAP_DAYS,
    `archive availableDates below target ${MIN_ARCHIVE_DAYS - MAX_ARCHIVE_GAP_DAYS}: got ${archiveManifest.availableDates.length}`
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
  warnIf(
    archiveManifest.gapCount > MAX_ARCHIVE_GAP_DAYS,
    `archive gapCount above target ${MAX_ARCHIVE_GAP_DAYS}: got ${archiveManifest.gapCount}`
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
    `validate-package: OK (${codes.length} currencies, history points=${historyFrom.points.length}, sample=${fromCode}->${toCode}, strictHistory=${STRICT_HISTORY_COVERAGE ? 'on' : 'off'})`
  )
}

function validateHistoryCoverage({ dates, latestDate, strict }) {
  ensure(dates.includes(latestDate), `history points must include latestDate ${latestDate}`)

  const startDate = dateDaysBeforeUTC(latestDate, HISTORY_DAYS - 1)
  const expectedDates = enumerateDates(startDate, latestDate)
  const expectedDateSet = new Set(expectedDates)
  const dateSet = new Set(dates)
  const outsideWindow = dates.filter((date) => !expectedDateSet.has(date))
  ensure(
    outsideWindow.length === 0,
    `history points outside ${startDate}..${latestDate}: ${outsideWindow.join(', ')}`
  )

  const missingDates = expectedDates.filter((date) => !dateSet.has(date))
  if (missingDates.length > 0) {
    const message = `history/30d calendar coverage incomplete: available ${dates.length}/${HISTORY_DAYS}, missing ${missingDates.length} day(s): ${formatDateSample(missingDates)}`
    if (strict) {
      throw new Error(message)
    }
    console.warn(`validate-package: WARNING ${message}`)
  }
}

function readJSON(relativePath) {
  const fullPath = path.join(packageRoot, relativePath)
  try {
    const raw = fs.readFileSync(fullPath, 'utf8')
    return JSON.parse(raw)
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new Error(`missing required file ${relativePath}`)
    }
    if (error instanceof SyntaxError) {
      throw new Error(`invalid JSON in ${relativePath}: ${error.message}`)
    }
    throw error
  }
}

function ensure(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function warnIf(condition, message) {
  if (condition) {
    console.warn(`validate-package: WARNING ${message}`)
  }
}

function arraysEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false
  }
  return left.every((value, index) => value === right[index])
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

function dateDaysBeforeUTC(anchorDate, daysBefore) {
  const date = new Date(`${anchorDate}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - daysBefore)
  return date.toISOString().slice(0, 10)
}

function enumerateDates(start, end) {
  const dates = []
  const cursor = new Date(`${start}T00:00:00Z`)
  const endDate = new Date(`${end}T00:00:00Z`)
  while (cursor <= endDate) {
    dates.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return dates
}

function formatDateSample(dates) {
  if (dates.length <= 6) {
    return dates.join(', ')
  }
  return `${dates.slice(0, 3).join(', ')} ... ${dates.slice(-3).join(', ')}`
}

/**
 * Value-sanity gate: flag implausible day-over-day rate jumps between today's
 * EUR-base table and the prior published day. A wrong-but-positive single-source
 * rate clears every structural check, so a >2x jump (gross) refuses the publish
 * and a >15% move (warn) surfaces for review. Pure + exported for tests.
 */
function computeRateSanity(todayRates, priorRates, { maxRatio = 2.0, warnRatio = 1.15 } = {}) {
  const gross = []
  const warns = []
  for (const [code, rate] of Object.entries(todayRates || {})) {
    const prev = priorRates && priorRates[code]
    if (!Number.isFinite(prev) || prev <= 0 || !Number.isFinite(rate) || rate <= 0) continue
    const ratio = rate / prev
    if (ratio > maxRatio || ratio < 1 / maxRatio) {
      gross.push({ code, prev, rate, ratio })
    } else if (ratio > warnRatio || ratio < 1 / warnRatio) {
      warns.push({ code, ratio })
    }
  }
  return { gross, warns }
}

module.exports = {
  main,
  computeRateSanity
}
