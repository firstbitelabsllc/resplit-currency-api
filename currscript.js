const fs = require('fs-extra')
const path = require('path')

const indent = '\t'
const historyDays = 7
const snapshotRetentionDays = 14
const rootDir = path.join(__dirname, 'package')

if (require.main === module) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

async function main() {
  const dateToday = toDateStringUTC(new Date())
  const latestRates = await fetchLatestRates()
  if (!latestRates || Object.keys(latestRates).length === 0) {
    throw new Error('Failed to fetch currency rates from source')
  }

  console.log(`Fetched ${Object.keys(latestRates).length} currencies for ${dateToday}`)

  const snapshots = await buildSnapshotWindow({
    todayDate: dateToday,
    latestRates,
    retentionDays: snapshotRetentionDays
  })
  const historySnapshots = snapshots.slice(-historyDays)

  fs.mkdirpSync(rootDir)
  fs.emptyDirSync(rootDir)

  writeArtifacts({
    root: rootDir,
    dateToday,
    latestRates,
    snapshots,
    historySnapshots
  })
  writeRootPackageMetadata({ root: rootDir, dateToday })

  fs.copyFileSync(path.join(__dirname, 'country.json'), path.join(rootDir, 'country.json'))

  console.log(`Generated unversioned files in ${rootDir}`)
}

function writeRootPackageMetadata({ root, dateToday }) {
  const semverDate = dateToday.replaceAll('-', '.')
  const pkg = fs.readJsonSync(path.join(__dirname, 'skeleton-package.json'))
  pkg.version = semverDate
  fs.writeJsonSync(path.join(root, 'package.json'), pkg)
  fs.writeFileSync(path.join(root, 'index.js'), '')
}

function writeArtifacts({
  root,
  dateToday,
  latestRates,
  snapshots,
  historySnapshots
}) {
  const latestDir = path.join(root, 'latest')
  const historyDir = path.join(root, 'history', '7d')
  const snapshotsDir = path.join(root, 'snapshots')
  fs.mkdirpSync(latestDir)
  fs.mkdirpSync(historyDir)
  fs.mkdirpSync(snapshotsDir)

  const currencyList = buildCurrencyList(latestRates)
  fs.writeFileSync(path.join(root, 'currencies.json'), JSON.stringify(currencyList, null, indent))
  fs.writeFileSync(path.join(root, 'currencies.min.json'), JSON.stringify(currencyList))

  const snapshotPayload = {
    date: dateToday,
    base: 'eur',
    rates: latestRates
  }
  fs.writeFileSync(path.join(snapshotsDir, 'base-rates.json'), JSON.stringify(snapshotPayload, null, indent))
  fs.writeFileSync(path.join(snapshotsDir, 'base-rates.min.json'), JSON.stringify(snapshotPayload))

  const metaPayload = {
    generatedAt: new Date().toISOString(),
    latestDate: dateToday,
    currencyCount: Object.keys(latestRates).length,
    historyDays,
    snapshotRetentionDays,
    availableSnapshotDates: snapshots.map((snapshot) => snapshot.date),
    availableHistoryDates: historySnapshots.map((snapshot) => snapshot.date)
  }
  fs.writeFileSync(path.join(root, 'meta.json'), JSON.stringify(metaPayload, null, indent))
  fs.writeFileSync(path.join(root, 'meta.min.json'), JSON.stringify(metaPayload))

  writeCrossRateFiles({
    outputDir: latestDir,
    fromRates: latestRates,
    outputShape: (fromCode, ratesByTo) => ({
      date: dateToday,
      from: fromCode,
      rates: ratesByTo
    })
  })

  const fromCurrencies = Object.keys(latestRates).sort()
  for (const fromCode of fromCurrencies) {
    const points = historySnapshots.map((snapshot) => {
      const fromRate = snapshot.rates[fromCode]
      if (!Number.isFinite(fromRate) || fromRate <= 0) {
        return null
      }
      const rates = computeCrossRates(fromRate, snapshot.rates)
      return { date: snapshot.date, rates }
    })
      .filter(Boolean)

    const payload = {
      from: fromCode,
      windowDays: historyDays,
      points
    }
    fs.writeFileSync(path.join(historyDir, `${fromCode}.json`), JSON.stringify(payload, null, indent))
    fs.writeFileSync(path.join(historyDir, `${fromCode}.min.json`), JSON.stringify(payload))
  }
}

function writeCrossRateFiles({ outputDir, fromRates, outputShape }) {
  for (const [fromCode, fromRate] of Object.entries(fromRates)) {
    const ratesByTo = computeCrossRates(fromRate, fromRates)

    const payload = outputShape(fromCode, ratesByTo)
    fs.writeFileSync(path.join(outputDir, `${fromCode}.json`), JSON.stringify(payload, null, indent))
    fs.writeFileSync(path.join(outputDir, `${fromCode}.min.json`), JSON.stringify(payload))
  }
}

async function buildSnapshotWindow({ todayDate, latestRates, retentionDays }) {
  const snapshotsByDate = new Map()
  snapshotsByDate.set(todayDate, latestRates)

  for (let dayOffset = 1; dayOffset < retentionDays; dayOffset += 1) {
    const date = dateDaysAgoUTC(dayOffset)
    const snapshot = await fetchHistoricalSnapshot(date)
    if (!snapshot || Object.keys(snapshot).length === 0) {
      continue
    }
    snapshotsByDate.set(date, snapshot)
  }

  return Array
    .from(snapshotsByDate.entries())
    .map(([date, rates]) => ({ date, rates }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

async function fetchHistoricalSnapshot(date) {
  // Primary: reuse yesterday snapshots from our own dated branch output.
  const candidates = [
    `https://${date}.resplit-currency-api.pages.dev/snapshots/base-rates.min.json`,
    `https://${date}.resplit-currency-api.pages.dev/snapshots/base-rates.json`
  ]

  for (const url of candidates) {
    try {
      const data = await fetchJSON(url, 10_000)
      if (data?.rates && typeof data.rates === 'object') {
        return toLowerSorted(data.rates)
      }
      if (data?.eur && typeof data.eur === 'object') {
        return toLowerSorted(data.eur)
      }
    } catch (_) {
      // Keep trying next candidate URL.
    }
  }

  return null
}

async function fetchLatestRates() {
  // Primary: open.er-api.com — free, ~160 fiat currencies, no API key.
  const data = await fetchJSON('https://open.er-api.com/v6/latest/EUR', 30_000)
  if (data?.result === 'success' && data.rates) {
    return toLowerSorted(data.rates)
  }
  return null
}

async function fetchJSON(url, timeoutMs) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`)
  }
  return response.json()
}

function buildCurrencyList(rates) {
  const list = {}
  for (const key of Object.keys(rates).sort()) {
    list[key] = ''
  }
  return list
}

function toDateStringUTC(date) {
  return date.toISOString().substring(0, 10)
}

function dateDaysAgoUTC(daysAgo) {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() - daysAgo)
  return toDateStringUTC(date)
}

function toLowerSorted(obj) {
  const entries = Object.entries(obj)
    .map(([key, value]) => [key.toLowerCase(), parseFloat(value)])
    .filter(([, value]) => Number.isFinite(value) && value > 0)
    .sort(([a], [b]) => a.localeCompare(b))
  return Object.fromEntries(entries)
}

function significantNum(num) {
  if (!Number.isFinite(num) || num <= 0) return 0
  const minDigits = 8
  if (num >= 0.1) return parseFloat(num.toFixed(minDigits))
  const str = num.toFixed(100)
  const zeros = str.match(/^0\.0+/i)[0].length - 2
  return parseFloat(num.toFixed(minDigits + zeros))
}

function computeCrossRates(fromRate, rates) {
  const output = {}
  if (!Number.isFinite(fromRate) || fromRate <= 0) {
    return output
  }

  for (const [toCode, toRate] of Object.entries(rates)) {
    output[toCode] = significantNum(toRate / fromRate)
  }
  return output
}

module.exports = {
  buildCurrencyList,
  computeCrossRates,
  significantNum,
  toDateStringUTC,
  toLowerSorted
}
