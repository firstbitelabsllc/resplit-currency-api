const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const path = require('path')

const {
  computeCrossRates,
  loadSnapshotFromArchive,
  pruneSnapshotArchive,
  saveSnapshotToArchive,
  significantNum,
  snapshotArchiveDir,
  toLowerSorted
} = require('../currscript')

test('toLowerSorted normalizes keys, filters invalid values, and sorts', () => {
  const input = {
    USD: '1.3',
    eur: 1,
    ZZZ: 0,
    bad: 'nope'
  }

  const normalized = toLowerSorted(input)
  assert.deepEqual(Object.keys(normalized), ['eur', 'usd'])
  assert.equal(normalized.eur, 1)
  assert.equal(normalized.usd, 1.3)
})

test('computeCrossRates produces positive finite cross rates', () => {
  const rates = {
    eur: 1,
    usd: 1.2,
    aed: 4.4
  }
  const cross = computeCrossRates(rates.usd, rates)

  assert.equal(cross.usd, 1)
  assert.equal(cross.eur, significantNum(1 / 1.2))
  assert.equal(cross.aed, significantNum(4.4 / 1.2))
  assert.ok(Number.isFinite(cross.aed) && cross.aed > 0)
})

test('significantNum retains precision for small rates', () => {
  const value = significantNum(0.0000123456789)
  assert.ok(value > 0)
  assert.ok(String(value).startsWith('0.00001234'))
})

test('saveSnapshotToArchive and loadSnapshotFromArchive round-trip', (t) => {
  const testDate = '2099-01-01'
  const testRates = { eur: 1, usd: 1.2, myr: 4.8 }

  t.after(() => {
    fs.removeSync(path.join(snapshotArchiveDir, `${testDate}.json`))
  })

  saveSnapshotToArchive(testDate, testRates)
  const loaded = loadSnapshotFromArchive(testDate)

  assert.deepEqual(loaded, testRates)
})

test('loadSnapshotFromArchive returns null for missing date', () => {
  const result = loadSnapshotFromArchive('1900-01-01')
  assert.equal(result, null)
})

test('loadSnapshotFromArchive returns null for corrupt file', (t) => {
  const testDate = '2099-12-31'
  const filePath = path.join(snapshotArchiveDir, `${testDate}.json`)

  t.after(() => {
    fs.removeSync(filePath)
  })

  fs.mkdirpSync(snapshotArchiveDir)
  fs.writeFileSync(filePath, 'not json')

  const result = loadSnapshotFromArchive(testDate)
  assert.equal(result, null)
})

test('loadSnapshotFromArchive returns null for empty rates', (t) => {
  const testDate = '2099-06-15'
  const filePath = path.join(snapshotArchiveDir, `${testDate}.json`)

  t.after(() => {
    fs.removeSync(filePath)
  })

  fs.mkdirpSync(snapshotArchiveDir)
  fs.writeJsonSync(filePath, { date: testDate, base: 'eur', rates: {} })

  const result = loadSnapshotFromArchive(testDate)
  assert.equal(result, null)
})

test('pruneSnapshotArchive removes files older than retention', (t) => {
  const oldDate = '2020-01-01'
  const recentDate = '2099-01-01'
  const oldPath = path.join(snapshotArchiveDir, `${oldDate}.json`)
  const recentPath = path.join(snapshotArchiveDir, `${recentDate}.json`)

  t.after(() => {
    fs.removeSync(oldPath)
    fs.removeSync(recentPath)
  })

  saveSnapshotToArchive(oldDate, { eur: 1 })
  saveSnapshotToArchive(recentDate, { eur: 1 })

  pruneSnapshotArchive(32)

  assert.equal(fs.existsSync(oldPath), false, 'old snapshot should be pruned')
  assert.equal(fs.existsSync(recentPath), true, 'recent snapshot should be kept')
})
