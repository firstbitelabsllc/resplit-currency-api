#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

const packageRoot = path.join(__dirname, '..', 'package')

main()

function main() {
  const v2Currencies = readJSON('v2/currencies.json')
  const meta = readJSON('v2/meta.json')
  const snapshot = readJSON('v2/snapshots/base-rates.json')

  const v2Codes = Object.keys(v2Currencies).sort()
  ensure(v2Codes.length >= 100, `Expected >= 100 currencies in v2 list, got ${v2Codes.length}`)

  const fromCode = pickCode(v2Codes, ['usd', 'eur', 'aed'])
  const toCode = pickCode(v2Codes, ['eur', 'usd', 'gbp', 'myr'])

  const v2LatestFrom = readJSON(`v2/latest/${fromCode}.json`)
  const v2HistoryFrom = readJSON(`v2/history/7d/${fromCode}.json`)

  ensure(isIsoDate(v2LatestFrom.date), 'v2 latest date is not ISO yyyy-mm-dd')
  ensure(v2LatestFrom.from === fromCode, `v2 latest from mismatch: expected ${fromCode}`)
  ensure(v2LatestFrom.rates && typeof v2LatestFrom.rates === 'object', 'v2 latest rates missing')
  ensure(
    Number.isFinite(v2LatestFrom.rates[toCode]) && v2LatestFrom.rates[toCode] > 0,
    'v2 latest sample rate missing'
  )

  ensure(v2HistoryFrom.from === fromCode, `v2 history from mismatch: expected ${fromCode}`)
  ensure(Array.isArray(v2HistoryFrom.points), 'v2 history points must be an array')
  ensure(
    v2HistoryFrom.points.length > 0 && v2HistoryFrom.points.length <= 7,
    `v2 history points must be 1..7, got ${v2HistoryFrom.points.length}`
  )

  let previousDate = null
  for (const point of v2HistoryFrom.points) {
    ensure(isIsoDate(point.date), `Invalid point date: ${point.date}`)
    if (previousDate !== null) {
      ensure(previousDate <= point.date, 'v2 history points must be ascending by date')
    }
    previousDate = point.date
    ensure(point.rates && typeof point.rates === 'object', `Missing rates map at ${point.date}`)
    ensure(
      Number.isFinite(point.rates[toCode]) && point.rates[toCode] > 0,
      `Missing sample pair rate at ${point.date}`
    )
  }

  ensure(isIsoDate(snapshot.date), 'v2 snapshot date is not ISO yyyy-mm-dd')
  ensure(snapshot.base === 'eur', `v2 snapshot base expected "eur", got "${snapshot.base}"`)
  ensure(snapshot.rates && typeof snapshot.rates === 'object', 'v2 snapshot rates missing')
  ensure(Object.keys(snapshot.rates).length === v2Codes.length, 'v2 snapshot currency count mismatch')

  ensure(isIsoDate(meta.latestDate), 'v2 meta latestDate invalid')
  ensure(meta.historyDays === 7, `v2 meta historyDays must be 7, got ${meta.historyDays}`)
  ensure(meta.snapshotRetentionDays >= 7, 'v2 meta snapshotRetentionDays should be >= 7')
  ensure(
    Array.isArray(meta.availableHistoryDates) &&
      meta.availableHistoryDates.length > 0 &&
      meta.availableHistoryDates.length <= 7,
    'v2 meta availableHistoryDates must contain 1..7 entries'
  )

  // Numeric consistency check between snapshot-derived pair and v2 latest pair.
  const fromBaseRate = snapshot.rates[fromCode]
  const toBaseRate = snapshot.rates[toCode]
  ensure(Number.isFinite(fromBaseRate) && fromBaseRate > 0, `snapshot missing base rate for ${fromCode}`)
  ensure(Number.isFinite(toBaseRate) && toBaseRate > 0, `snapshot missing base rate for ${toCode}`)
  const derivedLatestRate = toBaseRate / fromBaseRate
  const v2Rate = v2LatestFrom.rates[toCode]
  ensure(approximatelyEqual(derivedLatestRate, v2Rate, 1e-8), 'snapshot-derived and v2 latest sample rates diverge')

  // Minified files must parse too.
  readJSON('v2/currencies.min.json')
  readJSON('v2/meta.min.json')
  readJSON('v2/snapshots/base-rates.min.json')
  readJSON(`v2/latest/${fromCode}.min.json`)
  readJSON(`v2/history/7d/${fromCode}.min.json`)

  console.log(
    `validate-package: OK (${v2Codes.length} currencies, history points=${v2HistoryFrom.points.length}, sample=${fromCode}->${toCode})`
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
  return Math.abs(left - right) <= epsilon
}
