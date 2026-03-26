import * as Sentry from '@sentry/cloudflare'

const SURFACE = 'resplit-currency-api'
const FX_CANARY_MONITOR_SLUG = 'resplit-currency-api-fx-canary'
const FX_CANARY_MONITOR_CONFIG = {
  schedule: {
    type: 'crontab',
    value: '0 13 * * *',
  },
  checkinMargin: 60,
  maxRuntime: 1,
  timezone: 'UTC',
  failureIssueThreshold: 1,
  recoveryThreshold: 1,
}

/**
 * @param {{ SENTRY_DSN?: string }} env
 * @returns {boolean}
 */
function isFxMonitoringEnabled(env) {
  return Boolean(env.SENTRY_DSN)
}

/**
 * @param {{ SENTRY_DSN?: string, SENTRY_ENVIRONMENT?: string, SENTRY_RELEASE?: string }} env
 * @returns {import('@sentry/cloudflare').CloudflareOptions | undefined}
 */
export function getSentryWorkerOptions(env) {
  if (!isFxMonitoringEnabled(env)) {
    return undefined
  }

  const runtime = getRuntimeMetadata(env)
  return {
    dsn: env.SENTRY_DSN,
    enabled: true,
    environment: runtime.environment,
    release: runtime.release || undefined,
    tracesSampleRate: 0,
    sendDefaultPii: false,
    initialScope: {
      tags: {
        surface: SURFACE,
        runtime: 'worker',
      },
    },
  }
}

/**
 * @param {{ SENTRY_DSN?: string, SENTRY_ENVIRONMENT?: string, SENTRY_RELEASE?: string }} env
 * @returns {{ surface: string, runtime: string, environment: string, release: string | null }}
 */
function getRuntimeMetadata(env) {
  return {
    surface: SURFACE,
    runtime: 'worker',
    environment: env.SENTRY_ENVIRONMENT || 'production',
    release: env.SENTRY_RELEASE || null,
  }
}

/**
 * @param {'info' | 'warn' | 'error'} level
 * @param {Record<string, unknown>} event
 * @param {{ SENTRY_DSN?: string, SENTRY_ENVIRONMENT?: string, SENTRY_RELEASE?: string }} env
 */
export function logFxMonitoringEvent(level, event, env) {
  const runtime = getRuntimeMetadata(env)
  const payload = JSON.stringify({
    timestamp: new Date().toISOString(),
    surface: runtime.surface,
    runtime: runtime.runtime,
    environment: runtime.environment,
    release: runtime.release,
    domain: 'fx',
    ...event,
  })
  const line = `[FX_MONITORING] ${payload}`

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
  }
}

/**
 * @param {unknown} error
 * @param {{
 *   route: string
 *   signal: string
 *   source?: 'fx-coverage-route' | 'fx-canary-cron'
 *   requestId?: string
 *   from?: string
 *   to?: string
 *   requestedDate?: string
 *   start?: string
 *   end?: string
 *   anchorDate?: string
 *   requestedDays?: number
 * }} context
 * @param {{ SENTRY_DSN?: string, SENTRY_ENVIRONMENT?: string, SENTRY_RELEASE?: string }} env
 * @returns {Promise<boolean>}
 */
export async function captureFxRouteFailure(error, context, env) {
  const normalizedError = asError(error)
  logFxMonitoringEvent('error', {
    signal: context.signal,
    route: context.route,
    source: context.source,
    requestId: context.requestId,
    from: context.from,
    to: context.to,
    requestedDate: context.requestedDate,
    start: context.start,
    end: context.end,
    anchorDate: context.anchorDate,
    requestedDays: context.requestedDays,
    error: normalizedError.message,
  }, env)

  if (!isFxMonitoringEnabled(env)) {
    return false
  }

  Sentry.withScope(scope => {
    scope.setLevel('error')
    scope.setTag('surface', SURFACE)
    scope.setTag('runtime', 'worker')
    scope.setTag('route', context.route)
    scope.setTag('monitoring.domain', 'fx')
    scope.setTag('monitoring.signal', context.signal)
    if (context.source) {
      scope.setTag('fx.source', context.source)
    }
    if (context.requestId) {
      scope.setTag('request.id', context.requestId)
    }
    if (context.from) {
      scope.setTag('fx.from', context.from)
    }
    if (context.to) {
      scope.setTag('fx.to', context.to)
    }
    scope.setContext('fxRoute', {
      ...context,
      error: normalizedError.message,
    })
    Sentry.captureException(normalizedError)
  })

  return Sentry.flush(2_000)
}

/**
 * @param {Awaited<import('./fx-diagnostics.mjs').buildFxCoverageReport>} report
 * @param {'fx-coverage-route' | 'fx-canary-cron'} source
 * @param {string | undefined} requestId
 * @param {{ SENTRY_DSN?: string, SENTRY_ENVIRONMENT?: string, SENTRY_RELEASE?: string }} env
 * @returns {Promise<boolean>}
 */
export async function captureFxCoverageMismatch(report, source, requestId, env) {
  if (report.signals.length === 0) {
    logFxMonitoringEvent('warn', {
      signal: 'fx_integrity_warning',
      source,
      from: report.from,
      to: report.to,
      anchorDate: report.anchorDate,
      requestedDays: report.requestedDays,
      mismatchCount: report.mismatchCount,
      requestId,
    }, env)
  } else {
    for (const signal of report.signals) {
      logFxMonitoringEvent('warn', {
        signal,
        source,
        from: report.from,
        to: report.to,
        anchorDate: report.anchorDate,
        requestedDays: report.requestedDays,
        quoteResolution: report.quote.resolutionKind,
        quoteResolvedDate: report.quote.resolvedDate,
        historyCoverage: report.historyCoverage,
        requestId,
      }, env)
    }
  }

  if (!isFxMonitoringEnabled(env)) {
    return false
  }

  Sentry.withScope(scope => {
    scope.setLevel('error')
    scope.setTag('surface', SURFACE)
    scope.setTag('runtime', 'worker')
    scope.setTag('monitoring.domain', 'fx')
    scope.setTag('monitoring.signal', report.signals[0] ?? 'fx_integrity_warning')
    scope.setTag('fx.source', source)
    scope.setTag('fx.from', report.from)
    scope.setTag('fx.to', report.to)
    if (requestId) {
      scope.setTag('request.id', requestId)
    }
    scope.setContext('fxCoverage', {
      anchorDate: report.anchorDate,
      requestedDays: report.requestedDays,
      quote: report.quote,
      historyCoverage: report.historyCoverage,
      mismatchCount: report.mismatchCount,
      signals: report.signals,
      requestId,
    })
    Sentry.captureMessage(
      `FX integrity warning for ${report.from}->${report.to} on ${report.anchorDate}`
    )
  })

  return Sentry.flush(2_000)
}

/**
 * @param {unknown} error
 * @param {{
 *   source: 'fx-coverage-route' | 'fx-canary-cron'
 *   from: string
 *   to: string
 *   anchorDate: string
 *   requestedDays: number
 *   requestId?: string
 * }} context
 * @param {{ SENTRY_DSN?: string, SENTRY_ENVIRONMENT?: string, SENTRY_RELEASE?: string }} env
 * @returns {Promise<boolean>}
 */
export async function captureFxCoverageFailure(error, context, env) {
  const normalizedError = asError(error)
  logFxMonitoringEvent('error', {
    signal: 'coverage_failure',
    source: context.source,
    from: context.from,
    to: context.to,
    anchorDate: context.anchorDate,
    requestedDays: context.requestedDays,
    requestId: context.requestId,
    error: normalizedError.message,
  }, env)

  if (!isFxMonitoringEnabled(env)) {
    return false
  }

  Sentry.withScope(scope => {
    scope.setLevel('error')
    scope.setTag('surface', SURFACE)
    scope.setTag('runtime', 'worker')
    scope.setTag('monitoring.domain', 'fx')
    scope.setTag('monitoring.signal', 'coverage_failure')
    scope.setTag('fx.source', context.source)
    scope.setTag('fx.from', context.from)
    scope.setTag('fx.to', context.to)
    if (context.requestId) {
      scope.setTag('request.id', context.requestId)
    }
    scope.setContext('fxCoverageRequest', {
      anchorDate: context.anchorDate,
      requestedDays: context.requestedDays,
      requestId: context.requestId,
    })
    Sentry.captureException(normalizedError)
  })

  return Sentry.flush(2_000)
}

/**
 * @param {{
 *   checkedAt: string
 *   mismatchCount: number
 *   failureCount: number
 *   results: Array<{
 *     pair: { from: string, to: string }
 *     anchorDate: string
 *     ok: boolean
 *     summary?: string
 *     error?: string
 *   }>
 * }} report
 * @param {string | undefined} requestId
 * @param {{ SENTRY_DSN?: string, SENTRY_ENVIRONMENT?: string, SENTRY_RELEASE?: string }} env
 * @returns {Promise<boolean>}
 */
export async function captureFxCanaryIncident(report, requestId, env) {
  if (!isFxMonitoringEnabled(env)) {
    return false
  }

  const failingChecks = report.results
    .filter(result => !result.ok)
    .map(result => ({
      from: result.pair.from,
      to: result.pair.to,
      anchorDate: result.anchorDate,
      summary: result.summary,
      error: result.error,
    }))

  Sentry.withScope(scope => {
    scope.setLevel('error')
    scope.setTag('surface', SURFACE)
    scope.setTag('runtime', 'worker')
    scope.setTag('monitoring.domain', 'fx')
    scope.setTag('monitoring.signal', 'canary_error')
    scope.setTag('fx.source', 'fx-canary-cron')
    if (requestId) {
      scope.setTag('request.id', requestId)
    }
    scope.setContext('fxCanary', {
      checkedAt: report.checkedAt,
      mismatchCount: report.mismatchCount,
      failureCount: report.failureCount,
      failingChecks,
      requestId,
    })
    Sentry.captureMessage(
      `FX canary failed with ${report.mismatchCount} mismatches and ${report.failureCount} failures`
    )
  })

  return Sentry.flush(2_000)
}

/**
 * @param {{ SENTRY_DSN?: string, SENTRY_ENVIRONMENT?: string, SENTRY_RELEASE?: string }} env
 * @returns {string | null}
 */
export function startFxCanaryCheckIn(env) {
  if (!isFxMonitoringEnabled(env)) {
    return null
  }

  return Sentry.captureCheckIn(
    {
      monitorSlug: FX_CANARY_MONITOR_SLUG,
      status: 'in_progress',
    },
    FX_CANARY_MONITOR_CONFIG
  )
}

/**
 * @param {string | null} checkInId
 * @param {'ok' | 'error'} status
 * @param {number} startedAt
 * @param {{ SENTRY_DSN?: string, SENTRY_ENVIRONMENT?: string, SENTRY_RELEASE?: string }} env
 * @returns {Promise<boolean>}
 */
export async function finishFxCanaryCheckIn(checkInId, status, startedAt, env) {
  if (!checkInId || !isFxMonitoringEnabled(env)) {
    return false
  }

  Sentry.captureCheckIn({
    checkInId,
    monitorSlug: FX_CANARY_MONITOR_SLUG,
    status,
    duration: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
  })

  return Sentry.flush(2_000)
}

/**
 * @param {unknown} error
 * @returns {Error}
 */
function asError(error) {
  return error instanceof Error ? error : new Error(String(error))
}
