const test = require('node:test')
const assert = require('node:assert/strict')

// Cross-rate envelope gate for worker/src/fx-contract.mjs computeCrossRate (the FX
// money math). The function is not exported, so it is exercised through the public
// buildFxQuoteResponse / buildFxHistoryResponse. Before this file the suite asserted
// exactly ONE numeric rate (AED->USD triangulation, happy path) and only checked
// that history *dates* lined up — never the EUR-direct branch, never the X->EUR
// reciprocal branch, never the history *rate value*, and never the "bad/zero rate in
// the archive falls through to latest" behavior. A wrong cross-rate is silent
// money corruption in every split that uses a non-AED/USD pair.
//
// Archive rates are EUR-based (the real wire shape): eur=1, usd=1.2, aed=4, myr=5.

const DATE = '2026-02-23'
const EUR_BASED_RATES = { eur: 1, usd: 1.2, aed: 4, myr: 5 }

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// Stub that serves a single-day EUR-based archive snapshot.
function archiveStub(dates, rates) {
  return async (input) => {
    const url = String(input)
    if (url.endsWith('/archive-manifest.min.json')) {
      return jsonResponse({
        earliestDate: dates[0],
        latestDate: dates.at(-1),
        availableDates: dates,
        gapCount: 0,
        supportedCurrencies: Object.keys(rates).sort(),
      })
    }
    const yearMatch = url.match(/\/archive-years\/(\d{4})\.min\.json$/)
    if (yearMatch) {
      const year = yearMatch[1]
      return jsonResponse({
        year,
        base: 'eur',
        snapshots: dates
          .filter((d) => d.startsWith(year))
          .map((d) => ({ date: d, base: 'eur', rates })),
      })
    }
    throw new Error(`Unexpected URL: ${url}`)
  }
}

// Each row pins an exact computed rate so a wrong branch turns this red.
// EUR-direct: rates[to]. X->EUR: 1/rates[from]. X->Y: rates[to]/rates[from].
const CROSS_RATE_CASES = [
  { from: 'EUR', to: 'USD', expected: 1.2, why: 'eur-direct branch returns rates[to]' },
  { from: 'USD', to: 'EUR', expected: 1 / 1.2, why: 'to-eur branch returns the reciprocal 1/rates[from]' },
  { from: 'MYR', to: 'AED', expected: 4 / 5, why: 'triangulation returns rates[to]/rates[from]' },
  { from: 'AED', to: 'MYR', expected: 5 / 4, why: 'triangulation is direction-correct, not symmetric' },
  { from: 'USD', to: 'USD', expected: 1, why: 'identical currency short-circuits to 1' },
]

for (const { from, to, expected, why } of CROSS_RATE_CASES) {
  test(`quote ${from}->${to} computes the exact cross rate (${why})`, async () => {
    const { buildFxQuoteResponse } = await import('../worker/src/fx-contract.mjs')
    const quote = await buildFxQuoteResponse({
      from,
      to,
      date: DATE,
      fetchImpl: archiveStub([DATE], EUR_BASED_RATES),
    })
    assert.equal(quote.resolutionKind, 'exact')
    assert.equal(quote.resolvedDate, DATE)
    assert.ok(
      Math.abs(quote.rate - expected) < 1e-9,
      `${from}->${to} expected ${expected}, got ${quote.rate}`
    )
  })
}

test('history points carry the computed cross-rate value, not just the date', async () => {
  const { buildFxHistoryResponse } = await import('../worker/src/fx-contract.mjs')
  const history = await buildFxHistoryResponse({
    from: 'MYR',
    to: 'AED',
    start: DATE,
    end: DATE,
    fetchImpl: archiveStub([DATE], EUR_BASED_RATES),
  })
  assert.equal(history.points.length, 1)
  assert.equal(history.points[0].date, DATE)
  // 4/5 = 0.8 — asserted as a value because a wrong cross-rate would still produce
  // the right date and slip past every existing history test.
  assert.ok(
    Math.abs(history.points[0].rate - 0.8) < 1e-9,
    `expected 0.8, got ${history.points[0].rate}`
  )
})

test('a zero/non-finite archive rate is not quoted — it falls through to latest', async () => {
  const { buildFxQuoteResponse } = await import('../worker/src/fx-contract.mjs')

  // usd=0 in the archive makes the USD->AED cross rate undefined (divide-by-zero
  // guard returns null). The contract must NOT emit a garbage 0/Infinity quote; it
  // falls through to the latest snapshot instead.
  const stub = async (input) => {
    const url = String(input)
    if (url.endsWith('/archive-manifest.min.json')) {
      return jsonResponse({
        earliestDate: DATE,
        latestDate: DATE,
        availableDates: [DATE],
        gapCount: 0,
        supportedCurrencies: ['aed', 'eur', 'usd'],
      })
    }
    if (/\/archive-years\/\d{4}\.min\.json$/.test(url)) {
      return jsonResponse({
        year: '2026',
        base: 'eur',
        snapshots: [{ date: DATE, base: 'eur', rates: { eur: 1, usd: 0, aed: 4 } }],
      })
    }
    if (url.endsWith('/latest/usd.json')) {
      return jsonResponse({ date: '2026-03-16', from: 'usd', rates: { aed: 3.67 } })
    }
    throw new Error(`Unexpected URL: ${url}`)
  }

  const quote = await buildFxQuoteResponse({ from: 'USD', to: 'AED', date: DATE, fetchImpl: stub })
  assert.equal(quote.rate, 3.67)
  assert.equal(quote.resolvedDate, '2026-03-16')
  assert.equal(quote.resolutionKind, 'today_fallback')
  assert.ok(Number.isFinite(quote.rate) && quote.rate > 0)
})
