const test = require('node:test')
const assert = require('node:assert/strict')

const {
  defaultWorkerBase,
  resolveExpectedDate,
  resolveWorkerBase,
  smokeCheckWorker,
} = require('../scripts/smoke-check-deploy.js')

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

test('resolveExpectedDate falls back to the latest published date when no explicit date is set', () => {
  assert.equal(
    resolveExpectedDate({
      latestDate: '2026-03-22',
      metaLatestDate: '2026-03-22',
    }),
    '2026-03-22'
  )
})

test('smokeCheckWorker rejects degraded coverage payloads', async () => {
  await assert.rejects(
    smokeCheckWorker('https://fx.resplit.app', '2026-03-25', {
      fetchJson: async (url) => {
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
