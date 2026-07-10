const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { stripJsonComments } = require('../scripts/reliability-cockpit.js')

const wranglerPath = path.join(__dirname, '..', 'wrangler.jsonc')
const wrangler = JSON.parse(stripJsonComments(fs.readFileSync(wranglerPath, 'utf8')))
const expectedBinding = {
  name: 'OCR_ACCOUNTING',
  class_name: 'OcrAccounting',
}

function assertAccountingConfig(config) {
  assert.equal(
    config.main,
    'worker/src/worker-entry.mjs',
    'the Workers-only entrypoint must export OcrAccounting without breaking Node imports of index.mjs'
  )
  assert.equal(config.vars?.OCR_ACCOUNTING_MODE, 'legacy', 'root accounting mode must stay dark')
  assert.equal(
    config.env?.production?.vars?.OCR_ACCOUNTING_MODE,
    'legacy',
    'named production accounting mode must stay dark'
  )

  const rootBindings = config.durable_objects?.bindings
  const productionBindings = config.env?.production?.durable_objects?.bindings
  assert.deepEqual(rootBindings, [expectedBinding], 'root must expose exactly the dark accounting binding')
  assert.deepEqual(
    productionBindings,
    rootBindings,
    'named production must repeat the non-inherited root accounting binding exactly'
  )

  const migration = config.migrations?.find((candidate) => candidate.tag === 'ocr-accounting-sqlite-v1')
  assert.deepEqual(
    migration,
    {
      tag: 'ocr-accounting-sqlite-v1',
      new_sqlite_classes: ['OcrAccounting'],
    },
    'the permanent SQLite Durable Object migration must remain in top-level history'
  )
  assert.equal(
    config.env?.production?.migrations,
    undefined,
    'named production must inherit top-level migration history instead of overriding it'
  )
}

function clone(value) {
  return structuredClone(value)
}

test('root and named production keep the dark accounting mode, binding, and permanent migration aligned', () => {
  assertAccountingConfig(wrangler)
})

test('accounting config contract rejects mode, binding, entrypoint, and migration mutations', () => {
  const mutations = [
    (config) => { config.main = 'worker/src/index.mjs' },
    (config) => { config.vars.OCR_ACCOUNTING_MODE = 'enforce' },
    (config) => { config.env.production.vars.OCR_ACCOUNTING_MODE = 'shadow' },
    (config) => { config.durable_objects.bindings = [] },
    (config) => { config.env.production.durable_objects.bindings[0].class_name = 'OtherClass' },
    (config) => { config.migrations[0].new_sqlite_classes = [] },
    (config) => { config.env.production.migrations = [] },
  ]

  for (const mutate of mutations) {
    const candidate = clone(wrangler)
    mutate(candidate)
    assert.throws(() => assertAccountingConfig(candidate))
  }
})

module.exports = { assertAccountingConfig }
