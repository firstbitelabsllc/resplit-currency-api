const test = require('node:test')
const assert = require('node:assert/strict')

const monitoringPath = require.resolve('../scripts/sentry-monitoring')
const sentryPath = require.resolve('@sentry/node')

test('finishWorkflowCheckIn no-ops when check-in id is missing', async () => {
  const originalDsn = process.env.SENTRY_DSN
  const originalEnv = process.env.SENTRY_ENVIRONMENT
  const originalRelease = process.env.SENTRY_RELEASE
  const originalSentryCache = require.cache[sentryPath]

  const sentryMock = {
    initCalls: [],
    captureCheckInCalls: [],
    flushCalls: [],
    logger: {
      info() {},
      warn() {},
      error() {},
    },
    init(options) {
      this.initCalls.push(options)
    },
    captureCheckIn(payload) {
      this.captureCheckInCalls.push(payload)
      return 'mock-checkin-id'
    },
    flush(timeout) {
      this.flushCalls.push(timeout)
      return Promise.resolve(true)
    },
    withScope(callback) {
      callback({
        setLevel() {},
        setTag() {},
        setContext() {},
      })
    },
    captureException() {},
    captureMessage() {},
  }

  process.env.SENTRY_DSN = 'https://public@example.ingest.sentry.io/1'
  process.env.SENTRY_ENVIRONMENT = 'test'
  process.env.SENTRY_RELEASE = 'unit-test'

  delete require.cache[monitoringPath]
  require.cache[sentryPath] = {
    id: sentryPath,
    filename: sentryPath,
    loaded: true,
    exports: sentryMock,
  }

  try {
    const { finishWorkflowCheckIn } = require('../scripts/sentry-monitoring')
    const result = await finishWorkflowCheckIn(null, 'error', Date.now())

    assert.equal(result, false)
    assert.equal(sentryMock.captureCheckInCalls.length, 0)
    assert.equal(sentryMock.flushCalls.length, 0)
  } finally {
    delete require.cache[monitoringPath]
    if (originalSentryCache) {
      require.cache[sentryPath] = originalSentryCache
    } else {
      delete require.cache[sentryPath]
    }

    if (originalDsn === undefined) {
      delete process.env.SENTRY_DSN
    } else {
      process.env.SENTRY_DSN = originalDsn
    }

    if (originalEnv === undefined) {
      delete process.env.SENTRY_ENVIRONMENT
    } else {
      process.env.SENTRY_ENVIRONMENT = originalEnv
    }

    if (originalRelease === undefined) {
      delete process.env.SENTRY_RELEASE
    } else {
      process.env.SENTRY_RELEASE = originalRelease
    }
  }
})
