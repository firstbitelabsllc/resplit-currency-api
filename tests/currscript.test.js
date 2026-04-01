const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')

const {
  bestEffortRemoveDir,
  buildArchiveManifest,
  buildArchiveYearPayloads,
  buildSnapshotWindow,
  computeCrossRates,
  dateDaysBeforeUTC,
  listSnapshotArchiveDates,
  loadAllSnapshotsFromArchive,
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
} = require('../currscript')

test('snapshot retention is pinned to one year', () => {
  assert.equal(snapshotRetentionDays, 365)
})

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

test('resolvePublishDate prefers an explicit workflow publish date', () => {
  const resolved = resolvePublishDate({
    env: { PUBLISH_DATE: '2026-03-25' },
    now: new Date('2026-03-26T01:00:00.000Z')
  })

  assert.equal(resolved, '2026-03-25')
})

test('resolvePublishDate rejects impossible calendar dates', () => {
  assert.throws(
    () => resolvePublishDate({ env: { PUBLISH_DATE: '2026-02-31' } }),
    /Invalid PUBLISH_DATE/
  )
})

test('dateDaysBeforeUTC subtracts days from the provided anchor date', () => {
  assert.equal(dateDaysBeforeUTC('2026-03-25', 1), '2026-03-24')
  assert.equal(dateDaysBeforeUTC('2026-03-25', 30), '2026-02-23')
})

test('buildSnapshotWindow anchors history fetches to the provided publish date', async () => {
  const requestedDates = []
  const savedDates = []

  const snapshots = await buildSnapshotWindow({
    todayDate: '2026-03-25',
    latestRates: { eur: 1, usd: 1.1 },
    retentionDays: 3,
    loadSnapshot: () => null,
    fetchSnapshot: async (date) => {
      requestedDates.push(date)
      return { eur: 1, usd: 1.1 }
    },
    saveSnapshot: (date) => {
      savedDates.push(date)
    },
    log: () => {}
  })

  assert.deepEqual(requestedDates, ['2026-03-24', '2026-03-23'])
  assert.deepEqual(savedDates, ['2026-03-24', '2026-03-23'])
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.date),
    ['2026-03-23', '2026-03-24', '2026-03-25']
  )
})

test('promoteBuildOutput swaps staged files into place', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'currscript-promote-'))
  const destinationRoot = path.join(tempRoot, 'package')
  const backupRoot = path.join(tempRoot, 'package.backup')
  const stagingRoot = path.join(tempRoot, 'package.staging')

  t.after(() => {
    fs.removeSync(tempRoot)
  })

  fs.mkdirpSync(destinationRoot)
  fs.writeFileSync(path.join(destinationRoot, 'stale.txt'), 'stale')

  promoteBuildOutput({
    destinationRoot,
    backupRoot,
    stagingRoot,
    build: (root) => {
      fs.writeFileSync(path.join(root, 'fresh.txt'), 'fresh')
    }
  })

  assert.equal(fs.readFileSync(path.join(destinationRoot, 'fresh.txt'), 'utf8'), 'fresh')
  assert.equal(fs.existsSync(path.join(destinationRoot, 'stale.txt')), false)
  assert.equal(fs.existsSync(backupRoot), false)
})

test('promoteBuildOutput restores the previous output when staging fails', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'currscript-promote-fail-'))
  const destinationRoot = path.join(tempRoot, 'package')
  const backupRoot = path.join(tempRoot, 'package.backup')
  const stagingRoot = path.join(tempRoot, 'package.staging')

  t.after(() => {
    fs.removeSync(tempRoot)
  })

  fs.mkdirpSync(destinationRoot)
  fs.writeFileSync(path.join(destinationRoot, 'stale.txt'), 'stale')

  assert.throws(() => {
    promoteBuildOutput({
      destinationRoot,
      backupRoot,
      stagingRoot,
      build: (root) => {
        fs.writeFileSync(path.join(root, 'partial.txt'), 'partial')
        throw new Error('build failed')
      }
    })
  }, /build failed/)

  assert.equal(fs.readFileSync(path.join(destinationRoot, 'stale.txt'), 'utf8'), 'stale')
  assert.equal(fs.existsSync(path.join(destinationRoot, 'partial.txt')), false)
  assert.equal(fs.existsSync(backupRoot), false)
  assert.equal(fs.existsSync(stagingRoot), false)
})

test('promoteBuildOutput throws when promoted backup cleanup fails', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'currscript-promote-cleanup-'))
  const destinationRoot = path.join(tempRoot, 'package')
  const backupRoot = path.join(tempRoot, 'package.backup')
  const stagingRoot = path.join(tempRoot, 'package.staging')

  t.after(() => {
    fs.removeSync(tempRoot)
  })

  fs.mkdirpSync(destinationRoot)
  fs.writeFileSync(path.join(destinationRoot, 'stale.txt'), 'stale')

  assert.throws(() => {
    promoteBuildOutput({
      destinationRoot,
      backupRoot,
      stagingRoot,
      build: (root) => {
        fs.writeFileSync(path.join(root, 'fresh.txt'), 'fresh')
      },
      removeDir: (dirPath) => {
        if (dirPath === backupRoot) {
          const error = new Error('cleanup busy')
          error.code = 'ENOTEMPTY'
          throw error
        }
        fs.removeSync(dirPath)
      },
      warn: () => {}
    })
  }, /failed to remove backup/)

  assert.equal(fs.readFileSync(path.join(destinationRoot, 'fresh.txt'), 'utf8'), 'fresh')
  assert.equal(fs.existsSync(path.join(destinationRoot, 'stale.txt')), false)
  assert.equal(fs.existsSync(backupRoot), true)
})

test('promoteBuildOutput restores the backup after partial promotion cleanup', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'currscript-promote-partial-'))
  const destinationRoot = path.join(tempRoot, 'package')
  const backupRoot = path.join(tempRoot, 'package.backup')
  const stagingRoot = path.join(tempRoot, 'package.staging')

  t.after(() => {
    fs.removeSync(tempRoot)
  })

  fs.mkdirpSync(destinationRoot)
  fs.writeFileSync(path.join(destinationRoot, 'stale.txt'), 'stale')

  assert.throws(() => {
    promoteBuildOutput({
      destinationRoot,
      backupRoot,
      stagingRoot,
      build: (root) => {
        fs.writeFileSync(path.join(root, 'fresh.txt'), 'fresh')
      },
      moveDir: (source, destination) => {
        if (source === stagingRoot && destination === destinationRoot) {
          fs.mkdirpSync(destinationRoot)
          fs.writeFileSync(path.join(destinationRoot, 'partial.txt'), 'partial')
          throw new Error('promotion failed')
        }

        fs.moveSync(source, destination, { overwrite: false })
      },
      warn: () => {}
    })
  }, /promotion failed/)

  assert.equal(fs.readFileSync(path.join(destinationRoot, 'stale.txt'), 'utf8'), 'stale')
  assert.equal(fs.existsSync(path.join(destinationRoot, 'partial.txt')), false)
  assert.equal(fs.existsSync(backupRoot), false)
  assert.equal(fs.existsSync(stagingRoot), false)
})

test('promoteBuildOutput preserves the promotion error when backup restore throws', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'currscript-promote-restore-fail-'))
  const destinationRoot = path.join(tempRoot, 'package')
  const backupRoot = path.join(tempRoot, 'package.backup')
  const stagingRoot = path.join(tempRoot, 'package.staging')

  t.after(() => {
    fs.removeSync(tempRoot)
  })

  fs.mkdirpSync(destinationRoot)
  fs.writeFileSync(path.join(destinationRoot, 'stale.txt'), 'stale')

  assert.throws(
    () => {
      promoteBuildOutput({
        destinationRoot,
        backupRoot,
        stagingRoot,
        build: (root) => {
          fs.writeFileSync(path.join(root, 'fresh.txt'), 'fresh')
        },
        moveDir: (source, destination) => {
          if (source === stagingRoot && destination === destinationRoot) {
            fs.mkdirpSync(destinationRoot)
            fs.writeFileSync(path.join(destinationRoot, 'partial.txt'), 'partial')
            throw new Error('promotion failed')
          }

          if (source === backupRoot && destination === destinationRoot) {
            throw new Error('restore failed')
          }

          fs.moveSync(source, destination, { overwrite: false })
        },
        warn: () => {}
      })
    },
    (error) => {
      assert.match(
        error.message,
        /Failed to restore .* after promotion error \(promotion failed\): restore failed/
      )
      assert.equal(error.cause.message, 'promotion failed')
      assert.equal(error.restoreFailure.message, 'restore failed')
      return true
    }
  )

  assert.equal(fs.existsSync(path.join(destinationRoot, 'partial.txt')), false)
  assert.equal(fs.existsSync(path.join(destinationRoot, 'stale.txt')), false)
  assert.equal(fs.existsSync(backupRoot), true)
  assert.equal(fs.existsSync(stagingRoot), false)
})

test('bestEffortRemoveDir tolerates transient cleanup failures', () => {
  let attempts = 0
  let exists = true

  const removed = bestEffortRemoveDir({
    dirPath: '/tmp/fake-dir',
    pathExists: () => exists,
    removeDir: () => {
      attempts += 1
      if (attempts < 3) {
        const error = new Error('busy')
        error.code = 'ENOTEMPTY'
        throw error
      }
      exists = false
    },
    warn: () => {}
  })

  assert.equal(removed, true)
  assert.equal(attempts, 3)
})

test('writeTextFile creates missing parent directories before writing', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'currscript-write-text-'))
  const target = path.join(tempRoot, 'nested', 'deeper', 'file.txt')

  t.after(() => {
    fs.removeSync(tempRoot)
  })

  writeTextFile(target, 'ok')

  assert.equal(fs.readFileSync(target, 'utf8'), 'ok')
})

test('writeJsonFile creates missing parent directories before writing', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'currscript-write-json-'))
  const target = path.join(tempRoot, 'nested', 'deeper', 'file.json')

  t.after(() => {
    fs.removeSync(tempRoot)
  })

  writeJsonFile(target, { ok: true }, true)

  assert.deepEqual(fs.readJsonSync(target), { ok: true })
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

test('loadAllSnapshotsFromArchive can ignore future-dated snapshots for backfill packaging', (t) => {
  const dates = ['2099-01-01', '2099-01-02', '2099-01-03']

  t.after(() => {
    for (const date of dates) {
      fs.removeSync(path.join(snapshotArchiveDir, `${date}.json`))
    }
  })

  for (const [index, date] of dates.entries()) {
    saveSnapshotToArchive(date, { eur: 1, usd: 1.1 + index })
  }

  const filteredSnapshots = loadAllSnapshotsFromArchive({ latestDate: '2099-01-02' })
    .filter(snapshot => snapshot.date.startsWith('2099-01-0'))

  assert.deepEqual(filteredSnapshots.map(snapshot => snapshot.date), ['2099-01-01', '2099-01-02'])
  assert.deepEqual(listSnapshotArchiveDates().filter(date => date.startsWith('2099-01-0')), dates)
})

test('pruneSnapshotArchive keeps a rolling retention window anchored to the newest snapshot', (t) => {
  const dates = ['2099-01-01', '2099-01-02', '2099-01-03']

  t.after(() => {
    for (const date of dates) {
      fs.removeSync(path.join(snapshotArchiveDir, `${date}.json`))
    }
  })

  for (const [index, date] of dates.entries()) {
    saveSnapshotToArchive(date, { eur: 1, usd: 1.1 + index })
  }

  const pruned = pruneSnapshotArchive({
    retentionDays: 2,
    latestDate: '2099-01-03',
    listDates: () => dates.slice()
  })

  assert.deepEqual(pruned, ['2099-01-01'])
  assert.deepEqual(listSnapshotArchiveDates().filter(date => date.startsWith('2099-01-0')), ['2099-01-02', '2099-01-03'])
})

test('pruneSnapshotArchive does not delete newer source snapshots during backfill packaging', (t) => {
  const dates = ['2099-01-01', '2099-01-02', '2099-01-03']
  const removedPaths = []

  const pruned = pruneSnapshotArchive({
    retentionDays: 10,
    latestDate: '2099-01-02',
    listDates: () => dates.slice(),
    removeFile: (filePath) => {
      removedPaths.push(path.basename(filePath, '.json'))
    }
  })

  assert.deepEqual(pruned, [])
  assert.deepEqual(removedPaths, [])
})
