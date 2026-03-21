import {
  buildFxCoverageReport,
  summarizeFxCoverageReport,
} from './fx-diagnostics.mjs'

const DEFAULT_FX_CANARY_ANCHOR_OFFSETS = [0, 7, 30, 180]

/**
 * @param {Date} [today]
 * @returns {string[]}
 */
export function defaultFxCanaryAnchorDates(today = new Date()) {
  const todayDate = today.toISOString().slice(0, 10)
  return [...new Set(
    DEFAULT_FX_CANARY_ANCHOR_OFFSETS.map((days) => dateDaysBefore(todayDate, days))
  )]
}

export const DEFAULT_FX_CANARY_PAIRS = [
  { from: 'AED', to: 'USD' },
  { from: 'MYR', to: 'USD' },
  { from: 'EUR', to: 'USD' },
]

/**
 * @param {{
 *   pairs?: Array<{ from: string, to: string }>
 *   anchorDate?: string
 *   anchorDates?: string[]
 *   days?: number
 *   baseUrl?: string
 *   fetchImpl?: typeof fetch
 *   buildReport?: typeof buildFxCoverageReport
 * }} options
 */
export async function runFxCanary({
  pairs = DEFAULT_FX_CANARY_PAIRS,
  anchorDate,
  anchorDates,
  days = 30,
  baseUrl,
  fetchImpl = fetch,
  buildReport = buildFxCoverageReport,
} = {}) {
  const results = []
  const datesToCheck = anchorDates ?? (anchorDate ? [anchorDate] : defaultFxCanaryAnchorDates())

  for (const pair of pairs) {
    for (const dateToCheck of datesToCheck) {
      try {
        const report = await buildReport({
          from: pair.from,
          to: pair.to,
          anchorDate: dateToCheck,
          days,
          baseUrl,
          fetchImpl,
        })
        results.push({
          pair,
          anchorDate: dateToCheck,
          ok: report.mismatchCount === 0,
          report,
          summary: summarizeFxCoverageReport(report),
        })
      } catch (error) {
        results.push({
          pair,
          anchorDate: dateToCheck,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  const mismatchCount = results.reduce(
    (total, result) => total + (result.report?.mismatchCount ?? 0),
    0
  )
  const failureCount = results.filter(result => result.error).length

  return {
    checkedAt: new Date().toISOString(),
    ok: mismatchCount === 0 && failureCount === 0,
    mismatchCount,
    failureCount,
    results,
  }
}

/**
 * @param {Request} request
 * @param {{ CRON_SECRET?: string }} env
 */
export function isAuthorizedCronRequest(request, env) {
  const secret = env.CRON_SECRET
  if (!secret) return false

  const authorization = request.headers.get('authorization')
  return authorization === `Bearer ${secret}`
}

function dateDaysBefore(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - days)
  return date.toISOString().slice(0, 10)
}
