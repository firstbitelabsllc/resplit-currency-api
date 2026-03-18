const DEFAULT_ASSET_BASE_URL = 'https://resplit-currency-api.pages.dev'

/**
 * @typedef {typeof fetch} FetchLike
 */

/**
 * @typedef {{
 *   generatedAt: string
 *   base: string
 *   earliestDate: string | null
 *   latestDate: string | null
 *   availableDates: string[]
 *   gapCount: number
 *   supportedCurrencies: string[]
 * }} ArchiveManifest
 */

/**
 * @typedef {{
 *   date: string
 *   base: string
 *   rates: Record<string, number>
 * }} ArchiveSnapshot
 */

/**
 * @typedef {{
 *   year: string
 *   base: string
 *   snapshots: ArchiveSnapshot[]
 * }} ArchiveYear
 */

/**
 * @typedef {{
 *   date: string
 *   from: string
 *   rates: Record<string, number>
 * }} LatestPayload
 */

/**
 * @typedef {{
 *   from: string
 *   to: string
 *   requestedDate: string
 *   resolvedDate: string
 *   rate: number
 *   resolutionKind: 'exact' | 'prior_day_fallback' | 'today_fallback'
 *   warning: string | null
 * }} FxQuoteResponse
 */

/**
 * @typedef {{
 *   date: string
 *   rate: number
 * }} FxHistoryPoint
 */

/**
 * @typedef {{
 *   from: string
 *   to: string
 *   start: string
 *   end: string
 *   points: FxHistoryPoint[]
 *   coverage: {
 *     requestedDays: number
 *     availableDays: number
 *     missingDayCount: number
 *     returnedRange: {
 *       start: string | null
 *       end: string | null
 *     }
 *     archiveLatestDate: string | null
 *     archiveGapCount: number
 *   }
 * }} FxHistoryResponse
 */

/**
 * @param {{
 *   from: string
 *   to: string
 *   date: string
 *   fetchImpl?: FetchLike
 *   baseUrl?: string
 * }} options
 * @returns {Promise<FxQuoteResponse>}
 */
export async function buildFxQuoteResponse({
  from,
  to,
  date,
  fetchImpl = fetch,
  baseUrl = DEFAULT_ASSET_BASE_URL,
}) {
  const fromCode = normalizeCurrencyCode(from)
  const toCode = normalizeCurrencyCode(to)
  const requestedDate = normalizeDate(date)
  const todayDate = todayDateString()

  if (fromCode === toCode) {
    return {
      from: fromCode,
      to: toCode,
      requestedDate,
      resolvedDate: requestedDate,
      rate: 1,
      resolutionKind: 'exact',
      warning: null,
    }
  }

  if (requestedDate === todayDate) {
    const latestQuote = await fetchLatestQuoteResponse({
      from: fromCode,
      to: toCode,
      requestedDate,
      fetchImpl,
      baseUrl,
    })
    if (latestQuote) {
      return latestQuote
    }
  }

  /** @type {ArchiveManifest | null} */
  let manifest = null
  try {
    manifest = await fetchJson(`${baseUrl}/archive-manifest.min.json`, fetchImpl)
  } catch (manifestError) {
    const latestQuote = await fetchLatestQuoteResponse({
      from: fromCode,
      to: toCode,
      requestedDate,
      fetchImpl,
      baseUrl,
    })
    if (latestQuote) {
      return latestQuote
    }
    throw manifestError
  }

  const historicalQuote = await fetchHistoricalQuoteResponse({
    manifest,
    from: fromCode,
    to: toCode,
    requestedDate,
    fetchImpl,
    baseUrl,
  })
  if (historicalQuote) {
    return historicalQuote
  }

  const latestQuote = await fetchLatestQuoteResponse({
    from: fromCode,
    to: toCode,
    requestedDate,
    fetchImpl,
    baseUrl,
  })
  if (latestQuote) {
    return latestQuote
  }

  throw new Error(`Latest quote unavailable for ${fromCode}->${toCode}`)
}

/**
 * @param {{
 *   from: string
 *   to: string
 *   start: string
 *   end: string
 *   fetchImpl?: FetchLike
 *   baseUrl?: string
 * }} options
 * @returns {Promise<FxHistoryResponse>}
 */
export async function buildFxHistoryResponse({
  from,
  to,
  start,
  end,
  fetchImpl = fetch,
  baseUrl = DEFAULT_ASSET_BASE_URL,
}) {
  const fromCode = normalizeCurrencyCode(from)
  const toCode = normalizeCurrencyCode(to)
  const normalizedStart = normalizeDate(start)
  const normalizedEnd = normalizeDate(end)

  if (normalizedStart > normalizedEnd) {
    throw new Error(`Invalid date range: ${normalizedStart} > ${normalizedEnd}`)
  }

  if (fromCode === toCode) {
    const dates = enumerateDates(normalizedStart, normalizedEnd)
    return {
      from: fromCode,
      to: toCode,
      start: normalizedStart,
      end: normalizedEnd,
      points: dates.map(dateValue => ({ date: dateValue, rate: 1 })),
      coverage: {
        requestedDays: dates.length,
        availableDays: dates.length,
        missingDayCount: 0,
        returnedRange: {
          start: dates[0] ?? null,
          end: dates[dates.length - 1] ?? null,
        },
        archiveLatestDate: normalizedEnd,
        archiveGapCount: 0,
      },
    }
  }

  const manifest = await fetchJson(`${baseUrl}/archive-manifest.min.json`, fetchImpl)
  const requestedDates = enumerateDates(normalizedStart, normalizedEnd)
  const availableDates = manifest.availableDates.filter(
    dateValue => dateValue >= normalizedStart && dateValue <= normalizedEnd
  )
  const years = [...new Set(availableDates.map(dateValue => dateValue.slice(0, 4)))]
  const yearPayloads = await Promise.all(
    years.map(year => fetchJson(`${baseUrl}/archive-years/${year}.min.json`, fetchImpl))
  )

  /** @type {Map<string, ArchiveSnapshot>} */
  const snapshotsByDate = new Map()
  for (const payload of yearPayloads) {
    for (const snapshot of payload.snapshots) {
      snapshotsByDate.set(snapshot.date, snapshot)
    }
  }

  const points = availableDates.flatMap(dateValue => {
    const snapshot = snapshotsByDate.get(dateValue)
    if (!snapshot) return []
    const rate = computeCrossRate(snapshot.rates, fromCode, toCode)
    if (!rate) return []
    return [{ date: dateValue, rate }]
  })

  return {
    from: fromCode,
    to: toCode,
    start: normalizedStart,
    end: normalizedEnd,
    points,
    coverage: {
      requestedDays: requestedDates.length,
      availableDays: points.length,
      missingDayCount: Math.max(requestedDates.length - points.length, 0),
      returnedRange: {
        start: points[0]?.date ?? null,
        end: points[points.length - 1]?.date ?? null,
      },
      archiveLatestDate: manifest.latestDate,
      archiveGapCount: computeRangeGapCount(availableDates),
    },
  }
}

/**
 * @param {{
 *   manifest: ArchiveManifest
 *   from: string
 *   to: string
 *   requestedDate: string
 *   fetchImpl: FetchLike
 *   baseUrl: string
 * }} options
 * @returns {Promise<FxQuoteResponse | null>}
 */
async function fetchHistoricalQuoteResponse({
  manifest,
  from,
  to,
  requestedDate,
  fetchImpl,
  baseUrl,
}) {
  const candidateDates = [...manifest.availableDates]
    .filter(dateValue => dateValue <= requestedDate)
    .sort((lhs, rhs) => rhs.localeCompare(lhs))

  /** @type {Map<string, Map<string, ArchiveSnapshot>>} */
  const yearSnapshotCache = new Map()

  for (const historicalResolvedDate of candidateDates) {
    const year = historicalResolvedDate.slice(0, 4)
    let snapshotsByDate = yearSnapshotCache.get(year)
    if (!snapshotsByDate) {
      /** @type {ArchiveYear} */
      const yearPayload = await fetchJson(`${baseUrl}/archive-years/${year}.min.json`, fetchImpl)
      snapshotsByDate = new Map(
        yearPayload.snapshots.map(snapshot => [snapshot.date, snapshot])
      )
      yearSnapshotCache.set(year, snapshotsByDate)
    }

    const snapshot = snapshotsByDate.get(historicalResolvedDate)
    if (!snapshot) continue

    const historicalRate = computeCrossRate(snapshot.rates, from, to)
    if (historicalRate === null) continue

    const resolutionKind =
      historicalResolvedDate === requestedDate ? 'exact' : 'prior_day_fallback'
    return {
      from,
      to,
      requestedDate,
      resolvedDate: historicalResolvedDate,
      rate: historicalRate,
      resolutionKind,
      warning:
        resolutionKind === 'prior_day_fallback'
          ? `Using ${historicalResolvedDate} rate for ${requestedDate}.`
          : null,
    }
  }

  return null
}

/**
 * @param {{
 *   from: string
 *   to: string
 *   requestedDate: string
 *   fetchImpl: FetchLike
 *   baseUrl: string
 * }} options
 * @returns {Promise<FxQuoteResponse | null>}
 */
async function fetchLatestQuoteResponse({
  from,
  to,
  requestedDate,
  fetchImpl,
  baseUrl,
}) {
  try {
    /** @type {LatestPayload} */
    const latestPayload = await fetchJson(`${baseUrl}/latest/${from.toLowerCase()}.json`, fetchImpl)
    const latestRate = latestPayload.rates[to.toLowerCase()]
    if (typeof latestRate !== 'number' || !Number.isFinite(latestRate) || latestRate <= 0) {
      return null
    }

    const resolvedDate = normalizeDate(latestPayload.date)
    const resolutionKind =
      resolvedDate === requestedDate
        ? 'exact'
        : requestedDate === todayDateString()
          ? 'prior_day_fallback'
          : 'today_fallback'

    return {
      from,
      to,
      requestedDate,
      resolvedDate,
      rate: latestRate,
      resolutionKind,
      warning: buildLatestWarning(requestedDate, resolvedDate, resolutionKind),
    }
  } catch {
    return null
  }
}

/**
 * @template T
 * @param {string} url
 * @param {FetchLike} fetchImpl
 * @returns {Promise<T>}
 */
async function fetchJson(url, fetchImpl) {
  const response = await fetchImpl(url, {
    method: 'GET',
    cache: 'no-store',
  })

  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${url}`)
  }

  return /** @type {Promise<T>} */ (response.json())
}

/**
 * @param {Record<string, number>} rates
 * @param {string} from
 * @param {string} to
 * @returns {number | null}
 */
function computeCrossRate(rates, from, to) {
  const fromKey = from.toLowerCase()
  const toKey = to.toLowerCase()

  if (fromKey === toKey) return 1
  if (fromKey === 'eur') {
    const rate = rates[toKey]
    return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : null
  }
  if (toKey === 'eur') {
    const rate = rates[fromKey]
    return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? 1 / rate : null
  }

  const fromRate = rates[fromKey]
  const toRate = rates[toKey]
  if (typeof fromRate !== 'number' || !Number.isFinite(fromRate) || fromRate <= 0) return null
  if (typeof toRate !== 'number' || !Number.isFinite(toRate) || toRate <= 0) return null
  return toRate / fromRate
}

/**
 * @param {string} start
 * @param {string} end
 * @returns {string[]}
 */
function enumerateDates(start, end) {
  const dates = []
  let cursor = new Date(`${start}T00:00:00Z`)
  const endDate = new Date(`${end}T00:00:00Z`)

  while (cursor <= endDate) {
    dates.push(cursor.toISOString().slice(0, 10))
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000)
  }

  return dates
}

/**
 * @param {string} value
 * @returns {string}
 */
function normalizeCurrencyCode(value) {
  const normalized = value.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new Error(`Invalid currency code: ${value}`)
  }
  return normalized
}

/**
 * @param {string} value
 * @returns {string}
 */
function normalizeDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid date: ${value}`)
  }
  return value
}

/**
 * @returns {string}
 */
function todayDateString() {
  return new Date().toISOString().slice(0, 10)
}

/**
 * @param {string} requestedDate
 * @param {string} resolvedDate
 * @param {FxQuoteResponse['resolutionKind']} resolutionKind
 * @returns {string | null}
 */
function buildLatestWarning(requestedDate, resolvedDate, resolutionKind) {
  switch (resolutionKind) {
  case 'exact':
    return null
  case 'prior_day_fallback':
    return `Using latest available rate (${resolvedDate}) for ${requestedDate}.`
  case 'today_fallback':
    return `Using today’s rate (${resolvedDate}) because ${requestedDate} is unavailable.`
  }
}

/**
 * @param {string[]} availableDates
 * @returns {number}
 */
function computeRangeGapCount(availableDates) {
  const sortedDates = [...availableDates].sort((lhs, rhs) => lhs.localeCompare(rhs))
  let gapCount = 0

  for (let index = 1; index < sortedDates.length; index += 1) {
    const previous = sortedDates[index - 1]
    const current = sortedDates[index]
    if (!previous || !current) continue
    const previousDate = new Date(`${previous}T00:00:00Z`)
    const currentDate = new Date(`${current}T00:00:00Z`)
    const diffDays = Math.round((currentDate.getTime() - previousDate.getTime()) / 86_400_000)
    if (diffDays > 1) {
      gapCount += diffDays - 1
    }
  }

  return gapCount
}
