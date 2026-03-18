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

test('worker quote resolves historical data from yearly archive payloads', async () => {
  const { buildFxQuoteResponse } = await import('../worker/src/fx-contract.mjs')
  const requested = []

  const fetchImpl = async input => {
    const url = String(input)
    requested.push(url)
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
      return makeJsonResponse({
        year: '2026',
        base: 'eur',
        snapshots: [
          { date: '2026-02-20', rates: { aed: 4, usd: 1.1, eur: 1 } },
          { date: '2026-02-23', rates: { aed: 4, usd: 1.2, eur: 1 } },
          { date: '2026-03-16', rates: { aed: 4, usd: 1.3, eur: 1 } },
        ],
      })
    }
    throw new Error(`Unexpected URL: ${url}`)
  }

  const quote = await buildFxQuoteResponse({
    from: 'AED',
    to: 'USD',
    date: '2026-02-23',
    fetchImpl,
  })

  assert.equal(quote.resolutionKind, 'exact')
  assert.equal(quote.resolvedDate, '2026-02-23')
  assert.ok(Math.abs(quote.rate - 0.3) < 1e-9)
  assert.ok(requested.some(url => url.endsWith('/archive-years/2026.min.json')))
  assert.ok(requested.every(url => !url.includes('/archive/2026-02-23.min.json')))
})

test('worker quote falls back to latest when historical manifest is unavailable', async () => {
  const { buildFxQuoteResponse } = await import('../worker/src/fx-contract.mjs')

  const fetchImpl = async input => {
    const url = String(input)
    if (url.endsWith('/archive-manifest.min.json')) {
      return new Response('boom', { status: 500 })
    }
    if (url.endsWith('/latest/aed.json')) {
      return makeJsonResponse({
        date: '2026-03-16',
        from: 'aed',
        rates: { usd: 0.272295 },
      })
    }
    throw new Error(`Unexpected URL: ${url}`)
  }

  const quote = await buildFxQuoteResponse({
    from: 'AED',
    to: 'USD',
    date: '2026-02-23',
    fetchImpl,
  })

  assert.equal(quote.resolutionKind, 'today_fallback')
  assert.equal(quote.resolvedDate, '2026-03-16')
  assert.match(quote.warning, /today/i)
})

test('worker history loads cross-year ranges from year payloads', async () => {
  const { buildFxHistoryResponse } = await import('../worker/src/fx-contract.mjs')
  const requested = []

  const fetchImpl = async input => {
    const url = String(input)
    requested.push(url)
    if (url.endsWith('/archive-manifest.min.json')) {
      return makeJsonResponse({
        earliestDate: '2025-12-30',
        latestDate: '2026-01-02',
        availableDates: ['2025-12-31', '2026-01-01', '2026-01-02'],
        gapCount: 0,
        supportedCurrencies: ['aed', 'eur', 'usd'],
      })
    }
    if (url.endsWith('/archive-years/2025.min.json')) {
      return makeJsonResponse({
        year: '2025',
        base: 'eur',
        snapshots: [
          { date: '2025-12-31', rates: { aed: 4, usd: 1.1, eur: 1 } },
        ],
      })
    }
    if (url.endsWith('/archive-years/2026.min.json')) {
      return makeJsonResponse({
        year: '2026',
        base: 'eur',
        snapshots: [
          { date: '2026-01-01', rates: { aed: 4, usd: 1.2, eur: 1 } },
          { date: '2026-01-02', rates: { aed: 4, usd: 1.22, eur: 1 } },
        ],
      })
    }
    throw new Error(`Unexpected URL: ${url}`)
  }

  const history = await buildFxHistoryResponse({
    from: 'AED',
    to: 'USD',
    start: '2025-12-31',
    end: '2026-01-02',
    fetchImpl,
  })

  assert.deepEqual(
    history.points.map(point => point.date),
    ['2025-12-31', '2026-01-01', '2026-01-02']
  )
  assert.equal(history.coverage.availableDays, 3)
  assert.ok(requested.some(url => url.endsWith('/archive-years/2025.min.json')))
  assert.ok(requested.some(url => url.endsWith('/archive-years/2026.min.json')))
})
