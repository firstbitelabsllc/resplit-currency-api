#!/usr/bin/env node

const { captureIssue, runMonitoredScript } = require('./sentry-monitoring')

const defaultWorkerBase = 'https://fx.resplit.app'

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
  const latest = await fetchJSONWithRetry(`${cloudflareBase}/latest/usd.json`)
  const history = await fetchJSONWithRetry(`${cloudflareBase}/history/30d/usd.json`)
  const meta = await fetchJSONWithRetry(`${cloudflareBase}/meta.json`)
  const dateToday = resolveExpectedDate({
    requestedDate,
    latestDate: latest?.date,
    metaLatestDate: meta?.latestDate,
  })
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

  assertISODate(latest.date, 'cloudflare latest date')
  assertISODate(meta.latestDate, 'cloudflare meta latestDate')
  assertISODate(datedSnapshot.date, 'dated snapshot date')
  assertISODate(ghFallbackLatest.date, 'github fallback latest date')

  assertPositive(latest?.rates?.usd, 'cloudflare latest usd->usd')
  assertPositive(ghFallbackLatest?.rates?.usd, 'github fallback latest usd->usd')
  assertPositive(datedSnapshot?.rates?.usd, 'dated snapshot usd base rate')

  if (!Array.isArray(history.points) || history.points.length < 1) {
    throw new Error('cloudflare history has no points')
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

function resolveExpectedDate({ requestedDate, latestDate, metaLatestDate }) {
  if (requestedDate) {
    return requestedDate
  }

  if (metaLatestDate) {
    return metaLatestDate
  }

  if (latestDate) {
    return latestDate
  }

  return toDateStringUTC(new Date())
}

async function smokeCheckWorker(baseUrl, dateToday, { fetchJson = fetchJSONWithRetry } = {}) {
  const normalizedBase = baseUrl.replace(/\/+$/, '')
  const historyStart = dateDaysAgoUTC(2)
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
  if (!Array.isArray(coverage.signals) || coverage.signals.length > 0) {
    throw new Error(`worker coverage signals present for ${normalizedBase}`)
  }
  if (!Number.isFinite(coverage.mismatchCount) || coverage.mismatchCount !== 0) {
    throw new Error(`worker coverage mismatchCount expected 0 for ${normalizedBase}, got ${coverage.mismatchCount}`)
  }
  if (coverage.historyCoverage.requestedDays !== coverage.historyCoverage.availableDays) {
    throw new Error(`worker coverage availableDays mismatch for ${normalizedBase}`)
  }
  if (coverage.historyCoverage.missingDayCount !== 0) {
    throw new Error(`worker coverage missingDayCount expected 0 for ${normalizedBase}, got ${coverage.historyCoverage.missingDayCount}`)
  }
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

function dateDaysAgoUTC(daysAgo) {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() - daysAgo)
  return toDateStringUTC(date)
}

module.exports = {
  defaultWorkerBase,
  fetchJSONWithRetry,
  main,
  resolveExpectedDate,
  resolveWorkerBase,
  smokeCheckWorker,
}
