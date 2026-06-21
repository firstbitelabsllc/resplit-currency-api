const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  main,
  parseArgs,
  sortRatesByRequiredCodes,
} = require('../scripts/backfill-history-snapshots')

test('backfill writes complete fxapi pair-history snapshots with deterministic pegs', async (t) => {
  const tempRoot = createTempArchive(t)
  const output = createOutput()

  const exitCode = await main({
    argv: [
      '--from', '2026-05-12',
      '--to', '2026-05-13',
      '--reference', 'snapshot-archive/2026-05-14.json',
      '--timeout-ms', '1000',
    ],
    cwd: tempRoot,
    fetchImpl: fakeFxApiFetch({
      AUD: {
        '2026-05-12': 1.6,
        '2026-05-13': 1.61,
      },
      DKK: {
        '2026-05-12': 7.46,
        '2026-05-13': 7.47,
      },
      USD: {
        '2026-05-12': 1.08,
        '2026-05-13': 1.09,
      },
    }),
    stdout: output.stdout,
    stderr: output.stderr,
  })

  assert.equal(exitCode, 0)
  assert.match(output.readStdout(), /2026-05-12: wrote; count=7; derived=fok<-dkk,kid<-aud,tvd<-aud/)
  assert.equal(output.readStderr(), '')

  const snapshot = readSnapshot(tempRoot, '2026-05-12')
  assert.deepEqual(snapshot, {
    date: '2026-05-12',
    base: 'eur',
    rates: {
      aud: 1.6,
      dkk: 7.46,
      eur: 1,
      fok: 7.46,
      kid: 1.6,
      tvd: 1.6,
      usd: 1.08,
    },
  })
})

test('backfill dry-run proves writes without mutating the archive', async (t) => {
  const tempRoot = createTempArchive(t)
  const output = createOutput()

  const exitCode = await main({
    argv: [
      '--from', '2026-05-12',
      '--to', '2026-05-12',
      '--reference', 'snapshot-archive/2026-05-14.json',
      '--dry-run',
    ],
    cwd: tempRoot,
    fetchImpl: fakeFxApiFetch({
      AUD: { '2026-05-12': 1.6 },
      DKK: { '2026-05-12': 7.46 },
      USD: { '2026-05-12': 1.08 },
    }),
    stdout: output.stdout,
    stderr: output.stderr,
  })

  assert.equal(exitCode, 0)
  assert.match(output.readStdout(), /2026-05-12: would-write/)
  assert.equal(fs.existsSync(path.join(tempRoot, 'snapshot-archive', '2026-05-12.json')), false)
})

test('backfill blocks incomplete single-source snapshots', async (t) => {
  const tempRoot = createTempArchive(t)
  const output = createOutput()

  const exitCode = await main({
    argv: [
      '--from', '2026-05-12',
      '--to', '2026-05-12',
      '--reference', 'snapshot-archive/2026-05-14.json',
    ],
    cwd: tempRoot,
    fetchImpl: fakeFxApiFetch({
      AUD: { '2026-05-12': 1.6 },
      USD: { '2026-05-12': 1.08 },
    }),
    stdout: output.stdout,
    stderr: output.stderr,
  })

  assert.equal(exitCode, 2)
  assert.match(output.readStdout(), /2026-05-12: blocked; missing=dkk,fok/)
  assert.match(output.readStderr(), /1\/1 date\(s\) blocked/)
  assert.equal(fs.existsSync(path.join(tempRoot, 'snapshot-archive', '2026-05-12.json')), false)
})

test('backfill skips existing snapshots unless overwrite is explicit', async (t) => {
  const tempRoot = createTempArchive(t)
  writeSnapshot(tempRoot, '2026-05-12', { usd: 1 })
  const output = createOutput()

  const exitCode = await main({
    argv: [
      '--from', '2026-05-12',
      '--to', '2026-05-12',
      '--reference', 'snapshot-archive/2026-05-14.json',
    ],
    cwd: tempRoot,
    fetchImpl: async () => {
      throw new Error('fetch should not run for skipped files')
    },
    stdout: output.stdout,
    stderr: output.stderr,
  })

  assert.equal(exitCode, 0)
  assert.match(output.readStdout(), /2026-05-12: skipped-existing/)
  assert.deepEqual(readSnapshot(tempRoot, '2026-05-12').rates, { usd: 1 })
})

test('sortRatesByRequiredCodes preserves reference snapshot ordering', () => {
  assert.deepEqual(
    sortRatesByRequiredCodes({ usd: 1.08, eur: 1, aud: 1.6 }, ['aud', 'eur', 'usd']),
    {
      aud: 1.6,
      eur: 1,
      usd: 1.08,
    }
  )
})

test('parseArgs rejects impossible calendar dates', () => {
  assert.throws(
    () => parseArgs(['--from', '2026-02-31', '--to', '2026-03-01'], __dirname),
    /Invalid --from: 2026-02-31/
  )
})

function createTempArchive(t) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'currency-backfill-'))
  fs.mkdirSync(path.join(tempRoot, 'snapshot-archive'), { recursive: true })
  writeSnapshot(tempRoot, '2026-05-14', {
    aud: 1.62,
    dkk: 7.48,
    eur: 1,
    fok: 7.48,
    kid: 1.62,
    tvd: 1.62,
    usd: 1.1,
  })
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))
  return tempRoot
}

function writeSnapshot(root, date, rates) {
  fs.writeFileSync(
    path.join(root, 'snapshot-archive', `${date}.json`),
    JSON.stringify({ date, base: 'eur', rates })
  )
}

function readSnapshot(root, date) {
  return JSON.parse(fs.readFileSync(path.join(root, 'snapshot-archive', `${date}.json`), 'utf8'))
}

function createOutput() {
  let stdout = ''
  let stderr = ''
  return {
    stdout: {
      write: (chunk) => {
        stdout += chunk
      },
    },
    stderr: {
      write: (chunk) => {
        stderr += chunk
      },
    },
    readStdout: () => stdout,
    readStderr: () => stderr,
  }
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
