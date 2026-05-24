const test = require('node:test')
const assert = require('node:assert/strict')

const {
  applyDeterministicCurrencyDerivations,
  auditDate,
  buildBackfillAudit,
  createFxApiPairHistorySource,
  enumerateDates,
  formatAuditReport,
  missingCodes,
  normalizeRatesMap,
} = require('../scripts/audit-history-backfill-sources')

test('normalizeRatesMap keeps only positive three-letter currency rates', () => {
  assert.deepEqual(
    normalizeRatesMap({
      USD: '1.08',
      aed: 3.97,
      USDT: 1,
      bad: 0,
      eur: Number.NaN,
    }),
    {
      aed: 3.97,
      usd: 1.08,
    }
  )
})

test('auditDate requires a complete single source and reports union holes', async () => {
  const requiredCodes = ['aed', 'eur', 'fok', 'kid', 'usd']
  const result = await auditDate({
    date: '2026-05-12',
    requiredCodes,
    sources: [
      source('fawaz', {
        aed: 3.97,
        eur: 1,
        usd: 1.08,
      }),
      source('fxratesapi', {
        aed: 3.97,
        eur: 1,
        fok: 7.46,
        usd: 1.08,
      }),
    ],
  })

  assert.deepEqual(result.completeSources, [])
  assert.equal(result.unionMissingCount, 1)
  assert.deepEqual(result.unionMissing, ['kid'])
  assert.deepEqual(
    result.sourceResults.map((entry) => [entry.name, entry.missing]),
    [
      ['fawaz', ['fok', 'kid']],
      ['fxratesapi', ['kid']],
    ]
  )
})

test('auditDate applies explicit deterministic currency derivations', async () => {
  const requiredCodes = ['aud', 'dkk', 'eur', 'fok', 'kid', 'tvd', 'usd']
  const result = await auditDate({
    date: '2026-05-12',
    requiredCodes,
    sources: [
      source('source-with-pegs', {
        aud: 1.6,
        dkk: 7.46,
        eur: 1,
        usd: 1.08,
      }),
    ],
  })

  assert.deepEqual(result.completeSources, ['source-with-pegs'])
  assert.deepEqual(result.unionMissing, [])
  assert.deepEqual(result.sourceResults[0].derivations, [
    { code: 'fok', sourceCode: 'dkk' },
    { code: 'kid', sourceCode: 'aud' },
    { code: 'tvd', sourceCode: 'aud' },
  ])
})

test('applyDeterministicCurrencyDerivations does not override source-provided rates', () => {
  const result = applyDeterministicCurrencyDerivations({
    aud: 1.6,
    dkk: 7.46,
    fok: 7.45,
    tvd: 1.61,
  })

  assert.equal(result.rates.fok, 7.45)
  assert.equal(result.rates.tvd, 1.61)
  assert.deepEqual(result.derivations, [
    { code: 'kid', sourceCode: 'aud' },
  ])
})

test('buildBackfillAudit passes when each date has a full single-source candidate', async () => {
  const audit = await buildBackfillAudit({
    dates: enumerateDates('2026-05-12', '2026-05-13'),
    requiredCodes: ['eur', 'usd'],
    sources: [
      source('complete-source', {
        eur: 1,
        usd: 1.08,
      }),
    ],
  })

  assert.equal(audit.incompleteDateCount, 0)
  assert.deepEqual(
    audit.dates.map((entry) => entry.completeSources),
    [['complete-source'], ['complete-source']]
  )
})

test('formatAuditReport makes missing source coverage visible', async () => {
  const audit = await buildBackfillAudit({
    dates: ['2026-05-12'],
    requiredCodes: ['eur', 'kid', 'usd'],
    sources: [
      source('partial-source', {
        eur: 1,
        usd: 1.08,
      }),
    ],
  })

  const report = formatAuditReport(audit)

  assert.match(report, /complete=none/)
  assert.match(report, /unionMissing=kid/)
  assert.match(report, /partial-source: ok; count=2; missing=kid/)
})

test('formatAuditReport shows deterministic derivation provenance', async () => {
  const audit = await buildBackfillAudit({
    dates: ['2026-05-12'],
    requiredCodes: ['aud', 'eur', 'kid'],
    sources: [
      source('aud-source', {
        aud: 1.6,
        eur: 1,
      }),
    ],
  })

  assert.match(formatAuditReport(audit), /derived=kid<-aud/)
})

test('fxapi pair-history source composes a complete dated source with peg derivations', async () => {
  const dates = enumerateDates('2026-05-12', '2026-05-13')
  const source = createFxApiPairHistorySource({
    dates,
    fetchImpl: fakeFxApiFetch({
      AUD: {
        '2026-05-12': 1.6,
        '2026-05-13': 1.61,
      },
      DKK: {
        '2026-05-12': 7.46,
        '2026-05-13': 7.47,
      },
      SSP: {
        '2026-05-12': 5400,
        '2026-05-13': 5401,
      },
      USD: {
        '2026-05-12': 1.08,
        '2026-05-13': 1.09,
      },
    }),
    requiredCodes: ['aud', 'dkk', 'eur', 'fok', 'kid', 'ssp', 'tvd', 'usd'],
    timeoutMs: 1000,
  })

  const audit = await buildBackfillAudit({
    dates,
    requiredCodes: ['aud', 'dkk', 'eur', 'fok', 'kid', 'ssp', 'tvd', 'usd'],
    sources: [source],
  })

  assert.equal(audit.incompleteDateCount, 0)
  assert.deepEqual(audit.dates.map((entry) => entry.completeSources), [
    ['fxapi-pair-history'],
    ['fxapi-pair-history'],
  ])
  assert.deepEqual(audit.dates[0].sourceResults[0].derivations, [
    { code: 'fok', sourceCode: 'dkk' },
    { code: 'kid', sourceCode: 'aud' },
    { code: 'tvd', sourceCode: 'aud' },
  ])
})

test('missingCodes returns normalized missing codes in required order', () => {
  assert.deepEqual(
    missingCodes(['aed', 'eur', 'usd'], { AED: 3.97, usd: 1.08 }),
    ['eur']
  )
})

test('enumerateDates rejects impossible calendar dates', () => {
  assert.throws(
    () => enumerateDates('2026-02-31', '2026-03-01'),
    /Invalid --from: 2026-02-31/
  )
})

function source(name, rates) {
  return {
    name,
    fetchRates: async (date) => ({
      name,
      url: `https://example.test/${date}/${name}.json`,
      ok: true,
      rates,
    }),
  }
}

function fakeFxApiFetch(historyByTarget) {
  return async (url) => {
    const target = url.match(/\/EUR\/([A-Z]{3})\.json/)?.[1]
    const targetHistory = historyByTarget[target] || {}
    return {
      ok: true,
      json: async () => ({
        rates: Object.entries(targetHistory).map(([date, rate]) => ({ date, rate })),
      }),
    }
  }
}
