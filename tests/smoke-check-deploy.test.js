const test = require('node:test')
const assert = require('node:assert/strict')

const {
  defaultWorkerBase,
  isRecoveryCoverageGap,
  isStaticRecoveryHistoryGap,
  resolveFreshnessContract,
  resolveExpectedDate,
  resolveGithubFallbackAcceptance,
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

test('resolveFreshnessContract accepts prior date during publish grace window', () => {
  const contract = resolveFreshnessContract({
    latestDate: '2026-05-24',
    metaLatestDate: '2026-05-24',
    now: new Date('2026-05-25T03:08:00Z'),
    publishGraceMinutes: 45,
  })

  assert.equal(contract.mode, 'publish_grace')
  assert.equal(contract.expectedDate, '2026-05-24')
  assert.equal(contract.strictExpectedDate, '2026-05-25')
  assert.equal(contract.graceEndsAt, '2026-05-25T03:45:00.000Z')
})

test('resolveFreshnessContract stays strict outside publish grace window', () => {
  const contract = resolveFreshnessContract({
    latestDate: '2026-05-24',
    metaLatestDate: '2026-05-24',
    now: new Date('2026-05-25T04:00:00Z'),
    publishGraceMinutes: 45,
  })

  assert.equal(contract.mode, 'strict')
  assert.equal(contract.expectedDate, '2026-05-25')
})

test('resolveFreshnessContract keeps explicit requested date strict', () => {
  const contract = resolveFreshnessContract({
    requestedDate: '2026-05-25',
    latestDate: '2026-05-24',
    metaLatestDate: '2026-05-24',
    now: new Date('2026-05-25T03:08:00Z'),
  })

  assert.equal(contract.mode, 'requested')
  assert.equal(contract.expectedDate, '2026-05-25')
})

test('resolveGithubFallbackAcceptance accepts a fresh fallback', () => {
  const result = resolveGithubFallbackAcceptance({
    ghFallbackDate: '2026-05-29',
    expectedDate: '2026-05-29',
    now: new Date('2026-05-29T03:36:00Z'),
  })

  assert.equal(result.accepted, true)
  assert.equal(result.stale, false)
  assert.equal(result.reason, 'fresh')
})

test('resolveGithubFallbackAcceptance tolerates one-day lag inside the propagation grace window', () => {
  // The ~03:36Z scheduled run: Cloudflare already serves today, github.io still
  // serves yesterday. This is the exact red-flap we are de-flaking.
  const result = resolveGithubFallbackAcceptance({
    ghFallbackDate: '2026-05-28',
    expectedDate: '2026-05-29',
    now: new Date('2026-05-29T03:36:00Z'),
  })

  assert.equal(result.accepted, true)
  assert.equal(result.stale, true)
  assert.equal(result.reason, 'propagation_grace')
  assert.equal(result.graceEndsAt, '2026-05-29T05:00:00.000Z')
})

test('resolveGithubFallbackAcceptance stays strict outside the propagation grace window', () => {
  const result = resolveGithubFallbackAcceptance({
    ghFallbackDate: '2026-05-28',
    expectedDate: '2026-05-29',
    now: new Date('2026-05-29T14:00:00Z'),
  })

  assert.equal(result.accepted, false)
  assert.equal(result.reason, 'propagation_grace_expired')
})

test('resolveGithubFallbackAcceptance rejects a >1 day stale fallback even inside the window', () => {
  const result = resolveGithubFallbackAcceptance({
    ghFallbackDate: '2026-05-27',
    expectedDate: '2026-05-29',
    now: new Date('2026-05-29T03:36:00Z'),
  })

  assert.equal(result.accepted, false)
  assert.equal(result.reason, 'not_one_day_stale')
})

test('resolveGithubFallbackAcceptance post-publish tolerates one-day lag in a wall-clock dead zone', () => {
  // The 2026-07-03T02:58Z failure: GitHub delayed the 00:00Z schedule into the
  // gap between the [0h,3h] grace windows. Post-publish context makes the
  // one-day propagation lag acceptable at ANY hour — no dead zones remain.
  const result = resolveGithubFallbackAcceptance({
    ghFallbackDate: '2026-07-02',
    expectedDate: '2026-07-03',
    now: new Date('2026-07-03T02:58:18Z'),
    postPublish: true,
  })

  assert.equal(result.accepted, true)
  assert.equal(result.stale, true)
  assert.equal(result.reason, 'post_publish_propagation')
})

test('resolveGithubFallbackAcceptance post-publish still rejects a >1 day stale fallback', () => {
  // Post-publish context only excuses propagation of THIS run; a fallback two
  // days behind means the PREVIOUS publish never landed — a real pipeline break.
  const result = resolveGithubFallbackAcceptance({
    ghFallbackDate: '2026-07-01',
    expectedDate: '2026-07-03',
    now: new Date('2026-07-03T02:58:18Z'),
    postPublish: true,
  })

  assert.equal(result.accepted, false)
  assert.equal(result.reason, 'not_one_day_stale')
})

test('isStaticRecoveryHistoryGap accepts fresh static history with known archive gaps', () => {
  const availableHistoryDates = [
    '2026-05-25',
    '2026-05-26',
    '2026-05-27',
    '2026-05-28',
    '2026-05-29',
    '2026-05-30',
    '2026-05-31',
    '2026-06-01',
    '2026-06-02',
    '2026-06-03',
    '2026-06-04',
    '2026-06-05',
    '2026-06-06',
    '2026-06-07',
    '2026-06-08',
    '2026-06-09',
    '2026-06-10',
    '2026-06-11',
    '2026-06-12',
    '2026-06-13',
    '2026-06-14',
    '2026-06-15',
    '2026-06-16',
    '2026-06-17',
    '2026-06-18',
    '2026-06-19',
    '2026-06-20',
    '2026-06-23',
  ]

  assert.equal(
    isStaticRecoveryHistoryGap({
      dateToday: '2026-06-23',
      expectedDays: 30,
      history: {
        points: availableHistoryDates.map(date => ({
          date,
          rates: { usd: 1 },
        })),
      },
      meta: {
        latestDate: '2026-06-23',
        archiveLatestDate: '2026-06-23',
        archiveGapCount: 4,
        availableHistoryDates,
      },
    }),
    true
  )
})

test('isStaticRecoveryHistoryGap rejects stale static history gaps', () => {
  assert.equal(
    isStaticRecoveryHistoryGap({
      dateToday: '2026-06-23',
      expectedDays: 30,
      history: {
        points: [
          { date: '2026-06-20', rates: { usd: 1 } },
        ],
      },
      meta: {
        latestDate: '2026-06-20',
        archiveLatestDate: '2026-06-20',
        archiveGapCount: 4,
        availableHistoryDates: ['2026-06-20'],
      },
    }),
    false
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
