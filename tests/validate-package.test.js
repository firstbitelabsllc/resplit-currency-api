const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')

const repoRoot = path.join(__dirname, '..')
const packageRoot = path.join(repoRoot, 'package')
const validatePackagePath = path.join(repoRoot, 'scripts', 'validate-package.js')

function withTempPackage(t) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-package-'))
  const tempPackage = path.join(tempRoot, 'package')
  const previousPackageRoot = process.env.CURRENCY_PACKAGE_ROOT
  const previousStrictHistoryCoverage = process.env.STRICT_HISTORY_COVERAGE

  t.after(() => {
    if (previousPackageRoot === undefined) {
      delete process.env.CURRENCY_PACKAGE_ROOT
    } else {
      process.env.CURRENCY_PACKAGE_ROOT = previousPackageRoot
    }
    if (previousStrictHistoryCoverage === undefined) {
      delete process.env.STRICT_HISTORY_COVERAGE
    } else {
      process.env.STRICT_HISTORY_COVERAGE = previousStrictHistoryCoverage
    }
    delete require.cache[validatePackagePath]
    fs.removeSync(tempRoot)
  })

  fs.copySync(packageRoot, tempPackage)
  process.env.CURRENCY_PACKAGE_ROOT = tempPackage
  delete require.cache[validatePackagePath]

  return {
    packageRoot: tempPackage,
    validate: () => {
      delete require.cache[validatePackagePath]
      return require(validatePackagePath).main()
    }
  }
}

test('validate-package warns instead of blocking recovery publishes with annual archive gaps', (t) => {
  const temp = withTempPackage(t)
  const warnings = []
  const originalWarn = console.warn

  t.after(() => {
    console.warn = originalWarn
  })

  const manifestPath = path.join(temp.packageRoot, 'archive-manifest.json')
  const minManifestPath = path.join(temp.packageRoot, 'archive-manifest.min.json')
  const manifest = fs.readJsonSync(manifestPath)
  const removableDates = new Set(manifest.availableDates.slice(20, 32))
  manifest.availableDates = manifest.availableDates.filter((date) => !removableDates.has(date))
  manifest.gapCount = 14
  fs.writeJsonSync(manifestPath, manifest, { spaces: '\t' })
  fs.writeJsonSync(minManifestPath, manifest)

  console.warn = (message) => warnings.push(message)

  assert.doesNotThrow(() => temp.validate())
  assert.ok(warnings.some((line) => line.includes('archive availableDates below target')))
  assert.ok(warnings.some((line) => line.includes('archive gapCount above target')))
})

test('validate-package still fails when a latest currency artifact is missing', (t) => {
  const temp = withTempPackage(t)

  fs.removeSync(path.join(temp.packageRoot, 'latest', 'usd.json'))

  assert.throws(
    () => temp.validate(),
    /missing required file latest\/usd\.json/
  )
})

test('validate-package warns instead of blocking recovery publishes with incomplete calendar history', (t) => {
  const temp = withTempPackage(t)
  const warnings = []
  const originalWarn = console.warn

  t.after(() => {
    console.warn = originalWarn
  })

  removeMiddleHistoryDate(temp.packageRoot)
  console.warn = (message) => warnings.push(message)

  assert.doesNotThrow(() => temp.validate())
  assert.ok(warnings.some((line) => line.includes('history/30d calendar coverage incomplete')))
})

test('validate-package fails strict release validation with incomplete calendar history', (t) => {
  const temp = withTempPackage(t)

  removeMiddleHistoryDate(temp.packageRoot)
  process.env.STRICT_HISTORY_COVERAGE = '1'

  assert.throws(
    () => temp.validate(),
    /history\/30d calendar coverage incomplete/
  )
})

test('validate-package refuses a snapshot missing the EUR self-rate', (t) => {
  const temp = withTempPackage(t)
  writeEurSelfRate(temp.packageRoot, undefined)

  assert.throws(
    () => temp.validate(),
    /snapshot EUR self-rate must equal 1/
  )
})

test('validate-package refuses a non-unit EUR self-rate', (t) => {
  const temp = withTempPackage(t)
  writeEurSelfRate(temp.packageRoot, 1.01)

  assert.throws(
    () => temp.validate(),
    /snapshot EUR self-rate must equal 1/
  )
})

test('validate-package refuses an unexplained currency removal versus the latest prior archive', (t) => {
  const temp = withTempPackage(t)
  const snapshotPath = path.join(temp.packageRoot, 'snapshots', 'base-rates.json')
  const currenciesPath = path.join(temp.packageRoot, 'currencies.json')
  const snapshot = fs.readJsonSync(snapshotPath)
  const currencies = fs.readJsonSync(currenciesPath)
  const removedCode = Object.keys(snapshot.rates)
    .find((code) => !['eur', 'usd', 'aed', 'gbp', 'myr'].includes(code))

  delete snapshot.rates[removedCode]
  delete currencies[removedCode]
  fs.writeJsonSync(snapshotPath, snapshot, { spaces: '\t' })
  fs.writeJsonSync(currenciesPath, currencies, { spaces: '\t' })

  assert.throws(
    () => temp.validate(),
    new RegExp(`currency-set continuity: snapshot missing 1 trusted currency.*${removedCode}`)
  )
})

test('validate-package warns on moderate independent-source drift', (t) => {
  const temp = withTempPackage(t)
  const warnings = []
  const originalWarn = console.warn

  t.after(() => {
    console.warn = originalWarn
  })

  writeAgreement(temp.packageRoot, {
    secondaryLagged: false,
    pairs: [{ code: 'usd', relDiff: 0.008 }]
  })
  console.warn = (message) => warnings.push(message)

  assert.doesNotThrow(() => temp.validate())
  assert.ok(warnings.some((line) => line.includes('cross-source: 1 intersection currency')))
})

test('validate-package refuses a persisted gross independent-source disagreement', (t) => {
  const temp = withTempPackage(t)
  writeAgreement(temp.packageRoot, {
    secondaryLagged: false,
    pairs: [{ code: 'usd', relDiff: 0.06 }]
  })

  assert.throws(
    () => temp.validate(),
    /cross-source: 1 intersection currency.*disagree >5%/
  )
})

function writeAgreement(tempPackage, agreement) {
  const snapshotPath = path.join(tempPackage, 'snapshots', 'base-rates.json')
  const snapshot = fs.readJsonSync(snapshotPath)
  snapshot.agreement = agreement
  fs.writeJsonSync(snapshotPath, snapshot, { spaces: '\t' })
}

function writeEurSelfRate(tempPackage, rate) {
  const snapshotPath = path.join(tempPackage, 'snapshots', 'base-rates.json')
  const snapshot = fs.readJsonSync(snapshotPath)
  if (rate === undefined) {
    delete snapshot.rates.eur
  } else {
    snapshot.rates.eur = rate
  }
  fs.writeJsonSync(snapshotPath, snapshot, { spaces: '\t' })
}

function removeMiddleHistoryDate(tempPackage) {
  const historyPath = path.join(tempPackage, 'history', '30d', 'usd.json')
  const minHistoryPath = path.join(tempPackage, 'history', '30d', 'usd.min.json')
  const metaPath = path.join(tempPackage, 'meta.json')
  const minMetaPath = path.join(tempPackage, 'meta.min.json')
  const history = fs.readJsonSync(historyPath)
  const removeIndex = Math.max(0, Math.min(history.points.length - 2, Math.floor(history.points.length / 2)))
  const removedDate = history.points[removeIndex].date
  history.points = history.points.filter((point) => point.date !== removedDate)
  fs.writeJsonSync(historyPath, history, { spaces: '\t' })
  fs.writeJsonSync(minHistoryPath, history)

  const meta = fs.readJsonSync(metaPath)
  meta.availableHistoryDates = meta.availableHistoryDates.filter((date) => date !== removedDate)
  fs.writeJsonSync(metaPath, meta, { spaces: '\t' })
  fs.writeJsonSync(minMetaPath, meta)
}
