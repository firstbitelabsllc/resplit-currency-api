#!/usr/bin/env node

const cloudflareBase = process.env.CF_PAGES_BASE || 'https://resplit-currency-api.pages.dev'
const fallbackBase = process.env.GH_PAGES_BASE || 'https://firstbitelabsllc.github.io/resplit-currency-api'
const dateToday = process.env.EXPECTED_DATE || toDateStringUTC(new Date())

main().catch((error) => {
  console.error(`smoke-check-deploy: FAILED\n${error.stack || error.message}`)
  process.exitCode = 1
})

async function main() {
  const v2Latest = await fetchJSONWithRetry(`${cloudflareBase}/v2/latest/usd.json`)
  const v2History = await fetchJSONWithRetry(`${cloudflareBase}/v2/history/7d/usd.json`)
  const v2Meta = await fetchJSONWithRetry(`${cloudflareBase}/v2/meta.json`)
  const datedSnapshot = await fetchJSONWithRetry(
    `https://${dateToday}.resplit-currency-api.pages.dev/v2/snapshots/base-rates.json`
  )
  const ghFallbackLatest = await fetchJSONWithRetry(`${fallbackBase}/v2/latest/usd.json`)

  assertISODate(v2Latest.date, 'cloudflare v2 latest date')
  assertISODate(v2Meta.latestDate, 'cloudflare v2 meta latestDate')
  assertISODate(datedSnapshot.date, 'dated v2 snapshot date')
  assertISODate(ghFallbackLatest.date, 'github fallback v2 latest date')

  assertPositive(v2Latest?.rates?.usd, 'cloudflare v2 latest usd->usd')
  assertPositive(ghFallbackLatest?.rates?.usd, 'github fallback v2 latest usd->usd')
  assertPositive(datedSnapshot?.rates?.usd, 'dated v2 snapshot usd base rate')

  if (!Array.isArray(v2History.points) || v2History.points.length < 1) {
    throw new Error('cloudflare v2 history has no points')
  }
  for (const point of v2History.points) {
    assertISODate(point.date, 'cloudflare v2 history point date')
    assertPositive(point?.rates?.usd, `cloudflare v2 history usd->usd at ${point.date}`)
  }

  if (v2Meta.historyDays !== 7) {
    throw new Error(`cloudflare v2 meta historyDays expected 7, got ${v2Meta.historyDays}`)
  }

  if (v2Latest.date !== v2Meta.latestDate) {
    throw new Error(`cloudflare v2 latest date (${v2Latest.date}) != v2 meta latestDate (${v2Meta.latestDate})`)
  }

  if (datedSnapshot.date !== dateToday) {
    throw new Error(`dated deployment date mismatch: expected ${dateToday}, got ${datedSnapshot.date}`)
  }

  console.log(
    `smoke-check-deploy: OK (date=${dateToday}, historyPoints=${v2History.points.length}, cf=${cloudflareBase})`
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
