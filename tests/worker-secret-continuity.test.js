const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const scriptPath = path.join(__dirname, '..', 'scripts', 'worker-secret-continuity.js')

const requiredOcrSecrets = ['AZURE_OCR_KEY', 'ANTHROPIC_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY']

test('continuity check accepts all required deployed Worker secrets by exact name and type', () => {
  const result = spawnSync(process.execPath, [scriptPath, ...requiredOcrSecrets], {
    input: JSON.stringify([
      { name: 'SENTRY_DSN', type: 'secret_text' },
      { name: 'AZURE_OCR_KEY', type: 'secret_text' },
      { name: 'ANTHROPIC_API_KEY', type: 'secret_text', value: 'must-not-be-logged' },
      { name: 'ZAI_API_KEY', type: 'secret_text', value: 'must-not-be-logged' },
      { name: 'OPENROUTER_API_KEY', type: 'secret_text', value: 'openrouter-must-not-be-logged' },
    ]),
    encoding: 'utf8',
  })

  assert.equal(result.status, 0)
  assert.match(
    result.stdout,
    /continuity preserved: AZURE_OCR_KEY, ANTHROPIC_API_KEY, ZAI_API_KEY, OPENROUTER_API_KEY exist on the deployed Worker/
  )
  assert.doesNotMatch(result.stdout, /secret_text/)
  assert.doesNotMatch(result.stdout, /SENTRY_DSN|must-not-be-logged/)
  assert.equal(result.stderr, '')
})

test('continuity check fails closed when any required deployed secret is absent or mistyped', () => {
  for (const { entries, missing } of [
    ...requiredOcrSecrets.flatMap((missing) => [
      {
        entries: requiredOcrSecrets.filter((name) => name !== missing)
          .map((name) => ({ name, type: 'secret_text', value: 'must-not-be-logged' })),
        missing,
      },
      {
        entries: requiredOcrSecrets.map((name) => ({
          name,
          type: name === missing ? 'plain_text' : 'secret_text',
          value: 'must-not-be-logged',
        })),
        missing,
      },
    ]),
    {
      entries: requiredOcrSecrets.map((name) => ({
        name: name === 'OPENROUTER_API_KEY' ? 'OPENROUTER_API_TOKEN' : name,
        type: 'secret_text',
        value: 'must-not-be-logged',
      })),
      missing: 'OPENROUTER_API_KEY',
    },
  ]) {
    const result = spawnSync(process.execPath, [scriptPath, ...requiredOcrSecrets], {
      input: JSON.stringify(entries),
      encoding: 'utf8',
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, new RegExp(`required Worker secret is absent: ${missing}`))
    assert.doesNotMatch(result.stderr, /secret_text|plain_text/)
    assert.doesNotMatch(result.stdout + result.stderr, /must-not-be-logged/)
    assert.equal(result.stdout, '')
  }
})

test('continuity check fails closed on malformed or non-array inventory', () => {
  for (const input of ['not-json', '{}']) {
    const result = spawnSync(process.execPath, [scriptPath, ...requiredOcrSecrets], {
      input,
      encoding: 'utf8',
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /unable to verify deployed Worker secret continuity/)
  }
})

test('continuity check requires one or more unique non-empty secret names', () => {
  for (const args of [[], [''], ['AZURE_OCR_KEY', ''], ['AZURE_OCR_KEY', 'AZURE_OCR_KEY']]) {
    const result = spawnSync(process.execPath, [scriptPath, ...args], {
      input: '[]',
      encoding: 'utf8',
    })

    assert.equal(result.status, 2)
    assert.match(result.stderr, /usage: worker-secret-continuity\.js <SECRET_NAME> \[SECRET_NAME \.\.\.\]/)
  }
})
