const test = require('node:test')
const assert = require('node:assert/strict')

const {
  QUORUM_TOLERANCE,
  MIN_AGREE,
  FX_MAX_RATE_AGE_HOURS,
  WEEKEND_WARN_TOLERANCE,
  REFUSE_TOLERANCE,
  relDiff,
  median,
  largestAgreeingCluster,
  reconcile,
  snapshotAgeHours,
  isFresh,
  crossCheckPairs,
  normalizeRates,
  parseErApiDate,
  parseErApiSnapshot,
  parseFrankfurterSnapshot,
  fetchErApiSnapshot,
  fetchFrankfurterSnapshot,
  buildReconciliation,
  evaluateCrossSourceAgreement,
} = require('../scripts/lib/sources')

// --- constants stay pinned to the Go source of truth ------------------------

test('constants match the ported Go quorum (internal/fx)', () => {
  assert.equal(QUORUM_TOLERANCE, 0.005)
  assert.equal(MIN_AGREE, 2)
  assert.equal(FX_MAX_RATE_AGE_HOURS, 96)
  assert.equal(REFUSE_TOLERANCE, 0.05)
})

// --- relDiff / median / largestAgreeingCluster (Go ports) -------------------

test('relDiff is symmetric and normalized by the smaller magnitude', () => {
  assert.equal(relDiff(100, 100), 0)
  assert.equal(relDiff(100, 100.5), 0.5 / 100)
  assert.equal(relDiff(100.5, 100), 0.5 / 100)
  // non-positive guard: never divide by zero
  assert.equal(relDiff(0, 5), 1)
})

test('median matches Go (odd + even length, unsorted input, no mutation)', () => {
  const odd = [3, 1, 2]
  assert.equal(median(odd), 2)
  assert.deepEqual(odd, [3, 1, 2], 'median must not mutate the caller array')
  assert.equal(median([4, 1, 3, 2]), 2.5)
})

test('largestAgreeingCluster keeps the biggest within-tolerance run and drops outliers', () => {
  // three tight values + one 3% outlier: cluster is the three, outlier dropped
  const cluster = largestAgreeingCluster([1.0, 1.002, 1.004, 1.03])
  assert.deepEqual(cluster, [1.0, 1.002, 1.004])
  // single value passes through
  assert.deepEqual(largestAgreeingCluster([2.5]), [2.5])
})

// --- reconcile (Go Reconcile port) ------------------------------------------

test('reconcile fuses agreeing sources to the per-currency median', () => {
  const { rates, failed } = reconcile([
    { source: 'a', rates: { usd: 1.080, eur: 1 } },
    { source: 'b', rates: { usd: 1.082, eur: 1 } },
  ], 2)
  assert.equal(rates.usd, median([1.080, 1.082]))
  assert.equal(rates.eur, 1)
  assert.deepEqual(failed, [])
})

test('reconcile fails a currency when sources disagree beyond tolerance', () => {
  const { rates, failed } = reconcile([
    { source: 'a', rates: { usd: 1.08, gbp: 0.85 } },
    { source: 'b', rates: { usd: 1.30, gbp: 0.85 } }, // usd off by ~20%
  ], 2)
  assert.equal(rates.gbp, 0.85)
  assert.equal(rates.usd, undefined)
  assert.deepEqual(failed, ['usd'])
})

test('reconcile drops non-positive votes and normalizes case', () => {
  const { rates, failed } = reconcile([
    { source: 'a', rates: { USD: 1.08, JPY: -1 } },
    { source: 'b', rates: { usd: 1.081, jpy: 168 } },
  ], 2)
  assert.equal(rates.usd, median([1.08, 1.081]))
  // jpy only has one positive vote -> fails quorum at minAgree 2
  assert.deepEqual(failed, ['jpy'])
})

test('reconcile throws on insufficient sources', () => {
  assert.throws(() => reconcile([{ source: 'a', rates: { usd: 1 } }], 2), /insufficient sources/)
  assert.throws(() => reconcile([], 1), /insufficient sources/)
  assert.throws(() => reconcile([{ rates: {} }], 0), /minAgree must be >= 1/)
})

// --- freshness gate (FX_MAX_RATE_AGE_HOURS = 96h) ---------------------------

test('snapshotAgeHours measures source date to publish date in hours', () => {
  assert.equal(snapshotAgeHours('2026-07-03', '2026-07-03'), 0)
  assert.equal(snapshotAgeHours('2026-07-02', '2026-07-03'), 24)
  assert.equal(snapshotAgeHours('bogus', '2026-07-03'), null)
})

test('isFresh treats a Friday snapshot served through Tuesday as fresh (96h window)', () => {
  // Fri 2026-07-03 rates, published on the following Mon/Tue after a holiday.
  assert.equal(isFresh('2026-07-03', '2026-07-06'), true) // 72h
  assert.equal(isFresh('2026-07-03', '2026-07-07'), true) // 96h exactly
  assert.equal(isFresh('2026-07-03', '2026-07-08'), false) // 120h — stuck source
  // unknown/unparseable date is treated as fresh (not penalized)
  assert.equal(isFresh('', '2026-07-03'), true)
})

// --- crossCheckPairs: intersection only, tail ignored -----------------------

test('crossCheckPairs compares only the currency intersection and stays sorted', () => {
  const primary = { usd: 1.08, gbp: 0.85, thb: 39.5, xof: 655 } // thb/xof are tail
  const secondary = { usd: 1.083, gbp: 0.85, sek: 11.2 } // sek not in primary
  const pairs = crossCheckPairs(primary, secondary)
  assert.deepEqual(pairs.map((p) => p.code), ['gbp', 'usd'])
  assert.equal(pairs.find((p) => p.code === 'gbp').relDiff, 0)
  assert.ok(pairs.find((p) => p.code === 'usd').relDiff > 0)
})

// --- parsers (Go sources.go ports) ------------------------------------------

test('normalizeRates lowercases keys and drops non-positive/non-numeric values', () => {
  assert.deepEqual(normalizeRates({ USD: '1.2', EUR: 1, BAD: 'x', ZERO: 0 }), { usd: 1.2, eur: 1 })
})

test('parseErApiDate maps RFC1123 to ISO and tolerates junk', () => {
  assert.equal(parseErApiDate('Fri, 03 Jul 2026 00:00:01 +0000'), '2026-07-03')
  assert.equal(parseErApiDate(''), '')
  assert.equal(parseErApiDate('not a date'), '')
})

test('parseErApiSnapshot validates result/base and normalizes rates', () => {
  const snap = parseErApiSnapshot({
    result: 'success',
    base_code: 'EUR',
    time_last_update_utc: 'Fri, 03 Jul 2026 00:00:01 +0000',
    rates: { USD: 1.08, EUR: 1 },
  })
  assert.equal(snap.source, 'er-api')
  assert.equal(snap.date, '2026-07-03')
  assert.deepEqual(snap.rates, { usd: 1.08, eur: 1 })
  assert.throws(() => parseErApiSnapshot({ result: 'error', rates: { usd: 1 } }), /upstream result/)
  assert.throws(() => parseErApiSnapshot({ base_code: 'USD', rates: { usd: 1 } }), /unexpected base/)
  assert.throws(() => parseErApiSnapshot({ result: 'success', rates: {} }), /empty rate table/)
})

test('parseFrankfurterSnapshot adds the implicit EUR base and validates', () => {
  const snap = parseFrankfurterSnapshot({ base: 'EUR', date: '2026-07-03', rates: { USD: 1.083, GBP: 0.85 } })
  assert.equal(snap.source, 'frankfurter')
  assert.equal(snap.date, '2026-07-03')
  assert.equal(snap.rates.eur, 1, 'EUR base must be made explicit')
  assert.equal(snap.rates.usd, 1.083)
  assert.throws(() => parseFrankfurterSnapshot({ base: 'USD', rates: { usd: 1 } }), /unexpected base/)
  assert.throws(() => parseFrankfurterSnapshot({ base: 'EUR', rates: {} }), /empty rate table/)
})

test('fetchErApiSnapshot / fetchFrankfurterSnapshot hit the pinned EUR-base URLs', async () => {
  const seen = []
  const erApi = await fetchErApiSnapshot({
    fetchJson: async (url) => {
      seen.push(url)
      return { result: 'success', base_code: 'EUR', time_last_update_utc: 'Fri, 03 Jul 2026 00:00:01 +0000', rates: { USD: 1.08 } }
    },
  })
  assert.equal(erApi.rates.usd, 1.08)
  assert.match(seen[0], /open\.er-api\.com\/v6\/latest\/EUR/)

  const frank = await fetchFrankfurterSnapshot({
    fetchJson: async (url) => {
      seen.push(url)
      return { base: 'EUR', date: '2026-07-03', rates: { USD: 1.083 } }
    },
  })
  assert.equal(frank.rates.usd, 1.083)
  assert.match(seen[1], /frankfurter\.app\/latest\?base=EUR/)
})

// --- buildReconciliation: the publish decision + emitted metadata -----------

const majors = { usd: 1.08, gbp: 0.85, jpy: 168, chf: 0.96 }
const tail = { thb: 39.5, xof: 655.9, myr: 5.1 }

test('both sources up: er-api stays authoritative, tail preserved, agreement emitted', () => {
  const primary = { source: 'er-api', date: '2026-07-03', rates: { ...majors, ...tail } }
  const secondary = {
    source: 'frankfurter',
    date: '2026-07-03',
    rates: { usd: 1.0805, gbp: 0.8502, jpy: 168.1, chf: 0.9603, eur: 1 },
  }
  const { rates, reconciliation } = buildReconciliation({ primary, secondary, publishDate: '2026-07-03' })

  // published values are er-api's, unchanged, including the tail
  assert.deepEqual(rates, primary.rates)
  assert.equal(reconciliation.publishedSource, 'er-api')
  assert.equal(reconciliation.reducedCoverage, false)
  assert.equal(reconciliation.stale, false)
  assert.equal(reconciliation.sources.length, 2)
  assert.equal(reconciliation.agreement.weekend, false)
  assert.equal(reconciliation.agreement.intersectionCount, 4) // majors only; tail excluded
  assert.ok(reconciliation.agreement.pairs.every((p) => p.relDiff < QUORUM_TOLERANCE))
})

test('er-api down, Frankfurter up: degrade to majors with reducedCoverage', () => {
  const secondary = { source: 'frankfurter', date: '2026-07-03', rates: { ...majors, eur: 1 } }
  const { rates, reconciliation } = buildReconciliation({ primary: null, secondary, publishDate: '2026-07-03' })

  assert.equal(reconciliation.publishedSource, 'frankfurter')
  assert.equal(reconciliation.reducedCoverage, true)
  assert.equal(rates.usd, 1.08)
  assert.equal(rates.thb, undefined, 'tail currencies are unavailable in degraded mode')
  assert.equal(reconciliation.agreement, null, 'no cross-check with a single source')
})

test('both sources down: no rates, caller must fail', () => {
  const { rates, reconciliation } = buildReconciliation({ primary: null, secondary: null, publishDate: '2026-07-03' })
  assert.equal(rates, null)
  assert.equal(reconciliation.publishedSource, null)
})

test('stale primary with no fresh secondary still publishes but is flagged stale', () => {
  const primary = { source: 'er-api', date: '2026-06-20', rates: { ...majors, ...tail } } // way older than 96h
  const { rates, reconciliation } = buildReconciliation({ primary, secondary: null, publishDate: '2026-07-03' })
  assert.deepEqual(rates, primary.rates)
  assert.equal(reconciliation.stale, true)
})

test('stale primary + fresh secondary prefers the fresh secondary (reduced coverage)', () => {
  const primary = { source: 'er-api', date: '2026-06-20', rates: { ...majors, ...tail } }
  const secondary = { source: 'frankfurter', date: '2026-07-03', rates: { ...majors, eur: 1 } }
  const { reconciliation } = buildReconciliation({ primary, secondary, publishDate: '2026-07-03' })
  assert.equal(reconciliation.publishedSource, 'frankfurter')
  assert.equal(reconciliation.reducedCoverage, true)
})

test('weekend date divergence flags weekend on the agreement', () => {
  const primary = { source: 'er-api', date: '2026-07-04', rates: { ...majors } } // Saturday
  const secondary = { source: 'frankfurter', date: '2026-07-03', rates: { ...majors, eur: 1 } } // Friday re-served
  const { reconciliation } = buildReconciliation({ primary, secondary, publishDate: '2026-07-04' })
  assert.equal(reconciliation.agreement.weekend, true)
})

// --- evaluateCrossSourceAgreement: the validate-package gate -----------------

test('gate warns on >0.5% business-day drift and refuses on >5%', () => {
  const agreement = {
    weekend: false,
    pairs: [
      { code: 'usd', relDiff: 0.001 }, // fine
      { code: 'gbp', relDiff: 0.008 }, // warn (>0.5%)
      { code: 'jpy', relDiff: 0.06 }, // refuse (>5%)
    ],
  }
  const { warns, refusals } = evaluateCrossSourceAgreement(agreement)
  assert.deepEqual(warns.map((w) => w.code), ['gbp'])
  assert.deepEqual(refusals.map((r) => r.code), ['jpy'])
})

test('gate uses the wider weekend band so ECB stale-Friday rates do not spam warnings', () => {
  const pairs = [{ code: 'usd', relDiff: 0.008 }] // 0.8%: warns on business day, silent on weekend
  assert.equal(evaluateCrossSourceAgreement({ weekend: false, pairs }).warns.length, 1)
  assert.equal(evaluateCrossSourceAgreement({ weekend: true, pairs }).warns.length, 0)
  assert.ok(WEEKEND_WARN_TOLERANCE > 0.008)
  // but a >5% gap still refuses even on a weekend
  const gross = [{ code: 'usd', relDiff: 0.07 }]
  assert.equal(evaluateCrossSourceAgreement({ weekend: true, pairs: gross }).refusals.length, 1)
})

test('gate is a no-op when no agreement metadata is present (single-source day)', () => {
  assert.deepEqual(evaluateCrossSourceAgreement(null), { warns: [], refusals: [] })
  assert.deepEqual(evaluateCrossSourceAgreement({ pairs: undefined }), { warns: [], refusals: [] })
})
