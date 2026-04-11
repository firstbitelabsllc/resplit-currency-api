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
    captureCheckIn(payload, monitorConfig) {
      this.captureCheckInCalls.push({
        payload,
        monitorConfig,
      })
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
    GITHUB_EVENT_NAME: process.env.GITHUB_EVENT_NAME,
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
  if (env.GITHUB_EVENT_NAME === undefined) {
    delete process.env.GITHUB_EVENT_NAME
  } else {
    process.env.GITHUB_EVENT_NAME = env.GITHUB_EVENT_NAME
  }

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
    GITHUB_EVENT_NAME: 'schedule',
  }, async ({ monitoring, sentryMock }) => {
    const checkInId = monitoring.startWorkflowCheckIn()

    assert.equal(checkInId, 'mock-checkin-id')
    assert.equal(sentryMock.initCalls.length, 1)
    assert.equal(sentryMock.initCalls[0].dsn, 'https://currency@example.ingest.sentry.io/1')
    assert.deepEqual(sentryMock.captureCheckInCalls, [
      {
        payload: {
          monitorSlug: 'resplit-currency-api-daily-publish',
          status: 'in_progress',
        },
        monitorConfig: {
          schedule: {
            type: 'crontab',
            value: '0 0,3 * * *',
          },
          checkinMargin: 240,
          maxRuntime: 15,
          timezone: 'UTC',
          failureIssueThreshold: 1,
          recoveryThreshold: 1,
        },
      },
    ])
  })
})

test('finishWorkflowCheckIn no-ops when check-in id is missing', async () => {
  await withMonitoringModule({
    SENTRY_CURRENCY_API_DSN: 'https://currency@example.ingest.sentry.io/1',
    SENTRY_DSN: undefined,
    GITHUB_EVENT_NAME: 'schedule',
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
    GITHUB_EVENT_NAME: 'schedule',
  }, async ({ monitoring, sentryMock }) => {
    const startedAt = Date.now() - 1500
    const result = await monitoring.finishWorkflowCheckIn('mock-checkin-id', 'ok', startedAt)

    assert.equal(result, true)
    assert.equal(sentryMock.captureCheckInCalls.length, 1)
    assert.equal(sentryMock.captureCheckInCalls[0].payload.checkInId, 'mock-checkin-id')
    assert.equal(sentryMock.captureCheckInCalls[0].payload.monitorSlug, 'resplit-currency-api-daily-publish')
    assert.equal(sentryMock.captureCheckInCalls[0].payload.status, 'ok')
    assert.equal(typeof sentryMock.captureCheckInCalls[0].payload.duration, 'number')
    assert.equal(sentryMock.captureCheckInCalls[0].monitorConfig, undefined)
    assert.equal(sentryMock.flushCalls.length, 1)
    assert.equal(sentryMock.flushCalls[0], 2000)
  })
})

test('startWorkflowCheckIn skips monitor check-ins for workflow_dispatch runs', async () => {
  await withMonitoringModule({
    SENTRY_CURRENCY_API_DSN: 'https://currency@example.ingest.sentry.io/1',
    SENTRY_DSN: undefined,
    GITHUB_EVENT_NAME: 'workflow_dispatch',
  }, async ({ monitoring, sentryMock }) => {
    const checkInId = monitoring.startWorkflowCheckIn()

    assert.equal(checkInId, null)
    assert.equal(sentryMock.captureCheckInCalls.length, 0)
  })
})

test('finishWorkflowCheckIn skips monitor completion for workflow_dispatch runs', async () => {
  await withMonitoringModule({
    SENTRY_CURRENCY_API_DSN: 'https://currency@example.ingest.sentry.io/1',
    SENTRY_DSN: undefined,
    GITHUB_EVENT_NAME: 'workflow_dispatch',
  }, async ({ monitoring, sentryMock }) => {
    const result = await monitoring.finishWorkflowCheckIn('mock-checkin-id', 'ok', Date.now() - 1500)

    assert.equal(result, false)
    assert.equal(sentryMock.captureCheckInCalls.length, 0)
    assert.equal(sentryMock.flushCalls.length, 0)
  })
})
