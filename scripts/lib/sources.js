'use strict'

// The publisher remains full-table and primary-authoritative. Frankfurter is an
// independent tripwire only; it must never silently replace ~166 currencies
// with its much smaller ECB set.
const PRIMARY_MIN_CURRENCIES = 100
const SECONDARY_MIN_CURRENCIES = 20
const FX_MAX_RATE_AGE_HOURS = 96
const WARN_TOLERANCE = 0.005
const LAGGED_SECONDARY_WARN_TOLERANCE = 0.02
const REFUSE_TOLERANCE = 0.05
const BASE_SELF_RATE_EPSILON = 1e-9

const ER_API_URL = 'https://open.er-api.com/v6/latest/EUR'
const FRANKFURTER_URL = 'https://api.frankfurter.app/latest?base=EUR'

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function normalizeRates(rates) {
  const entries = Object.entries(rates || {})
    .map(([code, value]) => [code.toLowerCase(), Number.parseFloat(value)])
    .filter(([, value]) => Number.isFinite(value) && value > 0)
    .sort(([left], [right]) => left.localeCompare(right))
  return Object.fromEntries(entries)
}

function assertCoverage(source, rates, minimum) {
  const count = Object.keys(rates).length
  if (count < minimum) {
    throw new Error(`${source}: expected at least ${minimum} currencies, got ${count}`)
  }
}

function assertEurSelfRate(source, rates) {
  const eurRate = rates.eur
  if (!Number.isFinite(eurRate) || Math.abs(eurRate - 1) > BASE_SELF_RATE_EPSILON) {
    throw new Error(`${source}: EUR self-rate must equal 1`)
  }
}

function parseErApiDate(raw) {
  if (!raw || typeof raw !== 'string') return null
  const parsed = new Date(raw.trim())
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString().slice(0, 10)
}

function parseErApiSnapshot(data, { minCurrencies = PRIMARY_MIN_CURRENCIES } = {}) {
  if (data?.result !== 'success') {
    throw new Error(`er-api: upstream result "${data?.result || 'missing'}"`)
  }
  if (String(data?.base_code || '').toUpperCase() !== 'EUR') {
    throw new Error(`er-api: unexpected base "${data?.base_code || 'missing'}", want EUR`)
  }

  const date = parseErApiDate(data?.time_last_update_utc)
  if (!date) {
    throw new Error('er-api: missing or invalid update date')
  }

  const rates = normalizeRates(data?.rates)
  assertEurSelfRate('er-api', rates)
  assertCoverage('er-api', rates, minCurrencies)
  return { source: 'er-api', date, rates }
}

function parseFrankfurterSnapshot(data, { minCurrencies = SECONDARY_MIN_CURRENCIES } = {}) {
  if (String(data?.base || '').toUpperCase() !== 'EUR') {
    throw new Error(`frankfurter: unexpected base "${data?.base || 'missing'}", want EUR`)
  }
  if (!isIsoDate(data?.date)) {
    throw new Error('frankfurter: missing or invalid update date')
  }

  const rates = normalizeRates(data?.rates)
  rates.eur = 1
  assertCoverage('frankfurter', rates, minCurrencies)
  return { source: 'frankfurter', date: data.date, rates }
}

async function fetchErApiSnapshot({
  fetchJson,
  url = ER_API_URL,
  timeoutMs = 30_000,
  minCurrencies = PRIMARY_MIN_CURRENCIES
}) {
  const data = await fetchJson(url, timeoutMs)
  return parseErApiSnapshot(data, { minCurrencies })
}

async function fetchFrankfurterSnapshot({
  fetchJson,
  url = FRANKFURTER_URL,
  timeoutMs = 15_000,
  minCurrencies = SECONDARY_MIN_CURRENCIES
}) {
  const data = await fetchJson(url, timeoutMs)
  return parseFrankfurterSnapshot(data, { minCurrencies })
}

function snapshotAgeHours(sourceDate, publishDate) {
  if (!isIsoDate(sourceDate) || !isIsoDate(publishDate)) return null
  const source = new Date(`${sourceDate}T00:00:00Z`)
  const publish = new Date(`${publishDate}T00:00:00Z`)
  return Math.round((publish - source) / (60 * 60 * 1000))
}

function isFresh(sourceDate, publishDate, maxAgeHours = FX_MAX_RATE_AGE_HOURS) {
  const ageHours = snapshotAgeHours(sourceDate, publishDate)
  return ageHours !== null && ageHours >= 0 && ageHours <= maxAgeHours
}

function relativeDifference(left, right) {
  if (left === right) return 0
  const denominator = Math.min(left, right)
  if (!(denominator > 0)) return 1
  return Math.abs(left - right) / denominator
}

function crossCheckPairs(primary, secondary) {
  const pairs = []
  for (const [code, primaryValue] of Object.entries(primary || {})) {
    const secondaryValue = secondary?.[code]
    if (!(primaryValue > 0) || !(secondaryValue > 0)) continue
    pairs.push({
      code,
      relDiff: Number(relativeDifference(primaryValue, secondaryValue).toFixed(6))
    })
  }
  return pairs.sort((left, right) => left.code.localeCompare(right.code))
}

function describeSource(snapshot, publishDate) {
  const ageHours = snapshotAgeHours(snapshot.date, publishDate)
  return {
    source: snapshot.source,
    date: snapshot.date,
    currencyCount: Object.keys(snapshot.rates).length,
    fresh: isFresh(snapshot.date, publishDate),
    ageHours
  }
}

function buildAgreement(primary, secondary) {
  const pairs = crossCheckPairs(primary.rates, secondary.rates)
  return {
    primaryDate: primary.date,
    secondaryDate: secondary.date,
    secondaryLagged: secondary.date < primary.date,
    intersectionCount: pairs.length,
    maxRelDiff: pairs.reduce((maximum, pair) => Math.max(maximum, pair.relDiff), 0),
    pairs
  }
}

function buildReconciliation({ primary, secondary, publishDate }) {
  const sources = [primary, secondary]
    .filter(Boolean)
    .map((snapshot) => describeSource(snapshot, publishDate))
  const secondaryFresh = secondary && isFresh(secondary.date, publishDate)

  return {
    rates: primary?.rates || null,
    reconciliation: {
      publishedSource: primary?.source || null,
      stale: primary ? !isFresh(primary.date, publishDate) : false,
      sources,
      agreement: primary && secondaryFresh ? buildAgreement(primary, secondary) : null
    }
  }
}

function evaluateCrossSourceAgreement(agreement, {
  warnTolerance = WARN_TOLERANCE,
  laggedSecondaryWarnTolerance = LAGGED_SECONDARY_WARN_TOLERANCE,
  refuseTolerance = REFUSE_TOLERANCE
} = {}) {
  if (!agreement || !Array.isArray(agreement.pairs)) {
    return { warns: [], refusals: [] }
  }

  const warnBand = agreement.secondaryLagged
    ? laggedSecondaryWarnTolerance
    : warnTolerance
  const warns = []
  const refusals = []
  for (const pair of agreement.pairs) {
    if (pair.relDiff > refuseTolerance) {
      refusals.push(pair)
    } else if (pair.relDiff > warnBand) {
      warns.push(pair)
    }
  }
  return { warns, refusals }
}

module.exports = {
  PRIMARY_MIN_CURRENCIES,
  SECONDARY_MIN_CURRENCIES,
  FX_MAX_RATE_AGE_HOURS,
  WARN_TOLERANCE,
  LAGGED_SECONDARY_WARN_TOLERANCE,
  REFUSE_TOLERANCE,
  BASE_SELF_RATE_EPSILON,
  ER_API_URL,
  FRANKFURTER_URL,
  normalizeRates,
  parseErApiDate,
  parseErApiSnapshot,
  parseFrankfurterSnapshot,
  fetchErApiSnapshot,
  fetchFrankfurterSnapshot,
  snapshotAgeHours,
  isFresh,
  relativeDifference,
  crossCheckPairs,
  buildReconciliation,
  evaluateCrossSourceAgreement
}
