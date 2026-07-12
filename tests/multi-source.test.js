const test = require('node:test')
const assert = require('node:assert/strict')

const {
  PRIMARY_MIN_CURRENCIES,
  SECONDARY_MIN_CURRENCIES,
  PRIMARY_MAX_RATE_AGE_HOURS,
  SECONDARY_MAX_RATE_AGE_HOURS,
  LAGGED_SECONDARY_WARN_TOLERANCE,
  REFUSE_TOLERANCE,
  normalizeRates,
  parseErApiDate,
  parseErApiSnapshot,
  parseFrankfurterSnapshot,
  fetchErApiSnapshot,
  fetchFrankfurterSnapshot,
  snapshotAgeHours,
  isPrimaryFresh,
  isSecondaryFresh,
  findMissingCurrencyCodes,
  relativeDifference,
  crossCheckPairs,
  buildReconciliation,
  evaluateCrossSourceAgreement
} = require('../scripts/lib/sources')

function rateTable(count, { includeEur = true } = {}) {
  const rates = {}
  for (let index = 0; index < count; index += 1) {
    rates[`x${index}`] = index + 1
  }
  if (includeEur) rates.eur = 1
  return rates
}

test('source coverage and freshness limits stay pinned', () => {
  assert.equal(PRIMARY_MIN_CURRENCIES, 100)
  assert.equal(SECONDARY_MIN_CURRENCIES, 20)
  assert.equal(PRIMARY_MAX_RATE_AGE_HOURS, 0)
  assert.equal(SECONDARY_MAX_RATE_AGE_HOURS, 96)
  assert.equal(REFUSE_TOLERANCE, 0.05)
})

test('normalizeRates lowercases, sorts, and drops invalid values', () => {
  assert.deepEqual(
    normalizeRates({ USD: '1.2', EUR: 1, BAD: 'nope', ZERO: 0 }),
    { eur: 1, usd: 1.2 }
  )
})

test('parseErApiDate normalizes valid dates and rejects unknown freshness', () => {
  assert.equal(parseErApiDate('Fri, 03 Jul 2026 00:00:01 +0000'), '2026-07-03')
  assert.equal(parseErApiDate(''), null)
  assert.equal(parseErApiDate('not a date'), null)
})

test('er-api parser requires success, EUR, a date, and full coverage', () => {
  const snapshot = parseErApiSnapshot({
    result: 'success',
    base_code: 'EUR',
    time_last_update_utc: 'Fri, 03 Jul 2026 00:00:01 +0000',
    rates: rateTable(PRIMARY_MIN_CURRENCIES)
  })
  assert.equal(snapshot.source, 'er-api')
  assert.equal(snapshot.date, '2026-07-03')
  assert.ok(Object.keys(snapshot.rates).length >= PRIMARY_MIN_CURRENCIES)

  assert.throws(
    () => parseErApiSnapshot({ result: 'error', base_code: 'EUR', rates: rateTable(100) }),
    /upstream result/
  )
  assert.throws(
    () => parseErApiSnapshot({ result: 'success', base_code: 'USD', rates: rateTable(100) }),
    /unexpected base/
  )
  assert.throws(
    () => parseErApiSnapshot({ result: 'success', base_code: 'EUR', rates: rateTable(100) }),
    /invalid update date/
  )
  assert.throws(
    () => parseErApiSnapshot({
      result: 'success',
      base_code: 'EUR',
      time_last_update_utc: 'Fri, 03 Jul 2026 00:00:01 +0000',
      rates: { eur: 1, usd: 1.08 }
    }),
    /expected at least 100 currencies/
  )
  assert.throws(
    () => parseErApiSnapshot({
      result: 'success',
      base_code: 'EUR',
      time_last_update_utc: 'Fri, 03 Jul 2026 00:00:01 +0000',
      rates: rateTable(PRIMARY_MIN_CURRENCIES, { includeEur: false })
    }),
    /EUR self-rate must equal 1/
  )
  assert.throws(
    () => parseErApiSnapshot({
      result: 'success',
      base_code: 'EUR',
      time_last_update_utc: 'Fri, 03 Jul 2026 00:00:01 +0000',
      rates: { ...rateTable(PRIMARY_MIN_CURRENCIES), eur: 1.01 }
    }),
    /EUR self-rate must equal 1/
  )
})

test('Frankfurter parser requires EUR, a dated snapshot, and major coverage', () => {
  const snapshot = parseFrankfurterSnapshot({
    base: 'EUR',
    date: '2026-07-03',
    rates: rateTable(SECONDARY_MIN_CURRENCIES, { includeEur: false })
  })
  assert.equal(snapshot.source, 'frankfurter')
  assert.equal(snapshot.rates.eur, 1)

  assert.throws(
    () => parseFrankfurterSnapshot({ base: 'USD', date: '2026-07-03', rates: rateTable(20) }),
    /unexpected base/
  )
  assert.throws(
    () => parseFrankfurterSnapshot({ base: 'EUR', date: 'bogus', rates: rateTable(20) }),
    /invalid update date/
  )
  assert.throws(
    () => parseFrankfurterSnapshot({ base: 'EUR', date: '2026-02-31', rates: rateTable(20) }),
    /invalid update date/
  )
  assert.throws(
    () => parseFrankfurterSnapshot({ base: 'EUR', date: '2026-07-03', rates: { usd: 1.08 } }),
    /expected at least 20 currencies/
  )
})

test('fetchers use the pinned independent EUR-base endpoints', async () => {
  const seen = []
  await fetchErApiSnapshot({
    minCurrencies: 1,
    fetchJson: async (url, timeoutMs) => {
      seen.push({ url, timeoutMs })
      return {
        result: 'success',
        base_code: 'EUR',
        time_last_update_utc: 'Fri, 03 Jul 2026 00:00:01 +0000',
        rates: { EUR: 1, USD: 1.08 }
      }
    }
  })
  await fetchFrankfurterSnapshot({
    minCurrencies: 1,
    fetchJson: async (url, timeoutMs) => {
      seen.push({ url, timeoutMs })
      return { base: 'EUR', date: '2026-07-03', rates: { USD: 1.081 } }
    }
  })

  assert.match(seen[0].url, /open\.er-api\.com\/v6\/latest\/EUR/)
  assert.equal(seen[0].timeoutMs, 30_000)
  assert.match(seen[1].url, /frankfurter\.app\/latest\?base=EUR/)
  assert.equal(seen[1].timeoutMs, 15_000)
})

test('primary freshness is exact-date while secondary freshness allows a 96-hour lag', () => {
  assert.equal(snapshotAgeHours('2026-07-03', '2026-07-07'), 96)
  assert.equal(isPrimaryFresh('2026-07-07', '2026-07-07'), true)
  assert.equal(isPrimaryFresh('2026-07-06', '2026-07-07'), false)
  assert.equal(isPrimaryFresh('', '2026-07-07'), false)
  assert.equal(isPrimaryFresh('2026-07-08', '2026-07-07'), false)
  assert.equal(isSecondaryFresh('2026-07-03', '2026-07-07'), true)
  assert.equal(isSecondaryFresh('2026-07-03', '2026-07-08'), false)
  assert.equal(isSecondaryFresh('2026-07-08', '2026-07-07'), false)
})

test('weekend publication still requires same-day primary while accepting lagged ECB', () => {
  const { reconciliation } = buildReconciliation({
    primary: { source: 'er-api', date: '2026-07-12', rates: { eur: 1, usd: 1.08 } },
    secondary: { source: 'frankfurter', date: '2026-07-10', rates: { eur: 1, usd: 1.081 } },
    publishDate: '2026-07-12'
  })

  assert.equal(reconciliation.stale, false)
  assert.equal(reconciliation.sources[0].ageHours, 0)
  assert.equal(reconciliation.sources[1].ageHours, 48)
  assert.equal(reconciliation.sources[1].fresh, true)
  assert.equal(reconciliation.agreement.secondaryLagged, true)

  const stalePrimary = buildReconciliation({
    primary: { source: 'er-api', date: '2026-07-11', rates: { eur: 1, usd: 1.08 } },
    secondary: null,
    publishDate: '2026-07-12'
  })
  assert.equal(stalePrimary.reconciliation.stale, true)
})

test('currency continuity allows additions and reports only trusted removals', () => {
  assert.deepEqual(
    findMissingCurrencyCodes(
      { eur: 1, usd: 1.08, new: 2 },
      { EUR: 1, USD: 1.07 }
    ),
    []
  )
  assert.deepEqual(
    findMissingCurrencyCodes(
      { eur: 1, new: 2 },
      { EUR: 1, USD: 1.07 }
    ),
    ['usd']
  )
})

test('cross-check compares only the intersection and preserves authoritative values', () => {
  assert.equal(relativeDifference(100, 100.5), 0.005)
  const pairs = crossCheckPairs(
    { usd: 1.08, gbp: 0.85, thb: 39.5 },
    { usd: 1.081, gbp: 0.85, sek: 11.2 }
  )
  assert.deepEqual(pairs.map((pair) => pair.code), ['gbp', 'usd'])

  const primary = {
    source: 'er-api',
    date: '2026-07-03',
    rates: { eur: 1, usd: 1.08, thb: 39.5 }
  }
  const secondary = {
    source: 'frankfurter',
    date: '2026-07-03',
    rates: { eur: 1, usd: 1.081 }
  }
  const { rates, reconciliation } = buildReconciliation({
    primary,
    secondary,
    publishDate: '2026-07-03'
  })
  assert.deepEqual(rates, primary.rates)
  assert.equal(reconciliation.publishedSource, 'er-api')
  assert.equal(reconciliation.stale, false)
  assert.equal(reconciliation.agreement.intersectionCount, 2)
})

test('reconciliation never promotes a partial secondary table', () => {
  const secondary = {
    source: 'frankfurter',
    date: '2026-07-03',
    rates: { eur: 1, usd: 1.081 }
  }
  const { rates, reconciliation } = buildReconciliation({
    primary: null,
    secondary,
    publishDate: '2026-07-03'
  })
  assert.equal(rates, null)
  assert.equal(reconciliation.publishedSource, null)
  assert.equal(reconciliation.agreement, null)
})

test('stale secondary remains visible but is excluded from the agreement gate', () => {
  const { reconciliation } = buildReconciliation({
    primary: { source: 'er-api', date: '2026-07-08', rates: { eur: 1, usd: 1.08 } },
    secondary: { source: 'frankfurter', date: '2026-07-01', rates: { eur: 1, usd: 1.081 } },
    publishDate: '2026-07-08'
  })
  assert.equal(reconciliation.sources[1].fresh, false)
  assert.equal(reconciliation.agreement, null)
})

test('agreement warns, widens the lagged-source band, and always refuses gross drift', () => {
  const pairs = [
    { code: 'usd', relDiff: 0.001 },
    { code: 'gbp', relDiff: 0.008 },
    { code: 'jpy', relDiff: 0.06 }
  ]
  const current = evaluateCrossSourceAgreement({ secondaryLagged: false, pairs })
  assert.deepEqual(current.warns.map((entry) => entry.code), ['gbp'])
  assert.deepEqual(current.refusals.map((entry) => entry.code), ['jpy'])

  const lagged = evaluateCrossSourceAgreement({ secondaryLagged: true, pairs })
  assert.ok(LAGGED_SECONDARY_WARN_TOLERANCE > 0.008)
  assert.deepEqual(lagged.warns, [])
  assert.deepEqual(lagged.refusals.map((entry) => entry.code), ['jpy'])
})
