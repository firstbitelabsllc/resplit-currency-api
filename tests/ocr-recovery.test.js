import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { handleOcr, computeRecovery } from '../worker/src/ocr/router.mjs'

// Per-scan recovery telemetry: what the vision-LLM leg catches that Azure's prebuilt
// parse misses — the pro-tier AI-scan product signal. Two layers under test:
//   1. computeRecovery(azure, llm) — the pure presence-pair + delta computation.
//   2. The Analytics Engine datapoint written per fresh scan (guarded, cache-miss only).

// --- Fixtures for the pure computation ----------------------------------------
function azureLeg({ merchant = true, date = true, total = 10, tax = true, tip = false, items = 2 } = {}) {
  const fields = {}
  if (merchant) fields.MerchantName = { type: 'string', valueString: 'Cafe Test' }
  if (date) fields.TransactionDate = { type: 'date', valueDate: '2026-07-05' }
  if (total != null) fields.Total = { type: 'currency', valueCurrency: { amount: total, currencyCode: 'USD' } }
  if (tax) fields.TotalTax = { type: 'currency', valueCurrency: { amount: 1, currencyCode: 'USD' } }
  if (tip) fields.Tip = { type: 'currency', valueCurrency: { amount: 2, currencyCode: 'USD' } }
  fields.Items = { type: 'array', valueArray: Array.from({ length: items }, () => ({ type: 'object', valueObject: {} })) }
  return { status: 'succeeded', raw: { status: 'succeeded', analyzeResult: { documents: [{ docType: 'receipt', fields }] } }, latencyMs: 100 }
}

function llmLeg({ merchant = 'Cafe Test', date = '2026-07-05', total = 10, extras = [{ label: 'Tax', amount: 1, kind: 'tax' }], items = 2 } = {}) {
  return {
    status: 'succeeded', provider: 'anthropic', model: 'claude-sonnet-5', latencyMs: 200,
    scanned: {
      merchantName: merchant, merchantAddress: null, transactionDate: date,
      currencyCode: 'USD', currencySymbol: '$',
      lineItems: Array.from({ length: items }, (_, i) => ({ name: `Item ${i}`, amount: 1, quantity: 1 })),
      subtotal: total - 1, total, extras,
    },
  }
}

test('computeRecovery flags a tip the LLM caught but Azure missed as llmOnly', () => {
  // Azure has no tip field; LLM extras carry a tip. tip.llmOnly must be true.
  const r = computeRecovery(
    azureLeg({ tip: false }),
    llmLeg({ extras: [{ label: 'Tax', amount: 1, kind: 'tax' }, { label: 'Tip', amount: 2, kind: 'tip' }] }),
  )
  assert.deepEqual(r.merchant, { azure: true, llm: true, llmOnly: false })
  assert.deepEqual(r.date, { azure: true, llm: true, llmOnly: false })
  assert.deepEqual(r.total, { azure: true, llm: true, llmOnly: false })
  assert.deepEqual(r.tax, { azure: true, llm: true, llmOnly: false })
  assert.deepEqual(r.tip, { azure: false, llm: true, llmOnly: true })
  assert.equal(r.llmOnlyFieldCount, 1)
})

test('computeRecovery counts extra line items the LLM read beyond Azure', () => {
  const r = computeRecovery(azureLeg({ items: 2 }), llmLeg({ items: 5 }))
  assert.equal(r.azureItems, 2)
  assert.equal(r.llmItems, 5)
  assert.equal(r.itemsDelta, 3)
})

test('computeRecovery clamps itemsDelta to 0 when the LLM read fewer items (not recovery)', () => {
  const r = computeRecovery(azureLeg({ items: 4 }), llmLeg({ items: 1 }))
  assert.equal(r.itemsDelta, 0)
})

test('computeRecovery with a failed Azure leg attributes every present field to the LLM', () => {
  // Azure raw null (provider_error) → all azure presence false; a full LLM read →
  // all five fields are llm-only. This is the maximal-recovery scan.
  const r = computeRecovery(
    { status: 'provider_error', raw: null, latencyMs: null },
    llmLeg({ extras: [{ label: 'Tax', amount: 1, kind: 'tax' }, { label: 'Tip', amount: 2, kind: 'tip' }] }),
  )
  assert.equal(r.merchant.llmOnly, true)
  assert.equal(r.date.llmOnly, true)
  assert.equal(r.tax.llmOnly, true)
  assert.equal(r.tip.llmOnly, true)
  assert.equal(r.total.llmOnly, true)
  assert.equal(r.llmOnlyFieldCount, 5)
  assert.equal(r.azureItems, 0)
})

test('computeRecovery with a failed LLM leg reports no recovery', () => {
  // scanned null → all llm presence false → nothing is llm-only, itemsDelta 0.
  const r = computeRecovery(azureLeg({ items: 3 }), { status: 'provider_error', scanned: null, model: 'claude-sonnet-5', latencyMs: null })
  assert.equal(r.merchant.llm, false)
  assert.equal(r.llmOnlyFieldCount, 0)
  assert.equal(r.azureItems, 3)
  assert.equal(r.llmItems, 0)
  assert.equal(r.itemsDelta, 0)
})

test('computeRecovery reports no llm-only fields when both legs agree on presence', () => {
  const r = computeRecovery(azureLeg({ tip: true }), llmLeg({ extras: [{ label: 'Tax', amount: 1, kind: 'tax' }, { label: 'Tip', amount: 2, kind: 'tip' }] }))
  assert.equal(r.llmOnlyFieldCount, 0)
  assert.equal(r.tip.azure, true)
  assert.equal(r.tip.llm, true)
})

// --- Analytics Engine datapoint (integration through handleOcr) ----------------
function makeKV() {
  const store = new Map()
  return { store, async get(k) { return store.has(k) ? store.get(k) : null }, async put(k, v) { store.set(k, v) }, async delete(k) { store.delete(k) } }
}
function makeAE() {
  const points = []
  return { points, writeDataPoint(p) { points.push(p) } }
}
function makeEnv(extra = {}) {
  return {
    ATTEST_KV: makeKV(),
    AZURE_OCR_ENDPOINT: 'https://test.cognitiveservices.azure.com',
    AZURE_OCR_KEY: 'test-key',
    SENTRY_ENVIRONMENT: 'test',
    LLM_SCAN_MODEL: 'claude-sonnet-5',
    LLM_SCAN_ALLOWED_KEY_IDS: '',
    LLM_SCAN_DAILY_CAP: '50',
    ...extra,
  }
}
let calls
const realFetch = globalThis.fetch
beforeEach(() => { calls = { azureSubmit: 0, azurePoll: 0, anthropic: 0 } })
afterEach(() => { globalThis.fetch = realFetch })

function analyzeRequest(imageBytes) {
  return new Request('https://fx.resplit.app/ocr/analyze', {
    method: 'POST', headers: { 'content-type': 'image/jpeg', 'x-resplit-attest-soft-fail': 'true' }, body: imageBytes,
  })
}
function dualScanRequest(imageBytes) {
  return new Request('https://fx.resplit.app/ocr/dual-scan', {
    method: 'POST', headers: { 'content-type': 'image/jpeg', 'x-resplit-attest-soft-fail': 'true' }, body: imageBytes,
  })
}
function azureRaw() {
  return {
    status: 'succeeded',
    analyzeResult: { documents: [{ docType: 'receipt', fields: {
      MerchantName: { type: 'string', valueString: 'Cafe Test' },
      TransactionDate: { type: 'date', valueDate: '2026-07-05' },
      Total: { type: 'currency', valueCurrency: { amount: 10, currencyCode: 'USD' } },
      TotalTax: { type: 'currency', valueCurrency: { amount: 1, currencyCode: 'USD' } },
      Items: { type: 'array', valueArray: [{ type: 'object', valueObject: {} }] },
    } }] },
  }
}
function anthropicToolResponse() {
  return {
    id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
    content: [{ type: 'tool_use', id: 'toolu_test', name: 'emit_receipt', input: {
      merchantName: 'Cafe Test', merchantAddress: null, transactionDate: '2026-07-05',
      currencyCode: 'USD', currencySymbol: '$',
      lineItems: [{ name: 'Coffee', amount: 9, quantity: 1 }, { name: 'Tip line', amount: 2, quantity: 1 }],
      subtotal: 9, total: 12, extras: [{ label: 'Tax', amount: 1, kind: 'tax' }, { label: 'Tip', amount: 2, kind: 'tip' }],
    } }],
    stop_reason: 'tool_use',
  }
}
function stubProviders({ anthropicStatus = 200 } = {}) {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (u === 'https://api.anthropic.com/v1/messages') {
      calls.anthropic++
      if (anthropicStatus !== 200) return new Response('boom', { status: anthropicStatus })
      return Response.json(anthropicToolResponse(), { status: 200 })
    }
    if (init.method === 'POST' && u.includes(':analyze')) {
      calls.azureSubmit++
      return new Response('', { status: 202, headers: { 'operation-location': 'https://test.cognitiveservices.azure.com/documentintelligence/documentModels/prebuilt-receipt/analyzeResults/op?api-version=2024-11-30' } })
    }
    if (u.includes('/analyzeResults/')) { calls.azurePoll++; return Response.json(azureRaw(), { status: 200 }) }
    throw new Error(`unexpected fetch ${init.method} ${u}`)
  }
}

test('/ocr/analyze writes one Analytics Engine datapoint per fresh scan (not on cache hit)', async () => {
  stubProviders()
  const ae = makeAE()
  const env = makeEnv({ ANTHROPIC_API_KEY: 'anthropic-key', LLM_SCAN_ALLOW_SOFT_FAIL: 'true', OCR_SCAN_ANALYTICS: ae })
  const image = new Uint8Array([1, 2, 3])

  await handleOcr(analyzeRequest(image), env)
  assert.equal(ae.points.length, 1, 'one datapoint on the fresh scan')
  const p = ae.points[0]
  assert.deepEqual(p.indexes, ['1'], 'llmReasoning=true partitions as index 1')
  assert.equal(p.blobs[1], 'analyze', 'route is tagged in blobs')
  assert.equal(p.blobs[2], 'succeeded', 'scan status in blobs')
  assert.equal(p.blobs[4], 'claude-sonnet-5', 'model in blobs')
  // doubles: [azureItems, llmItems, itemsDelta, llmOnlyFieldCount, recoveredAmount, azureMs, llmMs, totalMs]
  assert.equal(p.doubles[0], 1, 'azureItems')
  assert.equal(p.doubles[1], 2, 'llmItems')
  assert.equal(p.doubles[2], 1, 'itemsDelta (2 - 1)')
  assert.equal(p.doubles[3], 1, 'llmOnlyFieldCount (LLM recovered the tip)')
  assert.equal(p.doubles[4], 2, 'llmRecoveredAmount (llm 12 - azure 10)')
  assert.equal(p.doubles.length, 8)

  // Second request, SAME image → cache hit → NO new datapoint (avoids double-count).
  await handleOcr(analyzeRequest(image), env)
  assert.equal(ae.points.length, 1, 'a cache hit must not emit a second datapoint')
})

test('/ocr/dual-scan tags its own route in the Analytics Engine datapoint', async () => {
  stubProviders()
  const ae = makeAE()
  const env = makeEnv({ ANTHROPIC_API_KEY: 'anthropic-key', LLM_SCAN_ALLOW_SOFT_FAIL: 'true', OCR_SCAN_ANALYTICS: ae })
  await handleOcr(dualScanRequest(new Uint8Array([4, 4, 4])), env)
  assert.equal(ae.points.length, 1)
  assert.equal(ae.points[0].blobs[1], 'dual-scan')
})

test('a failed LLM leg still records a datapoint, partitioned as non-reasoned (index 0)', async () => {
  stubProviders({ anthropicStatus: 500 })
  const ae = makeAE()
  const env = makeEnv({ ANTHROPIC_API_KEY: 'anthropic-key', LLM_SCAN_ALLOW_SOFT_FAIL: 'true', OCR_SCAN_ANALYTICS: ae })
  await handleOcr(analyzeRequest(new Uint8Array([5, 5, 5])), env)
  assert.equal(ae.points.length, 1)
  assert.deepEqual(ae.points[0].indexes, ['0'], 'a failed AI leg is not "reasoned"')
  assert.equal(ae.points[0].blobs[2], 'partial')
  assert.equal(ae.points[0].doubles[3], 0, 'no llm-only fields when the LLM leg failed')
})

test('scans run cleanly with no Analytics Engine binding bound (write is a no-op)', async () => {
  stubProviders()
  const env = makeEnv({ ANTHROPIC_API_KEY: 'anthropic-key', LLM_SCAN_ALLOW_SOFT_FAIL: 'true' }) // no OCR_SCAN_ANALYTICS
  const res = await handleOcr(analyzeRequest(new Uint8Array([6, 6, 6])), env)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.status, 'succeeded')
})
