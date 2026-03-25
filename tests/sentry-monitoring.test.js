const test = require('node:test')
const assert = require('node:assert/strict')

const monitoringPath = require.resolve('../scripts/sentry-monitoring')
const sentryPath = require.resolve('@sentry/node')

function createSentryMock() {
  return {
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
}

async function withMonitoringModule(env, callback) {
  const originalEnv = {
    SENTRY_CURRENCY_API_DSN: process.env.SENTRY_CURRENCY_API_DSN,
    SENTRY_DSN: process.env.SENTRY_DSN,
    SENTRY_ENVIRONMENT: process.env.SENTRY_ENVIRONMENT,
    SENTRY_RELEASE: process.env.SENTRY_RELEASE,
  }
  const originalSentryCache = require.cache[sentryPath]
  const sentryMock = createSentryMock()

  if (env.SENTRY_CURRENCY_API_DSN === undefined) {
    delete process.env.SENTRY_CURRENCY_API_DSN
  } else {
    process.env.SENTRY_CURRENCY_API_DSN = env.SENTRY_CURRENCY_API_DSN
  }

  if (env.SENTRY_DSN === undefined) {
    delete process.env.SENTRY_DSN
  } else {
    process.env.SENTRY_DSN = env.SENTRY_DSN
  }

  process.env.SENTRY_ENVIRONMENT = env.SENTRY_ENVIRONMENT || 'test'
  process.env.SENTRY_RELEASE = env.SENTRY_RELEASE || 'unit-test'

  delete require.cache[monitoringPath]
  require.cache[sentryPath] = {
    id: sentryPath,
    filename: sentryPath,
    loaded: true,
    exports: sentryMock,
  }

  try {
    const monitoring = require('../scripts/sentry-monitoring')
    await callback({ monitoring, sentryMock })
  } finally {
    delete require.cache[monitoringPath]
    if (originalSentryCache) {
      require.cache[sentryPath] = originalSentryCache
    } else {
      delete require.cache[sentryPath]
    }

    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

test('startWorkflowCheckIn prefers SENTRY_CURRENCY_API_DSN when SENTRY_DSN is unset', async () => {
  await withMonitoringModule({
    SENTRY_CURRENCY_API_DSN: 'https://currency@example.ingest.sentry.io/1',
    SENTRY_DSN: undefined,
  }, async ({ monitoring, sentryMock }) => {
    const checkInId = monitoring.startWorkflowCheckIn()

    assert.equal(checkInId, 'mock-checkin-id')
    assert.equal(sentryMock.initCalls.length, 1)
    assert.equal(sentryMock.initCalls[0].dsn, 'https://currency@example.ingest.sentry.io/1')
    assert.deepEqual(sentryMock.captureCheckInCalls, [
      {
        monitorSlug: 'resplit-currency-api-daily-publish',
        status: 'in_progress',
      },
    ])
  })
})

test('finishWorkflowCheckIn no-ops when check-in id is missing', async () => {
  await withMonitoringModule({
    SENTRY_CURRENCY_API_DSN: 'https://currency@example.ingest.sentry.io/1',
    SENTRY_DSN: undefined,
  }, async ({ monitoring, sentryMock }) => {
    const result = await monitoring.finishWorkflowCheckIn(null, 'error', Date.now())

    assert.equal(result, false)
    assert.equal(sentryMock.captureCheckInCalls.length, 0)
    assert.equal(sentryMock.flushCalls.length, 0)
  })
})

test('finishWorkflowCheckIn completes successfully with the dedicated DSN path', async () => {
  await withMonitoringModule({
    SENTRY_CURRENCY_API_DSN: 'https://currency@example.ingest.sentry.io/1',
    SENTRY_DSN: undefined,
  }, async ({ monitoring, sentryMock }) => {
    const startedAt = Date.now() - 1500
    const result = await monitoring.finishWorkflowCheckIn('mock-checkin-id', 'ok', startedAt)

    assert.equal(result, true)
    assert.equal(sentryMock.captureCheckInCalls.length, 1)
    assert.equal(sentryMock.captureCheckInCalls[0].checkInId, 'mock-checkin-id')
    assert.equal(sentryMock.captureCheckInCalls[0].monitorSlug, 'resplit-currency-api-daily-publish')
    assert.equal(sentryMock.captureCheckInCalls[0].status, 'ok')
    assert.equal(typeof sentryMock.captureCheckInCalls[0].duration, 'number')
    assert.equal(sentryMock.flushCalls.length, 1)
    assert.equal(sentryMock.flushCalls[0], 2000)
  })
})
