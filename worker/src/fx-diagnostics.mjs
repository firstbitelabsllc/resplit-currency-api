import {
  buildFxHistoryResponse,
  buildFxQuoteResponse,
} from './fx-contract.mjs'
import {
  dateDaysBefore,
  normalizeISODate,
  todayDateString,
} from './date-utils.mjs'

const MAX_WINDOW_DAYS = 366

/**
 * @typedef {typeof fetch} FetchLike
 */

/**
 * @param {{
 *   from: string
 *   to: string
 *   days?: number
 *   anchorDate?: string
 *   fetchImpl?: FetchLike
 *   baseUrl?: string
 * }} options
 */
export async function buildFxCoverageReport({
  from,
  to,
  days = 30,
  anchorDate,
  fetchImpl = fetch,
  baseUrl,
}) {
  const fromCode = normalizeCurrencyCode(from)
  const toCode = normalizeCurrencyCode(to)
  const normalizedAnchorDate = normalizeAnchorDate(anchorDate)
  const requestedDays = clampDays(days)
  const startDate = dateDaysBefore(normalizedAnchorDate, requestedDays - 1)

  const [quote, history] = await Promise.all([
    buildFxQuoteResponse({
      from: fromCode,
      to: toCode,
      date: normalizedAnchorDate,
      fetchImpl,
      baseUrl,
    }),
    buildFxHistoryResponse({
      from: fromCode,
      to: toCode,
      start: startDate,
      end: normalizedAnchorDate,
      fetchImpl,
      baseUrl,
    }),
  ])

  const signals = collectSignals(quote, history)

  return {
    checkedAt: new Date().toISOString(),
    from: fromCode,
    to: toCode,
    anchorDate: normalizedAnchorDate,
    requestedDays,
    quote,
    historyCoverage: history.coverage,
    mismatchCount: computeMismatchCount(quote, history),
    signals,
  }
}

/**
 * @param {Awaited<ReturnType<typeof buildFxCoverageReport>>} report
 */
export function summarizeFxCoverageReport(report) {
  return [
    `from=${report.from}`,
    `to=${report.to}`,
    `anchorDate=${report.anchorDate}`,
    `requestedDays=${report.requestedDays}`,
    `quoteResolution=${report.quote.resolutionKind}`,
    `quoteResolvedDate=${report.quote.resolvedDate}`,
    `availableDays=${report.historyCoverage.availableDays}`,
    `missingDayCount=${report.historyCoverage.missingDayCount}`,
    `archiveGapCount=${report.historyCoverage.archiveGapCount}`,
    `signals=${report.signals.length > 0 ? report.signals.join(',') : 'none'}`,
  ].join(' ')
}

function collectSignals(quote, history) {
  const signals = new Set()

  if (quote.resolutionKind === 'prior_day_fallback') {
    signals.add('prior_day_fallback_used')
  }

  if (quote.resolutionKind === 'today_fallback') {
    signals.add('today_fallback_used')
  }

  if (history.coverage.missingDayCount > 0) {
    signals.add('history_range_incomplete')
  }

  if (history.coverage.archiveGapCount > 0) {
    signals.add('archive_gap_detected')
  }

  return [...signals]
}

function computeMismatchCount(quote, history) {
  let mismatchCount = history.coverage.missingDayCount + history.coverage.archiveGapCount
  if (quote.resolutionKind !== 'exact') {
    mismatchCount += 1
  }
  return mismatchCount
}

function normalizeCurrencyCode(value) {
  const normalized = value.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new Error(`Invalid currency code: ${value}`)
  }
  return normalized
}

function normalizeAnchorDate(value) {
  if (!value) {
    return todayDateString()
  }
  return normalizeISODate(value, 'anchorDate')
}

function clampDays(value) {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`Invalid days: ${value}`)
  }
  return Math.min(MAX_WINDOW_DAYS, Math.max(1, value))
}
