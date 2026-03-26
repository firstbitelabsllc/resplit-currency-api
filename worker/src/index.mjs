import * as Sentry from '@sentry/cloudflare'
import {
  buildFxHistoryResponse,
  buildFxQuoteResponse,
} from './fx-contract.mjs'
import {
  buildFxCoverageReport,
  summarizeFxCoverageReport,
} from './fx-diagnostics.mjs'
import {
  isAuthorizedCronRequest,
  runFxCanary,
} from './fx-canary.mjs'
import {
  errorResponse,
  jsonResponse,
} from './http.mjs'
import {
  captureFxCanaryIncident,
  captureFxCoverageFailure,
  captureFxCoverageMismatch,
  captureFxRouteFailure,
  finishFxCanaryCheckIn,
  getSentryWorkerOptions,
  logFxMonitoringEvent,
  startFxCanaryCheckIn,
} from './monitoring.mjs'
import { resolveRequestId } from './request-id.mjs'

const ASSET_BASE_URL = 'https://resplit-currency-api.pages.dev'
const QUOTE_HISTORY_CACHE_CONTROL = 'public, s-maxage=3600, stale-while-revalidate=86400'

const handler = {
  /**
   * @param {Request} request
   * @param {Record<string, string | undefined>} env
   * @param {ExecutionContext} _ctx
   */
  async fetch(request, env, _ctx) {
    return handleRequest(request, env)
  },
}

export default Sentry.withSentry(getSentryWorkerOptions, handler)

/**
 * @param {Request} request
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<Response>}
 */
export async function handleRequest(request, env) {
  const url = new URL(request.url)

  switch (url.pathname) {
  case '/quote':
    return handleQuote(request, env)
  case '/history':
    return handleHistory(request, env)
  case '/coverage':
    return handleCoverage(request, env)
  case '/cron/fx-canary':
    return handleFxCanary(request, env)
  default:
    return errorResponse('NOT_FOUND', 'Route not found', 404, resolveRequestId(request), {
      'Cache-Control': 'no-store',
    })
  }
}

async function handleQuote(request, env) {
  const url = new URL(request.url)
  const requestId = resolveRequestId(request)
  const from = url.searchParams.get('from')
  const to = url.searchParams.get('to')
  const date = url.searchParams.get('date')

  logFxMonitoringEvent('info', {
    signal: 'quote_entry',
    route: 'quote',
    requestId,
    from,
    to,
    requestedDate: date,
  }, env)

  if (!from || !to || !date) {
    return errorResponse(
      'INVALID_QUERY',
      'Expected from, to, and date query params',
      400,
      requestId,
      { 'Cache-Control': 'no-store' }
    )
  }

  try {
    const response = await buildFxQuoteResponse({
      from,
      to,
      date,
      baseUrl: env.ASSET_BASE_URL || ASSET_BASE_URL,
    })
    return jsonResponse(response, {
      requestId,
      headers: {
        'Cache-Control': QUOTE_HISTORY_CACHE_CONTROL,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.startsWith('Invalid ')) {
      return errorResponse('INVALID_QUERY', message, 400, requestId, {
        'Cache-Control': 'no-store',
      })
    }

    await captureFxRouteFailure(error, {
      route: 'quote',
      signal: 'worker_route_exception',
      requestId,
      from,
      to,
      requestedDate: date,
    }, env)
    return errorResponse('FX_QUOTE_FAILED', message, 502, requestId, {
      'Cache-Control': 'no-store',
    })
  }
}

async function handleHistory(request, env) {
  const url = new URL(request.url)
  const requestId = resolveRequestId(request)
  const from = url.searchParams.get('from')
  const to = url.searchParams.get('to')
  const start = url.searchParams.get('start')
  const end = url.searchParams.get('end')

  logFxMonitoringEvent('info', {
    signal: 'history_entry',
    route: 'history',
    requestId,
    from,
    to,
    start,
    end,
  }, env)

  if (!from || !to || !start || !end) {
    return errorResponse(
      'INVALID_QUERY',
      'Expected from, to, start, and end query params',
      400,
      requestId,
      { 'Cache-Control': 'no-store' }
    )
  }

  try {
    const response = await buildFxHistoryResponse({
      from,
      to,
      start,
      end,
      baseUrl: env.ASSET_BASE_URL || ASSET_BASE_URL,
    })
    return jsonResponse(response, {
      requestId,
      headers: {
        'Cache-Control': QUOTE_HISTORY_CACHE_CONTROL,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.startsWith('Invalid ')) {
      return errorResponse('INVALID_QUERY', message, 400, requestId, {
        'Cache-Control': 'no-store',
      })
    }

    await captureFxRouteFailure(error, {
      route: 'history',
      signal: 'worker_route_exception',
      requestId,
      from,
      to,
      start,
      end,
    }, env)
    return errorResponse('FX_HISTORY_FAILED', message, 502, requestId, {
      'Cache-Control': 'no-store',
    })
  }
}

async function handleCoverage(request, env) {
  const url = new URL(request.url)
  const requestId = resolveRequestId(request)
  const rawFrom = url.searchParams.get('from') ?? 'AED'
  const rawTo = url.searchParams.get('to') ?? 'USD'
  const rawAnchorDate = url.searchParams.get('anchorDate') ?? undefined
  const rawDays = Number(url.searchParams.get('days') ?? 30)

  logFxMonitoringEvent('info', {
    signal: 'coverage_entry',
    source: 'fx-coverage-route',
    route: 'coverage',
    requestId,
    from: rawFrom,
    to: rawTo,
    anchorDate: rawAnchorDate ?? 'today',
    requestedDays: rawDays,
  }, env)

  try {
    const report = await buildFxCoverageReport({
      from: rawFrom,
      to: rawTo,
      anchorDate: rawAnchorDate,
      days: rawDays,
      baseUrl: env.ASSET_BASE_URL || ASSET_BASE_URL,
    })
    const summary = summarizeFxCoverageReport(report)
    const line = `[FX_DIAGNOSTICS] step=done status=200 ${summary}`

    if (report.mismatchCount > 0) {
      console.warn(line)
      await captureFxCoverageMismatch(report, 'fx-coverage-route', requestId, env)
    } else {
      console.log(line)
      logFxMonitoringEvent('info', {
        signal: 'coverage_ok',
        source: 'fx-coverage-route',
        route: 'coverage',
        requestId,
        from: report.from,
        to: report.to,
        anchorDate: report.anchorDate,
        requestedDays: report.requestedDays,
        availableDays: report.historyCoverage.availableDays,
      }, env)
    }

    return jsonResponse(report, {
      requestId,
      headers: {
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const line =
      `[FX_DIAGNOSTICS] step=error from=${rawFrom} to=${rawTo} anchorDate=${rawAnchorDate ?? 'today'} days=${rawDays} message=${message}`

    if (message.startsWith('Invalid ') || message.startsWith('No history points available')) {
      console.warn(line)
      return errorResponse('INVALID_QUERY', message, 400, requestId, {
        'Cache-Control': 'no-store',
      })
    }

    console.error(line)
    await captureFxCoverageFailure(error, {
      source: 'fx-coverage-route',
      from: rawFrom,
      to: rawTo,
      anchorDate: rawAnchorDate ?? new Date().toISOString().slice(0, 10),
      requestedDays: rawDays,
      requestId,
    }, env)
    return errorResponse('FX_DIAGNOSTICS_FAILED', message, 502, requestId, {
      'Cache-Control': 'no-store',
    })
  }
}

async function handleFxCanary(request, env) {
  const requestId = resolveRequestId(request)

  if (!isAuthorizedCronRequest(request, env)) {
    console.warn('[FX_CANARY] status=401 unauthorized')
    return errorResponse(
      'UNAUTHORIZED',
      'Missing or invalid cron authorization',
      401,
      requestId,
      { 'Cache-Control': 'no-store' }
    )
  }

  const startedAt = Date.now()
  const checkInId = startFxCanaryCheckIn(env)
  let checkInStatus = 'error'

  try {
    const report = await runFxCanary({
      baseUrl: env.ASSET_BASE_URL || ASSET_BASE_URL,
    })
    const status = report.ok ? 200 : 500
    checkInStatus = report.ok ? 'ok' : 'error'

    logFxMonitoringEvent(report.ok ? 'info' : 'error', {
      signal: report.ok ? 'canary_ok' : 'canary_error',
      source: 'fx-canary-cron',
      route: 'cron_fx_canary',
      requestId,
      mismatchCount: report.mismatchCount,
      failureCount: report.failureCount,
      checkedAt: report.checkedAt,
    }, env)

    console[report.ok ? 'log' : 'error'](
      `[FX_CANARY] status=${status} ok=${report.ok} mismatchCount=${report.mismatchCount} failureCount=${report.failureCount}`
    )

    if (!report.ok) {
      await captureFxCanaryIncident(report, requestId, env)
    }

    return jsonResponse(report, {
      status,
      requestId,
      headers: {
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    console.error('[FX_CANARY] status=500 FX canary failed', error)
    await captureFxRouteFailure(error, {
      route: 'cron_fx_canary',
      signal: 'canary_error',
      source: 'fx-canary-cron',
      from: 'MULTI',
      to: 'MULTI',
      anchorDate: new Date().toISOString().slice(0, 10),
      requestedDays: 30,
      requestId,
    }, env)
    return errorResponse('FX_CANARY_FAILED', 'FX canary failed', 500, requestId, {
      'Cache-Control': 'no-store',
    })
  } finally {
    await finishFxCanaryCheckIn(checkInId, /** @type {'ok' | 'error'} */ (checkInStatus), startedAt, env)
  }
}
