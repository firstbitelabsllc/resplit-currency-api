import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { handleOcr } from '../worker/src/ocr/router.mjs'
import { llmProvider, llmProviderConfigured, llmModel, llmMaxEdge } from '../worker/src/ocr/llm-provider.mjs'

// The env-gated LLM provider seam. Defaults must reproduce today's Anthropic path
// byte-for-byte; LLM_SCAN_PROVIDER=zai swaps only the paid vision-LLM transport,
// and LLM_SCAN_MAX_EDGE bounds only the image that leg receives.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ZAI_URL = 'https://api.z.ai/api/coding/paas/v4/chat/completions'

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
    LLM_SCAN_ALLOWED_KEY_IDS: '',
    LLM_SCAN_DAILY_CAP: '50',
    LLM_SCAN_ALLOW_SOFT_FAIL: 'true',
    ...extra,
  }
}

let calls
const realFetch = globalThis.fetch
beforeEach(() => { calls = { azureSubmit: 0, azurePoll: 0, anthropic: 0, zai: 0, azureBody: null, zaiBody: null, anthropicBody: null } })
afterEach(() => { globalThis.fetch = realFetch })

function analyzeRequest(imageBytes) {
  return new Request('https://fx.resplit.app/ocr/analyze', {
    method: 'POST',
    headers: { 'content-type': 'image/jpeg', 'x-resplit-attest-soft-fail': 'true' },
    body: imageBytes,
  })
}

function jpegWithDimensions(width, height, seed = 1) {
  return new Uint8Array([
    0xFF, 0xD8,
    0xFF, 0xC0,
    0x00, 0x11,
    0x08,
    (height >> 8) & 0xFF, height & 0xFF,
    (width >> 8) & 0xFF, width & 0xFF,
    0x03,
    0x01, 0x22, 0x00,
    0x02, 0x11, 0x01,
    0x03, 0x11, 0x01,
    seed,
  ])
}

function azureRaw({ total = 10, tax = 1 } = {}) {
  return {
    status: 'succeeded',
    analyzeResult: {
      documents: [{
        docType: 'receipt',
        fields: {
          Total: { type: 'currency', valueCurrency: { amount: total, currencyCode: 'USD' } },
          TotalTax: { type: 'currency', valueCurrency: { amount: tax, currencyCode: 'USD' } },
        },
      }],
    },
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

function stubProviders({ azure = azureRaw(), scanned = scannedReceipt() } = {}) {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (u === ANTHROPIC_URL) {
      calls.anthropic++
      calls.anthropicBody = JSON.parse(init.body)
      return Response.json({
        id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
        content: [{ type: 'tool_use', id: 'toolu_test', name: 'emit_receipt', input: scanned }],
        stop_reason: 'tool_use',
      }, { status: 200 })
    }
    if (u === ZAI_URL) {
      calls.zai++
      calls.zaiBody = JSON.parse(init.body)
      return Response.json({
        id: 'chatcmpl-test', model: 'glm-5.3-flash',
        choices: [{ index: 0, message: { role: 'assistant', content: '```json\n' + JSON.stringify(scanned) + '\n```' }, finish_reason: 'stop' }],
      }, { status: 200 })
    }
    if (init.method === 'POST' && u.includes(':analyze')) {
      calls.azureSubmit++
      calls.azureBody = new Uint8Array(init.body)
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

function captureMonitoring(fn) {
  const lines = []
  const origLog = console.log
  const origWarn = console.warn
  console.log = (line) => lines.push(line)
  console.warn = (line) => lines.push(line)
  return fn().finally(() => { console.log = origLog; console.warn = origWarn }).then((value) => ({
    value,
    events: lines
      .filter((line) => typeof line === 'string' && line.startsWith('[OCR_MONITORING] '))
      .map((line) => JSON.parse(line.slice('[OCR_MONITORING] '.length))),
  }))
}

function dataUrlBytes(url) {
  const match = /^data:([^;]+);base64,(.*)$/.exec(url)
  assert.ok(match)
  return Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0))
}

test('env helpers: the provider defaults to anthropic and fails closed on an unknown value', () => {
  assert.equal(llmProvider({}), 'anthropic')
  assert.equal(llmProvider({ LLM_SCAN_PROVIDER: '' }), 'anthropic')
  assert.equal(llmProvider({ LLM_SCAN_PROVIDER: ' ZAI ' }), 'zai')
  assert.equal(llmProviderConfigured({ ANTHROPIC_API_KEY: 'a' }), true)
  assert.equal(llmProviderConfigured({ ZAI_API_KEY: 'z' }), false)
  assert.equal(llmProviderConfigured({ LLM_SCAN_PROVIDER: 'zai', ZAI_API_KEY: 'z' }), true)
  assert.equal(llmProviderConfigured({ LLM_SCAN_PROVIDER: 'zai', ANTHROPIC_API_KEY: 'a' }), false)
  assert.equal(llmProviderConfigured({ LLM_SCAN_PROVIDER: 'openai', ANTHROPIC_API_KEY: 'a', ZAI_API_KEY: 'z' }), false)
  assert.equal(llmModel({}), 'claude-sonnet-5')
  assert.equal(llmModel({ LLM_SCAN_PROVIDER: 'zai' }), 'glm-5.3-flash')
  assert.equal(llmModel({ LLM_SCAN_PROVIDER: 'zai', LLM_SCAN_MODEL: 'glm-4.6v' }), 'glm-4.6v')
  assert.equal(llmMaxEdge({}), 0)
  assert.equal(llmMaxEdge({ LLM_SCAN_MAX_EDGE: '1600' }), 1600)
  assert.equal(llmMaxEdge({ LLM_SCAN_MAX_EDGE: 'big' }), 0)
  assert.equal(llmMaxEdge({ LLM_SCAN_MAX_EDGE: '-5' }), 0)
})

test('default (no LLM_SCAN_PROVIDER) still runs the Anthropic leg and never calls Z.AI', async () => {
  stubProviders()
  const env = makeEnv({ ANTHROPIC_API_KEY: 'anthropic-key', ZAI_API_KEY: 'zai-key', LLM_SCAN_MODEL: 'claude-sonnet-5' })
  const res = await handleOcr(analyzeRequest(jpegWithDimensions(800, 600)), env)
  assert.equal(res.status, 200)
  const body = await res.json()
  const llm = body.engines.find((e) => e.id === 'llm')
  assert.equal(llm.provider, 'anthropic')
  assert.equal(llm.model, 'claude-sonnet-5')
  assert.equal(llm.status, 'succeeded')
  assert.equal(calls.anthropic, 1)
  assert.equal(calls.zai, 0)
})

test('LLM_SCAN_PROVIDER=zai runs the Z.AI leg, keeps Azure, and reports the truthful provider/model', async () => {
  stubProviders()
  const env = makeEnv({ LLM_SCAN_PROVIDER: 'zai', ZAI_API_KEY: 'zai-key', LLM_SCAN_MODEL: 'glm-5.3-flash' })
  const { value: res, events } = await captureMonitoring(() => handleOcr(analyzeRequest(jpegWithDimensions(800, 600)), env))
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.status, 'succeeded')
  assert.deepEqual(body.aiModels, ['azure-di-v4', 'glm-5.3-flash'])
  const llm = body.engines.find((e) => e.id === 'llm')
  assert.equal(llm.provider, 'zai')
  assert.equal(llm.model, 'glm-5.3-flash')
  assert.equal(llm.status, 'succeeded')
  assert.equal(llm.scanned.total, 10)
  assert.equal(calls.zai, 1)
  assert.equal(calls.anthropic, 0)
  assert.equal(calls.azureSubmit, 1)

  const scan = events.find((e) => e.signal === 'dual_scan')
  assert.ok(scan, 'dual_scan monitoring line emitted')
  assert.equal(scan.llm_provider, 'zai')
  assert.equal(scan.llm_model, 'glm-5.3-flash')
  assert.equal(scan.llm_input_px, 800)
  assert.equal(scan.llm_status, 'succeeded')
  const serialized = JSON.stringify(events)
  assert.equal(serialized.includes('zai-key'), false)
})

test('LLM_SCAN_MAX_EDGE=1600 downscales only the LLM leg; Azure receives the original bytes', async () => {
  stubProviders()
  const original = jpegWithDimensions(4000, 3000, 7)
  const transformed = jpegWithDimensions(1600, 1200, 8)
  const resizes = []
  const env = makeEnv({
    LLM_SCAN_PROVIDER: 'zai', ZAI_API_KEY: 'zai-key', LLM_SCAN_MODEL: 'glm-5.3-flash',
    LLM_SCAN_MAX_EDGE: '1600',
    __TEST_LLM_IMAGE_RESIZER: async (bytes, options) => { resizes.push(options); return transformed },
  })
  const { value: res, events } = await captureMonitoring(() => handleOcr(analyzeRequest(original), env))
  assert.equal(res.status, 200)
  assert.deepEqual(resizes, [{ sourceWidth: 4000, sourceHeight: 3000, width: 1600, height: 1200, quality: 90, orientation: 1 }])
  assert.deepEqual(dataUrlBytes(calls.zaiBody.messages[1].content[0].image_url.url), transformed)
  assert.deepEqual(calls.azureBody, original)
  const scan = events.find((e) => e.signal === 'dual_scan')
  assert.equal(scan.llm_input_px, 1600)
})

test('LLM_SCAN_MAX_EDGE applies to the Anthropic leg too, never above its own 1568px ceiling', async () => {
  stubProviders()
  const original = jpegWithDimensions(4000, 3000)
  const resizes = []
  const env = makeEnv({
    ANTHROPIC_API_KEY: 'anthropic-key', LLM_SCAN_MODEL: 'claude-sonnet-5',
    LLM_SCAN_MAX_EDGE: '1200',
    __TEST_LLM_IMAGE_RESIZER: async (bytes, options) => { resizes.push(options); return jpegWithDimensions(1200, 900) },
  })
  const { value: res, events } = await captureMonitoring(() => handleOcr(analyzeRequest(original), env))
  assert.equal(res.status, 200)
  assert.equal(resizes[0].width, 1200)
  assert.equal(events.find((e) => e.signal === 'dual_scan').llm_input_px, 1200)

  resizes.length = 0
  const wide = makeEnv({
    ANTHROPIC_API_KEY: 'anthropic-key', LLM_SCAN_MODEL: 'claude-sonnet-5',
    LLM_SCAN_MAX_EDGE: '1600',
    __TEST_LLM_IMAGE_RESIZER: async (bytes, options) => { resizes.push(options); return jpegWithDimensions(1568, 1176) },
  })
  const res2 = await handleOcr(analyzeRequest(jpegWithDimensions(4000, 3000, 9)), wide)
  assert.equal(res2.status, 200)
  assert.equal(resizes[0].width, 1568)
})

test('provider=zai without ZAI_API_KEY fails closed to provider_unavailable before any paid Z.AI call', async () => {
  stubProviders()
  const env = makeEnv({ LLM_SCAN_PROVIDER: 'zai', ANTHROPIC_API_KEY: 'anthropic-key', LLM_SCAN_MODEL: 'glm-5.3-flash' })
  const res = await handleOcr(analyzeRequest(jpegWithDimensions(800, 600)), env)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.status, 'partial')
  const llm = body.engines.find((e) => e.id === 'llm')
  assert.equal(llm.status, 'provider_unavailable')
  assert.equal(llm.provider, 'zai')
  assert.equal(calls.zai, 0)
  assert.equal(calls.anthropic, 0)
  assert.equal(calls.azureSubmit, 1)
})

test('an unknown LLM_SCAN_PROVIDER fails closed to provider_unavailable', async () => {
  stubProviders()
  const env = makeEnv({ LLM_SCAN_PROVIDER: 'openai', ANTHROPIC_API_KEY: 'a', ZAI_API_KEY: 'z' })
  const res = await handleOcr(analyzeRequest(jpegWithDimensions(800, 600)), env)
  const body = await res.json()
  assert.equal(body.engines.find((e) => e.id === 'llm').status, 'provider_unavailable')
  assert.equal(calls.zai + calls.anthropic, 0)
})

test('a Z.AI transport failure is a data-shaped provider_error and Azure still succeeds', async () => {
  stubProviders()
  const stub = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url) === ZAI_URL) { calls.zai++; return new Response('upstream boom', { status: 500 }) }
    return stub(url, init)
  }
  const env = makeEnv({ LLM_SCAN_PROVIDER: 'zai', ZAI_API_KEY: 'zai-key', LLM_SCAN_MODEL: 'glm-5.3-flash' })
  const res = await handleOcr(analyzeRequest(jpegWithDimensions(800, 600)), env)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.status, 'partial')
  const llm = body.engines.find((e) => e.id === 'llm')
  assert.equal(llm.status, 'provider_error')
  assert.equal(llm.provider, 'zai')
  assert.equal(calls.zai, 1)
})

test('the shared cache key is unchanged for the default provider and distinct once the seam is flipped', async () => {
  stubProviders()
  const image = jpegWithDimensions(800, 600, 3)
  const anthropic = makeEnv({ ANTHROPIC_API_KEY: 'a', LLM_SCAN_MODEL: 'claude-sonnet-5' })
  await handleOcr(analyzeRequest(image), anthropic)
  const legacyKey = [...anthropic.ATTEST_KV.store.keys()].find((k) => k.startsWith('cache:dualScan:v2core:'))
  assert.match(legacyKey, /^cache:dualScan:v2core:[0-9a-f]{64}:allowed:soft_fail:claude-sonnet-5$/)

  const zai = makeEnv({ LLM_SCAN_PROVIDER: 'zai', ZAI_API_KEY: 'z', LLM_SCAN_MODEL: 'glm-5.3-flash', LLM_SCAN_MAX_EDGE: '1600' })
  await handleOcr(analyzeRequest(image), zai)
  const zaiKey = [...zai.ATTEST_KV.store.keys()].find((k) => k.startsWith('cache:dualScan:v2core:'))
  assert.match(zaiKey, /^cache:dualScan:v2core:[0-9a-f]{64}:allowed:soft_fail:glm-5\.3-flash:zai:1600$/)
})
