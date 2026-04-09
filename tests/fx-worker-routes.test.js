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
  assert.deepEqual(await response.json(), {
    error: 'INVALID_QUERY',
    message: 'Expected from, to, and date query params',
  })
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
  })
})

test('worker cron route rejects unauthorized requests', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')

  const response = await handleRequest(
    new Request('https://example.workers.dev/cron/fx-canary'),
    { CRON_SECRET: 'top-secret' }
  )

  assert.equal(response.status, 401)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), {
    error: 'UNAUTHORIZED',
    message: 'Missing or invalid cron authorization',
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

test('worker cron route reports canary_error on unexpected failures', async () => {
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
      assert.deepEqual(await response.json(), {
        error: 'FX_CANARY_FAILED',
        message: 'FX canary failed',
      })
    })
  } finally {
    console.error = originalConsoleError
  }

  const monitoringLine = errorLines.find(line => {
    if (!line.startsWith('[FX_MONITORING] ')) {
      return false
    }
    const payload = JSON.parse(line.replace('[FX_MONITORING] ', ''))
    return payload.signal === 'canary_error' && payload.error === 'console exploded'
  })
  assert.ok(monitoringLine, 'expected FX monitoring error log')

  const payload = JSON.parse(monitoringLine.replace('[FX_MONITORING] ', ''))
  assert.equal(payload.signal, 'canary_error')
  assert.equal(payload.route, 'cron_fx_canary')
  assert.equal(payload.requestId, 'req-canary-fail')
  assert.equal(payload.error, 'console exploded')
  assert.equal(payload.requestedDays, 30)
})
