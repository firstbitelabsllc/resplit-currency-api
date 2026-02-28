#!/usr/bin/env node

const fs = require('fs-extra')
const { saveSnapshotToArchive, loadSnapshotFromArchive, toLowerSorted, dateDaysAgoUTC } = require('../currscript')

const BACKFILL_DAYS = 30

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

async function main() {
  let backfilled = 0
  let skipped = 0

  for (let dayOffset = 0; dayOffset < BACKFILL_DAYS; dayOffset += 1) {
    const date = dateDaysAgoUTC(dayOffset)
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
      console.log(`  missed: ${date}`)
    }
  }

  console.log(`\nBackfill complete: ${backfilled} new, ${skipped} already cached`)
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
