#!/usr/bin/env node

const { captureIssue, runMonitoredScript } = require('./sentry-monitoring')

const defaultWorkerBase = 'https://fx.resplit.app'
const allowedRecoveryCoverageSignals = new Set([
  'archive_gap_detected',
  'history_range_incomplete',
])
const defaultPublishGraceMinutes = 45
const defaultPublishUtcHours = [0, 3]
// GitHub Pages CDN propagation lags Cloudflare after each publish, so the
// github.io fallback can still serve yesterday's snapshot for a while after the
// primary (Cloudflare) is already fresh. Accept a one-day-stale fallback only
// within this wider grace window after each publish hour; strict otherwise.
const defaultGithubFallbackGraceMinutes = 120

if (require.main === module) {
  runMonitoredScript('smoke_check_deploy', main, {
    workflow: 'daily_publish',
    failureSignal: 'smoke_check_mismatch'
  }).catch((error) => {
    console.error(`smoke-check-deploy: FAILED\n${error.stack || error.message}`)
    process.exitCode = 1
  })
}

async function main() {
  const cloudflareBase = process.env.CF_PAGES_BASE || 'https://resplit-currency-api.pages.dev'
  const fallbackBase = process.env.GH_PAGES_BASE || 'https://firstbitelabsllc.github.io/resplit-currency-api'
  const workerBase = resolveWorkerBase()
  const requestedDate = process.env.EXPECTED_DATE || null
  const allowLatestFallback = process.env.ALLOW_STALE_DEPLOY_SMOKE === '1'
  const publishGraceMinutes = parsePositiveInteger(
    process.env.PUBLISH_GRACE_MINUTES,
    defaultPublishGraceMinutes
  )
  const githubFallbackGraceMinutes = parsePositiveInteger(
    process.env.GH_FALLBACK_GRACE_MINUTES,
    defaultGithubFallbackGraceMinutes
  )
  const latest = await fetchJSONWithRetry(`${cloudflareBase}/latest/usd.json`)
  const history = await fetchJSONWithRetry(`${cloudflareBase}/history/30d/usd.json`)
  const meta = await fetchJSONWithRetry(`${cloudflareBase}/meta.json`)
  const freshnessContract = resolveFreshnessContract({
    requestedDate,
    latestDate: latest?.date,
    metaLatestDate: meta?.latestDate,
    allowLatestFallback,
    publishGraceMinutes,
  })
  const dateToday = freshnessContract.expectedDate

  assertISODate(latest.date, 'cloudflare latest date')
  assertISODate(meta.latestDate, 'cloudflare meta latestDate')
  if (latest.date !== dateToday) {
    throw new Error(`cloudflare latest date expected ${dateToday}, got ${latest.date}`)
  }
  if (meta.latestDate !== dateToday) {
    throw new Error(`cloudflare meta latestDate expected ${dateToday}, got ${meta.latestDate}`)
  }
  if (freshnessContract.mode === 'publish_grace') {
    console.warn(
      `smoke-check-deploy: WARNING publish window grace accepted ${dateToday}; ` +
      `strict expected ${freshnessContract.strictExpectedDate} until ${freshnessContract.graceEndsAt}`
    )
  }

  const datedSnapshotUrl = `https://${dateToday}.resplit-currency-api.pages.dev/snapshots/base-rates.json`
  let datedSnapshot
  try {
    datedSnapshot = await fetchJSONWithRetry(datedSnapshotUrl)
  } catch (error) {
    await captureIssue({
      signal: 'missing_dated_snapshot_deployment',
      error,
      context: {
        workflow: 'daily_publish',
        requested_date: requestedDate,
        expected_date: dateToday,
        url: datedSnapshotUrl
      }
    })
    throw error
  }
  const ghFallbackLatest = await fetchJSONWithRetry(`${fallbackBase}/latest/usd.json`)

  assertISODate(datedSnapshot.date, 'dated snapshot date')
  assertISODate(ghFallbackLatest.date, 'github fallback latest date')

  assertPositive(latest?.rates?.usd, 'cloudflare latest usd->usd')
  assertPositive(ghFallbackLatest?.rates?.usd, 'github fallback latest usd->usd')
  assertPositive(datedSnapshot?.rates?.usd, 'dated snapshot usd base rate')

  if (!Array.isArray(history.points)) {
    throw new Error(`cloudflare history points expected 30, got ${typeof history.points}`)
  }
  if (history.points.length !== 30) {
    const staticHistoryRecoveryGap = isStaticRecoveryHistoryGap({
      history,
      meta,
      dateToday,
      expectedDays: 30,
    })
    if (staticHistoryRecoveryGap) {
      console.warn(
        `smoke-check-deploy: WARNING cloudflare static history has recovery archive gaps ` +
        `(historyPoints=${history.points.length}/30, ` +
        `archiveGapCount=${meta.archiveGapCount}, latestDate=${meta.latestDate})`
      )
    } else {
      throw new Error(
        `cloudflare history points expected 30, got ${
          Array.isArray(history.points) ? history.points.length : typeof history.points
        }`
      )
    }
  }
  for (const point of history.points) {
    assertISODate(point.date, 'cloudflare history point date')
    assertPositive(point?.rates?.usd, `cloudflare history usd->usd at ${point.date}`)
  }

  if (meta.historyDays !== 30) {
    throw new Error(`cloudflare meta historyDays expected 30, got ${meta.historyDays}`)
  }

  if (latest.date !== meta.latestDate) {
    throw new Error(`cloudflare latest date (${latest.date}) != meta latestDate (${meta.latestDate})`)
  }

  if (datedSnapshot.date !== dateToday) {
    throw new Error(`dated deployment date mismatch: expected ${dateToday}, got ${datedSnapshot.date}`)
  }
  const ghFallbackAcceptance = resolveGithubFallbackAcceptance({
    ghFallbackDate: ghFallbackLatest.date,
    expectedDate: dateToday,
    graceMinutes: githubFallbackGraceMinutes,
    postPublish: process.env.POST_PUBLISH_SMOKE === '1',
  })
  if (!ghFallbackAcceptance.accepted) {
    throw new Error(`github fallback latest date expected ${dateToday}, got ${ghFallbackLatest.date}`)
  }
  if (ghFallbackAcceptance.stale) {
    console.warn(
      `smoke-check-deploy: WARNING github fallback latest date is one day stale ` +
      `(${ghFallbackLatest.date}, expected ${dateToday}) within GitHub Pages propagation grace ` +
      `(until ${ghFallbackAcceptance.graceEndsAt}) — github.io CDN lag behind Cloudflare; ` +
      `self-heals on next publish.`
    )
  }

  if (workerBase) {
    await smokeCheckWorker(workerBase, dateToday)
  } else {
    console.log('smoke-check-deploy: skipping worker smoke check (SKIP_WORKER_SMOKE_CHECK=1)')
  }

  console.log(
    `smoke-check-deploy: OK (date=${dateToday}, historyPoints=${history.points.length}, cf=${cloudflareBase})`
  )
}

function resolveWorkerBase(env = process.env) {
  if (env.SKIP_WORKER_SMOKE_CHECK === '1') {
    return null
  }
  return (env.FX_WORKER_BASE_URL || defaultWorkerBase).replace(/\/+$/, '')
}

function resolveExpectedDate({
  requestedDate,
  latestDate,
  metaLatestDate,
  allowLatestFallback = false,
  now = new Date()
}) {
  return resolveFreshnessContract({
    requestedDate,
    latestDate,
    metaLatestDate,
    allowLatestFallback,
    now,
  }).expectedDate
}

function resolveFreshnessContract({
  requestedDate,
  latestDate,
  metaLatestDate,
  allowLatestFallback = false,
  now = new Date(),
  publishGraceMinutes = defaultPublishGraceMinutes,
  publishUtcHours = defaultPublishUtcHours,
} = {}) {
  if (requestedDate) {
    return {
      mode: 'requested',
      expectedDate: requestedDate,
      strictExpectedDate: requestedDate,
      graceEndsAt: null,
    }
  }

  if (allowLatestFallback && metaLatestDate) {
    return {
      mode: 'latest_fallback',
      expectedDate: metaLatestDate,
      strictExpectedDate: toDateStringUTC(now),
      graceEndsAt: null,
    }
  }

  if (allowLatestFallback && latestDate) {
    return {
      mode: 'latest_fallback',
      expectedDate: latestDate,
      strictExpectedDate: toDateStringUTC(now),
      graceEndsAt: null,
    }
  }

  const strictExpectedDate = toDateStringUTC(now)
  const servedDate = metaLatestDate || latestDate || null
  const graceWindow = resolvePublishGraceWindow(now, publishUtcHours, publishGraceMinutes)
  if (
    servedDate &&
    servedDate !== strictExpectedDate &&
    servedDate === dateDaysBeforeUTC(strictExpectedDate, 1) &&
    graceWindow.active
  ) {
    return {
      mode: 'publish_grace',
      expectedDate: servedDate,
      strictExpectedDate,
      graceEndsAt: graceWindow.endsAt,
    }
  }

  return {
    mode: 'strict',
    expectedDate: strictExpectedDate,
    strictExpectedDate,
    graceEndsAt: null,
  }
}

function resolvePublishGraceWindow(now, publishUtcHours, publishGraceMinutes) {
  const nowTime = now.getTime()
  const windows = publishUtcHours
    .filter(hour => Number.isInteger(hour) && hour >= 0 && hour <= 23)
    .map(hour => {
      const start = new Date(now)
      start.setUTCHours(hour, 0, 0, 0)
      if (start.getTime() > nowTime) {
        start.setUTCDate(start.getUTCDate() - 1)
      }
      const end = new Date(start.getTime() + publishGraceMinutes * 60_000)
      return { start, end }
    })
    .sort((a, b) => b.start.getTime() - a.start.getTime())

  const active = windows.find(window => nowTime >= window.start.getTime() && nowTime <= window.end.getTime())
  return active
    ? { active: true, startsAt: active.start.toISOString(), endsAt: active.end.toISOString() }
    : { active: false, startsAt: windows[0]?.start.toISOString() || null, endsAt: windows[0]?.end.toISOString() || null }
}

// The github.io fallback CDN propagates more slowly than Cloudflare, so right
// after a publish it can still serve the previous day's snapshot while the
// primary is already fresh. Tolerate a one-day-stale fallback ONLY within a
// propagation grace window after each publish hour; everything else is strict
// (a fallback that is >1 day stale, or stale outside the window, is a real
// failure). This stops the ~03:36Z scheduled run from red-flapping on a CDN
// propagation race that self-heals on the next publish.
function resolveGithubFallbackAcceptance({
  ghFallbackDate,
  expectedDate,
  now = new Date(),
  graceMinutes = defaultGithubFallbackGraceMinutes,
  publishUtcHours = defaultPublishUtcHours,
  postPublish = false,
} = {}) {
  if (ghFallbackDate === expectedDate) {
    return { accepted: true, stale: false, reason: 'fresh', graceEndsAt: null }
  }
  if (ghFallbackDate !== dateDaysBeforeUTC(expectedDate, 1)) {
    return { accepted: false, stale: true, reason: 'not_one_day_stale', graceEndsAt: null }
  }
  // When this check runs as the post-deploy step of the SAME workflow run that
  // just pushed gh-pages (POST_PUBLISH_SMOKE=1), a one-day-stale github.io is
  // by construction CDN propagation: the previous publish worked and ours is
  // seconds old. No wall-clock window can model that — GitHub delays the
  // 00:00Z schedule by hours (observed 02:58Z and 06:39Z), so every fixed
  // window leaves dead zones that red-flap the cron (36 failures / 52 days).
  // A genuinely broken fallback pipeline still hard-fails above (>1 day stale).
  if (postPublish) {
    return { accepted: true, stale: true, reason: 'post_publish_propagation', graceEndsAt: null }
  }
  const graceWindow = resolvePublishGraceWindow(now, publishUtcHours, graceMinutes)
  if (graceWindow.active) {
    return { accepted: true, stale: true, reason: 'propagation_grace', graceEndsAt: graceWindow.endsAt }
  }
  return { accepted: false, stale: true, reason: 'propagation_grace_expired', graceEndsAt: null }
}

async function smokeCheckWorker(baseUrl, dateToday, { fetchJson = fetchJSONWithRetry } = {}) {
  const normalizedBase = baseUrl.replace(/\/+$/, '')
  const historyStart = dateDaysBeforeUTC(dateToday, 2)
  const health = await fetchJson(`${normalizedBase}/health`)
  assertWorkerHealth(health, normalizedBase)

  const quote = await fetchJson(
    `${normalizedBase}/quote?from=AED&to=USD&date=${dateToday}`
  )
  const history = await fetchJson(
    `${normalizedBase}/history?from=AED&to=USD&start=${historyStart}&end=${dateToday}`
  )
  const coverage = await fetchJson(
    `${normalizedBase}/coverage?from=AED&to=USD&anchorDate=${dateToday}&days=30`
  )

  if (quote.from !== 'AED' || quote.to !== 'USD' || quote.requestedDate !== dateToday) {
    throw new Error(`worker quote shape mismatch for ${normalizedBase}`)
  }
  assertISODate(quote.resolvedDate, 'worker quote resolvedDate')
  assertPositive(quote.rate, 'worker quote rate')

  if (!Array.isArray(history.points) || history.points.length < 1) {
    throw new Error(`worker history has no points for ${normalizedBase}`)
  }
  for (const point of history.points) {
    assertISODate(point.date, 'worker history point date')
    assertPositive(point.rate, `worker history rate at ${point.date}`)
  }

  if (!coverage?.quote || !coverage?.historyCoverage) {
    throw new Error(`worker coverage shape mismatch for ${normalizedBase}`)
  }
  if (coverage.quote.resolutionKind !== 'exact') {
    throw new Error(`worker coverage quote degraded for ${normalizedBase}`)
  }
  const coverageSignals = Array.isArray(coverage.signals) ? coverage.signals : null
  if (!coverageSignals) {
    throw new Error(`worker coverage signals missing for ${normalizedBase}`)
  }
  const hasCoverageGaps = coverage.historyCoverage.requestedDays !== coverage.historyCoverage.availableDays ||
    coverage.historyCoverage.missingDayCount !== 0 ||
    coverageSignals.length > 0 ||
    coverage.mismatchCount !== 0

  if (hasCoverageGaps && !isRecoveryCoverageGap(coverage, dateToday)) {
    throw new Error(`worker coverage signals present for ${normalizedBase}: ${coverageSignals.join(', ')}`)
  }
  if (hasCoverageGaps) {
    console.warn(
      `smoke-check-deploy: WARNING worker coverage has recovery archive gaps ` +
      `(availableDays=${coverage.historyCoverage.availableDays}/${coverage.historyCoverage.requestedDays}, ` +
      `missingDayCount=${coverage.historyCoverage.missingDayCount}, signals=${coverageSignals.join(',')})`
    )
  }
}

function assertWorkerHealth(health, normalizedBase) {
  if (health?.ok !== true || health?.service !== 'resplit-currency-api') {
    throw new Error(`worker health shape mismatch for ${normalizedBase}`)
  }
  if (typeof health.environment !== 'string' || health.environment.trim() === '' || health.environment === 'unknown') {
    throw new Error(`worker health environment missing for ${normalizedBase}`)
  }
  if (typeof health.release !== 'string' || health.release.trim() === '' || health.release === 'unknown') {
    throw new Error(`worker health release missing for ${normalizedBase}`)
  }
  if (typeof health.timestamp !== 'string' || Number.isNaN(Date.parse(health.timestamp))) {
    throw new Error(`worker health timestamp invalid for ${normalizedBase}`)
  }
}

function isRecoveryCoverageGap(coverage, dateToday) {
  const signals = Array.isArray(coverage.signals) ? coverage.signals : []
  if (signals.some((signal) => !allowedRecoveryCoverageSignals.has(signal))) {
    return false
  }
  if (!coverage.historyCoverage || coverage.historyCoverage.archiveLatestDate !== dateToday) {
    return false
  }
  if (coverage?.freshness?.quoteResolvedLagDays !== 0 || coverage?.freshness?.archiveLatestLagDays !== 0) {
    return false
  }
  if (coverage?.freshness?.staleAgainstAnchor === true) {
    return false
  }
  return coverage.quote?.resolutionKind === 'exact'
}

function isStaticRecoveryHistoryGap({ history, meta, dateToday, expectedDays = 30 } = {}) {
  if (!Array.isArray(history?.points) || history.points.length < 1 || history.points.length >= expectedDays) {
    return false
  }
  if (meta?.latestDate !== dateToday || meta?.archiveLatestDate !== dateToday) {
    return false
  }
  if (!Number.isInteger(meta?.archiveGapCount) || meta.archiveGapCount <= 0) {
    return false
  }
  if (!Array.isArray(meta.availableHistoryDates)) {
    return false
  }

  const availableHistoryDates = new Set(meta.availableHistoryDates)
  if (!availableHistoryDates.has(dateToday)) {
    return false
  }

  const expectedDates = []
  for (let daysAgo = expectedDays - 1; daysAgo >= 0; daysAgo -= 1) {
    expectedDates.push(dateDaysBeforeUTC(dateToday, daysAgo))
  }
  const missingDates = expectedDates.filter(date => !availableHistoryDates.has(date))
  if (missingDates.length === 0 || missingDates.length !== expectedDays - history.points.length) {
    return false
  }

  const expectedAvailableDates = expectedDates.filter(date => availableHistoryDates.has(date))
  const historyPointDates = history.points.map(point => point.date)
  if (historyPointDates.length !== expectedAvailableDates.length) {
    return false
  }

  return historyPointDates.every((date, index) => date === expectedAvailableDates[index])
}

async function fetchJSONWithRetry(url, attempts = 8, delayMs = 3_000) {
  let lastError = null

  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      return await response.json()
    } catch (error) {
      lastError = error
      if (index < attempts - 1) {
        await sleep(delayMs)
      }
    }
  }

  throw new Error(`Failed to fetch ${url}: ${lastError?.message || 'unknown error'}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function assertISODate(value, fieldName) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid ${fieldName}: ${value}`)
  }
}

function assertPositive(value, fieldName) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid positive number for ${fieldName}: ${value}`)
  }
}

function toDateStringUTC(date) {
  return date.toISOString().slice(0, 10)
}

function dateDaysBeforeUTC(anchorDate, daysAgo) {
  const date = new Date(`${anchorDate}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - daysAgo)
  return toDateStringUTC(date)
}

function parsePositiveInteger(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback
  }
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

module.exports = {
  defaultWorkerBase,
  defaultPublishGraceMinutes,
  defaultGithubFallbackGraceMinutes,
  fetchJSONWithRetry,
  isRecoveryCoverageGap,
  isStaticRecoveryHistoryGap,
  main,
  resolveExpectedDate,
  resolveFreshnessContract,
  resolveGithubFallbackAcceptance,
  resolvePublishGraceWindow,
  resolveWorkerBase,
  smokeCheckWorker,
}
