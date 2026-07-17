const test = require('node:test')
const assert = require('node:assert/strict')

function makeJsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  })
}

function withStubbedFetch(fetchImpl, run) {
  const originalFetch = global.fetch
  global.fetch = fetchImpl
  return Promise.resolve()
    .then(run)
    .finally(() => {
      global.fetch = originalFetch
    })
}

async function withThrowingConsole(method, run) {
  const original = console[method]
  console[method] = () => {
    throw new Error(`${method} sink rejected`)
  }
  try {
    await run()
  } finally {
    console[method] = original
  }
}

async function withCapturedConsole(method, run) {
  const original = console[method]
  const lines = []
  console[method] = (...args) => {
    lines.push(args.map(String).join(' '))
  }
  try {
    await run(lines)
  } finally {
    console[method] = original
  }
}

async function withRejectingTelemetry(run) {
  const monitoring = await import('../worker/src/monitoring.mjs')
  const scope = {
    setLevel() {},
    setTag() {},
    setContext() {},
  }
  monitoring.setSentryWorkerSdkForTests({
    withScope(callback) {
      callback(scope)
    },
    captureException() {},
    captureMessage() {},
    captureCheckIn(payload) {
      return payload.status === 'in_progress' ? 'rejecting-check-in' : undefined
    },
    flush() {
      return Promise.reject(new Error('telemetry flush rejected'))
    },
  })

  try {
    await run()
  } finally {
    monitoring.resetSentryWorkerSdkForTests()
  }
}

function enumerateDates(start, end) {
  const dates = []
  const cursor = new Date(`${start}T00:00:00Z`)
  const endDate = new Date(`${end}T00:00:00Z`)
  while (cursor <= endDate) {
    dates.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return dates
}

function createArchiveFetchStub(availableDates, rates = { eur: 1, usd: 1.2, aed: 4, myr: 5 }) {
  const snapshotsByYear = new Map()
  for (const date of availableDates) {
    const year = date.slice(0, 4)
    if (!snapshotsByYear.has(year)) {
      snapshotsByYear.set(year, [])
    }
    snapshotsByYear.get(year).push({
      date,
      base: 'eur',
      rates,
    })
  }

  return async input => {
    const url = String(input)
    if (url.endsWith('/archive-manifest.min.json')) {
      return makeJsonResponse({
        earliestDate: availableDates[0] ?? null,
        latestDate: availableDates.at(-1) ?? null,
        availableDates,
        gapCount: 0,
        supportedCurrencies: Object.keys(rates).sort(),
      })
    }

    const match = url.match(/\/archive-years\/(\d{4})\.min\.json$/)
    if (match) {
      return makeJsonResponse({
        year: match[1],
        base: 'eur',
        snapshots: snapshotsByYear.get(match[1]) ?? [],
      })
    }

    throw new Error(`Unexpected URL: ${url}`)
  }
}

test('worker health route returns liveness payload with request id', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')

  const response = await handleRequest(
    new Request('https://example.workers.dev/health', {
      headers: { 'x-request-id': 'req-health' },
    }),
    {
      SENTRY_ENVIRONMENT: 'production',
      SENTRY_RELEASE: 'release-123',
    }
  )

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-request-id'), 'req-health')
  assert.equal(response.headers.get('x-resplit-trace-id'), 'req-health')
  assert.equal(response.headers.get('cache-control'), 'no-store')

  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.service, 'resplit-currency-api')
  assert.equal(body.environment, 'production')
  assert.equal(body.release, 'release-123')
  assert.match(body.timestamp, /^\d{4}-\d{2}-\d{2}T/)
})

test('worker health route supports HEAD without a body', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')

  const response = await handleRequest(
    new Request('https://example.workers.dev/health', {
      method: 'HEAD',
      headers: { 'x-request-id': 'req-health-head' },
    }),
    {}
  )

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-request-id'), 'req-health-head')
  assert.equal(response.headers.get('x-resplit-trace-id'), 'req-health-head')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(await response.text(), '')
})

test('worker routes prefer x-resplit-trace-id as the cross-service request id', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')

  const response = await handleRequest(
    new Request('https://example.workers.dev/health', {
      headers: {
        'x-request-id': 'legacy-health',
        'x-resplit-trace-id': 'trace-health',
      },
    }),
    {
      SENTRY_ENVIRONMENT: 'production',
      SENTRY_RELEASE: 'release-123',
    }
  )

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-request-id'), 'trace-health')
  assert.equal(response.headers.get('x-resplit-trace-id'), 'trace-health')
})

test('worker health route ignores an invalid trace id and preserves a valid request id', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')

  const response = await handleRequest(
    new Request('https://example.workers.dev/health', {
      headers: {
        'x-request-id': 'valid-health-request',
        'x-resplit-trace-id': 'rejected trace id',
      },
    }),
    {}
  )

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-request-id'), 'valid-health-request')
  assert.equal(response.headers.get('x-resplit-trace-id'), 'valid-health-request')
  assert.ok(![...response.headers.values()].some(value => value.includes('rejected trace id')))
})

test('worker health route never reflects invalid caller correlation ids', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')

  const rejectedTraceId = 'rejected trace id'
  const rejectedRequestId = 'rejected/request/id'
  const response = await handleRequest(
    new Request('https://example.workers.dev/health', {
      headers: {
        'x-request-id': rejectedRequestId,
        'x-resplit-trace-id': rejectedTraceId,
      },
    }),
    {}
  )

  const requestId = response.headers.get('x-request-id')
  assert.equal(response.status, 200)
  assert.match(requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  assert.equal(response.headers.get('x-resplit-trace-id'), requestId)
  assert.ok(![...response.headers.values()].some(value => (
    value.includes(rejectedTraceId) || value.includes(rejectedRequestId)
  )))
})

test('worker health route rejects non-probe methods', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')

  const response = await handleRequest(
    new Request('https://example.workers.dev/health', {
      method: 'POST',
      headers: { 'x-request-id': 'req-health-post' },
    }),
    {}
  )

  assert.equal(response.status, 405)
  assert.equal(response.headers.get('x-request-id'), 'req-health-post')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('allow'), 'GET, HEAD')
  assert.deepEqual(await response.json(), {
    error: 'METHOD_NOT_ALLOWED',
    message: 'Expected GET or HEAD',
    requestId: 'req-health-post',
    traceId: 'req-health-post',
  })
})

test('worker quote route returns request id on invalid query', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')

  const response = await handleRequest(
    new Request('https://example.workers.dev/quote?from=AED&to=USD', {
      headers: { 'x-request-id': 'req-invalid' },
    }),
    {}
  )

  assert.equal(response.status, 400)
  assert.equal(response.headers.get('x-request-id'), 'req-invalid')
  assert.equal(response.headers.get('access-control-expose-headers'), 'x-request-id, x-resplit-trace-id, cf-ray')
  assert.deepEqual(await response.json(), {
    error: 'INVALID_QUERY',
    message: 'Expected from, to, and date query params',
    requestId: 'req-invalid',
    traceId: 'req-invalid',
  })
})

test('worker health route returns no-store service metadata', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')

  const response = await handleRequest(
    new Request('https://example.workers.dev/health', {
      headers: { 'x-request-id': 'req-health' },
    }),
    {
      SENTRY_ENVIRONMENT: 'production',
      SENTRY_RELEASE: 'release-123',
    }
  )

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-request-id'), 'req-health')
  assert.equal(response.headers.get('cache-control'), 'no-store')

  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.service, 'resplit-currency-api')
  assert.equal(body.environment, 'production')
  assert.equal(body.release, 'release-123')
  assert.equal(typeof body.timestamp, 'string')
  assert.ok(!Number.isNaN(Date.parse(body.timestamp)))
})

test('worker quote route rejects impossible calendar dates', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')

  const response = await handleRequest(
    new Request('https://example.workers.dev/quote?from=AED&to=USD&date=2026-02-31', {
      headers: { 'x-request-id': 'req-invalid-date' },
    }),
    {}
  )

  assert.equal(response.status, 400)
  assert.equal(response.headers.get('x-request-id'), 'req-invalid-date')
  assert.deepEqual(await response.json(), {
    error: 'INVALID_QUERY',
    message: 'Invalid date: 2026-02-31',
    requestId: 'req-invalid-date',
    traceId: 'req-invalid-date',
  })
})

test('worker quote route rejects a manifest-unsupported currency as an invalid query', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')

  await withStubbedFetch(async input => {
    const url = String(input)
    if (url.endsWith('/archive-manifest.min.json')) {
      return makeJsonResponse({
        earliestDate: '2026-02-20',
        latestDate: '2026-03-16',
        availableDates: ['2026-02-20', '2026-02-23', '2026-03-16'],
        gapCount: 2,
        supportedCurrencies: ['aed', 'eur', 'usd'],
      })
    }
    throw new Error(`Unexpected URL: ${url}`)
  }, async () => {
    const response = await handleRequest(
      new Request('https://example.workers.dev/quote?from=AED&to=ZZZ&date=2026-02-23', {
        headers: { 'x-request-id': 'req-quote-unsupported' },
      }),
      { ASSET_BASE_URL: 'https://example-assets.dev' }
    )

    assert.equal(response.status, 400)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), {
      error: 'INVALID_QUERY',
      message: 'Invalid currency code: ZZZ',
      requestId: 'req-quote-unsupported',
      traceId: 'req-quote-unsupported',
    })
  })
})

test('worker quote route returns cache headers and stable request id', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')
  await withStubbedFetch(async input => {
    const url = String(input)
    if (url.endsWith('/latest/aed.json')) {
      return makeJsonResponse({
        date: '2026-02-23',
        from: 'aed',
        rates: { usd: 0.272295 },
      })
    }
    if (url.endsWith('/archive-manifest.min.json')) {
      return new Response('missing', { status: 500 })
    }
    throw new Error(`Unexpected URL: ${url}`)
  }, async () => {
    const response = await handleRequest(
      new Request('https://example.workers.dev/quote?from=AED&to=USD&date=2026-02-23', {
        headers: { 'x-request-id': 'req-quote' },
      }),
      {
        ASSET_BASE_URL: 'https://example-assets.dev',
      }
    )

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-request-id'), 'req-quote')
    assert.equal(
      response.headers.get('cache-control'),
      'public, s-maxage=3600, stale-while-revalidate=86400'
    )
    assert.deepEqual(await response.json(), {
      from: 'AED',
      to: 'USD',
      requestedDate: '2026-02-23',
      resolvedDate: '2026-02-23',
      rate: 0.272295,
      resolutionKind: 'exact',
      warning: null,
    })
  })
})

test('worker quote route emits correlated telemetry when a year outage recovers through latest', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')

  await withCapturedConsole('warn', async lines => {
    await withStubbedFetch(async input => {
      const url = String(input)
      if (url.endsWith('/archive-manifest.min.json')) {
        return makeJsonResponse({
          earliestDate: '2026-02-20',
          latestDate: '2026-03-16',
          availableDates: ['2026-02-20', '2026-02-23', '2026-03-16'],
          gapCount: 2,
          supportedCurrencies: ['aed', 'eur', 'usd'],
        })
      }
      if (url.endsWith('/archive-years/2026.min.json')) {
        return new Response('archive down', { status: 503 })
      }
      if (url.endsWith('/latest/aed.json')) {
        return makeJsonResponse({
          date: '2026-03-16',
          from: 'aed',
          rates: { usd: 0.272295 },
        })
      }
      throw new Error(`Unexpected URL: ${url}`)
    }, async () => {
      const response = await handleRequest(
        new Request('https://example.workers.dev/quote?from=AED&to=USD&date=2026-02-23', {
          headers: { 'x-resplit-trace-id': 'req-quote-year-fallback' },
        }),
        { ASSET_BASE_URL: 'https://example-assets.dev' }
      )

      assert.equal(response.status, 200)
      assert.equal(response.headers.get('x-request-id'), 'req-quote-year-fallback')
      assert.equal((await response.json()).resolutionKind, 'today_fallback')
    })

    const event = lines
      .filter(line => line.startsWith('[FX_MONITORING] '))
      .map(line => JSON.parse(line.slice('[FX_MONITORING] '.length)))
      .find(payload => payload.signal === 'today_fallback_used')
    assert.deepEqual(event, {
      timestamp: event?.timestamp,
      surface: 'resplit-currency-api',
      runtime: 'worker',
      environment: 'production',
      release: null,
      domain: 'fx',
      signal: 'today_fallback_used',
      source: 'fx-quote-route',
      route: 'quote',
      requestId: 'req-quote-year-fallback',
      from: 'AED',
      to: 'USD',
      requestedDate: '2026-02-23',
      resolvedDate: '2026-03-16',
      resolutionKind: 'today_fallback',
    })
  })
})

test('worker history route returns cache headers and history coverage payload', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')
  const availableDates = ['2025-12-31', '2026-01-01', '2026-01-02']

  await withStubbedFetch(createArchiveFetchStub(availableDates), async () => {
    const response = await handleRequest(
      new Request('https://example.workers.dev/history?from=AED&to=USD&start=2025-12-31&end=2026-01-02', {
        headers: { 'x-request-id': 'req-history' },
      }),
      {
        ASSET_BASE_URL: 'https://example-assets.dev',
      }
    )

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-request-id'), 'req-history')
    assert.equal(
      response.headers.get('cache-control'),
      'public, s-maxage=3600, stale-while-revalidate=86400'
    )

    const body = await response.json()
    assert.deepEqual(body.points.map(point => point.date), availableDates)
    assert.equal(body.coverage.availableDays, 3)
    assert.equal(body.coverage.missingDayCount, 0)
    assert.deepEqual(body.coverage.returnedRange, {
      start: '2025-12-31',
      end: '2026-01-02',
    })
  })
})

test('worker history route rejects impossible calendar dates', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')

  const response = await handleRequest(
    new Request('https://example.workers.dev/history?from=AED&to=USD&start=2026-02-31&end=2026-03-02', {
      headers: { 'x-request-id': 'req-history-invalid' },
    }),
    {}
  )

  assert.equal(response.status, 400)
  assert.equal(response.headers.get('x-request-id'), 'req-history-invalid')
  assert.deepEqual(await response.json(), {
    error: 'INVALID_QUERY',
    message: 'Invalid date: 2026-02-31',
    requestId: 'req-history-invalid',
    traceId: 'req-history-invalid',
  })
})

test('worker history route rejects a manifest-unsupported currency as an invalid query', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')

  await withStubbedFetch(async input => {
    const url = String(input)
    if (url.endsWith('/archive-manifest.min.json')) {
      return makeJsonResponse({
        earliestDate: '2026-02-20',
        latestDate: '2026-03-16',
        availableDates: ['2026-02-20', '2026-02-23', '2026-03-16'],
        gapCount: 2,
        supportedCurrencies: ['aed', 'eur', 'usd'],
      })
    }
    throw new Error(`Unexpected URL: ${url}`)
  }, async () => {
    const response = await handleRequest(
      new Request('https://example.workers.dev/history?from=AED&to=ZZZ&start=2026-02-20&end=2026-02-23', {
        headers: { 'x-request-id': 'req-history-unsupported' },
      }),
      { ASSET_BASE_URL: 'https://example-assets.dev' }
    )

    assert.equal(response.status, 400)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), {
      error: 'INVALID_QUERY',
      message: 'Invalid currency code: ZZZ',
      requestId: 'req-history-unsupported',
      traceId: 'req-history-unsupported',
    })
  })
})

test('rejecting telemetry cannot replace typed correlated FX route failures', async t => {
  const cases = [
    {
      name: 'quote',
      url: 'https://example.workers.dev/quote?from=AED&to=USD&date=2026-03-24',
      error: 'FX_QUOTE_FAILED',
    },
    {
      name: 'history',
      url: 'https://example.workers.dev/history?from=AED&to=USD&start=2026-03-23&end=2026-03-24',
      error: 'FX_HISTORY_FAILED',
    },
    {
      name: 'coverage',
      url: 'https://example.workers.dev/coverage?from=AED&to=USD&anchorDate=2026-03-24&days=30',
      error: 'FX_DIAGNOSTICS_FAILED',
    },
  ]

  for (const routeCase of cases) {
    await t.test(routeCase.name, async () => {
      const requestId = `req-${routeCase.name}-telemetry-reject`
      await withRejectingTelemetry(async () => {
        await withStubbedFetch(async () => {
          throw new Error('archive transport failed')
        }, async () => {
          const { handleRequest } = await import('../worker/src/index.mjs')
          const response = await handleRequest(
            new Request(routeCase.url, {
              headers: { 'x-resplit-trace-id': requestId },
            }),
            { SENTRY_DSN: 'https://worker@example.ingest.sentry.io/1' }
          )

          assert.equal(response.status, 502)
          assert.equal(response.headers.get('x-request-id'), requestId)
          assert.equal(response.headers.get('x-resplit-trace-id'), requestId)
          assert.deepEqual(await response.json(), {
            error: routeCase.error,
            message: 'archive transport failed',
            requestId,
            traceId: requestId,
          })
        })
      })
    })
  }
})

test('throwing console sinks cannot replace coverage success or failure responses', async t => {
  await t.test('successful coverage stays 200 when console.log throws', async () => {
    const availableDates = enumerateDates('2026-02-23', '2026-03-24')
    await withThrowingConsole('log', async () => {
      await withStubbedFetch(createArchiveFetchStub(availableDates), async () => {
        const { handleRequest } = await import('../worker/src/index.mjs')
        const response = await handleRequest(
          new Request(
            'https://example.workers.dev/coverage?from=AED&to=USD&anchorDate=2026-03-24&days=30',
            { headers: { 'x-resplit-trace-id': 'req-coverage-console-success' } }
          ),
          { ASSET_BASE_URL: 'https://example-assets.dev' }
        )

        assert.equal(response.status, 200)
        assert.equal(response.headers.get('x-request-id'), 'req-coverage-console-success')
        assert.equal((await response.json()).mismatchCount, 0)
      })
    })
  })

  await t.test('failed coverage keeps its typed 502 when console.error throws', async () => {
    await withThrowingConsole('error', async () => {
      await withStubbedFetch(async () => {
        throw new Error('archive transport failed')
      }, async () => {
        const { handleRequest } = await import('../worker/src/index.mjs')
        const response = await handleRequest(
          new Request(
            'https://example.workers.dev/coverage?from=AED&to=USD&anchorDate=2026-03-24&days=30',
            { headers: { 'x-resplit-trace-id': 'req-coverage-console-failure' } }
          ),
          {}
        )

        assert.equal(response.status, 502)
        assert.equal(response.headers.get('x-request-id'), 'req-coverage-console-failure')
        assert.equal((await response.json()).error, 'FX_DIAGNOSTICS_FAILED')
      })
    })
  })
})

test('worker coverage route returns request id and no-store diagnostics payload', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')
  const availableDates = enumerateDates('2026-02-23', '2026-03-24')

  await withStubbedFetch(createArchiveFetchStub(availableDates), async () => {
    const response = await handleRequest(
      new Request('https://example.workers.dev/coverage?from=AED&to=USD&anchorDate=2026-03-24&days=30', {
        headers: { 'x-request-id': 'req-coverage' },
      }),
      {
        ASSET_BASE_URL: 'https://example-assets.dev',
      }
    )

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-request-id'), 'req-coverage')
    assert.equal(response.headers.get('x-resplit-trace-id'), 'req-coverage')
    assert.equal(response.headers.get('cache-control'), 'no-store')

    const body = await response.json()
    assert.equal(body.from, 'AED')
    assert.equal(body.to, 'USD')
    assert.equal(body.anchorDate, '2026-03-24')
    assert.equal(body.requestedDays, 30)
    assert.equal(body.mismatchCount, 0)
    assert.deepEqual(body.signals, [])
    assert.deepEqual(body.freshness, {
      quoteResolvedLagDays: 0,
      archiveLatestLagDays: 0,
      staleAgainstAnchor: false,
    })
    assert.equal(body.quote.resolutionKind, 'exact')
    assert.equal(body.historyCoverage.availableDays, 30)
    assert.equal(body.historyCoverage.missingDayCount, 0)
  })
})

test('worker coverage route surfaces explicit anchor staleness when the archive lags behind the request date', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')
  const availableDates = ['2026-03-23']

  await withStubbedFetch(createArchiveFetchStub(availableDates), async () => {
    const response = await handleRequest(
      new Request('https://example.workers.dev/coverage?from=AED&to=USD&anchorDate=2026-03-24&days=2', {
        headers: { 'x-request-id': 'req-coverage-stale' },
      }),
      {
        ASSET_BASE_URL: 'https://example-assets.dev',
      }
    )

    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.mismatchCount, 3)
    assert.equal(body.quote.resolutionKind, 'prior_day_fallback')
    assert.equal(body.quote.resolvedDate, '2026-03-23')
    assert.deepEqual(body.freshness, {
      quoteResolvedLagDays: 1,
      archiveLatestLagDays: 1,
      staleAgainstAnchor: true,
    })
    assert.deepEqual(body.signals, [
      'prior_day_fallback_used',
      'history_range_incomplete',
      'quote_anchor_stale',
      'archive_anchor_stale',
    ])
  })
})

test('worker coverage route rejects impossible calendar anchor dates', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')

  const response = await handleRequest(
    new Request('https://example.workers.dev/coverage?from=AED&to=USD&anchorDate=2026-02-31&days=30', {
      headers: { 'x-request-id': 'req-coverage-invalid' },
    }),
    {}
  )

  assert.equal(response.status, 400)
  assert.equal(response.headers.get('x-request-id'), 'req-coverage-invalid')
  assert.deepEqual(await response.json(), {
    error: 'INVALID_QUERY',
    message: 'Invalid anchorDate: 2026-02-31',
    requestId: 'req-coverage-invalid',
    traceId: 'req-coverage-invalid',
  })
})

test('worker coverage route defaults an empty days param to the 30-day window', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')
  const availableDates = enumerateDates('2026-02-23', '2026-03-24')

  await withStubbedFetch(createArchiveFetchStub(availableDates), async () => {
    const response = await handleRequest(
      new Request('https://example.workers.dev/coverage?from=AED&to=USD&anchorDate=2026-03-24&days=', {
        headers: { 'x-request-id': 'req-coverage-empty-days' },
      }),
      {
        ASSET_BASE_URL: 'https://example-assets.dev',
      }
    )

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-request-id'), 'req-coverage-empty-days')

    const body = await response.json()
    // Empty `days` must fall back to the documented default (30), not floor to 1.
    assert.equal(body.requestedDays, 30)
    assert.equal(body.historyCoverage.availableDays, 30)
  })
})

test('worker unknown route surfaces trace ids in headers and body', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')

  const response = await handleRequest(
    new Request('https://example.workers.dev/nope', {
      headers: { 'x-resplit-trace-id': 'trace-root-404' },
    }),
    {}
  )

  assert.equal(response.status, 404)
  assert.equal(response.headers.get('x-request-id'), 'trace-root-404')
  assert.equal(response.headers.get('x-resplit-trace-id'), 'trace-root-404')
  assert.equal(response.headers.get('access-control-expose-headers'), 'x-request-id, x-resplit-trace-id, cf-ray')
  assert.deepEqual(await response.json(), {
    error: 'NOT_FOUND',
    message: 'Route not found',
    requestId: 'trace-root-404',
    traceId: 'trace-root-404',
  })
})

test('worker cron route rejects unauthorized requests with generated trace ids', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')

  const response = await handleRequest(
    new Request('https://example.workers.dev/cron/fx-canary'),
    { CRON_SECRET: 'top-secret' }
  )

  assert.equal(response.status, 401)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.json()
  assert.equal(body.error, 'UNAUTHORIZED')
  assert.equal(body.message, 'Missing or invalid cron authorization')
  assert.equal(body.requestId, body.traceId)
  assert.match(body.requestId, /^[0-9a-f-]{36}$/)
})

test('worker cron route rejects unauthorized requests with supplied trace id', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')

  const response = await handleRequest(
    new Request('https://example.workers.dev/cron/fx-canary', {
      headers: { 'x-resplit-trace-id': 'trace-canary-denied' },
    }),
    { CRON_SECRET: 'top-secret' }
  )

  assert.equal(response.status, 401)
  assert.equal(response.headers.get('x-request-id'), 'trace-canary-denied')
  assert.equal(response.headers.get('access-control-expose-headers'), 'x-request-id, x-resplit-trace-id, cf-ray')
  assert.deepEqual(await response.json(), {
    error: 'UNAUTHORIZED',
    message: 'Missing or invalid cron authorization',
    requestId: 'trace-canary-denied',
    traceId: 'trace-canary-denied',
  })
})

test('worker cron route returns canary report for authorized requests', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')
  const now = new Date()
  const today = now.toISOString().slice(0, 10)
  const anchorDates = [0, 7, 30, 180].map(days => {
    const date = new Date(`${today}T00:00:00Z`)
    date.setUTCDate(date.getUTCDate() - days)
    return date.toISOString().slice(0, 10)
  })
  const earliestStart = new Date(`${anchorDates.at(-1)}T00:00:00Z`)
  earliestStart.setUTCDate(earliestStart.getUTCDate() - 29)
  const availableDates = enumerateDates(
    earliestStart.toISOString().slice(0, 10),
    anchorDates[0]
  )

  await withStubbedFetch(createArchiveFetchStub(availableDates), async () => {
    const response = await handleRequest(
      new Request('https://example.workers.dev/cron/fx-canary', {
        headers: {
          authorization: 'Bearer top-secret',
          'x-request-id': 'req-canary',
        },
      }),
      {
        ASSET_BASE_URL: 'https://example-assets.dev',
        CRON_SECRET: 'top-secret',
      }
    )

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-request-id'), 'req-canary')
    assert.equal(response.headers.get('cache-control'), 'no-store')

    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.mismatchCount, 0)
    assert.equal(body.failureCount, 0)
    assert.equal(body.results.length, 12)
    assert.deepEqual(
      [...new Set(body.results.map(result => result.anchorDate))],
      anchorDates
    )
  })
})

test('rejecting telemetry cannot turn a truthful successful canary into a failure', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')
  const now = new Date()
  const today = now.toISOString().slice(0, 10)
  const anchorDates = [0, 7, 30, 180].map(days => {
    const date = new Date(`${today}T00:00:00Z`)
    date.setUTCDate(date.getUTCDate() - days)
    return date.toISOString().slice(0, 10)
  })
  const earliestStart = new Date(`${anchorDates.at(-1)}T00:00:00Z`)
  earliestStart.setUTCDate(earliestStart.getUTCDate() - 29)
  const availableDates = enumerateDates(
    earliestStart.toISOString().slice(0, 10),
    anchorDates[0]
  )

  await withRejectingTelemetry(async () => {
    await withStubbedFetch(createArchiveFetchStub(availableDates), async () => {
      const response = await handleRequest(
        new Request('https://example.workers.dev/cron/fx-canary', {
          headers: {
            authorization: 'Bearer top-secret',
            'x-resplit-trace-id': 'trace-canary-telemetry-reject',
          },
        }),
        {
          ASSET_BASE_URL: 'https://example-assets.dev',
          CRON_SECRET: 'top-secret',
          SENTRY_DSN: 'https://worker@example.ingest.sentry.io/1',
        }
      )

      assert.equal(response.status, 200)
      assert.equal(response.headers.get('x-request-id'), 'trace-canary-telemetry-reject')
      const body = await response.json()
      assert.equal(body.ok, true)
      assert.equal(body.mismatchCount, 0)
      assert.equal(body.failureCount, 0)
    })
  })
})

test('throwing console.log cannot turn a truthful successful canary into a failure', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')
  const now = new Date()
  const today = now.toISOString().slice(0, 10)
  const anchorDates = [0, 7, 30, 180].map(days => {
    const date = new Date(`${today}T00:00:00Z`)
    date.setUTCDate(date.getUTCDate() - days)
    return date.toISOString().slice(0, 10)
  })
  const earliestStart = new Date(`${anchorDates.at(-1)}T00:00:00Z`)
  earliestStart.setUTCDate(earliestStart.getUTCDate() - 29)
  const availableDates = enumerateDates(
    earliestStart.toISOString().slice(0, 10),
    anchorDates[0]
  )

  await withThrowingConsole('log', async () => {
    await withStubbedFetch(createArchiveFetchStub(availableDates), async () => {
      const response = await handleRequest(
        new Request('https://example.workers.dev/cron/fx-canary', {
          headers: {
            authorization: 'Bearer top-secret',
            'x-resplit-trace-id': 'trace-canary-console-reject',
          },
        }),
        {
          ASSET_BASE_URL: 'https://example-assets.dev',
          CRON_SECRET: 'top-secret',
        }
      )

      assert.equal(response.status, 200)
      assert.equal(response.headers.get('x-request-id'), 'trace-canary-console-reject')
      const body = await response.json()
      assert.equal(body.ok, true)
      assert.equal(body.mismatchCount, 0)
      assert.equal(body.failureCount, 0)
    })
  })
})

test('worker cron route keeps the truthful canary report when the diagnostics console throws', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')
  const originalConsoleError = console.error
  const errorLines = []

  console.error = (...args) => {
    const line = args.map(arg => String(arg)).join(' ')
    errorLines.push(line)
    if (line.startsWith('[FX_CANARY] status=500 ok=false')) {
      throw new Error('console exploded')
    }
  }

  try {
    await withStubbedFetch(async () => {
      throw new Error('archive fetch exploded')
    }, async () => {
      const response = await handleRequest(
        new Request('https://example.workers.dev/cron/fx-canary', {
          headers: {
            authorization: 'Bearer top-secret',
            'x-request-id': 'req-canary-fail',
          },
        }),
        {
          ASSET_BASE_URL: 'https://example-assets.dev',
          CRON_SECRET: 'top-secret',
        }
      )

      assert.equal(response.status, 500)
      assert.equal(response.headers.get('x-request-id'), 'req-canary-fail')
      assert.equal(response.headers.get('cache-control'), 'no-store')
      const body = await response.json()
      assert.equal(body.ok, false)
      assert.equal(body.mismatchCount, 0)
      assert.equal(body.failureCount, 12)
      assert.equal(body.results.length, 12)
    })
  } finally {
    console.error = originalConsoleError
  }

  const monitoringLine = errorLines.find(line => {
    if (!line.startsWith('[FX_MONITORING] ')) {
      return false
    }
    const payload = JSON.parse(line.replace('[FX_MONITORING] ', ''))
    return payload.signal === 'canary_error' && payload.failureCount === 12
  })
  assert.ok(monitoringLine, 'expected truthful FX canary monitoring log')

  const payload = JSON.parse(monitoringLine.replace('[FX_MONITORING] ', ''))
  assert.equal(payload.signal, 'canary_error')
  assert.equal(payload.route, 'cron_fx_canary')
  assert.equal(payload.requestId, 'req-canary-fail')
  assert.equal(payload.failureCount, 12)
  assert.ok(
    errorLines.some(line => line.startsWith('[FX_CANARY] status=500 ok=false')),
    'expected the failing diagnostics sink to receive the canary summary'
  )
})
