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

async function withMockedSentryCloudflare(run) {
  const monitoring = await import('../worker/src/monitoring.mjs')
  const calls = {
    captureCheckIn: [],
    flush: [],
    captureMessage: [],
    captureException: [],
    scopes: [],
  }

  const mockedSentry = {
    captureCheckIn(payload, config) {
      calls.captureCheckIn.push({ payload, config })
      return 'mock-canary-checkin'
    },
    flush(timeout) {
      calls.flush.push(timeout)
      return Promise.resolve(true)
    },
    captureMessage(message) {
      calls.captureMessage.push(message)
    },
    captureException(error) {
      calls.captureException.push(error)
    },
    withScope(callback) {
      const scope = {
        level: null,
        tags: {},
        contexts: {},
        setLevel(level) {
          this.level = level
        },
        setTag(key, value) {
          this.tags[key] = value
        },
        setContext(key, value) {
          this.contexts[key] = value
        },
      }
      calls.scopes.push(scope)
      callback(scope)
    },
  }

  monitoring.setSentryWorkerSdkForTests(mockedSentry)

  try {
    await run({ calls, monitoring })
  } finally {
    monitoring.resetSentryWorkerSdkForTests()
  }
}

test('getSentryWorkerOptions returns dedicated worker config when DSN is present', async () => {
  const monitoring = await import('../worker/src/monitoring.mjs')

  const options = monitoring.getSentryWorkerOptions({
    SENTRY_DSN: 'https://worker@example.ingest.sentry.io/1',
    SENTRY_ENVIRONMENT: 'staging',
    SENTRY_RELEASE: 'worker-unit-test',
  })

  assert.deepEqual(options, {
    dsn: 'https://worker@example.ingest.sentry.io/1',
    enabled: true,
    environment: 'staging',
    release: 'worker-unit-test',
    tracesSampleRate: 0,
    sendDefaultPii: false,
    initialScope: {
      tags: {
        surface: 'resplit-currency-api',
        runtime: 'worker',
      },
    },
  })
})

test('startFxCanaryCheckIn starts the dedicated worker canary monitor when DSN is present', async () => {
  await withMockedSentryCloudflare(async ({ calls, monitoring }) => {
    const checkInId = monitoring.startFxCanaryCheckIn({
      SENTRY_DSN: 'https://worker@example.ingest.sentry.io/1',
    })

    assert.equal(checkInId, 'mock-canary-checkin')
    assert.deepEqual(calls.captureCheckIn, [
      {
        payload: {
          monitorSlug: 'resplit-currency-api-fx-canary',
          status: 'in_progress',
        },
        config: {
          schedule: {
            type: 'crontab',
            value: '0 13 * * *',
          },
          checkinMargin: 60,
          maxRuntime: 1,
          timezone: 'UTC',
          failureIssueThreshold: 1,
          recoveryThreshold: 1,
        },
      },
    ])
  })
})

test('finishFxCanaryCheckIn records a completed worker canary check-in with duration', async () => {
  await withMockedSentryCloudflare(async ({ calls, monitoring }) => {
    const startedAt = 1_000
    const originalNow = Date.now
    Date.now = () => startedAt + 1_234

    try {
      const result = await monitoring.finishFxCanaryCheckIn(
        'mock-canary-checkin',
        'ok',
        startedAt,
        { SENTRY_DSN: 'https://worker@example.ingest.sentry.io/1' }
      )

      assert.equal(result, true)
      assert.deepEqual(calls.captureCheckIn, [
        {
          payload: {
            checkInId: 'mock-canary-checkin',
            monitorSlug: 'resplit-currency-api-fx-canary',
            status: 'ok',
            duration: 1.234,
          },
          config: undefined,
        },
      ])
      assert.deepEqual(calls.flush, [2_000])
    } finally {
      Date.now = originalNow
    }
  })
})

test('captureFxCanaryIncident reports a DSN-enabled worker canary failure to Sentry', async () => {
  await withMockedSentryCloudflare(async ({ calls, monitoring }) => {
    const report = {
      checkedAt: '2026-03-26T05:47:58.000Z',
      mismatchCount: 1,
      failureCount: 1,
      results: [
        {
          pair: { from: 'AED', to: 'USD' },
          anchorDate: '2026-03-26',
          ok: false,
          summary: 'coverage mismatch',
          error: 'coverage exploded',
        },
      ],
    }

    const result = await monitoring.captureFxCanaryIncident(report, 'req-canary-incident', {
      SENTRY_DSN: 'https://worker@example.ingest.sentry.io/1',
    })

    assert.equal(result, true)
    assert.deepEqual(calls.captureMessage, [
      'FX canary failed with 1 mismatches and 1 failures',
    ])
    assert.equal(calls.scopes.length, 1)
    assert.equal(calls.scopes[0].level, 'error')
    assert.equal(calls.scopes[0].tags.surface, 'resplit-currency-api')
    assert.equal(calls.scopes[0].tags.runtime, 'worker')
    assert.equal(calls.scopes[0].tags['monitoring.signal'], 'canary_error')
    assert.equal(calls.scopes[0].tags['fx.source'], 'fx-canary-cron')
    assert.equal(calls.scopes[0].tags['request.id'], 'req-canary-incident')
    assert.deepEqual(calls.scopes[0].contexts.fxCanary, {
      checkedAt: '2026-03-26T05:47:58.000Z',
      mismatchCount: 1,
      failureCount: 1,
      failingChecks: [
        {
          from: 'AED',
          to: 'USD',
          anchorDate: '2026-03-26',
          summary: 'coverage mismatch',
          error: 'coverage exploded',
        },
      ],
      requestId: 'req-canary-incident',
    })
    assert.deepEqual(calls.flush, [2_000])
  })
})

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

test('captureFxRouteFailure reports DSN-enabled route failures to Sentry', async () => {
  await withMockedSentryCloudflare(async ({ calls, monitoring }) => {
    const result = await monitoring.captureFxRouteFailure(new Error('boom'), {
      route: 'cron_fx_canary',
      signal: 'canary_error',
      source: 'fx-canary-cron',
      requestId: 'req-canary-failure',
      from: 'MULTI',
      to: 'MULTI',
      anchorDate: '2026-03-26',
      requestedDays: 30,
    }, {
      SENTRY_DSN: 'https://worker@example.ingest.sentry.io/1',
    })

    assert.equal(result, true)
    assert.equal(calls.captureException.length, 1)
    assert.equal(calls.captureException[0].message, 'boom')
    assert.deepEqual(calls.flush, [2_000])
    assert.equal(calls.scopes.length, 1)
    assert.equal(calls.scopes[0].level, 'error')
    assert.equal(calls.scopes[0].tags.surface, 'resplit-currency-api')
    assert.equal(calls.scopes[0].tags.runtime, 'worker')
    assert.equal(calls.scopes[0].tags.route, 'cron_fx_canary')
    assert.equal(calls.scopes[0].tags['monitoring.signal'], 'canary_error')
    assert.equal(calls.scopes[0].tags['fx.source'], 'fx-canary-cron')
    assert.equal(calls.scopes[0].tags['request.id'], 'req-canary-failure')
    assert.deepEqual(calls.scopes[0].contexts.fxRoute, {
      route: 'cron_fx_canary',
      signal: 'canary_error',
      source: 'fx-canary-cron',
      requestId: 'req-canary-failure',
      from: 'MULTI',
      to: 'MULTI',
      anchorDate: '2026-03-26',
      requestedDays: 30,
      error: 'boom',
    })
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

test('captureFxCoverageMismatch logs live worker coverage signals with quote context', async () => {
  const monitoring = await import('../worker/src/monitoring.mjs')
  const { buildFxCoverageReport } = await import('../worker/src/fx-diagnostics.mjs')
  const baseUrl = 'https://fx.example.test'
  const fixtures = new Map([
    [`${baseUrl}/archive-manifest.min.json`, {
      generatedAt: '2026-03-24T00:00:00.000Z',
      base: 'eur',
      earliestDate: '2026-03-22',
      latestDate: '2026-03-24',
      availableDates: ['2026-03-22', '2026-03-24'],
      gapCount: 1,
      supportedCurrencies: ['AED', 'USD'],
    }],
    [`${baseUrl}/archive-years/2026.min.json`, {
      year: '2026',
      base: 'eur',
      snapshots: [
        {
          date: '2026-03-22',
          base: 'eur',
          rates: { aed: 4, usd: 1 },
        },
        {
          date: '2026-03-24',
          base: 'eur',
          rates: { aed: 4, usd: 1 },
        },
      ],
    }],
  ])
  const fetchImpl = async url => {
    const payload = fixtures.get(url)
    if (!payload) {
      return new Response('Not found', { status: 404 })
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const report = await buildFxCoverageReport({
    from: 'AED',
    to: 'USD',
    days: 3,
    anchorDate: '2026-03-24',
    fetchImpl,
    baseUrl,
  })

  assert.deepEqual(report.signals, ['history_range_incomplete', 'archive_gap_detected'])

  await withCapturedConsole('warn', async loggedLines => {
    const result = await monitoring.captureFxCoverageMismatch(report, 'fx-coverage-route', 'req-coverage-mismatch', {})

    assert.equal(result, false)
    assert.equal(loggedLines.length, 2)
    assert.ok(loggedLines.every(line => line.includes('"source":"fx-coverage-route"')))
    assert.ok(loggedLines.some(line => line.includes('"signal":"history_range_incomplete"')))
    assert.ok(loggedLines.some(line => line.includes('"signal":"archive_gap_detected"')))
    assert.ok(loggedLines.every(line => line.includes('"quoteResolution":"exact"')))
    assert.ok(loggedLines.every(line => line.includes('"quoteResolvedDate":"2026-03-24"')))
  })
})

test('captureFxCoverageMismatch keeps public coverage-route mismatches out of Sentry', async () => {
  await withMockedSentryCloudflare(async ({ calls, monitoring }) => {
    const report = {
      from: 'AED',
      to: 'USD',
      anchorDate: '2026-03-26',
      requestedDays: 30,
      mismatchCount: 2,
      signals: ['prior_day_fallback_used', 'history_range_incomplete'],
      quote: {
        resolutionKind: 'prior_day_fallback',
        resolvedDate: '2026-03-25',
      },
      historyCoverage: {
        requestedDays: 30,
        availableDays: 29,
        missingDayCount: 1,
        archiveGapCount: 0,
      },
    }

    const result = await monitoring.captureFxCoverageMismatch(report, 'fx-coverage-route', 'req-public-route', {
      SENTRY_DSN: 'https://worker@example.ingest.sentry.io/1',
    })

    assert.equal(result, false)
    assert.deepEqual(calls.captureMessage, [])
    assert.deepEqual(calls.flush, [])
    assert.equal(calls.scopes.length, 0)
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

test('captureFxCoverageFailure reports DSN-enabled failures to Sentry', async () => {
  await withMockedSentryCloudflare(async ({ calls, monitoring }) => {
    const result = await monitoring.captureFxCoverageFailure(new Error('coverage exploded'), {
      source: 'fx-coverage-route',
      from: 'AED',
      to: 'USD',
      anchorDate: '2026-03-26',
      requestedDays: 30,
      requestId: 'req-coverage-failure',
    }, {
      SENTRY_DSN: 'https://worker@example.ingest.sentry.io/1',
    })

    assert.equal(result, true)
    assert.equal(calls.captureException.length, 1)
    assert.equal(calls.captureException[0].message, 'coverage exploded')
    assert.deepEqual(calls.flush, [2_000])
    assert.equal(calls.scopes.length, 1)
    assert.equal(calls.scopes[0].level, 'error')
    assert.equal(calls.scopes[0].tags.surface, 'resplit-currency-api')
    assert.equal(calls.scopes[0].tags.runtime, 'worker')
    assert.equal(calls.scopes[0].tags['monitoring.signal'], 'coverage_failure')
    assert.equal(calls.scopes[0].tags['fx.source'], 'fx-coverage-route')
    assert.equal(calls.scopes[0].tags['request.id'], 'req-coverage-failure')
    assert.deepEqual(calls.scopes[0].contexts.fxCoverageRequest, {
      anchorDate: '2026-03-26',
      requestedDays: 30,
      requestId: 'req-coverage-failure',
    })
  })
})
