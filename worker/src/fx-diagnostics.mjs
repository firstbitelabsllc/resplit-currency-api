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

  const freshness = buildFreshness(normalizedAnchorDate, quote, history)
  const signals = collectSignals(quote, history, freshness)

  return {
    checkedAt: new Date().toISOString(),
    from: fromCode,
    to: toCode,
    anchorDate: normalizedAnchorDate,
    requestedDays,
    quote,
    historyCoverage: history.coverage,
    freshness,
    mismatchCount: computeMismatchCount(quote, history, freshness),
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
    `quoteResolvedLagDays=${report.freshness.quoteResolvedLagDays}`,
    `availableDays=${report.historyCoverage.availableDays}`,
    `missingDayCount=${report.historyCoverage.missingDayCount}`,
    `archiveGapCount=${report.historyCoverage.archiveGapCount}`,
    `archiveLatestLagDays=${report.freshness.archiveLatestLagDays}`,
    `signals=${report.signals.length > 0 ? report.signals.join(',') : 'none'}`,
  ].join(' ')
}

function collectSignals(quote, history, freshness) {
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

  if (freshness.quoteResolvedLagDays > 0) {
    signals.add('quote_anchor_stale')
  }

  if (freshness.archiveLatestLagDays > 0) {
    signals.add('archive_anchor_stale')
  }

  return [...signals]
}

function computeMismatchCount(quote, history, freshness) {
  let mismatchCount = history.coverage.missingDayCount + history.coverage.archiveGapCount
  if (quote.resolutionKind !== 'exact') {
    mismatchCount += 1
  }
  if (freshness.archiveLatestLagDays > 0) {
    mismatchCount += 1
  }
  return mismatchCount
}

function buildFreshness(anchorDate, quote, history) {
  const quoteResolvedLagDays = lagDays(anchorDate, quote.resolvedDate)
  const archiveLatestLagDays = lagDays(anchorDate, history.coverage.archiveLatestDate)

  return {
    quoteResolvedLagDays,
    archiveLatestLagDays,
    staleAgainstAnchor: quoteResolvedLagDays > 0 || archiveLatestLagDays > 0,
  }
}

function lagDays(anchorDate, candidateDate) {
  if (!candidateDate) {
    return 0
  }

  const normalizedAnchorDate = normalizeISODate(anchorDate, 'anchorDate')
  const normalizedCandidateDate = normalizeISODate(candidateDate, 'candidateDate')
  if (normalizedCandidateDate >= normalizedAnchorDate) {
    return 0
  }

  const anchorTime = Date.parse(`${normalizedAnchorDate}T00:00:00Z`)
  const candidateTime = Date.parse(`${normalizedCandidateDate}T00:00:00Z`)
  return Math.round((anchorTime - candidateTime) / 86_400_000)
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
