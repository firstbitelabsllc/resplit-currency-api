#!/usr/bin/env node

const { performance } = require('node:perf_hooks')
const { captureIssue, runMonitoredScript } = require('./sentry-monitoring')

const defaultWorkerBase = 'https://fx.resplit.app'
const allowedRecoveryCoverageSignals = new Set([
  'archive_gap_detected',
  'history_range_incomplete',
])
const defaultPublishGraceMinutes = 45
const defaultPublishUtcHours = [0, 3]
// The stable Pages alias briefly served the prior release for 43 seconds after
// a successful upload on 2026-07-12. Post-publish retries use single-attempt,
// five-second requests under one monotonic two-minute deadline; stale primary
// data still hard-fails when that budget or the observation cap is exhausted.
const defaultCloudflarePropagationAttempts = 25
const defaultCloudflarePropagationDelayMs = 5_000
const defaultCloudflarePropagationDeadlineMs = 120_000
const defaultCloudflarePropagationRequestTimeoutMs = 5_000
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
  const verification = await verifyDeployedRelease()
  console.log(
    `smoke-check-deploy: OK (date=${verification.dateToday}, ` +
    `historyPoints=${verification.history.points.length}, cf=${verification.cloudflareBase})`
  )
}

// Shared by the post-publish smoke and the no-op publication guard. Keeping
// this verification in one place means a skip only happens when the same
// deployment contract that normally follows a publish is already true.
async function verifyDeployedRelease({
  env = process.env,
  cloudflareBase = env.CF_PAGES_BASE || 'https://resplit-currency-api.pages.dev',
  fallbackBase = env.GH_PAGES_BASE || 'https://firstbitelabsllc.github.io/resplit-currency-api',
  workerBase = resolveWorkerBase(env),
  requestedDate = env.EXPECTED_DATE || null,
  allowLatestFallback = env.ALLOW_STALE_DEPLOY_SMOKE === '1',
  publishGraceMinutes = parsePositiveInteger(env.PUBLISH_GRACE_MINUTES, defaultPublishGraceMinutes),
  githubFallbackGraceMinutes = parsePositiveInteger(
    env.GH_FALLBACK_GRACE_MINUTES,
    defaultGithubFallbackGraceMinutes
  ),
  postPublish = env.POST_PUBLISH_SMOKE === '1',
  requireFreshGithubFallback = false,
  fetchCloudflareState = fetchCloudflareReleaseState,
  fetchJson,
  captureMissingDatedSnapshotIssue = true,
  captureIssueFn = captureIssue,
  warn = console.warn,
  log = console.log,
  now,
} = {}) {
  const releaseStateOptions = {
    baseUrl: cloudflareBase,
    expectedDate: requestedDate,
    postPublish,
    warn,
  }
  if (fetchJson) {
    releaseStateOptions.fetchJson = fetchJson
  }
  const { latest, history, meta } = await fetchCloudflareState(releaseStateOptions)
  const freshnessOptions = {
    requestedDate,
    latestDate: latest?.date,
    metaLatestDate: meta?.latestDate,
    allowLatestFallback,
    publishGraceMinutes,
  }
  if (now) {
    freshnessOptions.now = now
  }
  const freshnessContract = resolveFreshnessContract({
    ...freshnessOptions,
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
    warn(
      `smoke-check-deploy: WARNING publish window grace accepted ${dateToday}; ` +
      `strict expected ${freshnessContract.strictExpectedDate} until ${freshnessContract.graceEndsAt}`
    )
  }

  const datedSnapshotUrl = `https://${dateToday}.resplit-currency-api.pages.dev/snapshots/base-rates.json`
  let datedSnapshot
  try {
    datedSnapshot = await (fetchJson || fetchJSONWithRetry)(datedSnapshotUrl)
  } catch (error) {
    if (captureMissingDatedSnapshotIssue) {
      await captureIssueFn({
        signal: 'missing_dated_snapshot_deployment',
        error,
        context: {
          workflow: 'daily_publish',
          requested_date: requestedDate,
          expected_date: dateToday,
          url: datedSnapshotUrl
        }
      })
    }
    throw error
  }
  const ghFallbackLatest = await (fetchJson || fetchJSONWithRetry)(`${fallbackBase}/latest/usd.json`)

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
      warn(
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
  if (history.points.at(-1)?.date !== dateToday) {
    throw new Error(
      `cloudflare history latest date expected ${dateToday}, got ${history.points.at(-1)?.date || 'missing'}`
    )
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
  if (requireFreshGithubFallback && ghFallbackLatest.date !== dateToday) {
    throw new Error(`github fallback latest date expected ${dateToday}, got ${ghFallbackLatest.date}`)
  }
  const githubFreshnessOptions = {
    ghFallbackDate: ghFallbackLatest.date,
    expectedDate: dateToday,
    graceMinutes: githubFallbackGraceMinutes,
    postPublish,
  }
  if (now) {
    githubFreshnessOptions.now = now
  }
  const ghFallbackAcceptance = resolveGithubFallbackAcceptance(githubFreshnessOptions)
  if (!ghFallbackAcceptance.accepted) {
    throw new Error(`github fallback latest date expected ${dateToday}, got ${ghFallbackLatest.date}`)
  }
  if (ghFallbackAcceptance.stale) {
    warn(
      `smoke-check-deploy: WARNING github fallback latest date is one day stale ` +
      `(${ghFallbackLatest.date}, expected ${dateToday}) within GitHub Pages propagation grace ` +
      `(until ${ghFallbackAcceptance.graceEndsAt}) — github.io CDN lag behind Cloudflare; ` +
      `self-heals on next publish.`
    )
  }

  let workerHealth = null
  if (workerBase) {
    workerHealth = await smokeCheckWorker(workerBase, dateToday, {
      fetchJson: fetchJson || fetchJSONWithRetry,
    })
  } else {
    log('smoke-check-deploy: skipping worker smoke check (SKIP_WORKER_SMOKE_CHECK=1)')
  }

  return {
    cloudflareBase,
    dateToday,
    datedSnapshot,
    freshnessContract,
    ghFallbackAcceptance,
    ghFallbackLatest,
    history,
    latest,
    meta,
    workerHealth,
  }
}

async function fetchCloudflareReleaseState({
  baseUrl,
  expectedDate,
  postPublish = false,
  attempts = defaultCloudflarePropagationAttempts,
  delayMs = defaultCloudflarePropagationDelayMs,
  deadlineMs = defaultCloudflarePropagationDeadlineMs,
  requestTimeoutMs = defaultCloudflarePropagationRequestTimeoutMs,
  fetchJson,
  wait = sleep,
  now = () => performance.now(),
  warn = console.warn,
} = {}) {
  const normalizedBase = String(baseUrl || '').replace(/\/+$/, '')
  const retryExpectedDate = postPublish && /^\d{4}-\d{2}-\d{2}$/.test(expectedDate || '')
  const boundedAttempts = retryExpectedDate ? parsePositiveInteger(attempts, 1) : 1
  const boundedDeadlineMs = parsePositiveInteger(
    deadlineMs,
    defaultCloudflarePropagationDeadlineMs
  )
  const boundedRequestTimeoutMs = parsePositiveInteger(
    requestTimeoutMs,
    defaultCloudflarePropagationRequestTimeoutMs
  )
  const fetchReleaseJson = fetchJson || (
    retryExpectedDate ? fetchJSONOnce : fetchJSONWithRetry
  )
  const deadlineAt = retryExpectedDate ? now() + boundedDeadlineMs : null
  let latest = null
  let history = null
  let meta = null
  let lastFetchError = null

  const deadlineError = () => new Error(
    `cloudflare post-publish propagation deadline exceeded after ${boundedDeadlineMs}ms ` +
    `(expected=${expectedDate}, latest=${latest?.date || 'missing'}, ` +
    `history=${Array.isArray(history?.points) ? history.points.at(-1)?.date || 'missing' : 'missing'}, ` +
    `meta=${meta?.latestDate || 'missing'}${lastFetchError ? `, transport=${lastFetchError.message}` : ''})`
  )

  for (let attempt = 1; attempt <= boundedAttempts; attempt += 1) {
    if (retryExpectedDate && now() >= deadlineAt) {
      throw deadlineError()
    }

    const remainingMs = retryExpectedDate ? Math.max(1, deadlineAt - now()) : null
    const effectiveRequestTimeoutMs = retryExpectedDate
      ? Math.max(1, Math.ceil(Math.min(boundedRequestTimeoutMs, remainingMs)))
      : boundedRequestTimeoutMs
    const fetchRelease = (url) => retryExpectedDate
      ? fetchReleaseJson(url, { timeoutMs: effectiveRequestTimeoutMs })
      : fetchReleaseJson(url)
    const requests = await Promise.allSettled([
      fetchRelease(`${normalizedBase}/latest/usd.json`),
      fetchRelease(`${normalizedBase}/history/30d/usd.json`),
      fetchRelease(`${normalizedBase}/meta.json`),
    ])
    const rejected = requests.find((request) => request.status === 'rejected')
    if (rejected) {
      lastFetchError = rejected.reason instanceof Error
        ? rejected.reason
        : new Error(String(rejected.reason))
      if (!retryExpectedDate) {
        throw lastFetchError
      }
      if (attempt >= boundedAttempts || now() >= deadlineAt) {
        throw deadlineError()
      }
      const remainingDelayMs = deadlineAt - now()
      const retryDelayMs = Math.min(delayMs, remainingDelayMs)
      warn(
        `smoke-check-deploy: retrying Cloudflare Pages transport ` +
        `(attempt=${attempt}/${boundedAttempts}, expected=${expectedDate}, ` +
        `remainingMs=${Math.max(0, Math.ceil(remainingDelayMs))}, error=${lastFetchError.message})`
      )
      await wait(retryDelayMs)
      continue
    }

    if (retryExpectedDate && now() >= deadlineAt) {
      throw deadlineError()
    }

    lastFetchError = null
    const observed = requests.map((request) => request.value)
    latest = observed[0]
    history = observed[1]
    meta = observed[2]
    const historyLatestDate = Array.isArray(history?.points)
      ? history.points.at(-1)?.date
      : null

    if (
      !retryExpectedDate ||
      (
        latest?.date === expectedDate &&
        meta?.latestDate === expectedDate &&
        historyLatestDate === expectedDate
      )
    ) {
      return { latest, history, meta }
    }

    const previousDate = dateDaysBeforeUTC(expectedDate, 1)
    const observedDates = [latest?.date, historyLatestDate, meta?.latestDate]
    const propagationPending =
      observedDates.every((date) => date === expectedDate || date === previousDate) &&
      observedDates.some((date) => date === previousDate)
    if (!propagationPending) {
      return { latest, history, meta }
    }

    if (attempt < boundedAttempts && now() < deadlineAt) {
      const remainingDelayMs = deadlineAt - now()
      const retryDelayMs = Math.min(delayMs, remainingDelayMs)
      warn(
        `smoke-check-deploy: waiting for Cloudflare Pages propagation ` +
        `(attempt=${attempt}/${boundedAttempts}, expected=${expectedDate}, ` +
        `latest=${latest?.date || 'missing'}, history=${historyLatestDate || 'missing'}, ` +
        `meta=${meta?.latestDate || 'missing'})`
      )
      await wait(retryDelayMs)
    }
  }

  if (retryExpectedDate && now() >= deadlineAt) {
    throw deadlineError()
  }

  throw new Error(
    `cloudflare latest date expected ${expectedDate}, got ${latest?.date || 'missing'} ` +
    `after ${boundedAttempts} post-publish propagation attempts ` +
    `(history latestDate ${Array.isArray(history?.points) ? history.points.at(-1)?.date || 'missing' : 'missing'}, ` +
    `meta latestDate ${meta?.latestDate || 'missing'})`
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

  return health
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
      return await fetchJSONOnce(url)
    } catch (error) {
      lastError = error
      if (index < attempts - 1) {
        await sleep(delayMs)
      }
    }
  }

  throw new Error(`Failed to fetch ${url}: ${lastError?.message || 'unknown error'}`)
}

async function fetchJSONOnce(url, { timeoutMs = 15_000 } = {}) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(parsePositiveInteger(timeoutMs, 15_000)),
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  return await response.json()
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
  defaultCloudflarePropagationAttempts,
  defaultCloudflarePropagationDelayMs,
  defaultCloudflarePropagationDeadlineMs,
  defaultCloudflarePropagationRequestTimeoutMs,
  defaultWorkerBase,
  defaultPublishGraceMinutes,
  defaultGithubFallbackGraceMinutes,
  fetchJSONWithRetry,
  fetchCloudflareReleaseState,
  isRecoveryCoverageGap,
  isStaticRecoveryHistoryGap,
  main,
  verifyDeployedRelease,
  resolveExpectedDate,
  resolveFreshnessContract,
  resolveGithubFallbackAcceptance,
  resolvePublishGraceWindow,
  resolveWorkerBase,
  smokeCheckWorker,
}
