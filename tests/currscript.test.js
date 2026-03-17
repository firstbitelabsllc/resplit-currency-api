const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const path = require('path')

const {
  buildArchiveManifest,
  buildArchiveYearPayloads,
  computeCrossRates,
  loadAllSnapshotsFromArchive,
  loadSnapshotFromArchive,
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

test('buildArchiveManifest summarizes immutable archive coverage', () => {
  const manifest = buildArchiveManifest({
    availableDates: ['2026-02-20', '2026-02-21', '2026-02-23'],
    latestRates: { eur: 1, usd: 1.2, aed: 4.1 },
    generatedAt: '2026-03-16T00:00:00.000Z'
  })

  assert.equal(manifest.earliestDate, '2026-02-20')
  assert.equal(manifest.latestDate, '2026-02-23')
  assert.equal(manifest.gapCount, 1)
  assert.deepEqual(manifest.supportedCurrencies, ['aed', 'eur', 'usd'])
})

test('buildArchiveYearPayloads groups snapshots by year', () => {
  const payloads = buildArchiveYearPayloads([
    { date: '2025-12-31', rates: { eur: 1, usd: 1.1 } },
    { date: '2026-01-01', rates: { eur: 1, usd: 1.2 } },
    { date: '2026-01-02', rates: { eur: 1, usd: 1.3 } }
  ])

  assert.deepEqual(Object.keys(payloads).sort(), ['2025', '2026'])
  assert.equal(payloads['2025'].snapshots.length, 1)
  assert.equal(payloads['2026'].snapshots.length, 2)
  assert.equal(payloads['2026'].snapshots[0].date, '2026-01-01')
})

test('loadAllSnapshotsFromArchive returns sorted immutable archive snapshots', (t) => {
  const dates = ['2099-01-03', '2099-01-01', '2099-01-02']

  t.after(() => {
    for (const date of dates) {
      fs.removeSync(path.join(snapshotArchiveDir, `${date}.json`))
    }
  })

  saveSnapshotToArchive('2099-01-03', { eur: 1, usd: 1.3 })
  saveSnapshotToArchive('2099-01-01', { eur: 1, usd: 1.1 })
  saveSnapshotToArchive('2099-01-02', { eur: 1, usd: 1.2 })

  const snapshots = loadAllSnapshotsFromArchive()
    .filter(snapshot => snapshot.date.startsWith('2099-01-0'))

  assert.deepEqual(snapshots.map(snapshot => snapshot.date), dates.slice().sort())
})
