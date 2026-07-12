import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
  handleOcr,
  isLegacyPartialCompatibilityVersion,
  mapLegacyPartialCompatibilityCandidate,
} from '../worker/src/ocr/router.mjs'

const require = createRequire(import.meta.url)
const { stripJsonComments } = require('../scripts/reliability-cockpit.js')
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const realFetch = globalThis.fetch

const CURRENCY = {
  USD: { symbol: '$', scale: 100 },
  EUR: { symbol: '€', scale: 100 },
  JPY: { symbol: '¥', scale: 1 },
}

function money(amount, currencyCode, content = null) {
  return {
    type: 'currency',
    content: content ?? `${CURRENCY[currencyCode]?.symbol ?? ''}${amount}`,
    valueCurrency: { amount, currencyCode },
  }
}

function azureReceipt({
  currencyCode = 'USD',
  subtotal = 900,
  tax = 100,
  tip = 0,
  total = 1000,
  items = [
    { name: 'Dinner A', amount: 400, quantity: 1 },
    { name: 'Dinner B', amount: 500, quantity: 1 },
  ],
} = {}) {
  const fields = {
    MerchantName: { type: 'string', valueString: 'Compatibility Bistro' },
    MerchantAddress: { type: 'string', content: '1 Test Way' },
    TransactionDate: { type: 'date', valueDate: '2026-07-10' },
    Items: {
      type: 'array',
      valueArray: items.map((item) => ({
        type: 'object',
        valueObject: {
          Description: { type: 'string', valueString: item.name },
          TotalPrice: money(item.amount, currencyCode),
          Quantity: { type: 'number', valueNumber: item.quantity },
        },
      })),
    },
    Subtotal: money(subtotal, currencyCode),
    TotalTax: money(tax, currencyCode),
    Total: money(total, currencyCode),
  }
  if (tip !== 0) fields.Tip = money(tip, currencyCode)
  return {
    status: 'succeeded',
    analyzeResult: {
      documents: [{ docType: 'receipt', fields }],
    },
  }
}

function expectedScanned(currencyCode, overrides = {}) {
  return {
    merchantName: 'Compatibility Bistro',
    merchantAddress: '1 Test Way',
    transactionDate: '2026-07-10',
    currencyCode,
    currencySymbol: CURRENCY[currencyCode].symbol,
    lineItems: [
      { name: 'Dinner A', amount: 400, quantity: 1 },
      { name: 'Dinner B', amount: 500, quantity: 1 },
    ],
    subtotal: 900,
    total: 1000,
    extras: [{ label: 'Tax', amount: 100, kind: 'tax' }],
    ...overrides,
  }
}

function makeKV() {
  const store = new Map()
  const calls = { get: [], put: [], delete: [] }
  return {
    calls,
    store,
    async get(key) {
      calls.get.push(key)
      return store.has(key) ? store.get(key) : null
    },
    async put(key, value) {
      calls.put.push(key)
      store.set(key, value)
    },
    async delete(key) {
      calls.delete.push(key)
      store.delete(key)
    },
  }
}

function makeAccounting() {
  const calls = { idFromName: 0, get: 0, reserve: 0 }
  const namespace = {
    idFromName(name) {
      calls.idFromName += 1
      assert.equal(name, 'ocr-accounting-global-v1')
      return name
    },
    get(id) {
      calls.get += 1
      assert.equal(id, 'ocr-accounting-global-v1')
      return {
        async reserve(request) {
          calls.reserve += 1
          return {
            ok: true,
            azure: { allowed: true },
            anthropic: { allowed: true },
            usage: {
              global: { azureUnits: request.azureUnits, anthropicUnits: request.anthropicUnits },
              subject: { azureUnits: request.azureUnits, anthropicUnits: request.anthropicUnits },
            },
          }
        },
      }
    },
  }
  return { calls, namespace }
}

function makeContext() {
  const tasks = []
  return {
    tasks,
    waitUntil(task) { tasks.push(task) },
  }
}

function makeEnv({ shadow = false } = {}) {
  const accounting = makeAccounting()
  return {
    env: {
      ATTEST_KV: makeKV(),
      AZURE_OCR_ENDPOINT: 'https://test.cognitiveservices.azure.com',
      AZURE_OCR_KEY: 'azure-test-key',
      ANTHROPIC_API_KEY: 'anthropic-test-key',
      LLM_SCAN_ALLOW_SOFT_FAIL: 'true',
      LLM_SCAN_DAILY_CAP: '3000',
      OCR_ACCOUNTING_MODE: 'shadow',
      OCR_ACCOUNTING_HMAC_KEY: '0123456789abcdef0123456789abcdef',
      OCR_ACCOUNTING: accounting.namespace,
      OCR_LEGACY_PARTIAL_COMPAT_SHADOW: shadow ? 'true' : 'false',
      SENTRY_ENVIRONMENT: 'test',
      SENTRY_RELEASE: 'legacy-shadow-test',
    },
    accounting,
  }
}

function dualScanRequest(imageBytes, clientVersion) {
  return new Request('https://fx.resplit.app/ocr/dual-scan', {
    method: 'POST',
    headers: {
      'content-type': 'image/jpeg',
      'x-resplit-attest-soft-fail': 'true',
      'x-resplit-client-version': clientVersion,
    },
    body: imageBytes,
  })
}

function stubPartialProviders(raw = azureReceipt({
  currencyCode: 'USD', subtotal: 9, tax: 1, total: 10,
  items: [{ name: 'Dinner A', amount: 4, quantity: 1 }, { name: 'Dinner B', amount: 5, quantity: 1 }],
})) {
  const calls = { azureSubmit: 0, azurePoll: 0, anthropic: 0 }
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url)
    if (target === 'https://api.anthropic.com/v1/messages') {
      calls.anthropic += 1
      throw new Error('receipt total $10 must not leak')
    }
    if (init.method === 'POST' && target.includes(':analyze')) {
      calls.azureSubmit += 1
      return new Response('', {
        status: 202,
        headers: {
          'operation-location': 'https://test.cognitiveservices.azure.com/documentintelligence/documentModels/prebuilt-receipt/analyzeResults/op-legacy?api-version=2024-11-30',
        },
      })
    }
    if (target.includes('/analyzeResults/')) {
      calls.azurePoll += 1
      return Response.json(raw, { status: 200 })
    }
    throw new Error(`unexpected fetch ${init.method} ${target}`)
  }
  return calls
}

async function runPartial({ shadow, clientVersion, imageByte }) {
  const providers = stubPartialProviders()
  const { env, accounting } = makeEnv({ shadow })
  const ctx = makeContext()
  const lines = []
  const originalLog = console.log
  const originalWarn = console.warn
  console.log = (line) => lines.push(line)
  console.warn = (line) => lines.push(line)
  try {
    const response = await handleOcr(
      dualScanRequest(new Uint8Array([
        0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08,
        0x02, 0x58, 0x03, 0x20, 0x03,
        0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
        imageByte,
      ]), clientVersion),
      env,
      ctx,
    )
    await Promise.all(ctx.tasks)
    const responseText = await response.text()
    return {
      response,
      responseText,
      body: JSON.parse(responseText),
      providers,
      accounting: accounting.calls,
      kv: env.ATTEST_KV.calls,
      events: lines
        .filter((line) => typeof line === 'string' && line.startsWith('[OCR_MONITORING] '))
        .map((line) => JSON.parse(line.replace('[OCR_MONITORING] ', ''))),
    }
  } finally {
    console.log = originalLog
    console.warn = originalWarn
  }
}

beforeEach(() => { globalThis.fetch = realFetch })
afterEach(() => { globalThis.fetch = realFetch })

test('only the exact active vulnerable build headers enter compatibility classification', () => {
  for (const version of ['2.0.0+3798', '2.0.0+3801', '2.0.0+3811']) {
    assert.equal(isLegacyPartialCompatibilityVersion(version), true, version)
  }
  for (const nearMiss of [
    '2.0.0+3797', '2.0.0+3812', '2.0.1+3798', '2.0.0+3811 ',
    ' 2.0.0+3811', '2.0.0+3811/debug', '3811', '', null,
  ]) {
    assert.equal(isLegacyPartialCompatibilityVersion(nearMiss), false, String(nearMiss))
  }
})

test('the pure mapper produces complete USD, EUR, and JPY candidates with one-minor-unit arithmetic tolerance', () => {
  const fixtures = [
    { currencyCode: 'USD', total: 1000.01, expected: expectedScanned('USD', { total: 1000.01 }) },
    { currencyCode: 'EUR', total: 1000.01, expected: expectedScanned('EUR', { total: 1000.01 }) },
    { currencyCode: 'JPY', total: 1001, expected: expectedScanned('JPY', { total: 1001 }) },
  ]

  for (const fixture of fixtures) {
    const mapped = mapLegacyPartialCompatibilityCandidate(azureReceipt(fixture))
    assert.equal(mapped.outcome, 'candidate', fixture.currencyCode)
    assert.equal(mapped.reason, 'arithmetic_verified', fixture.currencyCode)
    assert.deepEqual(mapped.scanned, fixture.expected, fixture.currencyCode)
  }
})

test('the mapper rejects two-minor-unit drift and missing or ambiguous money fields', () => {
  const twoMinorUnits = mapLegacyPartialCompatibilityCandidate(azureReceipt({ total: 1000.02 }))
  assert.deepEqual(twoMinorUnits, { outcome: 'rejected', reason: 'arithmetic_mismatch', scanned: null })

  const missingTotalRaw = azureReceipt()
  delete missingTotalRaw.analyzeResult.documents[0].fields.Total
  assert.deepEqual(
    mapLegacyPartialCompatibilityCandidate(missingTotalRaw),
    { outcome: 'rejected', reason: 'missing_total', scanned: null },
  )

  const ambiguousCurrencyRaw = azureReceipt()
  ambiguousCurrencyRaw.analyzeResult.documents[0].fields.Subtotal.valueCurrency.currencyCode = 'EUR'
  assert.deepEqual(
    mapLegacyPartialCompatibilityCandidate(ambiguousCurrencyRaw),
    { outcome: 'rejected', reason: 'ambiguous_currency', scanned: null },
  )

  const missingItemAmountRaw = azureReceipt()
  delete missingItemAmountRaw.analyzeResult.documents[0].fields.Items.valueArray[0].valueObject.TotalPrice
  assert.deepEqual(
    mapLegacyPartialCompatibilityCandidate(missingItemAmountRaw),
    { outcome: 'rejected', reason: 'missing_item_amount', scanned: null },
  )

  assert.deepEqual(
    mapLegacyPartialCompatibilityCandidate(azureReceipt({ currencyCode: 'GBP' })),
    { outcome: 'rejected', reason: 'unsupported_currency', scanned: null },
  )
})

test('the default-off root and named-production config preserve soft-fail while pinning the shadow rollback rail', () => {
  const wranglerPath = path.join(__dirname, '..', 'wrangler.jsonc')
  const wrangler = JSON.parse(stripJsonComments(fs.readFileSync(wranglerPath, 'utf8')))
  for (const [name, vars] of [
    ['root', wrangler.vars],
    ['named production', wrangler.env.production.vars],
  ]) {
    assert.equal(vars.LLM_SCAN_ALLOW_SOFT_FAIL, 'true', `${name} soft-fail must remain enabled`)
    assert.equal(vars.OCR_LEGACY_PARTIAL_COMPAT_SHADOW, 'false', `${name} shadow must default off`)
  }
})

test('enabled exact-build shadow emits one bounded candidate event without changing response, spend, accounting, or cache behavior', { concurrency: false }, async () => {
  const originalRandomUUID = globalThis.crypto.randomUUID
  const originalDateNow = Date.now
  globalThis.crypto.randomUUID = () => '11111111-1111-4111-8111-111111111111'
  Date.now = () => 1_789_000_000_000
  let off
  let on
  try {
    off = await runPartial({ shadow: false, clientVersion: '2.0.0+3798', imageByte: 7 })
    on = await runPartial({ shadow: true, clientVersion: '2.0.0+3798', imageByte: 7 })
  } finally {
    globalThis.crypto.randomUUID = originalRandomUUID
    Date.now = originalDateNow
  }

  for (const run of [off, on]) {
    assert.equal(run.response.status, 200)
    assert.equal(run.body.status, 'partial')
    assert.equal(run.body.azure.status, 'succeeded')
    assert.equal(run.body.llm.status, 'provider_error')
    assert.equal(run.body.llm.scanned, null)
    assert.equal(run.body.llmReasoning, false)
    assert.deepEqual(run.body.aiModels, ['azure-di-v4'])
  }

  assert.equal(on.responseText, off.responseText, 'shadow activation must not change one response byte')
  assert.deepEqual(on.providers, off.providers)
  assert.deepEqual(on.providers, { azureSubmit: 1, azurePoll: 1, anthropic: 1 })
  assert.deepEqual(on.accounting, off.accounting)
  assert.deepEqual(on.accounting, { idFromName: 1, get: 1, reserve: 1 })
  assert.deepEqual(on.kv.get, off.kv.get)
  assert.deepEqual(on.kv.put, off.kv.put)
  assert.equal(on.kv.put.some((key) => key.startsWith('cache:dualScan:')), false)

  assert.equal(off.events.filter((event) => event.signal === 'ocr_legacy_partial_compat_shadow').length, 0)
  const compatibilityEvents = on.events.filter((event) => event.signal === 'ocr_legacy_partial_compat_shadow')
  assert.equal(compatibilityEvents.length, 1)
  const event = compatibilityEvents[0]
  assert.equal(event.compatibility_outcome, 'candidate')
  assert.equal(event.compatibility_version, '2.0.0+3798')
  assert.equal(event.compatibility_reason, 'arithmetic_verified')
  assert.equal(event.llm_status, 'provider_error')
  assert.equal(event.route, 'dual-scan')
  assert.deepEqual(
    Object.keys(event).sort(),
    [
      'compatibility_outcome', 'compatibility_reason', 'compatibility_version',
      'domain', 'environment', 'llm_status', 'release', 'route', 'runtime',
      'signal', 'surface', 'timestamp',
    ].sort(),
  )
  assert.doesNotMatch(JSON.stringify(event), /Compatibility Bistro|Dinner A|Dinner B|1 Test Way|\$10|1000|USD|EUR|JPY|receipt total/)
})

test('near-miss versions never invoke or emit the compatibility shadow', { concurrency: false }, async () => {
  const run = await runPartial({ shadow: true, clientVersion: '2.0.0+3812', imageByte: 9 })
  assert.equal(run.body.status, 'partial')
  assert.equal(run.body.llm.status, 'provider_error')
  assert.equal(run.events.filter((event) => event.signal === 'ocr_legacy_partial_compat_shadow').length, 0)
})
