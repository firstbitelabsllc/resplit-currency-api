const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { stripJsonComments } = require('../scripts/reliability-cockpit.js')

const wranglerPath = path.join(__dirname, '..', 'wrangler.jsonc')
const wrangler = JSON.parse(stripJsonComments(fs.readFileSync(wranglerPath, 'utf8')))
const requiredOcrSecrets = ['AZURE_OCR_KEY', 'ANTHROPIC_API_KEY']

function assertExactRequiredSecrets(config, scope) {
  const required = config?.secrets?.required
  const exactMatch = Array.isArray(required)
    && required.length === requiredOcrSecrets.length
    && required.every((name, index) => name === requiredOcrSecrets[index])

  assert.ok(
    exactMatch,
    `${scope} must declare exactly ${requiredOcrSecrets.join(', ')}`
  )
}

test('root Worker declares both OCR provider secrets for local dev and type generation', () => {
  assertExactRequiredSecrets(wrangler, 'root Worker')
})

test('named production Worker mirrors the local-dev and type-generation declaration', () => {
  assertExactRequiredSecrets(wrangler.env?.production, 'production Worker')
})

test('required-secret declaration rejects omission, substitution, or extras', () => {
  for (const invalid of [
    ['AZURE_OCR_KEY'],
    ['ANTHROPIC_API_KEY'],
    ['AZURE_OCR_KEY', 'ANTHROPIC_API_TOKEN'],
    ['AZURE_OCR_KEY', 'ANTHROPIC_API_KEY', 'UNRELATED_SECRET'],
  ]) {
    assert.throws(
      () => assertExactRequiredSecrets({ secrets: { required: invalid } }, 'mutated Worker'),
      /must declare exactly AZURE_OCR_KEY, ANTHROPIC_API_KEY/
    )
  }
})
