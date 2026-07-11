import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { handleOcr } from '../worker/src/ocr/router.mjs'
import { setOcrSentrySdkForTests, resetOcrSentrySdkForTests } from '../worker/src/ocr/monitoring.mjs'

// /ocr/analyze — the v2 N-engine envelope. Same auth/attest/caps/cache pipeline as
// /ocr/dual-scan (they share one internal implementation), rendered as the versioned
// engines[] shape. These tests exercise the shape and the cross-route cache boundary.

function makeKV() {
  const store = new Map()
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null },
    async put(k, v) { store.set(k, v) },
    async delete(k) { store.delete(k) },
  }
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

// A soft-fail request — with LLM_SCAN_ALLOW_SOFT_FAIL=true this reaches the paid LLM leg.
function analyzeRequest(imageBytes, headers = {}) {
  return new Request('https://fx.resplit.app/ocr/analyze', {
    method: 'POST',
    headers: { 'content-type': 'image/jpeg', 'x-resplit-attest-soft-fail': 'true', ...headers },
    body: imageBytes,
  })
}
function dualScanRequest(imageBytes, headers = {}) {
  return new Request('https://fx.resplit.app/ocr/dual-scan', {
    method: 'POST',
    headers: { 'content-type': 'image/jpeg', 'x-resplit-attest-soft-fail': 'true', ...headers },
    body: imageBytes,
  })
}

function azureRaw({ total = 10, tax = 1 } = {}) {
  return {
    status: 'succeeded',
    analyzeResult: {
      documents: [
        {
          docType: 'receipt',
          fields: {
            Total: { type: 'currency', valueCurrency: { amount: total, currencyCode: 'USD' } },
            TotalTax: { type: 'currency', valueCurrency: { amount: tax, currencyCode: 'USD' } },
          },
        },
      ],
    },
  }
}

function anthropicToolResponse(scanned) {
  return {
    id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
    content: [{ type: 'tool_use', id: 'toolu_test', name: 'emit_receipt', input: scanned }],
    stop_reason: 'tool_use',
  }
}

function scannedReceipt(overrides = {}) {
  return {
    merchantName: 'Cafe Test', merchantAddress: null, transactionDate: '2026-07-05',
    currencyCode: 'USD', currencySymbol: '$',
    lineItems: [{ name: 'Coffee', amount: 9, quantity: 1 }],
    subtotal: 9, total: 10, extras: [{ label: 'Tax', amount: 1, kind: 'tax' }],
    ...overrides,
  }
}

// Azure always succeeds; `anthropicStatus` lets a test fail the LLM leg (500).
function stubProviders({ azure = azureRaw(), scanned = scannedReceipt(), anthropicStatus = 200 } = {}) {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (u === 'https://api.anthropic.com/v1/messages') {
      calls.anthropic++
      if (anthropicStatus !== 200) return new Response('anthropic upstream boom', { status: anthropicStatus })
      return Response.json(anthropicToolResponse(scanned), { status: 200 })
    }
    if (init.method === 'POST' && u.includes(':analyze')) {
      calls.azureSubmit++
      return new Response('', {
        status: 202,
        headers: { 'operation-location': 'https://test.cognitiveservices.azure.com/documentintelligence/documentModels/prebuilt-receipt/analyzeResults/op-receipt?api-version=2024-11-30' },
      })
    }
    if (u.includes('/analyzeResults/')) {
      calls.azurePoll++
      return Response.json(azure, { status: 200 })
    }
    throw new Error(`unexpected fetch ${init.method} ${u}`)
  }
}

test('POST /ocr/analyze returns the exact v2 N-engine envelope on the happy path', async () => {
  stubProviders()
  const env = makeEnv({ ANTHROPIC_API_KEY: 'anthropic-key', LLM_SCAN_ALLOW_SOFT_FAIL: 'true' })
  const res = await handleOcr(analyzeRequest(new Uint8Array([1, 2, 3])), env)
  assert.equal(res.status, 200)
  const body = await res.json()

  assert.equal(body.v, 2)
  assert.equal(typeof body.scanId, 'string')
  assert.equal(body.status, 'succeeded')
  assert.equal(body.llmReasoning, true)
  assert.deepEqual(body.aiModels, ['azure-di-v4', 'claude-sonnet-5'])

  // engines[] — array so a third engine is an append, not a schema break.
  assert.equal(Array.isArray(body.engines), true)
  assert.equal(body.engines.length, 2)
  const azureEngine = body.engines.find((e) => e.id === 'azure')
  const llmEngine = body.engines.find((e) => e.id === 'llm')
  assert.equal(azureEngine.kind, 'ocr')
  assert.equal(azureEngine.provider, 'azure-di')
  assert.equal(azureEngine.model, 'prebuilt-receipt')
  assert.equal(azureEngine.status, 'succeeded')
  assert.equal(azureEngine.raw.analyzeResult.documents[0].fields.Total.valueCurrency.amount, 10)
  assert.equal(llmEngine.kind, 'vision-llm')
  assert.equal(llmEngine.provider, 'anthropic')
  assert.equal(llmEngine.model, 'claude-sonnet-5')
  assert.equal(llmEngine.status, 'succeeded')
  assert.equal(llmEngine.scanned.total, 10)

  // consensus = today's divergence object, inner field names preserved.
  assert.deepEqual(body.consensus, {
    totalsAgree: true, azureTotal: 10, llmTotal: 10, extrasKindsDelta: [], llmRecoveredAmount: 0,
  })

  // No v1 leakage — the new route does not carry the legacy mode/azure/llm/divergence keys.
  assert.equal('mode' in body, false)
  assert.equal('divergence' in body, false)

  assert.equal(calls.azureSubmit, 1)
  assert.equal(calls.anthropic, 1)
})

test('POST /ocr/analyze preserves the full v2 result and emits grouped cache-degradation telemetry when cache write fails', async () => {
  stubProviders()
  const env = makeEnv({
    ANTHROPIC_API_KEY: 'anthropic-key-must-not-leak',
    AZURE_OCR_KEY: 'azure-key-must-not-leak',
    LLM_SCAN_ALLOW_SOFT_FAIL: 'true',
    SENTRY_DSN: 'https://ocr@example.ingest.sentry.io/1',
    SENTRY_RELEASE: 'release-cache-test',
  })
  const originalPut = env.ATTEST_KV.put.bind(env.ATTEST_KV)
  env.ATTEST_KV.put = async (key, value, options) => {
    if (key.startsWith('cache:dualScan:')) throw new Error('RAW_CACHE_ERROR_MUST_NOT_LEAK')
    return originalPut(key, value, options)
  }
  const warnings = []
  const logs = []
  const originalWarn = console.warn
  const originalLog = console.log
  console.warn = (line) => warnings.push(line)
  console.log = (line) => logs.push(line)
  const sentry = { messages: [], scopes: [] }
  setOcrSentrySdkForTests({
    captureMessage(message) { sentry.messages.push(message) },
    flush() { return Promise.resolve(true) },
    withScope(cb) {
      const scope = {
        tags: {}, contexts: {}, fingerprint: null,
        setLevel(level) { this.level = level },
        setTag(key, value) { this.tags[key] = value },
        setContext(key, value) { this.contexts[key] = value },
        setFingerprint(value) { this.fingerprint = value },
      }
      sentry.scopes.push(scope)
      cb(scope)
    },
  })

  let res
  try {
    res = await handleOcr(analyzeRequest(new TextEncoder().encode('ANALYZE_IMAGE_MUST_NOT_LEAK'), {
      'x-resplit-attest-key-id': 'DEVICE_KEY_MUST_NOT_LEAK',
      'x-resplit-client-version': 'CLIENT_VERSION_MUST_NOT_LEAK',
      'x-resplit-trace-id': 'CLIENT_REQUEST_ID_MUST_NOT_LEAK',
    }), env)
  } finally {
    console.warn = originalWarn
    console.log = originalLog
    resetOcrSentrySdkForTests()
  }

  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.v, 2)
  assert.equal(body.status, 'succeeded')
  const azureEngine = body.engines.find((engine) => engine.id === 'azure')
  const llmEngine = body.engines.find((engine) => engine.id === 'llm')
  assert.equal(azureEngine.raw.analyzeResult.documents[0].fields.Total.valueCurrency.amount, 10)
  assert.deepEqual(llmEngine.scanned, scannedReceipt())
  assert.deepEqual(body.consensus, {
    totalsAgree: true,
    azureTotal: 10,
    llmTotal: 10,
    extrasKindsDelta: [],
    llmRecoveredAmount: 0,
  })
  assert.equal(calls.azureSubmit, 1)
  assert.equal(calls.azurePoll, 1)
  assert.equal(calls.anthropic, 1)

  const cacheEvents = warnings.filter((line) => typeof line === 'string' && line.startsWith('[OCR_MONITORING] '))
    .map((line) => JSON.parse(line.replace('[OCR_MONITORING] ', '')))
    .filter((event) => event.signal === 'ocr_cache_write_failed')
  assert.equal(cacheEvents.length, 1)
  assert.equal(cacheEvents[0].route, 'analyze')
  assert.equal(cacheEvents[0].scanId, body.scanId)
  assert.equal(cacheEvents[0].release, 'release-cache-test')
  assert.equal('requestId' in cacheEvents[0], false)
  assert.equal('client_version' in cacheEvents[0], false)

  const successEvents = logs.filter((line) => typeof line === 'string' && line.startsWith('[OCR_MONITORING] '))
    .map((line) => JSON.parse(line.replace('[OCR_MONITORING] ', '')))
    .filter((event) => event.signal === 'dual_scan' && event.route === 'analyze')
  assert.equal(successEvents.length, 1)
  assert.equal(successEvents[0].scanId, body.scanId)

  assert.deepEqual(sentry.messages, ['OCR cache write failed'])
  assert.equal(sentry.scopes.length, 1)
  assert.equal(sentry.scopes[0].tags['monitoring.signal'], 'ocr_cache_write_failed')
  assert.deepEqual(sentry.scopes[0].fingerprint, ['ocr_cache_write_failed'])
  assert.deepEqual(sentry.scopes[0].contexts.ocrCacheWrite, {
    scanId: body.scanId,
    route: 'analyze',
    release: 'release-cache-test',
  })
  assert.doesNotMatch(
    JSON.stringify({ cacheEvents, sentry }),
    /ANALYZE_IMAGE_MUST_NOT_LEAK|DEVICE_KEY_MUST_NOT_LEAK|CLIENT_VERSION_MUST_NOT_LEAK|CLIENT_REQUEST_ID_MUST_NOT_LEAK|RAW_CACHE_ERROR_MUST_NOT_LEAK|azure-key-must-not-leak|anthropic-key-must-not-leak/
  )
})

test('POST /ocr/analyze with a failed LLM leg is partial: llmReasoning false, aiModels azure-only', async () => {
  stubProviders({ anthropicStatus: 500 })
  const env = makeEnv({ ANTHROPIC_API_KEY: 'anthropic-key', LLM_SCAN_ALLOW_SOFT_FAIL: 'true' })
  const res = await handleOcr(analyzeRequest(new Uint8Array([4, 4, 4])), env)
  assert.equal(res.status, 200)
  const body = await res.json()

  assert.equal(body.v, 2)
  assert.equal(body.status, 'partial')
  assert.equal(body.llmReasoning, false)
  assert.deepEqual(body.aiModels, ['azure-di-v4'])
  const azureEngine = body.engines.find((e) => e.id === 'azure')
  const llmEngine = body.engines.find((e) => e.id === 'llm')
  assert.equal(azureEngine.status, 'succeeded')
  assert.equal(llmEngine.status, 'provider_error')
  assert.equal(llmEngine.scanned, null)
  // Both legs did not succeed → no consensus to report.
  assert.equal(body.consensus, null)
  assert.equal(calls.anthropic, 1)
})

test('POST /ocr/analyze totals disagreement reports it as consensus, not divergence', async () => {
  stubProviders({ azure: azureRaw({ total: 12 }), scanned: scannedReceipt({ total: 14, extras: [
    { label: 'Tax', amount: 1, kind: 'tax' },
    { label: 'Bag fee', amount: 2, kind: 'fee' },
  ] }) })
  const env = makeEnv({ ANTHROPIC_API_KEY: 'anthropic-key', LLM_SCAN_ALLOW_SOFT_FAIL: 'true' })
  const res = await handleOcr(analyzeRequest(new Uint8Array([5, 5, 5])), env)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.status, 'succeeded')
  assert.deepEqual(body.consensus, {
    totalsAgree: false, azureTotal: 12, llmTotal: 14, extrasKindsDelta: ['fee'], llmRecoveredAmount: 2,
  })
})

test('the shared cache serves one scan to BOTH routes, shaped per-route (no cross-shape collision)', async () => {
  // /ocr/analyze scans the image once and caches the shape-neutral internal result.
  // /ocr/dual-scan on the SAME image+gate+model must hit that cache (no 2nd Anthropic
  // call) YET render the legacy v1 envelope — never the v2 shape it was cached under.
  stubProviders()
  const env = makeEnv({ ANTHROPIC_API_KEY: 'anthropic-key', LLM_SCAN_ALLOW_SOFT_FAIL: 'true' })
  const image = new Uint8Array([7, 7, 7])

  const analyzeRes = await handleOcr(analyzeRequest(image), env)
  const analyzeBody = await analyzeRes.json()
  assert.equal(analyzeBody.v, 2)
  assert.equal(Array.isArray(analyzeBody.engines), true)
  assert.equal(calls.anthropic, 1)

  const dualRes = await handleOcr(dualScanRequest(image), env)
  const dualBody = await dualRes.json()
  // Legacy v1 shape, rendered from the SHARED cache entry.
  assert.equal(dualBody.v, 1)
  assert.equal(dualBody.mode, 'dual')
  assert.equal(dualBody.status, 'succeeded')
  assert.equal(dualBody.azure.status, 'succeeded')
  assert.equal(dualBody.llm.scanned.total, 10)
  assert.equal('engines' in dualBody, false, 'the v1 route must not leak the v2 engines[] shape')
  // Proof it was a cache HIT: Anthropic was not re-billed for the second route.
  assert.equal(calls.anthropic, 1, 'the shared cache must dedup the paid leg across routes')

  // And the reverse direction: analyze re-reads the same entry, still v2-shaped.
  const analyzeRes2 = await handleOcr(analyzeRequest(image), env)
  const analyzeBody2 = await analyzeRes2.json()
  assert.equal(analyzeBody2.v, 2)
  assert.equal('mode' in analyzeBody2, false)
  assert.equal(calls.anthropic, 1)
})

test('cache-first accounting: analyze to dual replay uses one paid provider pair and one legacy debit at cap 1', async () => {
  stubProviders()
  const env = makeEnv({
    ANTHROPIC_API_KEY: 'anthropic-key',
    LLM_SCAN_ALLOW_SOFT_FAIL: 'true',
    SOFT_FAIL_DAILY_CAP: '1',
  })
  const image = new Uint8Array([8, 6, 7, 5, 3, 0, 9])
  const day = new Date().toISOString().slice(0, 10)

  const analyze = await handleOcr(analyzeRequest(image), env)
  const dual = await handleOcr(dualScanRequest(image), env)

  assert.equal(analyze.status, 200)
  assert.equal(dual.status, 200, 'the shared cache replay must not require a second provider budget unit')
  assert.equal(calls.azureSubmit, 1, 'analyze and dual share one paid Azure call')
  assert.equal(calls.anthropic, 1, 'analyze and dual share one paid Anthropic call')
  assert.equal(await env.ATTEST_KV.get(`count:ip:unknown:${day}`), '1', 'only the shared-cache miss debits the legacy budget')
  assert.equal((await dual.json()).v, 1, 'the replay still renders the requested legacy envelope')
})

test('POST /ocr/analyze dark mode (no ANTHROPIC_API_KEY) is partial with an azure-only aiModels', async () => {
  stubProviders()
  const env = makeEnv()
  const res = await handleOcr(analyzeRequest(new Uint8Array([2, 2, 2])), env)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.v, 2)
  assert.equal(body.status, 'partial')
  assert.equal(body.llmReasoning, false)
  assert.deepEqual(body.aiModels, ['azure-di-v4'])
  const llmEngine = body.engines.find((e) => e.id === 'llm')
  assert.equal(llmEngine.status, 'provider_unavailable')
  assert.equal(body.consensus, null)
  assert.equal(calls.anthropic, 0)
})
