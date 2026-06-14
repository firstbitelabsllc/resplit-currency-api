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
