const test = require('node:test')
const assert = require('node:assert/strict')

const {
  defaultWorkerBase,
  isRecoveryCoverageGap,
  resolveExpectedDate,
  resolveWorkerBase,
  smokeCheckWorker,
} = require('../scripts/smoke-check-deploy.js')

function makeWorkerHealthPayload() {
  return {
    ok: true,
    service: 'resplit-currency-api',
    environment: 'production',
    release: 'release-123',
    timestamp: '2026-03-25T14:00:00.000Z',
  }
}

test('resolveWorkerBase defaults to the canonical production worker host', () => {
  assert.equal(resolveWorkerBase({}), defaultWorkerBase)
})

test('resolveWorkerBase honors explicit worker override and trims trailing slash', () => {
  assert.equal(
    resolveWorkerBase({ FX_WORKER_BASE_URL: 'https://example.workers.dev///' }),
    'https://example.workers.dev'
  )
})

test('resolveWorkerBase supports an explicit skip switch', () => {
  assert.equal(resolveWorkerBase({ SKIP_WORKER_SMOKE_CHECK: '1' }), null)
})

test('resolveExpectedDate prefers an explicit requested date', () => {
  assert.equal(
    resolveExpectedDate({
      requestedDate: '2026-03-23',
      latestDate: '2026-03-22',
      metaLatestDate: '2026-03-22',
    }),
    '2026-03-23'
  )
})

test('resolveExpectedDate defaults to the current UTC date when no explicit date is set', () => {
  assert.equal(
    resolveExpectedDate({
      latestDate: '2026-03-22',
      metaLatestDate: '2026-03-22',
      now: new Date('2026-03-25T14:00:00Z'),
    }),
    '2026-03-25'
  )
})

test('resolveExpectedDate supports explicit stale deploy smoke fallback', () => {
  assert.equal(
    resolveExpectedDate({
      latestDate: '2026-03-21',
      metaLatestDate: '2026-03-22',
      allowLatestFallback: true,
      now: new Date('2026-03-25T14:00:00Z'),
    }),
    '2026-03-22'
  )
})

test('smokeCheckWorker rejects degraded coverage payloads', async () => {
  await assert.rejects(
    smokeCheckWorker('https://fx.resplit.app', '2026-03-25', {
      fetchJson: async (url) => {
        if (String(url).endsWith('/health')) {
          return makeWorkerHealthPayload()
        }
        if (String(url).includes('/quote?')) {
          return {
            from: 'AED',
            to: 'USD',
            requestedDate: '2026-03-25',
            resolvedDate: '2026-03-25',
            resolutionKind: 'exact',
            rate: 0.27,
          }
        }
        if (String(url).includes('/history?')) {
          return {
            points: [
              { date: '2026-03-23', rate: 0.27 },
              { date: '2026-03-24', rate: 0.27 },
              { date: '2026-03-25', rate: 0.27 },
            ],
          }
        }
        return {
          quote: {
            resolvedDate: '2026-03-25',
            resolutionKind: 'exact',
          },
          historyCoverage: {
            requestedDays: 30,
            availableDays: 26,
            missingDayCount: 4,
          },
          mismatchCount: 4,
          signals: ['history_gap'],
        }
      },
    }),
    /worker coverage signals present/
  )
})

test('smokeCheckWorker accepts exact coverage payloads', async () => {
  await assert.doesNotReject(
    smokeCheckWorker('https://fx.resplit.app', '2026-03-25', {
      fetchJson: async (url) => {
        if (String(url).endsWith('/health')) {
          return makeWorkerHealthPayload()
        }
        if (String(url).includes('/quote?')) {
          return {
            from: 'AED',
            to: 'USD',
            requestedDate: '2026-03-25',
            resolvedDate: '2026-03-25',
            resolutionKind: 'exact',
            rate: 0.27,
          }
        }
        if (String(url).includes('/history?')) {
          return {
            points: [
              { date: '2026-03-23', rate: 0.27 },
              { date: '2026-03-24', rate: 0.27 },
              { date: '2026-03-25', rate: 0.27 },
            ],
          }
        }
        return {
          quote: {
            resolvedDate: '2026-03-25',
            resolutionKind: 'exact',
          },
          historyCoverage: {
            requestedDays: 30,
            availableDays: 30,
            missingDayCount: 0,
          },
          mismatchCount: 0,
          signals: [],
        }
      },
    })
  )
})

test('smokeCheckWorker warns through archive-only recovery gaps', async () => {
  const warnings = []
  const originalWarn = console.warn

  console.warn = (message) => warnings.push(message)

  try {
    await assert.doesNotReject(
      smokeCheckWorker('https://fx.resplit.app', '2026-05-24', {
        fetchJson: async (url) => {
          if (String(url).endsWith('/health')) {
            return makeWorkerHealthPayload()
          }
          if (String(url).includes('/quote?')) {
            return {
              from: 'AED',
              to: 'USD',
              requestedDate: '2026-05-24',
              resolvedDate: '2026-05-24',
              resolutionKind: 'exact',
              rate: 0.27,
            }
          }
          if (String(url).includes('/history?')) {
            return {
              points: [
                { date: '2026-05-24', rate: 0.27 },
              ],
            }
          }
          return {
            quote: {
              resolvedDate: '2026-05-24',
              resolutionKind: 'exact',
            },
            historyCoverage: {
              requestedDays: 30,
              availableDays: 18,
              missingDayCount: 12,
              archiveLatestDate: '2026-05-24',
            },
            freshness: {
              quoteResolvedLagDays: 0,
              archiveLatestLagDays: 0,
              staleAgainstAnchor: false,
            },
            mismatchCount: 24,
            signals: ['history_range_incomplete', 'archive_gap_detected'],
          }
        },
      })
    )
  } finally {
    console.warn = originalWarn
  }

  assert.ok(warnings.some((line) => line.includes('recovery archive gaps')))
})

test('isRecoveryCoverageGap rejects stale or fallback coverage', () => {
  assert.equal(
    isRecoveryCoverageGap({
      quote: { resolutionKind: 'prior_day_fallback' },
      historyCoverage: {
        archiveLatestDate: '2026-05-24',
      },
      freshness: {
        quoteResolvedLagDays: 1,
        archiveLatestLagDays: 0,
        staleAgainstAnchor: true,
      },
      signals: ['prior_day_fallback_used', 'history_range_incomplete'],
    }, '2026-05-24'),
    false
  )
})

test('smokeCheckWorker rejects missing worker health payloads', async () => {
  await assert.rejects(
    smokeCheckWorker('https://fx.resplit.app', '2026-03-25', {
      fetchJson: async (url) => {
        if (String(url).endsWith('/health')) {
          return {
            ok: false,
            service: 'unknown',
            timestamp: '2026-03-25T14:00:00.000Z',
          }
        }
        throw new Error(`Unexpected URL: ${url}`)
      },
    }),
    /worker health shape mismatch/
  )
})

test('smokeCheckWorker rejects health payloads without release metadata', async () => {
  await assert.rejects(
    smokeCheckWorker('https://fx.resplit.app', '2026-03-25', {
      fetchJson: async (url) => {
        if (String(url).endsWith('/health')) {
          return {
            ok: true,
            service: 'resplit-currency-api',
            environment: 'production',
            release: 'unknown',
            timestamp: '2026-03-25T14:00:00.000Z',
          }
        }
        throw new Error(`Unexpected URL: ${url}`)
      },
    }),
    /worker health release missing/
  )
})

test('smokeCheckWorker anchors history start to the requested publish date', async () => {
  const seenUrls = []

  await assert.doesNotReject(
    smokeCheckWorker('https://fx.resplit.app', '2026-03-01', {
      fetchJson: async (url) => {
        seenUrls.push(String(url))
        if (String(url).endsWith('/health')) {
          return makeWorkerHealthPayload()
        }
        if (String(url).includes('/quote?')) {
          return {
            from: 'AED',
            to: 'USD',
            requestedDate: '2026-03-01',
            resolvedDate: '2026-03-01',
            resolutionKind: 'exact',
            rate: 0.27,
          }
        }
        if (String(url).includes('/history?')) {
          return {
            points: [
              { date: '2026-02-27', rate: 0.27 },
              { date: '2026-02-28', rate: 0.27 },
              { date: '2026-03-01', rate: 0.27 },
            ],
          }
        }
        return {
          quote: {
            resolvedDate: '2026-03-01',
            resolutionKind: 'exact',
          },
          historyCoverage: {
            requestedDays: 30,
            availableDays: 30,
            missingDayCount: 0,
          },
          mismatchCount: 0,
          signals: [],
        }
      },
    })
  )

  assert.ok(
    seenUrls.includes('https://fx.resplit.app/health')
  )
  assert.ok(
    seenUrls.includes('https://fx.resplit.app/history?from=AED&to=USD&start=2026-02-27&end=2026-03-01')
  )
})
