const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  buildBackfillSnapshots,
  main,
  parseArgs,
} = require('../scripts/backfill-history-snapshots')

test('parseArgs requires explicit date range and reference snapshot', () => {
  assert.throws(
    () => parseArgs(['--from', '2026-05-12', '--to', '2026-05-13']),
    /--reference is required/
  )
})

test('buildBackfillSnapshots returns complete snapshots with deterministic derivations', async () => {
  const snapshots = await buildBackfillSnapshots({
    dates: ['2026-05-12'],
    fetchImpl: fakeFxApiFetch({
      AUD: { '2026-05-12': 1.6 },
      DKK: { '2026-05-12': 7.46 },
      SSP: { '2026-05-12': 5400 },
      USD: { '2026-05-12': 1.08 },
    }),
    requiredCodes: ['aud', 'dkk', 'eur', 'fok', 'kid', 'ssp', 'tvd', 'usd'],
    timeoutMs: 1000,
  })

  assert.deepEqual(snapshots[0].missing, [])
  assert.equal(snapshots[0].rates.fok, 7.46)
  assert.equal(snapshots[0].rates.kid, 1.6)
  assert.equal(snapshots[0].rates.tvd, 1.6)
  assert.deepEqual(Object.keys(snapshots[0].rates), ['aud', 'dkk', 'eur', 'fok', 'kid', 'ssp', 'tvd', 'usd'])
})

test('main dry-run does not write snapshot files', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-backfill-dry-run-'))
  t.after(() => fs.rmSync(tempRoot, { force: true, recursive: true }))
  writeReference(tempRoot)

  const stdout = buffer()
  const stderr = buffer()
  const exitCode = await main({
    argv: [
      '--from',
      '2026-05-12',
      '--to',
      '2026-05-12',
      '--reference',
      'reference.json',
      '--output-dir',
      'snapshot-archive',
    ],
    cwd: tempRoot,
    fetchImpl: completeFetch(),
    stdout,
    stderr,
  })

  assert.equal(exitCode, 0)
  assert.match(stdout.text, /ready to write 1 complete snapshot/)
  assert.equal(stderr.text, '')
  assert.equal(fs.existsSync(path.join(tempRoot, 'snapshot-archive', '2026-05-12.json')), false)
})

test('main writes complete snapshot files when --write is passed', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-backfill-write-'))
  t.after(() => fs.rmSync(tempRoot, { force: true, recursive: true }))
  writeReference(tempRoot)

  const exitCode = await main({
    argv: [
      '--from',
      '2026-05-12',
      '--to',
      '2026-05-12',
      '--reference',
      'reference.json',
      '--output-dir',
      'snapshot-archive',
      '--write',
    ],
    cwd: tempRoot,
    fetchImpl: completeFetch(),
    stdout: buffer(),
    stderr: buffer(),
  })

  assert.equal(exitCode, 0)
  const snapshot = JSON.parse(fs.readFileSync(path.join(tempRoot, 'snapshot-archive', '2026-05-12.json'), 'utf8'))
  assert.equal(snapshot.date, '2026-05-12')
  assert.equal(snapshot.base, 'eur')
  assert.equal(snapshot.rates.fok, 7.46)
  assert.equal(snapshot.rates.kid, 1.6)
})

test('main refuses to write incomplete snapshots', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-backfill-incomplete-'))
  t.after(() => fs.rmSync(tempRoot, { force: true, recursive: true }))
  writeReference(tempRoot)

  const stderr = buffer()
  const exitCode = await main({
    argv: [
      '--from',
      '2026-05-12',
      '--to',
      '2026-05-12',
      '--reference',
      'reference.json',
      '--output-dir',
      'snapshot-archive',
      '--write',
    ],
    cwd: tempRoot,
    fetchImpl: fakeFxApiFetch({
      AUD: { '2026-05-12': 1.6 },
      DKK: { '2026-05-12': 7.46 },
      USD: { '2026-05-12': 1.08 },
    }),
    stdout: buffer(),
    stderr,
  })

  assert.equal(exitCode, 2)
  assert.match(stderr.text, /missing=ssp/)
  assert.equal(fs.existsSync(path.join(tempRoot, 'snapshot-archive', '2026-05-12.json')), false)
})

function completeFetch() {
  return fakeFxApiFetch({
    AUD: { '2026-05-12': 1.6 },
    DKK: { '2026-05-12': 7.46 },
    SSP: { '2026-05-12': 5400 },
    USD: { '2026-05-12': 1.08 },
  })
}

function fakeFxApiFetch(historyByTarget) {
  return async (url) => {
    const target = url.match(/\/EUR\/([A-Z]{3})\.json/)?.[1]
    const targetHistory = historyByTarget[target] || {}
    return {
      ok: true,
      json: async () => ({
        rates: Object.entries(targetHistory).map(([date, rate]) => ({ date, rate })),
      }),
    }
  }
}

function writeReference(root) {
  fs.writeFileSync(
    path.join(root, 'reference.json'),
    JSON.stringify({
      date: '2026-05-24',
      base: 'eur',
      rates: {
        aud: 1.6,
        dkk: 7.46,
        eur: 1,
        fok: 7.46,
        kid: 1.6,
        ssp: 5400,
        tvd: 1.6,
        usd: 1.08,
      },
    })
  )
}

function buffer() {
  return {
    text: '',
    write(chunk) {
      this.text += chunk
    },
  }
}
