const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { stripJsonComments } = require('../scripts/reliability-cockpit.js')

const wranglerPath = path.join(__dirname, '..', 'wrangler.jsonc')
const wrangler = JSON.parse(stripJsonComments(fs.readFileSync(wranglerPath, 'utf8')))
const runbook = fs.readFileSync(path.join(__dirname, '..', 'RUNBOOK.md'), 'utf8')
const requiredOcrSecrets = ['AZURE_OCR_KEY', 'ANTHROPIC_API_KEY', 'ZAI_API_KEY']
const selectedReceiptProvider = 'zai'
const selectedReceiptModel = 'glm-5.3-flash'

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

test('root Worker declares selected and retained OCR provider secrets for local dev and type generation', () => {
  assertExactRequiredSecrets(wrangler, 'root Worker')
})

test('named production Worker mirrors the local-dev and type-generation declaration', () => {
  assertExactRequiredSecrets(wrangler.env?.production, 'production Worker')
})

test('root and named production retain the selected receipt provider and model', () => {
  for (const [scope, config] of [
    ['root Worker', wrangler],
    ['production Worker', wrangler.env?.production],
  ]) {
    assert.equal(config?.vars?.LLM_SCAN_PROVIDER, selectedReceiptProvider, `${scope} provider`)
    assert.equal(config?.vars?.LLM_SCAN_MODEL, selectedReceiptModel, `${scope} model`)
    assert.equal('LLM_SCAN_AZURE_GRACE_MS' in config.vars, false, `${scope} grace override`)
  }
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
    /must declare exactly AZURE_OCR_KEY, ANTHROPIC_API_KEY, ZAI_API_KEY/
    )
  }
})

test('the optional LLM emergency stop is secret-managed and cannot be reset by source vars', () => {
  assert.equal('LLM_SCAN_KILL_SWITCH' in wrangler.vars, false)
  assert.equal('LLM_SCAN_KILL_SWITCH' in wrangler.env.production.vars, false)
  assert.match(
    runbook,
    /wrangler secret put LLM_SCAN_KILL_SWITCH[\s\\\n]+--config wrangler\.jsonc --env=""/,
  )
  assert.match(
    runbook,
    /wrangler secret delete LLM_SCAN_KILL_SWITCH --config wrangler\.jsonc --env=""/,
  )
})
