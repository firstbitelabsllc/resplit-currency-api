const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

test('history rejects a 367-day range before archive fetch or date enumeration', async () => {
  const { buildFxHistoryResponse } = await import('../worker/src/fx-contract.mjs')
  let fetchCount = 0

  await assert.rejects(
    buildFxHistoryResponse({
      from: 'AED',
      to: 'USD',
      start: '2025-01-01',
      end: '2026-01-02',
      fetchImpl: async () => {
        fetchCount += 1
        return Response.json({})
      },
    }),
    /Invalid date range: maximum 366 days/
  )

  assert.equal(fetchCount, 0)

  // Mutation oracle: moving the O(1) guard below either same-currency date
  // enumeration or the manifest fetch re-opens the CPU/fan-out abuse path.
  const source = readFileSync(join(__dirname, '../worker/src/fx-contract.mjs'), 'utf8')
  const historyFunction = source.slice(
    source.indexOf('export async function buildFxHistoryResponse'),
    source.indexOf('async function fetchHistoricalQuoteResponse')
  )
  const guardIndex = historyFunction.indexOf(
    'assertHistoryRangeWithinLimit(normalizedStart, normalizedEnd)'
  )
  const enumerationIndex = historyFunction.indexOf('enumerateDates(normalizedStart, normalizedEnd)')
  const fetchIndex = historyFunction.indexOf('fetchJson(`${baseUrl}/archive-manifest.min.json`')

  assert.ok(guardIndex >= 0, 'range guard must remain in buildFxHistoryResponse')
  assert.ok(guardIndex < enumerationIndex, 'range guard must run before date enumeration')
  assert.ok(guardIndex < fetchIndex, 'range guard must run before manifest fetch')
})

for (const { label, start, end, expectedDays } of [
  { label: '366-day maximum', start: '2025-01-01', end: '2026-01-01', expectedDays: 366 },
  { label: 'installed iOS 30-day window', start: '2026-01-01', end: '2026-01-30', expectedDays: 30 },
  { label: 'installed iOS 7-day window', start: '2026-01-01', end: '2026-01-07', expectedDays: 7 },
]) {
  test(`history keeps the ${label} valid`, async () => {
    const { buildFxHistoryResponse } = await import('../worker/src/fx-contract.mjs')
    const history = await buildFxHistoryResponse({
      from: 'USD',
      to: 'USD',
      start,
      end,
      fetchImpl: async () => {
        throw new Error('same-currency history must not fetch')
      },
    })

    assert.equal(history.coverage.requestedDays, expectedDays)
    assert.equal(history.points.length, expectedDays)
  })
}

test('worker /history returns the deterministic invalid-query contract for 367 days', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')
  const response = await handleRequest(
    new Request(
      'https://fx.resplit.app/history?from=USD&to=USD&start=2025-01-01&end=2026-01-02',
      { headers: { 'x-resplit-trace-id': 'fx-history-range-cap' } }
    ),
    {}
  )

  assert.equal(response.status, 400)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('x-request-id'), 'fx-history-range-cap')
  assert.deepEqual(await response.json(), {
    error: 'INVALID_QUERY',
    message: 'Invalid date range: maximum 366 days',
    requestId: 'fx-history-range-cap',
    traceId: 'fx-history-range-cap',
  })
})
