const test = require('node:test')
const assert = require('node:assert/strict')

const currencyPath = require.resolve('../currscript')
const monitoringPath = require.resolve('../scripts/sentry-monitoring')
const sentryPath = require.resolve('@sentry/node')

function createSentryMock() {
  return {
    initCalls: [],
    captureExceptionCalls: [],
    captureMessageCalls: [],
    flushCalls: [],
    issueSignals: [],
    logger: {
      info() {},
      warn() {},
      error() {}
    },
    init(options) {
      this.initCalls.push(options)
    },
    flush(timeout) {
      this.flushCalls.push(timeout)
      return Promise.resolve(true)
    },
    withScope(callback) {
      let issueSignal = null
      callback({
        setLevel() {},
        setTag(key, value) {
          if (key === 'monitoring.signal') issueSignal = value
        },
        setContext() {}
      })
      if (issueSignal) this.issueSignals.push(issueSignal)
    },
    captureException(error) {
      this.captureExceptionCalls.push(error)
    },
    captureMessage(message) {
      this.captureMessageCalls.push(message)
    }
  }
}

test('a final failed generation emits exactly one terminal Sentry issue', async () => {
  const originalAttempt = process.env.CURRENCY_PUBLISH_ATTEMPT
  const originalDsn = process.env.SENTRY_CURRENCY_API_DSN
  const originalEnvironment = process.env.SENTRY_ENVIRONMENT
  const originalRelease = process.env.SENTRY_RELEASE
  const originalSentryCache = require.cache[sentryPath]
  const originalCurrencyCache = require.cache[currencyPath]
  const originalMonitoringCache = require.cache[monitoringPath]
  const sentryMock = createSentryMock()

  process.env.CURRENCY_PUBLISH_ATTEMPT = 'final'
  process.env.SENTRY_CURRENCY_API_DSN = 'https://currency@example.ingest.sentry.io/1'
  process.env.SENTRY_ENVIRONMENT = 'test'
  process.env.SENTRY_RELEASE = 'terminal-alert-test'
  delete require.cache[currencyPath]
  delete require.cache[monitoringPath]
  require.cache[sentryPath] = {
    id: sentryPath,
    filename: sentryPath,
    loaded: true,
    exports: sentryMock
  }

  try {
    const { fetchReconciledRates } = require('../currscript')
    const { runMonitoredScript } = require('../scripts/sentry-monitoring')

    await assert.rejects(
      () => runMonitoredScript('currency_publish', () => fetchReconciledRates({
        publishDate: '2026-07-03',
        loadPriorTrustedSnapshot: () => null,
        loadSameDayCommittedSnapshot: () => null,
        fetchPrimary: async () => {
          throw new Error('upstream unavailable')
        },
        fetchSecondary: async () => null,
        loadArchiveSnapshot: () => null,
        warn: () => {}
      }), {
        workflow: 'daily_publish',
        failureSignal: 'generation_retry_failure'
      }),
      /refusing partial-currency publish/
    )

    assert.equal(
      sentryMock.captureExceptionCalls.length + sentryMock.captureMessageCalls.length,
      1,
      'the final upstream failure and generation failure must not open two terminal issues'
    )
    assert.deepEqual(sentryMock.issueSignals, ['generation_retry_failure'])
  } finally {
    if (originalAttempt === undefined) delete process.env.CURRENCY_PUBLISH_ATTEMPT
    else process.env.CURRENCY_PUBLISH_ATTEMPT = originalAttempt
    if (originalDsn === undefined) delete process.env.SENTRY_CURRENCY_API_DSN
    else process.env.SENTRY_CURRENCY_API_DSN = originalDsn
    if (originalEnvironment === undefined) delete process.env.SENTRY_ENVIRONMENT
    else process.env.SENTRY_ENVIRONMENT = originalEnvironment
    if (originalRelease === undefined) delete process.env.SENTRY_RELEASE
    else process.env.SENTRY_RELEASE = originalRelease
    if (originalCurrencyCache) require.cache[currencyPath] = originalCurrencyCache
    else delete require.cache[currencyPath]
    if (originalMonitoringCache) require.cache[monitoringPath] = originalMonitoringCache
    else delete require.cache[monitoringPath]
    if (originalSentryCache) require.cache[sentryPath] = originalSentryCache
    else delete require.cache[sentryPath]
  }
})
