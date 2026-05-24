const test = require('node:test')
const assert = require('node:assert/strict')

const {
  auditDate,
  buildBackfillAudit,
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
