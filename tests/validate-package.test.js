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

  const fixtureSnapshot = fs.readJsonSync(
    path.join(tempPackage, 'snapshots', 'base-rates.json')
  )
  const fixtureSameDaySource = fixtureSnapshot.trustedCurrencyBaseline?.sources
    ?.find((source) => source.kind === 'same_day_committed_archive')
  const fixtureCommittedSameDaySnapshot = fixtureSameDaySource
    ? committedSnapshotFromCodes(fixtureSnapshot, fixtureSameDaySource.currencyCodes)
    : null

  return {
    packageRoot: tempPackage,
    validate: (options = {}) => {
      delete require.cache[validatePackagePath]
      const effectiveOptions = Object.prototype.hasOwnProperty.call(
        options,
        'loadCommittedSameDaySnapshot'
      )
        ? options
        : {
            ...options,
            loadCommittedSameDaySnapshot: () => fixtureCommittedSameDaySnapshot
          }
      return require(validatePackagePath).main(effectiveOptions)
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
    new RegExp(`trusted currency baseline: candidate missing 1 pre-write trusted currency.*${removedCode}`)
  )
})

test('validate-package refuses a candidate missing a committed same-day baseline addition', (t) => {
  const temp = withTempPackage(t)
  const committedSnapshot = installSameDayBaseline(temp.packageRoot, ['zzq'])

  assert.throws(
    () => temp.validate({
      loadCommittedSameDaySnapshot: () => committedSnapshot
    }),
    /trusted currency baseline: candidate missing 1 pre-write trusted currency: zzq/
  )
})

test('validate-package refuses a committed HEAD addition omitted from candidate and metadata', (t) => {
  const temp = withTempPackage(t)
  const snapshotPath = path.join(temp.packageRoot, 'snapshots', 'base-rates.json')
  const snapshot = fs.readJsonSync(snapshotPath)
  const committedSnapshot = installSameDayBaseline(temp.packageRoot)
  committedSnapshot.rates.zzq = 1

  assert.equal(Object.hasOwn(snapshot.rates, 'zzq'), false)

  assert.throws(
    () => temp.validate({
      loadCommittedSameDaySnapshot: () => committedSnapshot
    }),
    /trusted currency baseline metadata must exactly match committed same-day archive codes/
  )
})

test('validate-package refuses same-day metadata that does not match committed HEAD codes', (t) => {
  const temp = withTempPackage(t)
  const snapshotPath = path.join(temp.packageRoot, 'snapshots', 'base-rates.json')
  const committedSnapshot = installSameDayBaseline(temp.packageRoot)
  const snapshot = fs.readJsonSync(snapshotPath)
  const sameDaySource = snapshot.trustedCurrencyBaseline.sources
    .find((source) => source.kind === 'same_day_committed_archive')

  assert.ok(sameDaySource)
  sameDaySource.currencyCodes.push('zzq')
  sameDaySource.currencyCodes.sort()
  snapshot.trustedCurrencyBaseline.currencyCodes.push('zzq')
  snapshot.trustedCurrencyBaseline.currencyCodes.sort()
  fs.writeJsonSync(snapshotPath, snapshot, { spaces: '\t' })

  assert.throws(
    () => temp.validate({
      loadCommittedSameDaySnapshot: () => committedSnapshot
    }),
    /trusted currency baseline metadata must exactly match committed same-day archive codes/
  )
})

test('validate-package requires same-day metadata when HEAD already contains that snapshot', (t) => {
  const temp = withTempPackage(t)
  const snapshotPath = path.join(temp.packageRoot, 'snapshots', 'base-rates.json')
  const committedSnapshot = installSameDayBaseline(temp.packageRoot)
  const snapshot = fs.readJsonSync(snapshotPath)

  snapshot.trustedCurrencyBaseline.sources = snapshot.trustedCurrencyBaseline.sources
    .filter((source) => source.kind !== 'same_day_committed_archive')
  snapshot.trustedCurrencyBaseline.currencyCodes = baselineUnion(
    snapshot.trustedCurrencyBaseline.sources
  )
  fs.writeJsonSync(snapshotPath, snapshot, { spaces: '\t' })

  assert.throws(
    () => temp.validate({
      loadCommittedSameDaySnapshot: () => committedSnapshot
    }),
    /trusted currency baseline must identify committed same-day archive/
  )
})

test('validate-package refuses same-day metadata when HEAD has no same-day snapshot', (t) => {
  const temp = withTempPackage(t)
  installSameDayBaseline(temp.packageRoot)

  assert.throws(
    () => temp.validate({ loadCommittedSameDaySnapshot: () => null }),
    /trusted currency baseline names a committed same-day archive when none exists in HEAD/
  )
})

test('validate-package accepts exact metadata absence when HEAD has no same-day snapshot', (t) => {
  const temp = withTempPackage(t)
  const snapshotPath = path.join(temp.packageRoot, 'snapshots', 'base-rates.json')
  const snapshot = fs.readJsonSync(snapshotPath)

  snapshot.trustedCurrencyBaseline.sources = snapshot.trustedCurrencyBaseline.sources
    .filter((source) => source.kind !== 'same_day_committed_archive')
  snapshot.trustedCurrencyBaseline.currencyCodes = baselineUnion(
    snapshot.trustedCurrencyBaseline.sources
  )
  fs.writeJsonSync(snapshotPath, snapshot, { spaces: '\t' })

  assert.doesNotThrow(
    () => temp.validate({ loadCommittedSameDaySnapshot: () => null })
  )
})

test('committed same-day loader distinguishes path absence from unrelated git failure', () => {
  const { loadCommittedSameDaySnapshotFromHead } = require(validatePackagePath)
  const absentError = new Error('missing path')
  absentError.stderr = Buffer.from("fatal: path 'snapshot-archive/2026-07-12.json' does not exist in 'HEAD'")
  const gitError = new Error('bad object')
  gitError.stderr = Buffer.from('fatal: bad object HEAD')

  assert.equal(
    loadCommittedSameDaySnapshotFromHead('2026-07-12', {
      execFile: () => { throw absentError }
    }),
    null
  )
  assert.throws(
    () => loadCommittedSameDaySnapshotFromHead('2026-07-12', {
      execFile: () => { throw gitError }
    }),
    /Unable to read committed FX snapshot 2026-07-12.*bad object HEAD/
  )
})

test('committed same-day loader fails closed on corrupt or invalid snapshots', () => {
  const { loadCommittedSameDaySnapshotFromHead } = require(validatePackagePath)
  const date = '2026-07-12'
  const validRates = validArchiveRates(100)
  const cases = [
    ['invalid JSON', '{not json', /invalid JSON/],
    [
      'wrong date',
      JSON.stringify({ date: '2026-07-11', base: 'eur', rates: validRates }),
      /mismatched date or base/
    ],
    [
      'wrong base',
      JSON.stringify({ date, base: 'usd', rates: validRates }),
      /mismatched date or base/
    ],
    [
      'undersized table',
      JSON.stringify({ date, base: 'eur', rates: validArchiveRates(99) }),
      /has only 99 currencies/
    ],
    [
      'invalid rate',
      JSON.stringify({ date, base: 'eur', rates: { ...validRates, usd: 0 } }),
      /contains invalid currency rates/
    ],
    [
      'wrong EUR self-rate',
      JSON.stringify({ date, base: 'eur', rates: { ...validRates, eur: 1.01 } }),
      /EUR self-rate must equal 1/
    ]
  ]

  for (const [label, raw, expected] of cases) {
    assert.throws(
      () => loadCommittedSameDaySnapshotFromHead(date, {
        execFile: () => raw
      }),
      expected,
      label
    )
  }
})

test('validate-package requires baseline metadata to contain every latest-prior archive code', (t) => {
  const temp = withTempPackage(t)
  const snapshotPath = path.join(temp.packageRoot, 'snapshots', 'base-rates.json')
  const snapshot = fs.readJsonSync(snapshotPath)
  const priorSource = snapshot.trustedCurrencyBaseline.sources
    .find((source) => source.kind === 'latest_prior_archive')

  assert.ok(priorSource)
  priorSource.currencyCodes = priorSource.currencyCodes.slice(1)
  fs.writeJsonSync(snapshotPath, snapshot, { spaces: '\t' })

  assert.throws(
    () => temp.validate(),
    /trusted currency baseline metadata must contain all latest prior archive codes/
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

function baselineUnion(sources) {
  return [...new Set(sources.flatMap((source) => source.currencyCodes))]
    .sort((left, right) => left.localeCompare(right))
}

function installSameDayBaseline(tempPackage, additions = []) {
  const snapshotPath = path.join(tempPackage, 'snapshots', 'base-rates.json')
  const snapshot = fs.readJsonSync(snapshotPath)
  const codes = [...new Set([...Object.keys(snapshot.rates), ...additions])]
    .sort((left, right) => left.localeCompare(right))
  const sameDaySource = {
    kind: 'same_day_committed_archive',
    date: snapshot.date,
    currencyCodes: codes
  }
  snapshot.trustedCurrencyBaseline.sources = [
    ...snapshot.trustedCurrencyBaseline.sources
      .filter((source) => source.kind !== 'same_day_committed_archive'),
    sameDaySource
  ]
  snapshot.trustedCurrencyBaseline.currencyCodes = baselineUnion(
    snapshot.trustedCurrencyBaseline.sources
  )
  fs.writeJsonSync(snapshotPath, snapshot, { spaces: '\t' })
  return committedSnapshotFromCodes(snapshot, codes)
}

function committedSnapshotFromCodes(snapshot, codes) {
  return {
    date: snapshot.date,
    base: 'eur',
    rates: Object.fromEntries(
      codes.map((code) => [code, snapshot.rates[code] ?? 1])
    )
  }
}

function validArchiveRates(count) {
  const rates = { eur: 1 }
  for (let index = 0; index < count - 1; index += 1) {
    rates[`x${String(index).padStart(3, '0')}`] = 1 + index / 1000
  }
  return rates
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
