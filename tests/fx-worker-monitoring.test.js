const test = require('node:test')
const assert = require('node:assert/strict')

async function withCapturedConsole(method, run) {
  const original = console[method]
  const loggedLines = []

  console[method] = line => {
    loggedLines.push(line)
  }

  try {
    await run(loggedLines)
  } finally {
    console[method] = original
  }
}

test('captureFxRouteFailure preserves source in structured monitoring logs', async () => {
  const monitoring = await import('../worker/src/monitoring.mjs')

  await withCapturedConsole('error', async loggedLines => {
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
  })
})

test('captureFxCoverageMismatch logs the fallback integrity warning payload without Sentry', async () => {
  const monitoring = await import('../worker/src/monitoring.mjs')
  const report = {
    from: 'AED',
    to: 'USD',
    anchorDate: '2026-03-26',
    requestedDays: 30,
    mismatchCount: 2,
    signals: [],
    quote: {
      resolutionKind: 'exact',
      resolvedDate: '2026-03-26',
    },
    historyCoverage: {
      requestedDays: 30,
      availableDays: 28,
      missingDayCount: 2,
    },
  }

  await withCapturedConsole('warn', async loggedLines => {
    const result = await monitoring.captureFxCoverageMismatch(report, 'fx-coverage-route', 'req-coverage-mismatch', {})

    assert.equal(result, false)
    assert.equal(loggedLines.length, 1)
    assert.ok(loggedLines[0].includes('"signal":"fx_integrity_warning"'))
    assert.ok(loggedLines[0].includes('"source":"fx-coverage-route"'))
    assert.ok(loggedLines[0].includes('"requestId":"req-coverage-mismatch"'))
    assert.ok(loggedLines[0].includes('"mismatchCount":2'))
  })
})

test('captureFxCoverageMismatch logs each worker coverage signal with quote context', async () => {
  const monitoring = await import('../worker/src/monitoring.mjs')
  const report = {
    from: 'AED',
    to: 'USD',
    anchorDate: '2026-03-26',
    requestedDays: 30,
    mismatchCount: 2,
    signals: ['history_window_shorter_than_30_days', 'archive_gap_present'],
    quote: {
      resolutionKind: 'prior_day_fallback',
      resolvedDate: '2026-03-25',
    },
    historyCoverage: {
      requestedDays: 30,
      availableDays: 28,
      missingDayCount: 2,
    },
  }

  await withCapturedConsole('warn', async loggedLines => {
    const result = await monitoring.captureFxCoverageMismatch(report, 'fx-canary-cron', 'req-canary-mismatch', {})

    assert.equal(result, false)
    assert.equal(loggedLines.length, 2)
    assert.ok(loggedLines.every(line => line.includes('"source":"fx-canary-cron"')))
    assert.ok(loggedLines.some(line => line.includes('"signal":"history_window_shorter_than_30_days"')))
    assert.ok(loggedLines.some(line => line.includes('"signal":"archive_gap_present"')))
    assert.ok(loggedLines.every(line => line.includes('"quoteResolution":"prior_day_fallback"')))
    assert.ok(loggedLines.every(line => line.includes('"quoteResolvedDate":"2026-03-25"')))
  })
})

test('captureFxCoverageFailure preserves source and request context in structured monitoring logs', async () => {
  const monitoring = await import('../worker/src/monitoring.mjs')

  await withCapturedConsole('error', async loggedLines => {
    const result = await monitoring.captureFxCoverageFailure(new Error('coverage exploded'), {
      source: 'fx-coverage-route',
      from: 'AED',
      to: 'USD',
      anchorDate: '2026-03-26',
      requestedDays: 30,
      requestId: 'req-coverage-failure',
    }, {})

    assert.equal(result, false)
    assert.equal(loggedLines.length, 1)
    assert.ok(loggedLines[0].includes('"signal":"coverage_failure"'))
    assert.ok(loggedLines[0].includes('"source":"fx-coverage-route"'))
    assert.ok(loggedLines[0].includes('"requestId":"req-coverage-failure"'))
    assert.ok(loggedLines[0].includes('"error":"coverage exploded"'))
  })
})
