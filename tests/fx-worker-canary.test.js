const test = require('node:test')
const assert = require('node:assert/strict')

test('defaultFxCanaryAnchorDates stays inside the retention window', async () => {
  const { defaultFxCanaryAnchorDates } = await import('../worker/src/fx-canary.mjs')

  assert.deepEqual(
    defaultFxCanaryAnchorDates(new Date('2026-03-21T12:00:00.000Z')),
    ['2026-03-21', '2026-03-14', '2026-02-19', '2025-09-22']
  )
})

// The 'runFxCanary checks the retention-safe default anchors' test was removed: it
// passed a buildReport stub hardcoded to mismatchCount:0 and then asserted the
// aggregator produced ok:true / mismatchCount:0 — a mock asserting the mock. A
// planted `ok: true` bug (dropping the failureCount guard) left it green. The real
// runFxCanary aggregation, including the failure path, is covered end-to-end by
// fx-worker-routes.test.js ('returns canary report' over 12 real reports +
// 'reports canary_error on unexpected failures'), which caught that planted bug.
