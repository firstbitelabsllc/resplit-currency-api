const fs = require('fs-extra')
const os = require('os')
const path = require('path')
const {
  captureIssue,
  runMonitoredScript
} = require('./scripts/sentry-monitoring')
const {
  ER_API_URL,
  FRANKFURTER_URL,
  FX_MAX_RATE_AGE_HOURS,
  fetchErApiSnapshot,
  fetchFrankfurterSnapshot,
  buildReconciliation,
  evaluateCrossSourceAgreement
} = require('./scripts/lib/sources')

const indent = '\t'
const historyDays = 30
const snapshotRetentionDays = 365
const rootDir = path.join(__dirname, 'package')
const snapshotArchiveDir = path.join(__dirname, 'snapshot-archive')

if (require.main === module) {
  runMonitoredScript('currency_publish', main, {
    workflow: 'daily_publish',
    failureSignal: 'currency_publish_failed'
  }).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

async function main() {
  const dateToday = resolvePublishDate()
  const { rates: latestRates, reconciliation } = await fetchReconciledRates({ publishDate: dateToday })
  if (!latestRates || Object.keys(latestRates).length === 0) {
    throw new Error('Failed to fetch currency rates from source')
  }

  console.log(
    `Fetched ${Object.keys(latestRates).length} currencies for ${dateToday} (source=${reconciliation.publishedSource})`
  )

  saveSnapshotToArchive(dateToday, latestRates)
  pruneSnapshotArchive({
    retentionDays: snapshotRetentionDays,
    latestDate: dateToday
  })

  const recentSnapshots = await buildSnapshotWindow({
    todayDate: dateToday,
    latestRates,
    retentionDays: snapshotRetentionDays
  })
  const archiveSnapshots = loadAllSnapshotsFromArchive({ latestDate: dateToday })
  const historyStartDate = dateDaysBeforeUTC(dateToday, historyDays - 1)
  const historySnapshots = recentSnapshots.filter((snapshot) => {
    return snapshot.date >= historyStartDate && snapshot.date <= dateToday
  })

  if (historySnapshots.length < historyDays) {
    const error = new Error(
      `History/30d calendar window incomplete: got ${historySnapshots.length}/${historyDays} snapshots for ${historyStartDate}..${dateToday}`
    )
    await captureIssue({
      signal: 'history_window_shorter_than_30_days',
      error,
      context: {
        workflow: 'daily_publish',
        latest_date: dateToday,
        history_start_date: historyStartDate,
        available_history_days: historySnapshots.length,
        required_history_days: historyDays
      }
    })
    console.warn(error.message)
  }

  promoteBuildOutput({
    destinationRoot: rootDir,
    backupRoot: path.join(__dirname, `.package-backup-${process.pid}-${Date.now()}`),
    build: (root) => {
      writeArtifacts({
        root,
        dateToday,
        latestRates,
        archiveSnapshots,
        historySnapshots,
        reconciliation
      })
      writeRootPackageMetadata({ root, dateToday })
      fs.copyFileSync(path.join(__dirname, 'country.json'), path.join(root, 'country.json'))
    }
  })

  console.log(`Generated unversioned files in ${rootDir}`)
}

function promoteBuildOutput({
  destinationRoot,
  backupRoot,
  stagingRoot = path.join(
    os.tmpdir(),
    `.package-staging-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  ),
  build,
  pathExists = fs.existsSync,
  ensureDir = fs.mkdirpSync,
  moveDir = (source, destination) => fs.moveSync(source, destination, { overwrite: false }),
  removeDir = fs.removeSync,
  warn = console.warn
}) {
  let destinationBackedUp = false
  let promoted = false
  let promotionError = null

  try {
    ensureDir(stagingRoot)
    build(stagingRoot)

    if (pathExists(destinationRoot)) {
      moveDir(destinationRoot, backupRoot)
      destinationBackedUp = true
    }

    moveDir(stagingRoot, destinationRoot)
    promoted = true
  } catch (error) {
    promotionError = error
  }

  if (promotionError) {
    bestEffortRemoveDir({
      dirPath: stagingRoot,
      pathExists,
      removeDir,
      warn
    })

    if (destinationBackedUp) {
      const destinationCleared = bestEffortRemoveDir({
        dirPath: destinationRoot,
        pathExists,
        removeDir,
        warn
      })

      if (!destinationCleared && pathExists(destinationRoot)) {
        const restoreError = new Error(
          `Failed to restore ${destinationRoot} after promotion error: cleanup failed while handling ${promotionError.message}`
        )
        restoreError.cause = promotionError
        throw restoreError
      }

      if (pathExists(backupRoot)) {
        try {
          moveDir(backupRoot, destinationRoot)
          destinationBackedUp = false
        } catch (error) {
          const restoreError = new Error(
            `Failed to restore ${destinationRoot} after promotion error (${promotionError.message}): ${error.message}`
          )
          restoreError.cause = promotionError
          restoreError.restoreFailure = error
          throw restoreError
        }
      }
    }

    throw promotionError
  }

  if (promoted && destinationBackedUp) {
    const backupRemoved = bestEffortRemoveDir({
      dirPath: backupRoot,
      pathExists,
      removeDir,
      warn
    })

    if (!backupRemoved && pathExists(backupRoot)) {
      throw new Error(`Promoted ${destinationRoot}, but failed to remove backup ${backupRoot}`)
    }
  }
}

function bestEffortRemoveDir({
  dirPath,
  pathExists = fs.existsSync,
  removeDir = fs.removeSync,
  warn = console.warn,
  attempts = 3
}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (!pathExists(dirPath)) {
      return true
    }

    try {
      removeDir(dirPath)
      return true
    } catch (error) {
      const isTransient = ['EBUSY', 'EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error?.code)
      if (!isTransient || attempt === attempts) {
        warn(`Skipped cleanup for ${dirPath}: ${error.message}`)
        return false
      }
    }
  }

  return false
}

function writeRootPackageMetadata({ root, dateToday }) {
  const semverDate = dateToday.replaceAll('-', '.')
  const pkg = fs.readJsonSync(path.join(__dirname, 'skeleton-package.json'))
  pkg.version = semverDate
  writeJsonFile(path.join(root, 'package.json'), pkg, true)
  writeTextFile(path.join(root, 'index.js'), '')
}

function writeTextFile(filePath, contents) {
  fs.mkdirpSync(path.dirname(filePath))
  fs.writeFileSync(filePath, contents)
}

function writeJsonFile(filePath, payload, pretty = false) {
  writeTextFile(filePath, JSON.stringify(payload, null, pretty ? indent : undefined))
}

function writeArtifacts({
  root,
  dateToday,
  latestRates,
  archiveSnapshots,
  historySnapshots,
  reconciliation = null
}) {
  const latestDir = path.join(root, 'latest')
  const historyDir = path.join(root, 'history', '30d')
  const snapshotsDir = path.join(root, 'snapshots')
  const archiveDir = path.join(root, 'archive')
  const archiveYearsDir = path.join(root, 'archive-years')
  fs.mkdirpSync(latestDir)
  fs.mkdirpSync(historyDir)
  fs.mkdirpSync(snapshotsDir)
  fs.mkdirpSync(archiveDir)
  fs.mkdirpSync(archiveYearsDir)

  const currencyList = buildCurrencyList(latestRates)
  writeJsonFile(path.join(root, 'currencies.json'), currencyList, true)
  writeJsonFile(path.join(root, 'currencies.min.json'), currencyList)

  const snapshotPayload = {
    date: dateToday,
    base: 'eur',
    rates: latestRates,
    // Multi-source provenance + cross-check (Phase 2). Absent on backfill/legacy
    // snapshots; validate-package enforces `agreement` when present, no-ops when
    // not, so older single-source artifacts stay valid.
    ...(reconciliation
      ? {
        publishedSource: reconciliation.publishedSource,
        reducedCoverage: reconciliation.reducedCoverage,
        stale: reconciliation.stale,
        sources: reconciliation.sources,
        agreement: reconciliation.agreement
      }
      : {})
  }
  writeJsonFile(path.join(snapshotsDir, 'base-rates.json'), snapshotPayload, true)
  writeJsonFile(path.join(snapshotsDir, 'base-rates.min.json'), snapshotPayload)

  const availableArchiveDates = archiveSnapshots.map((snapshot) => snapshot.date)
  const archiveYears = buildArchiveYearPayloads(archiveSnapshots)
  const archiveManifest = buildArchiveManifest({
    availableDates: availableArchiveDates,
    latestRates,
    generatedAt: new Date().toISOString()
  })

  const metaPayload = {
    generatedAt: new Date().toISOString(),
    latestDate: dateToday,
    currencyCount: Object.keys(latestRates).length,
    historyDays,
    availableSnapshotDates: archiveSnapshots.map((snapshot) => snapshot.date),
    availableHistoryDates: historySnapshots.map((snapshot) => snapshot.date),
    archiveMode: 'immutable',
    archiveEarliestDate: archiveManifest.earliestDate,
    archiveLatestDate: archiveManifest.latestDate,
    archiveGapCount: archiveManifest.gapCount,
    // Slim cross-source summary for dashboards/metrics (Phase 3 reads these).
    sources: reconciliation ? reconciliation.sources.map((source) => source.source) : ['er-api'],
    crossSource: reconciliation
      ? {
        publishedSource: reconciliation.publishedSource,
        reducedCoverage: reconciliation.reducedCoverage,
        stale: reconciliation.stale,
        intersectionCount: reconciliation.agreement ? reconciliation.agreement.intersectionCount : 0,
        maxRelDiff: reconciliation.agreement ? reconciliation.agreement.maxRelDiff : 0,
        weekend: reconciliation.agreement ? reconciliation.agreement.weekend : false
      }
      : null
  }
  writeJsonFile(path.join(root, 'meta.json'), metaPayload, true)
  writeJsonFile(path.join(root, 'meta.min.json'), metaPayload)
  writeJsonFile(path.join(root, 'archive-manifest.json'), archiveManifest, true)
  writeJsonFile(path.join(root, 'archive-manifest.min.json'), archiveManifest)

  for (const snapshot of archiveSnapshots) {
    const payload = {
      date: snapshot.date,
      base: 'eur',
      rates: snapshot.rates
    }
    writeJsonFile(path.join(archiveDir, `${snapshot.date}.json`), payload, true)
    writeJsonFile(path.join(archiveDir, `${snapshot.date}.min.json`), payload)
  }

  for (const [year, yearPayload] of Object.entries(archiveYears)) {
    writeJsonFile(path.join(archiveYearsDir, `${year}.json`), yearPayload, true)
    writeJsonFile(path.join(archiveYearsDir, `${year}.min.json`), yearPayload)
  }

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
    writeJsonFile(path.join(historyDir, `${fromCode}.json`), payload, true)
    writeJsonFile(path.join(historyDir, `${fromCode}.min.json`), payload)
  }
}

function writeCrossRateFiles({ outputDir, fromRates, outputShape }) {
  for (const [fromCode, fromRate] of Object.entries(fromRates)) {
    const ratesByTo = computeCrossRates(fromRate, fromRates)

    const payload = outputShape(fromCode, ratesByTo)
    writeJsonFile(path.join(outputDir, `${fromCode}.json`), payload, true)
    writeJsonFile(path.join(outputDir, `${fromCode}.min.json`), payload)
  }
}

async function buildSnapshotWindow({
  todayDate,
  latestRates,
  retentionDays,
  loadSnapshot = loadSnapshotFromArchive,
  fetchSnapshot = fetchHistoricalSnapshot,
  saveSnapshot = saveSnapshotToArchive,
  log = console.log
}) {
  const snapshotsByDate = new Map()
  snapshotsByDate.set(todayDate, latestRates)

  let localHits = 0
  let networkHits = 0

  for (let dayOffset = 1; dayOffset < retentionDays; dayOffset += 1) {
    const date = dateDaysBeforeUTC(todayDate, dayOffset)

    const localSnapshot = loadSnapshot(date)
    if (localSnapshot) {
      snapshotsByDate.set(date, localSnapshot)
      localHits += 1
      continue
    }

    const remoteSnapshot = await fetchSnapshot(date)
    if (remoteSnapshot && Object.keys(remoteSnapshot).length > 0) {
      snapshotsByDate.set(date, remoteSnapshot)
      saveSnapshot(date, remoteSnapshot)
      networkHits += 1
    }
  }

  log(`Snapshot window: ${snapshotsByDate.size} days (${localHits} local, ${networkHits} network)`)

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

function saveSnapshotToArchive(date, rates) {
  fs.mkdirpSync(snapshotArchiveDir)
  const filePath = path.join(snapshotArchiveDir, `${date}.json`)
  fs.writeJsonSync(filePath, { date, base: 'eur', rates })
}

function listSnapshotArchiveDates() {
  if (!fs.existsSync(snapshotArchiveDir)) {
    return []
  }

  return fs.readdirSync(snapshotArchiveDir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .map((name) => name.replace(/\.json$/, ''))
    .sort((lhs, rhs) => lhs.localeCompare(rhs))
}

function loadSnapshotFromArchive(date) {
  const filePath = path.join(snapshotArchiveDir, `${date}.json`)
  try {
    const data = fs.readJsonSync(filePath)
    if (data?.rates && typeof data.rates === 'object' && Object.keys(data.rates).length > 0) {
      return data.rates
    }
  } catch (_) {}
  return null
}

function loadAllSnapshotsFromArchive({ latestDate = null } = {}) {
  return listSnapshotArchiveDates()
    .filter((date) => latestDate === null || date <= latestDate)
    .map((date) => {
      const rates = loadSnapshotFromArchive(date)
      if (!rates) return null
      return { date, rates }
    })
    .filter(Boolean)
    .sort((lhs, rhs) => lhs.date.localeCompare(rhs.date))
}

function pruneSnapshotArchive({
  retentionDays,
  latestDate = null,
  listDates = listSnapshotArchiveDates,
  removeFile = fs.removeSync
}) {
  const dates = listDates()
  if (dates.length === 0) {
    return []
  }

  const effectiveLatestDate = latestDate ?? dates[dates.length - 1]
  const earliestRetainedDate = dateDaysBeforeUTC(effectiveLatestDate, retentionDays - 1)
  const prunedDates = dates.filter((date) => date < earliestRetainedDate)

  for (const date of prunedDates) {
    removeFile(path.join(snapshotArchiveDir, `${date}.json`))
  }

  return prunedDates
}

async function fetchLatestRates({
  publishDate = resolvePublishDate(),
  env = process.env,
  fetchJson = fetchJSON,
  loadArchiveSnapshot = loadSnapshotFromArchive,
  capture = captureIssue,
  warn = console.warn
} = {}) {
  // Primary: open.er-api.com — free, ~160 fiat currencies, no API key.
  const sourceUrl = 'https://open.er-api.com/v6/latest/EUR'
  try {
    const data = await fetchJson(sourceUrl, 30_000)
    if (data?.result === 'success' && data.rates) {
      return toLowerSorted(data.rates)
    }
    return loadArchiveRateFallback({
      publishDate,
      env,
      loadArchiveSnapshot,
      warn,
      reason: new Error('upstream did not return successful rates')
    })
  } catch (error) {
    await capture({
      signal: 'upstream_fetch_failure',
      error,
      context: {
        workflow: 'daily_publish',
        source_url: sourceUrl
      }
    })

    const fallbackRates = loadArchiveRateFallback({
      publishDate,
      env,
      loadArchiveSnapshot,
      warn,
      reason: error
    })
    if (fallbackRates) {
      return fallbackRates
    }

    throw error
  }
}

function loadArchiveRateFallback({
  publishDate,
  env = process.env,
  loadArchiveSnapshot = loadSnapshotFromArchive,
  warn = console.warn,
  reason = null
} = {}) {
  if (!allowArchiveRateFallback({ env })) {
    return null
  }

  const fallbackRates = loadArchiveSnapshot(publishDate)
  if (!fallbackRates || Object.keys(fallbackRates).length === 0) {
    return null
  }

  const reasonText = reason?.message ? `: ${reason.message}` : ''
  warn(`Using exact-date archive fallback rates for ${publishDate}${reasonText}`)
  return toLowerSorted(fallbackRates)
}

function allowArchiveRateFallback({ env = process.env } = {}) {
  return /^(1|true|yes|on)$/i.test(String(env.CURRENCY_API_ALLOW_ARCHIVE_FALLBACK || ''))
}

/**
 * Fetch + reconcile the published EUR-base rate table across two independent
 * sources. open.er-api.com (primary, ~160 currencies) stays authoritative for
 * every published value; frankfurter.app/ECB (secondary, ~30 majors) is a
 * cross-check tripwire and a degraded-mode fallback. See scripts/lib/sources.js
 * for the ported Go quorum semantics + the published-value policy.
 *
 * Returns { rates, reconciliation }. `reconciliation` carries the source
 * provenance + intersection agreement that gets emitted into snapshots/meta and
 * enforced by scripts/validate-package.js.
 */
async function fetchReconciledRates({
  publishDate = resolvePublishDate(),
  env = process.env,
  fetchJson = fetchJSON,
  fetchPrimary = fetchErApiSnapshot,
  fetchSecondary = fetchFrankfurterSnapshot,
  loadArchiveSnapshot = loadSnapshotFromArchive,
  capture = captureIssue,
  warn = console.warn
} = {}) {
  // Primary: open.er-api.com, with the existing exact-date archive fallback.
  let primary = null
  try {
    primary = await fetchPrimary({ fetchJson })
  } catch (error) {
    await capture({
      signal: 'upstream_fetch_failure',
      error,
      context: { workflow: 'daily_publish', source_url: ER_API_URL }
    })
    const fallbackRates = loadArchiveRateFallback({ publishDate, env, loadArchiveSnapshot, warn, reason: error })
    if (fallbackRates) {
      primary = { source: 'er-api-archive', date: publishDate, rates: fallbackRates }
    }
  }

  // Secondary: frankfurter.app/ECB, best-effort. Its absence never fails the
  // publish — it only removes that day's cross-check.
  let secondary = null
  try {
    secondary = await fetchSecondary({ fetchJson })
  } catch (error) {
    warn(`Frankfurter cross-check source unavailable: ${error.message}`)
    await capture({
      signal: 'fx_secondary_source_unavailable',
      error,
      context: { workflow: 'daily_publish', source_url: FRANKFURTER_URL }
    })
  }

  const { rates, reconciliation } = buildReconciliation({ primary, secondary, publishDate })
  if (!rates || Object.keys(rates).length === 0) {
    return { rates: null, reconciliation }
  }

  if (reconciliation.reducedCoverage) {
    warn(`Publishing reduced-coverage majors from ${reconciliation.publishedSource} — er-api unavailable`)
    await capture({
      signal: 'fx_reduced_coverage_publish',
      error: new Error('er-api unavailable; published Frankfurter/ECB majors only'),
      context: {
        workflow: 'daily_publish',
        published_source: reconciliation.publishedSource,
        currency_count: Object.keys(rates).length
      }
    })
  }

  if (reconciliation.stale) {
    warn(`Published rates are stale (older than ${FX_MAX_RATE_AGE_HOURS}h) from ${reconciliation.publishedSource}`)
  }

  if (reconciliation.agreement) {
    const { warns, refusals } = evaluateCrossSourceAgreement(reconciliation.agreement)
    if (warns.length > 0) {
      warn(
        `cross-source: ${warns.length} intersection currency(ies) diverge beyond the warn band: ${warns
          .slice(0, 8)
          .map((entry) => `${entry.code} ${(entry.relDiff * 100).toFixed(2)}%`)
          .join(', ')}`
      )
    }
    if (refusals.length > 0) {
      // validate-package is the hard gate; surface loudly here so the failure is
      // attributable even if someone runs generate without validate.
      await capture({
        signal: 'fx_cross_source_disagreement',
        error: new Error(
          `cross-source disagreement >5% between er-api and Frankfurter: ${refusals.map((entry) => entry.code).join(', ')}`
        ),
        context: { workflow: 'daily_publish', refusals }
      })
    }
  }

  const summary = reconciliation.agreement
    ? `intersection=${reconciliation.agreement.intersectionCount} maxDrift=${(reconciliation.agreement.maxRelDiff * 100).toFixed(3)}% weekend=${reconciliation.agreement.weekend}`
    : 'single-source (no cross-check)'
  console.log(
    `Sources: published=${reconciliation.publishedSource} reducedCoverage=${reconciliation.reducedCoverage} stale=${reconciliation.stale} ${summary}`
  )

  return { rates, reconciliation }
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

function resolvePublishDate({ env = process.env, now = new Date() } = {}) {
  const explicitDate = env.PUBLISH_DATE || env.date_today || null
  if (!explicitDate) {
    return toDateStringUTC(now)
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(explicitDate)) {
    throw new Error(`Invalid PUBLISH_DATE: ${explicitDate}`)
  }

  const parsedDate = new Date(`${explicitDate}T00:00:00Z`)
  if (Number.isNaN(parsedDate.getTime()) || toDateStringUTC(parsedDate) !== explicitDate) {
    throw new Error(`Invalid PUBLISH_DATE: ${explicitDate}`)
  }

  return explicitDate
}

function dateDaysBeforeUTC(anchorDate, daysBefore) {
  const date = new Date(`${anchorDate}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - daysBefore)
  return toDateStringUTC(date)
}

function dateDaysAgoUTC(daysAgo, { now = new Date() } = {}) {
  return dateDaysBeforeUTC(toDateStringUTC(now), daysAgo)
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

function buildArchiveYearPayloads(snapshots) {
  const byYear = {}

  for (const snapshot of snapshots) {
    const year = snapshot.date.slice(0, 4)
    byYear[year] ??= {
      year,
      base: 'eur',
      snapshots: []
    }
    byYear[year].snapshots.push({
      date: snapshot.date,
      rates: snapshot.rates
    })
  }

  for (const payload of Object.values(byYear)) {
    payload.snapshots.sort((lhs, rhs) => lhs.date.localeCompare(rhs.date))
  }

  return byYear
}

function buildArchiveManifest({ availableDates, latestRates, generatedAt }) {
  const sortedDates = [...availableDates].sort((lhs, rhs) => lhs.localeCompare(rhs))
  let gapCount = 0

  for (let index = 1; index < sortedDates.length; index += 1) {
    const previous = sortedDates[index - 1]
    const current = sortedDates[index]
    if (!previous || !current) continue
    const previousDate = new Date(`${previous}T00:00:00Z`)
    const currentDate = new Date(`${current}T00:00:00Z`)
    const diffDays = Math.round((currentDate - previousDate) / (24 * 60 * 60 * 1000))
    if (diffDays > 1) {
      gapCount += diffDays - 1
    }
  }

  return {
    generatedAt,
    base: 'eur',
    earliestDate: sortedDates[0] ?? null,
    latestDate: sortedDates[sortedDates.length - 1] ?? null,
    availableDates: sortedDates,
    gapCount,
    supportedCurrencies: Object.keys(latestRates).sort()
  }
}

module.exports = {
  allowArchiveRateFallback,
  bestEffortRemoveDir,
  buildArchiveManifest,
  buildArchiveYearPayloads,
  buildSnapshotWindow,
  computeCrossRates,
  dateDaysBeforeUTC,
  fetchLatestRates,
  fetchReconciledRates,
  loadAllSnapshotsFromArchive,
  loadArchiveRateFallback,
  listSnapshotArchiveDates,
  loadSnapshotFromArchive,
  pruneSnapshotArchive,
  promoteBuildOutput,
  resolvePublishDate,
  saveSnapshotToArchive,
  significantNum,
  snapshotRetentionDays,
  snapshotArchiveDir,
  toLowerSorted,
  writeJsonFile,
  writeTextFile
}
