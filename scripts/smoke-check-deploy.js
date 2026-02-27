#!/usr/bin/env node

const cloudflareBase = process.env.CF_PAGES_BASE || 'https://resplit-currency-api.pages.dev'
const fallbackBase = process.env.GH_PAGES_BASE || 'https://firstbitelabsllc.github.io/resplit-currency-api'
const dateToday = process.env.EXPECTED_DATE || toDateStringUTC(new Date())

main().catch((error) => {
  console.error(`smoke-check-deploy: FAILED\n${error.stack || error.message}`)
  process.exitCode = 1
})

async function main() {
  const latest = await fetchJSONWithRetry(`${cloudflareBase}/latest/usd.json`)
  const history = await fetchJSONWithRetry(`${cloudflareBase}/history/7d/usd.json`)
  const meta = await fetchJSONWithRetry(`${cloudflareBase}/meta.json`)
  const datedSnapshot = await fetchJSONWithRetry(
    `https://${dateToday}.resplit-currency-api.pages.dev/snapshots/base-rates.json`
  )
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

  if (meta.historyDays !== 7) {
    throw new Error(`cloudflare meta historyDays expected 7, got ${meta.historyDays}`)
  }

  if (latest.date !== meta.latestDate) {
    throw new Error(`cloudflare latest date (${latest.date}) != meta latestDate (${meta.latestDate})`)
  }

  if (datedSnapshot.date !== dateToday) {
    throw new Error(`dated deployment date mismatch: expected ${dateToday}, got ${datedSnapshot.date}`)
  }

  console.log(
    `smoke-check-deploy: OK (date=${dateToday}, historyPoints=${history.points.length}, cf=${cloudflareBase})`
  )
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
