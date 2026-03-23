const test = require('node:test')
const assert = require('node:assert/strict')

const {
  defaultWorkerBase,
  resolveExpectedDate,
  resolveWorkerBase,
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
