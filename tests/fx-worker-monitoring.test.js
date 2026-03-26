const test = require('node:test')
const assert = require('node:assert/strict')

test('captureFxRouteFailure preserves source in structured monitoring logs', async () => {
  const monitoring = await import('../worker/src/monitoring.mjs')
  const originalConsoleError = console.error
  const loggedLines = []

  console.error = line => {
    loggedLines.push(line)
  }

  try {
    const result = await monitoring.captureFxRouteFailure(new Error('boom'), {
      route: 'cron_fx_canary',
      signal: 'canary_error',
      source: 'fx-canary-cron',
      requestId: 'req-canary-failure',
      from: 'MULTI',
      to: 'MULTI',
      anchorDate: '2026-03-26',
      requestedDays: 30,
    }, {})

    assert.equal(result, false)
    assert.ok(loggedLines.some(line => line.includes('"source":"fx-canary-cron"')))
    assert.ok(loggedLines.some(line => line.includes('"route":"cron_fx_canary"')))
    assert.ok(loggedLines.some(line => line.includes('"signal":"canary_error"')))
  } finally {
    console.error = originalConsoleError
  }
})
