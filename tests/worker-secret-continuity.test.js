const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const scriptPath = path.join(__dirname, '..', 'scripts', 'worker-secret-continuity.js')

test('continuity check accepts an existing deployed Worker secret by exact name', () => {
  const result = spawnSync(process.execPath, [scriptPath, 'AZURE_OCR_KEY'], {
    input: JSON.stringify([
      { name: 'SENTRY_DSN', type: 'secret_text' },
      { name: 'AZURE_OCR_KEY', type: 'secret_text' },
    ]),
    encoding: 'utf8',
  })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /continuity preserved: AZURE_OCR_KEY exists on the deployed Worker/)
  assert.doesNotMatch(result.stdout, /secret_text/)
})

test('continuity check fails closed when the required deployed secret is absent', () => {
  const result = spawnSync(process.execPath, [scriptPath, 'AZURE_OCR_KEY'], {
    input: JSON.stringify([{ name: 'SENTRY_DSN', type: 'secret_text' }]),
    encoding: 'utf8',
  })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /required Worker secret is absent: AZURE_OCR_KEY/)
  assert.doesNotMatch(result.stderr, /SENTRY_DSN/)
})

test('continuity check fails closed on malformed or non-array inventory', () => {
  for (const input of ['not-json', '{}']) {
    const result = spawnSync(process.execPath, [scriptPath, 'AZURE_OCR_KEY'], {
      input,
      encoding: 'utf8',
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /unable to verify deployed Worker secret continuity/)
  }
})

test('continuity check requires exactly one non-empty secret name', () => {
  for (const args of [[], ['', 'EXTRA']]) {
    const result = spawnSync(process.execPath, [scriptPath, ...args], {
      input: '[]',
      encoding: 'utf8',
    })

    assert.equal(result.status, 2)
    assert.match(result.stderr, /usage: worker-secret-continuity\.js <SECRET_NAME>/)
  }
})
