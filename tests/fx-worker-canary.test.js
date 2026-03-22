const test = require('node:test')
const assert = require('node:assert/strict')

test('defaultFxCanaryAnchorDates stays inside the retention window', async () => {
  const { defaultFxCanaryAnchorDates } = await import('../worker/src/fx-canary.mjs')

  assert.deepEqual(
    defaultFxCanaryAnchorDates(new Date('2026-03-21T12:00:00.000Z')),
    ['2026-03-21', '2026-03-14', '2026-02-19', '2025-09-22']
  )
})

test('runFxCanary checks the retention-safe default anchors', async () => {
  const { defaultFxCanaryAnchorDates, runFxCanary } = await import('../worker/src/fx-canary.mjs')
  const seenAnchorDates = []
  const fixedToday = new Date('2026-03-21T12:00:00.000Z')
  const expectedAnchorDates = defaultFxCanaryAnchorDates(fixedToday)

  const report = await runFxCanary({
    pairs: [{ from: 'AED', to: 'USD' }],
    anchorDates: expectedAnchorDates,
    buildReport: async ({ anchorDate }) => {
      seenAnchorDates.push(anchorDate)
      return {
        mismatchCount: 0,
        from: 'AED',
        to: 'USD',
        anchorDate,
        requestedDays: 30,
        quote: {
          resolutionKind: 'exact',
          resolvedDate: anchorDate,
        },
        historyCoverage: {
          availableDays: 30,
          missingDayCount: 0,
          archiveGapCount: 0,
        },
        signals: [],
      }
    },
  })

  assert.deepEqual(seenAnchorDates, expectedAnchorDates)
  assert.equal(report.ok, true)
  assert.equal(report.mismatchCount, 0)
  assert.equal(report.failureCount, 0)
  assert.deepEqual(report.results.map((result) => result.anchorDate), expectedAnchorDates)
})
