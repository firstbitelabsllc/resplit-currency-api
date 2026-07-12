const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')

const {
  allowArchiveRateFallback,
  bestEffortRemoveDir,
  buildArchiveManifest,
  buildArchiveYearPayloads,
  buildSnapshotWindow,
  buildTrustedCurrencyBaseline,
  computeCrossRates,
  dateDaysBeforeUTC,
  fetchLatestRates,
  fetchReconciledRates,
  listSnapshotArchiveDates,
  loadAllSnapshotsFromArchive,
  loadArchiveRateFallback,
  loadPriorTrustedSnapshotFromArchive,
  loadSameDayCommittedSnapshotFromArchive,
  loadSnapshotFromArchive,
  pruneSnapshotArchive,
  promoteBuildOutput,
  resolveArchiveDateForPublish,
  resolvePublishDate,
  saveSnapshotToArchive,
  significantNum,
  snapshotRetentionDays,
  snapshotArchiveDir,
  toLowerSorted,
  writeJsonFile,
  writeTextFile
} = require('../currscript')

function currencyTable(count) {
  const rates = { eur: 1 }
  for (let index = 0; index < count - 1; index += 1) {
    rates[`x${String(index).padStart(3, '0')}`] = index + 2
  }
  return rates
}

const noPriorTrustedSnapshot = () => null
const noSameDayCommittedSnapshot = () => null

test('snapshot retention is pinned to one year', () => {
  assert.equal(snapshotRetentionDays, 365)
})

test('toLowerSorted normalizes keys, filters invalid values, and sorts', () => {
  const input = {
    USD: '1.3',
    eur: 1,
    ZZZ: 0,
    bad: 'nope'
  }

  const normalized = toLowerSorted(input)
  assert.deepEqual(Object.keys(normalized), ['eur', 'usd'])
  assert.equal(normalized.eur, 1)
  assert.equal(normalized.usd, 1.3)
})

test('allowArchiveRateFallback requires an explicit opt-in env var', () => {
  assert.equal(allowArchiveRateFallback({ env: {} }), false)
  assert.equal(allowArchiveRateFallback({ env: { CURRENCY_API_ALLOW_ARCHIVE_FALLBACK: '0' } }), false)
  assert.equal(allowArchiveRateFallback({ env: { CURRENCY_API_ALLOW_ARCHIVE_FALLBACK: '1' } }), true)
  assert.equal(allowArchiveRateFallback({ env: { CURRENCY_API_ALLOW_ARCHIVE_FALLBACK: 'true' } }), true)
})

test('loadArchiveRateFallback returns exact-date archived rates when explicitly enabled', () => {
  const warnings = []
  const fallback = loadArchiveRateFallback({
    publishDate: '2026-06-30',
    env: { CURRENCY_API_ALLOW_ARCHIVE_FALLBACK: '1' },
    loadArchiveSnapshot: (date) => {
      assert.equal(date, '2026-06-30')
      return { USD: '1.2', EUR: 1 }
    },
    warn: (message) => warnings.push(message),
    reason: new Error('dns unavailable')
  })

  assert.deepEqual(fallback, { eur: 1, usd: 1.2 })
  assert.match(warnings[0], /Using exact-date archive fallback rates for 2026-06-30: dns unavailable/)
})

test('loadArchiveRateFallback stays disabled by default', () => {
  const fallback = loadArchiveRateFallback({
    publishDate: '2026-06-30',
    env: {},
    loadArchiveSnapshot: () => ({ eur: 1, usd: 1.2 }),
    warn: () => {
      throw new Error('unexpected warning')
    }
  })

  assert.equal(fallback, null)
})

test('fetchLatestRates uses upstream rates before fallback', async () => {
  const rates = await fetchLatestRates({
    publishDate: '2026-06-30',
    loadPriorTrustedSnapshot: noPriorTrustedSnapshot,
    loadSameDayCommittedSnapshot: noSameDayCommittedSnapshot,
    env: { CURRENCY_API_ALLOW_ARCHIVE_FALLBACK: '1' },
    fetchPrimary: async () => ({
      source: 'er-api',
      date: '2026-06-30',
      rates: { eur: 1, usd: 1.2 }
    }),
    loadArchiveSnapshot: () => {
      throw new Error('unexpected fallback')
    }
  })

  assert.deepEqual(rates, { eur: 1, usd: 1.2 })
})

test('fetchLatestRates can fall back to exact-date archive rates after upstream failure', async () => {
  const captured = []
  const warnings = []

  const rates = await fetchLatestRates({
    publishDate: '2026-06-30',
    loadPriorTrustedSnapshot: noPriorTrustedSnapshot,
    loadSameDayCommittedSnapshot: noSameDayCommittedSnapshot,
    env: { CURRENCY_API_ALLOW_ARCHIVE_FALLBACK: '1' },
    fetchJson: async () => {
      throw new Error('getaddrinfo EAI_AGAIN open.er-api.com')
    },
    loadArchiveSnapshot: () => ({ USD: '1.2', EUR: 1 }),
    capture: async (payload) => captured.push(payload),
    warn: (message) => warnings.push(message)
  })

  assert.deepEqual(rates, { eur: 1, usd: 1.2 })
  assert.equal(captured[0].signal, 'upstream_fetch_failure')
  assert.match(warnings[0], /Using exact-date archive fallback rates/)
})

test('fetchLatestRates still throws upstream failures when archive fallback is unavailable', async () => {
  await assert.rejects(
    () => fetchLatestRates({
      publishDate: '2026-06-30',
      loadPriorTrustedSnapshot: noPriorTrustedSnapshot,
      loadSameDayCommittedSnapshot: noSameDayCommittedSnapshot,
      env: { CURRENCY_API_ALLOW_ARCHIVE_FALLBACK: '1' },
      fetchJson: async () => {
        throw new Error('network unreachable')
      },
      loadArchiveSnapshot: () => null,
      capture: async () => {},
      warn: () => {
        throw new Error('unexpected warning')
      }
    }),
    /network unreachable/
  )
})

test('fetchReconciledRates keeps er-api authoritative and emits cross-check agreement', async () => {
  const { rates, reconciliation } = await fetchReconciledRates({
    publishDate: '2026-07-03',
    loadPriorTrustedSnapshot: noPriorTrustedSnapshot,
    loadSameDayCommittedSnapshot: noSameDayCommittedSnapshot,
    minimumIntersection: 2,
    fetchPrimary: async () => ({
      source: 'er-api',
      date: '2026-07-03',
      rates: { eur: 1, usd: 1.08, thb: 39.5 } // thb is er-api-only (tail)
    }),
    fetchSecondary: async () => ({
      source: 'frankfurter',
      date: '2026-07-03',
      rates: { eur: 1, usd: 1.0805 }
    }),
    capture: async () => {},
    warn: () => {}
  })

  // Published values are er-api's, tail preserved and unblended.
  assert.deepEqual(rates, { eur: 1, usd: 1.08, thb: 39.5 })
  assert.equal(reconciliation.publishedSource, 'er-api')
  assert.equal(reconciliation.agreement.intersectionCount, 2) // eur + usd; thb excluded
})

test('fetchReconciledRates refuses a partial Frankfurter replacement when er-api is down', async () => {
  const captured = []
  await assert.rejects(
    () => fetchReconciledRates({
      publishDate: '2026-07-03',
      loadPriorTrustedSnapshot: noPriorTrustedSnapshot,
      loadSameDayCommittedSnapshot: noSameDayCommittedSnapshot,
      env: {},
      fetchPrimary: async () => {
        throw new Error('getaddrinfo EAI_AGAIN open.er-api.com')
      },
      fetchSecondary: async () => ({
        source: 'frankfurter',
        date: '2026-07-03',
        rates: { eur: 1, usd: 1.083, gbp: 0.85 }
      }),
      loadArchiveSnapshot: () => null,
      capture: async (payload) => captured.push(payload.signal),
      warn: () => {}
    }),
    /refusing partial-currency publish/
  )
  assert.ok(captured.includes('upstream_fetch_failure'))
})

test('fetchReconciledRates preserves the explicit exact-date archive fallback', async () => {
  const { rates, reconciliation } = await fetchReconciledRates({
    publishDate: '2026-07-03',
    loadPriorTrustedSnapshot: noPriorTrustedSnapshot,
    loadSameDayCommittedSnapshot: noSameDayCommittedSnapshot,
    minimumIntersection: 2,
    env: { CURRENCY_API_ALLOW_ARCHIVE_FALLBACK: '1' },
    fetchPrimary: async () => {
      throw new Error('primary down')
    },
    fetchSecondary: async () => ({
      source: 'frankfurter',
      date: '2026-07-03',
      rates: { eur: 1, usd: 1.081 }
    }),
    loadArchiveSnapshot: () => ({ eur: 1, usd: 1.08, thb: 39.5 }),
    capture: async () => {},
    warn: () => {}
  })

  assert.deepEqual(rates, { eur: 1, thb: 39.5, usd: 1.08 })
  assert.equal(reconciliation.publishedSource, 'er-api-archive')
  assert.equal(reconciliation.stale, false)
})

test('fetchReconciledRates continues full-table publication when the tripwire is unavailable', async () => {
  const captured = []
  const warnings = []
  const { rates, reconciliation } = await fetchReconciledRates({
    publishDate: '2026-07-03',
    loadPriorTrustedSnapshot: noPriorTrustedSnapshot,
    loadSameDayCommittedSnapshot: noSameDayCommittedSnapshot,
    fetchPrimary: async () => ({
      source: 'er-api',
      date: '2026-07-03',
      rates: { eur: 1, usd: 1.08, thb: 39.5 }
    }),
    fetchSecondary: async () => {
      throw new Error('secondary down')
    },
    capture: async (payload) => captured.push(payload.signal),
    warn: (message) => warnings.push(message)
  })

  assert.equal(rates.thb, 39.5)
  assert.equal(reconciliation.agreement, null)
  assert.ok(captured.includes('fx_secondary_source_unavailable'))
  assert.match(warnings[0], /cross-check source unavailable/)
})

test('fetchReconciledRates does not claim an undersized cross-check intersection', async () => {
  const captured = []
  const warnings = []
  const { rates, reconciliation } = await fetchReconciledRates({
    publishDate: '2026-07-03',
    loadPriorTrustedSnapshot: noPriorTrustedSnapshot,
    loadSameDayCommittedSnapshot: noSameDayCommittedSnapshot,
    minimumIntersection: 3,
    fetchPrimary: async () => ({
      source: 'er-api',
      date: '2026-07-03',
      rates: { eur: 1, usd: 1.08, thb: 39.5 }
    }),
    fetchSecondary: async () => ({
      source: 'frankfurter',
      date: '2026-07-03',
      rates: { eur: 1, usd: 1.081, sek: 11.2 }
    }),
    capture: async (payload) => captured.push(payload.signal),
    warn: (message) => warnings.push(message)
  })

  assert.equal(rates.thb, 39.5)
  assert.equal(reconciliation.agreement, null)
  assert.ok(captured.includes('fx_secondary_source_incomplete_intersection'))
  assert.match(warnings[0], /intersection is incomplete \(2\/3\)/)
})

test('fetchReconciledRates refuses stale primary data', async () => {
  await assert.rejects(
    () => fetchReconciledRates({
      publishDate: '2026-07-11',
      fetchPrimary: async () => ({
        source: 'er-api',
        date: '2026-07-07',
        rates: { eur: 1, usd: 1.08 }
      }),
      fetchSecondary: async () => null,
      loadPriorTrustedSnapshot: () => null,
      loadSameDayCommittedSnapshot: noSameDayCommittedSnapshot,
      capture: async () => {},
      warn: () => {}
    }),
    /is stale; refusing publish/
  )
})

test('fetchReconciledRates refuses unexplained live-primary currency removals', async () => {
  const captured = []
  await assert.rejects(
    () => fetchReconciledRates({
      publishDate: '2026-07-11',
      fetchPrimary: async () => ({
        source: 'er-api',
        date: '2026-07-11',
        rates: currencyTable(100)
      }),
      fetchSecondary: async () => null,
      loadPriorTrustedSnapshot: () => ({
        date: '2026-07-10',
        rates: currencyTable(166)
      }),
      loadSameDayCommittedSnapshot: noSameDayCommittedSnapshot,
      capture: async (payload) => captured.push(payload.signal),
      warn: () => {}
    }),
    /missing 66 trusted currencies/
  )
  assert.ok(captured.includes('fx_currency_set_regression'))
})

test('fetchReconciledRates refuses unexplained exact-date archive-fallback removals', async () => {
  const captured = []
  await assert.rejects(
    () => fetchReconciledRates({
      publishDate: '2026-07-11',
      env: { CURRENCY_API_ALLOW_ARCHIVE_FALLBACK: '1' },
      fetchPrimary: async () => {
        throw new Error('primary down')
      },
      fetchSecondary: async () => null,
      loadArchiveSnapshot: () => currencyTable(100),
      loadPriorTrustedSnapshot: () => ({
        date: '2026-07-10',
        rates: currencyTable(166)
      }),
      loadSameDayCommittedSnapshot: noSameDayCommittedSnapshot,
      capture: async (payload) => captured.push(payload.signal),
      warn: () => {}
    }),
    /missing 66 trusted currencies/
  )
  assert.ok(captured.includes('fx_currency_set_regression'))
})

test('00:00 additions become a required baseline for a reduced 03:00 primary', async () => {
  const publishDate = '2026-07-11'
  const priorRates = currencyTable(166)
  const midnightRates = currencyTable(167)

  const midnight = await fetchReconciledRates({
    publishDate,
    fetchPrimary: async () => ({ source: 'er-api', date: publishDate, rates: midnightRates }),
    fetchSecondary: async () => null,
    loadPriorTrustedSnapshot: () => ({ date: '2026-07-10', rates: priorRates }),
    loadSameDayCommittedSnapshot: noSameDayCommittedSnapshot,
    capture: async () => {},
    warn: () => {}
  })

  assert.equal(midnight.reconciliation.trustedCurrencyBaseline.currencyCodes.length, 166)
  assert.deepEqual(
    midnight.reconciliation.trustedCurrencyBaseline.sources.map((source) => source.kind),
    ['latest_prior_archive']
  )

  const captured = []
  await assert.rejects(
    () => fetchReconciledRates({
      publishDate,
      fetchPrimary: async () => ({ source: 'er-api', date: publishDate, rates: priorRates }),
      fetchSecondary: async () => null,
      loadPriorTrustedSnapshot: () => ({ date: '2026-07-10', rates: priorRates }),
      loadSameDayCommittedSnapshot: () => ({ date: publishDate, rates: midnight.rates }),
      capture: async (payload) => captured.push(payload.signal),
      warn: () => {}
    }),
    /missing 1 trusted currency.*x165/
  )
  assert.ok(captured.includes('fx_currency_set_regression'))
})

test('03:00 refresh allows changed values and a currency superset', async () => {
  const publishDate = '2026-07-11'
  const priorRates = currencyTable(166)
  const committedSameDayRates = currencyTable(167)
  const refreshedRates = currencyTable(168)
  refreshedRates.x000 = 2.25

  const refreshed = await fetchReconciledRates({
    publishDate,
    fetchPrimary: async () => ({ source: 'er-api', date: publishDate, rates: refreshedRates }),
    fetchSecondary: async () => null,
    loadPriorTrustedSnapshot: () => ({ date: '2026-07-10', rates: priorRates }),
    loadSameDayCommittedSnapshot: () => ({ date: publishDate, rates: committedSameDayRates }),
    capture: async () => {},
    warn: () => {}
  })

  assert.equal(Object.keys(refreshed.rates).length, 168)
  assert.equal(refreshed.rates.x000, 2.25)
  assert.equal(refreshed.reconciliation.trustedCurrencyBaseline.currencyCodes.length, 167)
  assert.deepEqual(
    refreshed.reconciliation.trustedCurrencyBaseline.sources.map((source) => source.date),
    ['2026-07-10', publishDate]
  )
})

test('historical backfill ignores future archives and treats an existing target as the no-shrink floor', async () => {
  const publishDate = resolvePublishDate({
    env: { PUBLISH_DATE: '2026-04-15' },
    now: new Date('2026-07-12T00:00:00Z')
  })
  const loadedDates = []
  const priorSnapshot = loadPriorTrustedSnapshotFromArchive({
    publishDate,
    minimumCurrencies: 1,
    listDates: () => ['2026-04-14', '2026-04-15', '2026-04-16', '2026-07-11'],
    loadSnapshot: (date) => {
      loadedDates.push(date)
      return currencyTable(166)
    }
  })
  const targetSnapshot = loadSameDayCommittedSnapshotFromArchive({
    publishDate,
    minimumCurrencies: 1,
    readCommittedFile: () => JSON.stringify({
      date: publishDate,
      base: 'eur',
      rates: currencyTable(167)
    })
  })

  assert.deepEqual(loadedDates, ['2026-04-14'])
  await assert.rejects(
    () => fetchReconciledRates({
      publishDate,
      fetchPrimary: async () => ({
        source: 'er-api',
        date: publishDate,
        rates: currencyTable(166)
      }),
      fetchSecondary: async () => null,
      loadPriorTrustedSnapshot: () => priorSnapshot,
      loadSameDayCommittedSnapshot: () => targetSnapshot,
      capture: async () => {},
      warn: () => {}
    }),
    /missing 1 trusted currency.*x165/
  )
})

test('exact-date fallback cannot self-authorize a reduction from the committed same-day set', async () => {
  const publishDate = '2026-07-11'
  const priorRates = currencyTable(166)
  const committedSameDayRates = currencyTable(167)
  const captured = []

  await assert.rejects(
    () => fetchReconciledRates({
      publishDate,
      env: { CURRENCY_API_ALLOW_ARCHIVE_FALLBACK: '1' },
      fetchPrimary: async () => {
        throw new Error('primary down')
      },
      fetchSecondary: async () => null,
      loadArchiveSnapshot: () => priorRates,
      loadPriorTrustedSnapshot: () => ({ date: '2026-07-10', rates: priorRates }),
      loadSameDayCommittedSnapshot: () => ({ date: publishDate, rates: committedSameDayRates }),
      capture: async (payload) => captured.push(payload.signal),
      warn: () => {}
    }),
    /missing 1 trusted currency.*x165/
  )
  assert.ok(captured.includes('upstream_fetch_failure'))
  assert.ok(captured.includes('fx_currency_set_regression'))
})

test('an invalid committed same-day baseline fails before any provider fetch', async () => {
  let primaryCalled = false
  await assert.rejects(
    () => fetchReconciledRates({
      publishDate: '2026-07-11',
      loadPriorTrustedSnapshot: () => ({
        date: '2026-07-10',
        rates: currencyTable(166)
      }),
      loadSameDayCommittedSnapshot: () => {
        throw new Error('Committed same-day FX snapshot 2026-07-11 is invalid')
      },
      fetchPrimary: async () => {
        primaryCalled = true
        return { source: 'er-api', date: '2026-07-11', rates: currencyTable(166) }
      }
    }),
    /Committed same-day FX snapshot 2026-07-11 is invalid/
  )
  assert.equal(primaryCalled, false)
})

test('fetchReconciledRates refuses and reports a >5% cross-source disagreement', async () => {
  const captured = []
  await assert.rejects(
    () => fetchReconciledRates({
      publishDate: '2026-07-03',
      loadPriorTrustedSnapshot: noPriorTrustedSnapshot,
      loadSameDayCommittedSnapshot: noSameDayCommittedSnapshot,
      minimumIntersection: 2,
      fetchPrimary: async () => ({
        source: 'er-api',
        date: '2026-07-03',
        rates: { eur: 1, usd: 1.08 }
      }),
      fetchSecondary: async () => ({
        source: 'frankfurter',
        date: '2026-07-03',
        rates: { eur: 1, usd: 1.30 }
      }),
      capture: async (payload) => captured.push(payload.signal),
      warn: () => {}
    }),
    /cross-source disagreement >5%/
  )
  assert.ok(captured.includes('fx_cross_source_disagreement'))
})

test('computeCrossRates produces positive finite cross rates', () => {
  const rates = {
    eur: 1,
    usd: 1.2,
    aed: 4.4
  }
  const cross = computeCrossRates(rates.usd, rates)

  assert.equal(cross.usd, 1)
  assert.equal(cross.eur, significantNum(1 / 1.2))
  assert.equal(cross.aed, significantNum(4.4 / 1.2))
  assert.ok(Number.isFinite(cross.aed) && cross.aed > 0)
})

test('significantNum retains precision for small rates', () => {
  const value = significantNum(0.0000123456789)
  assert.ok(value > 0)
  assert.ok(String(value).startsWith('0.00001234'))
})

test('saveSnapshotToArchive and loadSnapshotFromArchive round-trip', (t) => {
  const testDate = '2099-01-01'
  const testRates = { eur: 1, usd: 1.2, myr: 4.8 }

  t.after(() => {
    fs.removeSync(path.join(snapshotArchiveDir, `${testDate}.json`))
  })

  saveSnapshotToArchive(testDate, testRates)
  const loaded = loadSnapshotFromArchive(testDate)

  assert.deepEqual(loaded, testRates)
})

test('loadSnapshotFromArchive returns null for missing date', () => {
  const result = loadSnapshotFromArchive('1900-01-01')
  assert.equal(result, null)
})

test('loadSnapshotFromArchive returns null for corrupt file', (t) => {
  const testDate = '2099-12-31'
  const filePath = path.join(snapshotArchiveDir, `${testDate}.json`)

  t.after(() => {
    fs.removeSync(filePath)
  })

  fs.mkdirpSync(snapshotArchiveDir)
  fs.writeFileSync(filePath, 'not json')

  const result = loadSnapshotFromArchive(testDate)
  assert.equal(result, null)
})

test('loadSnapshotFromArchive returns null for empty rates', (t) => {
  const testDate = '2099-06-15'
  const filePath = path.join(snapshotArchiveDir, `${testDate}.json`)

  t.after(() => {
    fs.removeSync(filePath)
  })

  fs.mkdirpSync(snapshotArchiveDir)
  fs.writeJsonSync(filePath, { date: testDate, base: 'eur', rates: {} })

  const result = loadSnapshotFromArchive(testDate)
  assert.equal(result, null)
})

test('loadSnapshotFromArchive refuses an internally mismatched source date', (t) => {
  const testDate = '2099-06-16'
  const filePath = path.join(snapshotArchiveDir, `${testDate}.json`)

  t.after(() => {
    fs.removeSync(filePath)
  })

  fs.mkdirpSync(snapshotArchiveDir)
  fs.writeJsonSync(filePath, {
    date: '2099-06-15',
    base: 'eur',
    rates: { eur: 1, usd: 1.2 }
  })

  assert.equal(loadSnapshotFromArchive(testDate), null)
})

test('loadPriorTrustedSnapshotFromArchive selects the latest date strictly before publish', () => {
  const loadedDates = []
  const snapshot = loadPriorTrustedSnapshotFromArchive({
    publishDate: '2026-07-11',
    minimumCurrencies: 1,
    listDates: () => ['2026-07-12', '2026-07-09', '2026-07-11', '2026-07-10'],
    loadSnapshot: (date) => {
      loadedDates.push(date)
      return { EUR: 1, USD: 1.2 }
    }
  })

  assert.deepEqual(loadedDates, ['2026-07-10'])
  assert.deepEqual(snapshot, {
    date: '2026-07-10',
    rates: { eur: 1, usd: 1.2 }
  })
})

test('loadPriorTrustedSnapshotFromArchive fails closed when the latest prior snapshot is invalid', () => {
  assert.throws(
    () => loadPriorTrustedSnapshotFromArchive({
      publishDate: '2026-07-11',
      listDates: () => ['2026-07-09', '2026-07-10'],
      loadSnapshot: () => null
    }),
    /Latest prior trusted FX snapshot 2026-07-10 is missing or invalid/
  )
})

test('loadSameDayCommittedSnapshotFromArchive validates committed date, base, and rates', () => {
  const valid = loadSameDayCommittedSnapshotFromArchive({
    publishDate: '2026-07-11',
    minimumCurrencies: 1,
    readCommittedFile: () => JSON.stringify({
      date: '2026-07-11',
      base: 'eur',
      rates: { EUR: 1, USD: 1.2 }
    })
  })
  assert.deepEqual(valid, {
    date: '2026-07-11',
    rates: { eur: 1, usd: 1.2 }
  })

  assert.throws(
    () => loadSameDayCommittedSnapshotFromArchive({
      publishDate: '2026-07-11',
      minimumCurrencies: 1,
      readCommittedFile: () => '{not json'
    }),
    /invalid JSON/
  )
  assert.throws(
    () => loadSameDayCommittedSnapshotFromArchive({
      publishDate: '2026-07-11',
      minimumCurrencies: 1,
      readCommittedFile: () => ({
        date: '2026-07-10',
        base: 'eur',
        rates: { eur: 1, usd: 1.2 }
      })
    }),
    /mismatched date or base/
  )
})

test('buildTrustedCurrencyBaseline records the union of prior and committed same-day codes', () => {
  const baseline = buildTrustedCurrencyBaseline({
    publishDate: '2026-07-11',
    priorSnapshot: { date: '2026-07-10', rates: { eur: 1, usd: 1.1 } },
    sameDayCommittedSnapshot: {
      date: '2026-07-11',
      rates: { eur: 1, usd: 1.1, xnew: 2 }
    },
    minimumCurrencies: 1
  })

  assert.deepEqual(baseline.currencyCodes, ['eur', 'usd', 'xnew'])
  assert.deepEqual(
    baseline.sources.map((source) => ({ kind: source.kind, date: source.date })),
    [
      { kind: 'latest_prior_archive', date: '2026-07-10' },
      { kind: 'same_day_committed_archive', date: '2026-07-11' }
    ]
  )
})

test('resolveArchiveDateForPublish never relabels rates under a different date', () => {
  assert.equal(
    resolveArchiveDateForPublish({
      publishDate: '2026-07-11',
      reconciliation: { publishedDate: '2026-07-11' }
    }),
    '2026-07-11'
  )
  assert.throws(
    () => resolveArchiveDateForPublish({
      publishDate: '2026-07-11',
      reconciliation: { publishedDate: '2026-07-07' }
    }),
    /does not match publish date 2026-07-11; refusing to relabel rates/
  )
})

test('buildArchiveManifest summarizes immutable archive coverage', () => {
  const manifest = buildArchiveManifest({
    availableDates: ['2026-02-20', '2026-02-21', '2026-02-23'],
    latestRates: { eur: 1, usd: 1.2, aed: 4.1 },
    generatedAt: '2026-03-16T00:00:00.000Z'
  })

  assert.equal(manifest.earliestDate, '2026-02-20')
  assert.equal(manifest.latestDate, '2026-02-23')
  assert.equal(manifest.gapCount, 1)
  assert.deepEqual(manifest.supportedCurrencies, ['aed', 'eur', 'usd'])
})

test('buildArchiveYearPayloads groups snapshots by year', () => {
  const payloads = buildArchiveYearPayloads([
    { date: '2025-12-31', rates: { eur: 1, usd: 1.1 } },
    { date: '2026-01-01', rates: { eur: 1, usd: 1.2 } },
    { date: '2026-01-02', rates: { eur: 1, usd: 1.3 } }
  ])

  assert.deepEqual(Object.keys(payloads).sort(), ['2025', '2026'])
  assert.equal(payloads['2025'].snapshots.length, 1)
  assert.equal(payloads['2026'].snapshots.length, 2)
  assert.equal(payloads['2026'].snapshots[0].date, '2026-01-01')
})

test('resolvePublishDate prefers an explicit workflow publish date', () => {
  const resolved = resolvePublishDate({
    env: { PUBLISH_DATE: '2026-03-25' },
    now: new Date('2026-03-26T01:00:00.000Z')
  })

  assert.equal(resolved, '2026-03-25')
})

test('resolvePublishDate rejects impossible calendar dates', () => {
  assert.throws(
    () => resolvePublishDate({ env: { PUBLISH_DATE: '2026-02-31' } }),
    /Invalid PUBLISH_DATE/
  )
})

test('dateDaysBeforeUTC subtracts days from the provided anchor date', () => {
  assert.equal(dateDaysBeforeUTC('2026-03-25', 1), '2026-03-24')
  assert.equal(dateDaysBeforeUTC('2026-03-25', 30), '2026-02-23')
})

test('buildSnapshotWindow anchors history fetches to the provided publish date', async () => {
  const requestedDates = []
  const savedDates = []

  const snapshots = await buildSnapshotWindow({
    todayDate: '2026-03-25',
    latestRates: { eur: 1, usd: 1.1 },
    retentionDays: 3,
    loadSnapshot: () => null,
    fetchSnapshot: async (date) => {
      requestedDates.push(date)
      return { eur: 1, usd: 1.1 }
    },
    saveSnapshot: (date) => {
      savedDates.push(date)
    },
    log: () => {}
  })

  assert.deepEqual(requestedDates, ['2026-03-24', '2026-03-23'])
  assert.deepEqual(savedDates, ['2026-03-24', '2026-03-23'])
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.date),
    ['2026-03-23', '2026-03-24', '2026-03-25']
  )
})

test('promoteBuildOutput swaps staged files into place', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'currscript-promote-'))
  const destinationRoot = path.join(tempRoot, 'package')
  const backupRoot = path.join(tempRoot, 'package.backup')
  const stagingRoot = path.join(tempRoot, 'package.staging')

  t.after(() => {
    fs.removeSync(tempRoot)
  })

  fs.mkdirpSync(destinationRoot)
  fs.writeFileSync(path.join(destinationRoot, 'stale.txt'), 'stale')

  promoteBuildOutput({
    destinationRoot,
    backupRoot,
    stagingRoot,
    build: (root) => {
      fs.writeFileSync(path.join(root, 'fresh.txt'), 'fresh')
    }
  })

  assert.equal(fs.readFileSync(path.join(destinationRoot, 'fresh.txt'), 'utf8'), 'fresh')
  assert.equal(fs.existsSync(path.join(destinationRoot, 'stale.txt')), false)
  assert.equal(fs.existsSync(backupRoot), false)
})

test('promoteBuildOutput restores the previous output when staging fails', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'currscript-promote-fail-'))
  const destinationRoot = path.join(tempRoot, 'package')
  const backupRoot = path.join(tempRoot, 'package.backup')
  const stagingRoot = path.join(tempRoot, 'package.staging')

  t.after(() => {
    fs.removeSync(tempRoot)
  })

  fs.mkdirpSync(destinationRoot)
  fs.writeFileSync(path.join(destinationRoot, 'stale.txt'), 'stale')

  assert.throws(() => {
    promoteBuildOutput({
      destinationRoot,
      backupRoot,
      stagingRoot,
      build: (root) => {
        fs.writeFileSync(path.join(root, 'partial.txt'), 'partial')
        throw new Error('build failed')
      }
    })
  }, /build failed/)

  assert.equal(fs.readFileSync(path.join(destinationRoot, 'stale.txt'), 'utf8'), 'stale')
  assert.equal(fs.existsSync(path.join(destinationRoot, 'partial.txt')), false)
  assert.equal(fs.existsSync(backupRoot), false)
  assert.equal(fs.existsSync(stagingRoot), false)
})

test('promoteBuildOutput throws when promoted backup cleanup fails', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'currscript-promote-cleanup-'))
  const destinationRoot = path.join(tempRoot, 'package')
  const backupRoot = path.join(tempRoot, 'package.backup')
  const stagingRoot = path.join(tempRoot, 'package.staging')

  t.after(() => {
    fs.removeSync(tempRoot)
  })

  fs.mkdirpSync(destinationRoot)
  fs.writeFileSync(path.join(destinationRoot, 'stale.txt'), 'stale')

  assert.throws(() => {
    promoteBuildOutput({
      destinationRoot,
      backupRoot,
      stagingRoot,
      build: (root) => {
        fs.writeFileSync(path.join(root, 'fresh.txt'), 'fresh')
      },
      removeDir: (dirPath) => {
        if (dirPath === backupRoot) {
          const error = new Error('cleanup busy')
          error.code = 'ENOTEMPTY'
          throw error
        }
        fs.removeSync(dirPath)
      },
      warn: () => {}
    })
  }, /failed to remove backup/)

  assert.equal(fs.readFileSync(path.join(destinationRoot, 'fresh.txt'), 'utf8'), 'fresh')
  assert.equal(fs.existsSync(path.join(destinationRoot, 'stale.txt')), false)
  assert.equal(fs.existsSync(backupRoot), true)
})

test('promoteBuildOutput restores the backup after partial promotion cleanup', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'currscript-promote-partial-'))
  const destinationRoot = path.join(tempRoot, 'package')
  const backupRoot = path.join(tempRoot, 'package.backup')
  const stagingRoot = path.join(tempRoot, 'package.staging')

  t.after(() => {
    fs.removeSync(tempRoot)
  })

  fs.mkdirpSync(destinationRoot)
  fs.writeFileSync(path.join(destinationRoot, 'stale.txt'), 'stale')

  assert.throws(() => {
    promoteBuildOutput({
      destinationRoot,
      backupRoot,
      stagingRoot,
      build: (root) => {
        fs.writeFileSync(path.join(root, 'fresh.txt'), 'fresh')
      },
      moveDir: (source, destination) => {
        if (source === stagingRoot && destination === destinationRoot) {
          fs.mkdirpSync(destinationRoot)
          fs.writeFileSync(path.join(destinationRoot, 'partial.txt'), 'partial')
          throw new Error('promotion failed')
        }

        fs.moveSync(source, destination, { overwrite: false })
      },
      warn: () => {}
    })
  }, /promotion failed/)

  assert.equal(fs.readFileSync(path.join(destinationRoot, 'stale.txt'), 'utf8'), 'stale')
  assert.equal(fs.existsSync(path.join(destinationRoot, 'partial.txt')), false)
  assert.equal(fs.existsSync(backupRoot), false)
  assert.equal(fs.existsSync(stagingRoot), false)
})

test('promoteBuildOutput preserves the promotion error when backup restore throws', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'currscript-promote-restore-fail-'))
  const destinationRoot = path.join(tempRoot, 'package')
  const backupRoot = path.join(tempRoot, 'package.backup')
  const stagingRoot = path.join(tempRoot, 'package.staging')

  t.after(() => {
    fs.removeSync(tempRoot)
  })

  fs.mkdirpSync(destinationRoot)
  fs.writeFileSync(path.join(destinationRoot, 'stale.txt'), 'stale')

  assert.throws(
    () => {
      promoteBuildOutput({
        destinationRoot,
        backupRoot,
        stagingRoot,
        build: (root) => {
          fs.writeFileSync(path.join(root, 'fresh.txt'), 'fresh')
        },
        moveDir: (source, destination) => {
          if (source === stagingRoot && destination === destinationRoot) {
            fs.mkdirpSync(destinationRoot)
            fs.writeFileSync(path.join(destinationRoot, 'partial.txt'), 'partial')
            throw new Error('promotion failed')
          }

          if (source === backupRoot && destination === destinationRoot) {
            throw new Error('restore failed')
          }

          fs.moveSync(source, destination, { overwrite: false })
        },
        warn: () => {}
      })
    },
    (error) => {
      assert.match(
        error.message,
        /Failed to restore .* after promotion error \(promotion failed\): restore failed/
      )
      assert.equal(error.cause.message, 'promotion failed')
      assert.equal(error.restoreFailure.message, 'restore failed')
      return true
    }
  )

  assert.equal(fs.existsSync(path.join(destinationRoot, 'partial.txt')), false)
  assert.equal(fs.existsSync(path.join(destinationRoot, 'stale.txt')), false)
  assert.equal(fs.existsSync(backupRoot), true)
  assert.equal(fs.existsSync(stagingRoot), false)
})

test('bestEffortRemoveDir tolerates transient cleanup failures', () => {
  let attempts = 0
  let exists = true

  const removed = bestEffortRemoveDir({
    dirPath: '/tmp/fake-dir',
    pathExists: () => exists,
    removeDir: () => {
      attempts += 1
      if (attempts < 3) {
        const error = new Error('busy')
        error.code = 'ENOTEMPTY'
        throw error
      }
      exists = false
    },
    warn: () => {}
  })

  assert.equal(removed, true)
  assert.equal(attempts, 3)
})

test('writeTextFile creates missing parent directories before writing', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'currscript-write-text-'))
  const target = path.join(tempRoot, 'nested', 'deeper', 'file.txt')

  t.after(() => {
    fs.removeSync(tempRoot)
  })

  writeTextFile(target, 'ok')

  assert.equal(fs.readFileSync(target, 'utf8'), 'ok')
})

test('writeJsonFile creates missing parent directories before writing', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'currscript-write-json-'))
  const target = path.join(tempRoot, 'nested', 'deeper', 'file.json')

  t.after(() => {
    fs.removeSync(tempRoot)
  })

  writeJsonFile(target, { ok: true }, true)

  assert.deepEqual(fs.readJsonSync(target), { ok: true })
})

test('loadAllSnapshotsFromArchive returns sorted immutable archive snapshots', (t) => {
  const dates = ['2099-01-03', '2099-01-01', '2099-01-02']

  t.after(() => {
    for (const date of dates) {
      fs.removeSync(path.join(snapshotArchiveDir, `${date}.json`))
    }
  })

  saveSnapshotToArchive('2099-01-03', { eur: 1, usd: 1.3 })
  saveSnapshotToArchive('2099-01-01', { eur: 1, usd: 1.1 })
  saveSnapshotToArchive('2099-01-02', { eur: 1, usd: 1.2 })

  const snapshots = loadAllSnapshotsFromArchive()
    .filter(snapshot => snapshot.date.startsWith('2099-01-0'))

  assert.deepEqual(snapshots.map(snapshot => snapshot.date), dates.slice().sort())
})

test('loadAllSnapshotsFromArchive can ignore future-dated snapshots for backfill packaging', (t) => {
  const dates = ['2099-01-01', '2099-01-02', '2099-01-03']

  t.after(() => {
    for (const date of dates) {
      fs.removeSync(path.join(snapshotArchiveDir, `${date}.json`))
    }
  })

  for (const [index, date] of dates.entries()) {
    saveSnapshotToArchive(date, { eur: 1, usd: 1.1 + index })
  }

  const filteredSnapshots = loadAllSnapshotsFromArchive({ latestDate: '2099-01-02' })
    .filter(snapshot => snapshot.date.startsWith('2099-01-0'))

  assert.deepEqual(filteredSnapshots.map(snapshot => snapshot.date), ['2099-01-01', '2099-01-02'])
  assert.deepEqual(listSnapshotArchiveDates().filter(date => date.startsWith('2099-01-0')), dates)
})

test('pruneSnapshotArchive keeps a rolling retention window anchored to the newest snapshot', (t) => {
  const dates = ['2099-01-01', '2099-01-02', '2099-01-03']

  t.after(() => {
    for (const date of dates) {
      fs.removeSync(path.join(snapshotArchiveDir, `${date}.json`))
    }
  })

  for (const [index, date] of dates.entries()) {
    saveSnapshotToArchive(date, { eur: 1, usd: 1.1 + index })
  }

  const pruned = pruneSnapshotArchive({
    retentionDays: 2,
    latestDate: '2099-01-03',
    listDates: () => dates.slice()
  })

  assert.deepEqual(pruned, ['2099-01-01'])
  assert.deepEqual(listSnapshotArchiveDates().filter(date => date.startsWith('2099-01-0')), ['2099-01-02', '2099-01-03'])
})

test('pruneSnapshotArchive does not delete newer source snapshots during backfill packaging', (t) => {
  const dates = ['2099-01-01', '2099-01-02', '2099-01-03']
  const removedPaths = []

  const pruned = pruneSnapshotArchive({
    retentionDays: 10,
    latestDate: '2099-01-02',
    listDates: () => dates.slice(),
    removeFile: (filePath) => {
      removedPaths.push(path.basename(filePath, '.json'))
    }
  })

  assert.deepEqual(pruned, [])
  assert.deepEqual(removedPaths, [])
})
