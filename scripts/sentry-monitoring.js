const Sentry = require('@sentry/node')

const SURFACE = 'resplit-currency-api'
const DEFAULT_WORKFLOW = 'daily_publish'
const DAILY_PUBLISH_MONITOR_SLUG = 'resplit-currency-api-daily-publish'
const DAILY_PUBLISH_MONITOR_CONFIG = {
  schedule: {
    type: 'crontab',
    value: '0 0 * * *'
  },
  // GitHub Actions scheduled workflows routinely start 2h+ after the nominal cron time.
  // Keep the expected schedule at midnight UTC, but allow a wider margin so Sentry
  // doesn't fire false missed-check-in incidents before GitHub dispatches the job.
  checkinMargin: 240,
  maxRuntime: 15,
  timezone: 'UTC',
  failureIssueThreshold: 1,
  recoveryThreshold: 1
}

let hasInitializedSentry = false
const reportedErrors = new WeakSet()

function shouldEmitDailyPublishCheckIn() {
  const eventName = process.env.GITHUB_EVENT_NAME

  if (!eventName) {
    return false
  }

  return eventName === 'schedule'
}

function resolveDsn() {
  return process.env.SENTRY_CURRENCY_API_DSN || process.env.SENTRY_DSN || null
}

function isEnabled() {
  return Boolean(resolveDsn())
}

function resolveEnvironment() {
  return process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development'
}

function resolveRelease() {
  return process.env.SENTRY_RELEASE || process.env.GITHUB_SHA || null
}

function getRuntimeMetadata() {
  return {
    surface: SURFACE,
    environment: resolveEnvironment(),
    release: resolveRelease(),
    workflow: DEFAULT_WORKFLOW
  }
}

function initializeSentry() {
  if (hasInitializedSentry || !isEnabled()) {
    return
  }

  const runtime = getRuntimeMetadata()
  Sentry.init({
    dsn: resolveDsn(),
    enabled: true,
    environment: runtime.environment,
    release: runtime.release || undefined,
    tracesSampleRate: 0,
    sendDefaultPii: false,
    enableLogs: true,
    initialScope: {
      tags: {
        surface: SURFACE
      }
    }
  })

  hasInitializedSentry = true
}

function normalizeContext(context = {}) {
  return Object.fromEntries(
    Object.entries({
      ...getRuntimeMetadata(),
      ...context
    }).filter(([, value]) => value !== undefined && value !== null)
  )
}

function toLogAttributes(context = {}) {
  return Object.fromEntries(
    Object.entries(normalizeContext(context)).map(([key, value]) => [key, serializeLogValue(value)])
  )
}

function serializeLogValue(value) {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  return JSON.stringify(value)
}

function writeConsole(level, line) {
  switch (level) {
    case 'info':
      console.log(line)
      break
    case 'warn':
      console.warn(line)
      break
    case 'error':
      console.error(line)
      break
    default:
      console.log(line)
      break
  }
}

function logEvent(level, signal, context = {}) {
  const payload = normalizeContext({
    'monitoring.domain': 'fx',
    'monitoring.signal': signal,
    ...context
  })
  const line = `[FX_PUBLISH] ${JSON.stringify(payload)}`

  writeConsole(level, line)

  if (!isEnabled()) {
    return
  }

  initializeSentry()
  const attributes = toLogAttributes(payload)
  switch (level) {
    case 'info':
      Sentry.logger.info(signal, attributes)
      break
    case 'warn':
      Sentry.logger.warn(signal, attributes)
      break
    case 'error':
      Sentry.logger.error(signal, attributes)
      break
    default:
      Sentry.logger.info(signal, attributes)
      break
  }
}

async function captureIssue({
  signal,
  error,
  message,
  level = 'error',
  tags = {},
  context = {}
}) {
  const normalizedError = asError(error)
  const normalizedContext = normalizeContext({
    'monitoring.domain': 'fx',
    'monitoring.signal': signal,
    error: normalizedError ? normalizedError.message : undefined,
    message,
    ...context
  })

  logEvent(level, signal, normalizedContext)

  if (!isEnabled()) {
    return false
  }

  initializeSentry()
  Sentry.withScope((scope) => {
    scope.setLevel(level === 'warn' ? 'warning' : level)
    scope.setTag('surface', SURFACE)
    scope.setTag('monitoring.domain', 'fx')
    scope.setTag('monitoring.signal', signal)
    scope.setTag('workflow', String(context.workflow || DEFAULT_WORKFLOW))
    for (const [key, value] of Object.entries(tags)) {
      scope.setTag(key, value)
    }
    scope.setContext('monitoring', normalizedContext)
    if (normalizedError) {
      Sentry.captureException(normalizedError)
    } else {
      Sentry.captureMessage(message || signal)
    }
  })

  if (normalizedError) {
    reportedErrors.add(normalizedError)
  }

  return Sentry.flush(2_000)
}

function hasReportedError(error) {
  return Boolean(error && typeof error === 'object' && reportedErrors.has(error))
}

async function runMonitoredScript(scriptName, fn, options = {}) {
  const {
    workflow = DEFAULT_WORKFLOW,
    successSignal = `${scriptName}_ok`,
    failureSignal = `${scriptName}_failed`
  } = options

  logEvent('info', `${scriptName}_start`, {
    workflow,
    script: scriptName
  })

  try {
    const result = await fn()
    logEvent('info', successSignal, {
      workflow,
      script: scriptName
    })
    await flush()
    return result
  } catch (error) {
    const normalizedError = asError(error)
    if (!hasReportedError(normalizedError)) {
      await captureIssue({
        signal: failureSignal,
        error: normalizedError,
        context: {
          workflow,
          script: scriptName
        }
      })
    }
    await flush()
    throw normalizedError
  }
}

function startWorkflowCheckIn() {
  if (!isEnabled() || !shouldEmitDailyPublishCheckIn()) {
    return null
  }

  initializeSentry()
  return Sentry.captureCheckIn(
    {
      monitorSlug: DAILY_PUBLISH_MONITOR_SLUG,
      status: 'in_progress'
    },
    DAILY_PUBLISH_MONITOR_CONFIG
  )
}

async function finishWorkflowCheckIn(checkInId, status, startedAt = Date.now()) {
  if (!isEnabled() || !shouldEmitDailyPublishCheckIn()) {
    return false
  }

  if (!checkInId) {
    logEvent('warn', 'workflow_checkin_finish_skipped', {
      reason: 'missing_checkin_id',
      status
    })
    return false
  }

  initializeSentry()
  Sentry.captureCheckIn({
    checkInId,
    monitorSlug: DAILY_PUBLISH_MONITOR_SLUG,
    status,
    duration: Number(((Date.now() - startedAt) / 1000).toFixed(3))
  })
  return Sentry.flush(2_000)
}

async function flush(timeout = 2_000) {
  if (!isEnabled()) {
    return false
  }
  initializeSentry()
  return Sentry.flush(timeout)
}

function asError(error) {
  if (!error) return null
  return error instanceof Error ? error : new Error(String(error))
}

module.exports = {
  captureIssue,
  finishWorkflowCheckIn,
  runMonitoredScript,
  startWorkflowCheckIn
}
