#!/usr/bin/env node

const fs = require('fs-extra')
const {
  saveSnapshotToArchive,
  loadSnapshotFromArchive,
  toLowerSorted,
  toDateStringUTC,
  dateDaysAgoUTC,
  snapshotArchiveDir,
} = require('../currscript')

const FULL_HISTORY_START_DATE = '1999-01-04'
const DEFAULT_RECENT_WINDOW_DAYS = 45

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

async function main() {
  const { startDate, endDate, allowMisses } = resolveRange(process.argv.slice(2))
  let backfilled = 0
  let skipped = 0
  let missed = 0

  for (const date of enumerateDates(startDate, endDate)) {
    const existing = loadSnapshotFromArchive(date)
    if (existing) {
      skipped += 1
      continue
    }

    const rates = await fetchFromUpstream(date)
    if (rates) {
      saveSnapshotToArchive(date, rates)
      backfilled += 1
      console.log(`  backfilled: ${date} (${Object.keys(rates).length} currencies)`)
    } else {
      missed += 1
      console.log(`  missed: ${date}`)
    }
  }

  console.log(
    `\nBackfill complete: ${backfilled} new, ${skipped} already cached, ${missed} missed`
  )

  if (missed > 0 && !allowMisses) {
    throw new Error(
      `Backfill incomplete: ${missed} dates were missed. Re-run with --allow-misses only if you intentionally accept archive gaps.`
    )
  }
}

async function fetchFromUpstream(date) {
  const url = `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${date}/v1/currencies/eur.json`
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) return null
    const data = await response.json()
    if (data?.eur && typeof data.eur === 'object') {
      return toLowerSorted(data.eur)
    }
  } catch (_) {}
  return null
}

function resolveRange(args) {
  let startDate = defaultStartDate()
  let endDate = toDateStringUTC(new Date())
  let allowMisses = false
  let fullHistory = false

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--start') {
      startDate = args[index + 1] ?? startDate
      index += 1
      continue
    }
    if (arg === '--end') {
      endDate = args[index + 1] ?? endDate
      index += 1
      continue
    }
    if (arg === '--allow-misses') {
      allowMisses = true
      continue
    }
    if (arg === '--full-history') {
      fullHistory = true
    }
  }

  if (fullHistory) {
    startDate = FULL_HISTORY_START_DATE
  }

  if (!isValidIsoCalendarDate(startDate) || !isValidIsoCalendarDate(endDate)) {
    throw new Error('Expected --start/--end in yyyy-mm-dd format')
  }
  if (startDate > endDate) {
    throw new Error(`Invalid range: ${startDate} > ${endDate}`)
  }

  return { startDate, endDate, allowMisses }
}

function enumerateDates(startDate, endDate) {
  const results = []
  let cursor = new Date(`${startDate}T00:00:00Z`)
  const end = new Date(`${endDate}T00:00:00Z`)

  while (cursor <= end) {
    results.push(toDateStringUTC(cursor))
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000)
  }

  return results
}

function isValidIsoCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const normalized = toDateStringUTC(new Date(`${value}T00:00:00Z`))
  return normalized === value
}

function defaultStartDate() {
  if (!fs.existsSync(snapshotArchiveDir)) {
    return dateDaysAgoUTC(DEFAULT_RECENT_WINDOW_DAYS)
  }

  const dates = fs.readdirSync(snapshotArchiveDir)
    .filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .map(name => name.replace(/\.json$/, ''))
    .sort((lhs, rhs) => lhs.localeCompare(rhs))

  return dates[0] ?? dateDaysAgoUTC(DEFAULT_RECENT_WINDOW_DAYS)
}
