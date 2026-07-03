'use strict'

/**
 * Multi-source FX quorum + cross-check library.
 *
 * This is the JavaScript port of the mature, tested Go quorum in the (currently
 * REFERENCE-ONLY) GCP tree — internal/fx/quorum.go, internal/fx/sources.go,
 * internal/fx/crossrate.go. The constants and semantics are copied VERBATIM so
 * the two implementations cannot drift; each is annotated with its Go origin.
 *
 * Convention (matches internal/fx/crossrate.go): rates are EUR-base, i.e. every
 * value is "units of the currency per 1 EUR" (rates.usd === 1.085 means
 * 1 EUR = 1.085 USD). EUR itself is implicitly 1.0. Keys are lower-cased to
 * match the currscript.js pipeline (Go upper-cases; we normalize to lower here).
 *
 * Published-value policy (agent decision 2026-07-03, revertable):
 *   open.er-api.com stays AUTHORITATIVE for every published rate value (both the
 *   ~30-currency intersection AND the ~130-currency tail). Frankfurter/ECB is a
 *   cross-check tripwire (catch >0.5% drift) plus a degraded-mode fallback
 *   (survive an er-api outage by publishing majors), NOT a value blender. This
 *   honors the "advisory-only on the intersection / tail single-sourced from
 *   er-api exactly as today" guards and avoids mutating money values by the sub-
 *   tolerance amount a 2-source median would introduce. reconcile()/median() are
 *   ported and tested as the correct primitive for source selection + future
 *   N>2 sources, but are intentionally NOT on the normal publish value path.
 */

// internal/fx/quorum.go: QuorumTolerance = 0.005 — max relative spread between
// two sources for the same currency before they are considered to disagree.
// Two rates a,b agree when |a-b| / min(a,b) <= QuorumTolerance.
const QUORUM_TOLERANCE = 0.005

// internal/fx/quorum.go: minAgree of 2 for the two-source configuration.
const MIN_AGREE = 2

// internal/fx DefaultMaxRateAge = 96h. 96h (4 days) is deliberate: it spans a
// Fri->Tue window so ECB/Frankfurter (which does NOT publish on weekends or
// holidays and re-serves Friday's rates under Friday's date) stays "fresh"
// across a long weekend, while still catching a source stuck for a week.
const FX_MAX_RATE_AGE_HOURS = 96

// Cross-source disagreement gate thresholds (validate-package.js enforces).
//   - business day (source dates equal): warn above WARN_TOLERANCE.
//   - weekend/divergent (secondary date < primary date): use the wider
//     WEEKEND_WARN_TOLERANCE so ECB serving stale-Friday rates does not spam
//     warnings for every currency every Sat/Sun.
//   - any day: REFUSE_TOLERANCE is a hard "someone is badly wrong" stop.
const WARN_TOLERANCE = QUORUM_TOLERANCE // 0.5%
const WEEKEND_WARN_TOLERANCE = 0.02 // 2%
const REFUSE_TOLERANCE = 0.05 // 5%

// internal/fx/sources.go: erAPIDefaultURL / frankfurterDefaultURL.
const ER_API_URL = 'https://open.er-api.com/v6/latest/EUR'
const FRANKFURTER_URL = 'https://api.frankfurter.app/latest?base=EUR'

// ---------------------------------------------------------------------------
// Pure quorum primitives — exact ports of internal/fx/quorum.go.
// ---------------------------------------------------------------------------

/**
 * Relative difference between a and b, normalized by the smaller magnitude so
 * the tolerance is symmetric. Port of internal/fx/quorum.go relDiff.
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function relDiff(a, b) {
  if (a === b) return 0
  const denom = Math.min(a, b)
  if (!(denom > 0)) {
    // Should not happen for positive rates; guard against div-by-zero/NaN.
    return 1
  }
  return Math.abs(a - b) / denom
}

/**
 * Median of vals (does not mutate the caller's array). vals must be non-empty.
 * Port of internal/fx/quorum.go median.
 * @param {number[]} vals
 * @returns {number}
 */
function median(vals) {
  const sorted = [...vals].sort((x, y) => x - y)
  const n = sorted.length
  const mid = Math.floor(n / 2)
  if (n % 2 === 1) return sorted[mid]
  return (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Largest subset of vals whose members are all within `tolerance` of the
 * subset's median. Sorts, then scans every contiguous window (sorted order
 * keeps agreeing values adjacent) and keeps the longest valid one. n is the
 * number of sources (single digits), so the O(n^3) scan is irrelevant.
 * Port of internal/fx/quorum.go largestAgreeingCluster.
 * @param {number[]} vals
 * @param {number} [tolerance]
 * @returns {number[]}
 */
function largestAgreeingCluster(vals, tolerance = QUORUM_TOLERANCE) {
  if (vals.length <= 1) return [...vals]

  const sorted = [...vals].sort((x, y) => x - y)
  let best = []
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j <= sorted.length; j += 1) {
      const window = sorted.slice(i, j)
      if (windowAgrees(window, tolerance) && window.length > best.length) {
        best = window
      }
    }
  }
  return [...best]
}

function windowAgrees(window, tolerance) {
  const m = median(window)
  return window.every((v) => relDiff(v, m) <= tolerance)
}

/**
 * Fuse multiple source snapshots into a single trusted rate table. For each
 * currency, find the largest cluster of sources agreeing pairwise-with-the-
 * cluster-median within tolerance; if that cluster has >= minAgree members the
 * currency passes and its reconciled value is the MEDIAN of the agreeing
 * sources. Port of internal/fx/quorum.go Reconcile.
 *
 * NOTE: intentionally NOT used on the normal publish value path (see the
 * published-value policy at the top of this file) — it is the primitive for
 * source selection and future N>2 sources, and is unit-tested to match Go.
 *
 * @param {Array<{ source?: string, date?: string, rates: Record<string, number> }>} snapshots
 * @param {number} [minAgree]
 * @returns {{ rates: Record<string, number>, failed: string[] }}
 */
function reconcile(snapshots, minAgree = MIN_AGREE) {
  if (minAgree < 1) {
    throw new Error(`fx: minAgree must be >= 1, got ${minAgree}`)
  }
  if (snapshots.length < minAgree) {
    throw new Error(
      `fx: insufficient sources for quorum: have ${snapshots.length}, need ${minAgree}`
    )
  }

  const valuesByCurrency = new Map()
  for (const snap of snapshots) {
    for (const [rawCode, value] of Object.entries(snap.rates || {})) {
      if (!(value > 0)) continue // corrupt/missing; does not vote for this currency
      const code = rawCode.toLowerCase()
      if (!valuesByCurrency.has(code)) valuesByCurrency.set(code, [])
      valuesByCurrency.get(code).push(value)
    }
  }

  const rates = {}
  const failed = []
  for (const [code, vals] of valuesByCurrency) {
    const agreeing = largestAgreeingCluster(vals)
    if (agreeing.length >= minAgree) {
      rates[code] = median(agreeing)
    } else {
      failed.push(code)
    }
  }
  failed.sort()
  return { rates, failed }
}

// ---------------------------------------------------------------------------
// Freshness gate — port of internal/fx DefaultMaxRateAge semantics.
// ---------------------------------------------------------------------------

function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function daysBetweenUTC(start, end) {
  const startDate = new Date(`${start}T00:00:00Z`)
  const endDate = new Date(`${end}T00:00:00Z`)
  return Math.round((endDate - startDate) / (24 * 60 * 60 * 1000))
}

/**
 * Age of a source snapshot in hours, measured from the source's own date to the
 * publish date (both calendar dates, UTC). Returns null when the source date is
 * unparseable (we do not penalize a source for a date we cannot read).
 * @param {string} sourceDate
 * @param {string} publishDate
 * @returns {number | null}
 */
function snapshotAgeHours(sourceDate, publishDate) {
  if (!isIsoDate(sourceDate) || !isIsoDate(publishDate)) return null
  return daysBetweenUTC(sourceDate, publishDate) * 24
}

/**
 * A source is fresh when its snapshot age does not exceed maxAgeHours. Unknown
 * (unparseable) dates are treated as fresh but flagged by the caller.
 * @param {string} sourceDate
 * @param {string} publishDate
 * @param {number} [maxAgeHours]
 * @returns {boolean}
 */
function isFresh(sourceDate, publishDate, maxAgeHours = FX_MAX_RATE_AGE_HOURS) {
  const age = snapshotAgeHours(sourceDate, publishDate)
  if (age === null) return true
  return age <= maxAgeHours
}

// ---------------------------------------------------------------------------
// Cross-source comparison (advisory tripwire) — intersection only.
// ---------------------------------------------------------------------------

/**
 * Relative differences for every currency present (positive) in BOTH tables.
 * Currencies only one source carries (the ~130 er-api tail) are intentionally
 * omitted, so the tail stays single-sourced. Pure + deterministic (sorted).
 * @param {Record<string, number>} primary
 * @param {Record<string, number>} secondary
 * @returns {Array<{ code: string, relDiff: number, primary: number, secondary: number }>}
 */
function crossCheckPairs(primary, secondary) {
  const pairs = []
  for (const [rawCode, primaryValue] of Object.entries(primary || {})) {
    const code = rawCode.toLowerCase()
    const secondaryValue = secondary ? secondary[code] : undefined
    if (!(primaryValue > 0) || !(secondaryValue > 0)) continue
    pairs.push({
      code,
      relDiff: relDiff(primaryValue, secondaryValue),
      primary: primaryValue,
      secondary: secondaryValue,
    })
  }
  return pairs.sort((a, b) => a.code.localeCompare(b.code))
}

// ---------------------------------------------------------------------------
// Source fetchers + parsers — ports of internal/fx/sources.go.
// ---------------------------------------------------------------------------

/**
 * Normalize a provider rate table to lower-cased keys with positive numeric
 * values only (same filtering as currscript toLowerSorted).
 * @param {Record<string, unknown>} rates
 * @returns {Record<string, number>}
 */
function normalizeRates(rates) {
  const out = {}
  for (const [key, value] of Object.entries(rates || {})) {
    const num = parseFloat(value)
    if (Number.isFinite(num) && num > 0) {
      out[key.toLowerCase()] = num
    }
  }
  return out
}

/**
 * Parse open.er-api.com's RFC1123-ish time_last_update_utc into an ISO date,
 * falling back to '' when unparseable. Port of internal/fx/sources.go
 * normalizeERAPIDate.
 * @param {string} raw
 * @returns {string}
 */
function parseErApiDate(raw) {
  if (!raw || typeof raw !== 'string') return ''
  const parsed = new Date(raw.trim())
  if (Number.isNaN(parsed.getTime())) return ''
  return parsed.toISOString().slice(0, 10)
}

/**
 * Parse an open.er-api.com response into a normalized snapshot. Port of
 * internal/fx/sources.go ERAPISource.Fetch validation.
 * @param {any} data
 * @returns {{ source: 'er-api', date: string, rates: Record<string, number> }}
 */
function parseErApiSnapshot(data) {
  if (data && data.result && data.result !== 'success') {
    throw new Error(`er-api: upstream result "${data.result}"`)
  }
  const base = String(data?.base_code || '').toUpperCase()
  if (base && base !== 'EUR') {
    throw new Error(`er-api: unexpected base "${base}", want EUR`)
  }
  const rates = normalizeRates(data?.rates)
  if (Object.keys(rates).length === 0) {
    throw new Error('er-api: empty rate table')
  }
  return {
    source: 'er-api',
    date: parseErApiDate(data?.time_last_update_utc),
    rates,
  }
}

/**
 * Parse a frankfurter.app (ECB) response into a normalized snapshot. Port of
 * internal/fx/sources.go FrankfurterSource.Fetch validation, including making
 * the implicit EUR base explicit (frankfurter omits it from its rate table).
 * @param {any} data
 * @returns {{ source: 'frankfurter', date: string, rates: Record<string, number> }}
 */
function parseFrankfurterSnapshot(data) {
  const base = String(data?.base || '').toUpperCase()
  if (base && base !== 'EUR') {
    throw new Error(`frankfurter: unexpected base "${base}", want EUR`)
  }
  const rates = normalizeRates(data?.rates)
  if (Object.keys(rates).length === 0) {
    throw new Error('frankfurter: empty rate table')
  }
  if (!(rates.eur > 0)) {
    rates.eur = 1
  }
  return {
    source: 'frankfurter',
    date: isIsoDate(data?.date) ? data.date : '',
    rates,
  }
}

/**
 * Fetch the latest EUR-base snapshot from open.er-api.com.
 * @param {{ fetchJson: (url: string, timeoutMs: number) => Promise<any>, url?: string, timeoutMs?: number }} options
 * @returns {Promise<{ source: 'er-api', date: string, rates: Record<string, number> }>}
 */
async function fetchErApiSnapshot({ fetchJson, url = ER_API_URL, timeoutMs = 30_000 }) {
  const data = await fetchJson(url, timeoutMs)
  return parseErApiSnapshot(data)
}

/**
 * Fetch the latest EUR-base ECB reference rates from frankfurter.app.
 * @param {{ fetchJson: (url: string, timeoutMs: number) => Promise<any>, url?: string, timeoutMs?: number }} options
 * @returns {Promise<{ source: 'frankfurter', date: string, rates: Record<string, number> }>}
 */
async function fetchFrankfurterSnapshot({ fetchJson, url = FRANKFURTER_URL, timeoutMs = 15_000 }) {
  const data = await fetchJson(url, timeoutMs)
  return parseFrankfurterSnapshot(data)
}

// ---------------------------------------------------------------------------
// Publish reconciliation — chooses published values + builds emitted metadata.
// ---------------------------------------------------------------------------

/**
 * Decide the published EUR-base rate table and build the `sources` + `agreement`
 * metadata emitted into snapshots/meta. See the published-value policy at the
 * top of this file: er-api is authoritative; Frankfurter is cross-check +
 * degraded fallback.
 *
 * @param {{
 *   primary: { source: string, date: string, rates: Record<string, number> } | null,
 *   secondary: { source: string, date: string, rates: Record<string, number> } | null,
 *   publishDate: string,
 *   maxAgeHours?: number,
 * }} options
 * @returns {{
 *   rates: Record<string, number> | null,
 *   reconciliation: {
 *     publishedSource: string | null,
 *     reducedCoverage: boolean,
 *     stale: boolean,
 *     sources: Array<{ source: string, date: string, currencyCount: number, fresh: boolean, ageHours: number | null }>,
 *     agreement: null | {
 *       weekend: boolean,
 *       primaryDate: string,
 *       secondaryDate: string,
 *       intersectionCount: number,
 *       maxRelDiff: number,
 *       pairs: Array<{ code: string, relDiff: number }>,
 *     },
 *   },
 * }}
 */
function buildReconciliation({ primary, secondary, publishDate, maxAgeHours = FX_MAX_RATE_AGE_HOURS }) {
  const describe = (snap) =>
    snap && {
      source: snap.source,
      date: snap.date || null,
      currencyCount: Object.keys(snap.rates || {}).length,
      fresh: isFresh(snap.date, publishDate, maxAgeHours),
      ageHours: snapshotAgeHours(snap.date, publishDate),
    }

  const sources = [describe(primary), describe(secondary)].filter(Boolean)
  const primaryFresh = primary ? isFresh(primary.date, publishDate, maxAgeHours) : false
  const secondaryFresh = secondary ? isFresh(secondary.date, publishDate, maxAgeHours) : false

  let rates = null
  let publishedSource = null
  let reducedCoverage = false
  let stale = false

  if (primary && (primaryFresh || !(secondary && secondaryFresh))) {
    // er-api authoritative. Publish it even when stale IF there is no fresh
    // secondary to prefer (better a flagged-stale full table than nothing).
    rates = primary.rates
    publishedSource = primary.source
    stale = !primaryFresh
  } else if (secondary && secondaryFresh) {
    // er-api missing or stale, ECB fresh: degrade to the ~30 majors.
    rates = secondary.rates
    publishedSource = secondary.source
    reducedCoverage = true
  } else if (secondary) {
    rates = secondary.rates
    publishedSource = secondary.source
    reducedCoverage = true
    stale = !secondaryFresh
  }

  let agreement = null
  if (primary && secondary) {
    const weekend = Boolean(primary.date && secondary.date && secondary.date < primary.date)
    const pairs = crossCheckPairs(primary.rates, secondary.rates)
    agreement = {
      weekend,
      primaryDate: primary.date || null,
      secondaryDate: secondary.date || null,
      intersectionCount: pairs.length,
      maxRelDiff: pairs.reduce((max, p) => Math.max(max, p.relDiff), 0),
      pairs: pairs.map((p) => ({ code: p.code, relDiff: Number(p.relDiff.toFixed(6)) })),
    }
  }

  return {
    rates,
    reconciliation: { publishedSource, reducedCoverage, stale, sources, agreement },
  }
}

/**
 * Enforce the cross-source disagreement gate over emitted `agreement` metadata.
 * Called by validate-package.js so the publish/refuse decision lives in the
 * gate (single tuning point), consistent with the existing day-over-day sanity
 * gate. Returns currencies to warn on and currencies that must refuse publish.
 *
 * @param {null | { weekend?: boolean, pairs?: Array<{ code: string, relDiff: number }> }} agreement
 * @param {{ warnTolerance?: number, weekendWarnTolerance?: number, refuseTolerance?: number }} [thresholds]
 * @returns {{ warns: Array<{ code: string, relDiff: number }>, refusals: Array<{ code: string, relDiff: number }> }}
 */
function evaluateCrossSourceAgreement(agreement, {
  warnTolerance = WARN_TOLERANCE,
  weekendWarnTolerance = WEEKEND_WARN_TOLERANCE,
  refuseTolerance = REFUSE_TOLERANCE,
} = {}) {
  if (!agreement || !Array.isArray(agreement.pairs)) {
    return { warns: [], refusals: [] }
  }
  const warnBand = agreement.weekend ? weekendWarnTolerance : warnTolerance
  const warns = []
  const refusals = []
  for (const pair of agreement.pairs) {
    if (pair.relDiff > refuseTolerance) {
      refusals.push({ code: pair.code, relDiff: pair.relDiff })
    } else if (pair.relDiff > warnBand) {
      warns.push({ code: pair.code, relDiff: pair.relDiff })
    }
  }
  return { warns, refusals }
}

module.exports = {
  // constants (ported from internal/fx)
  QUORUM_TOLERANCE,
  MIN_AGREE,
  FX_MAX_RATE_AGE_HOURS,
  WARN_TOLERANCE,
  WEEKEND_WARN_TOLERANCE,
  REFUSE_TOLERANCE,
  ER_API_URL,
  FRANKFURTER_URL,
  // quorum primitives
  relDiff,
  median,
  largestAgreeingCluster,
  reconcile,
  // freshness
  snapshotAgeHours,
  isFresh,
  // cross-check
  crossCheckPairs,
  // sources
  normalizeRates,
  parseErApiDate,
  parseErApiSnapshot,
  parseFrankfurterSnapshot,
  fetchErApiSnapshot,
  fetchFrankfurterSnapshot,
  // orchestration + gate
  buildReconciliation,
  evaluateCrossSourceAgreement,
}
