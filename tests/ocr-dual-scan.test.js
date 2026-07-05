import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { handleOcr } from '../worker/src/ocr/router.mjs'

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

beforeEach(() => {
  calls = { azureSubmit: 0, azurePoll: 0, anthropic: 0, anthropicBodies: [] }
})
afterEach(() => { globalThis.fetch = realFetch })

function dualScanRequest(imageBytes, headers = {}) {
  return new Request('https://fx.resplit.app/ocr/dual-scan', {
    method: 'POST',
    headers: {
      'content-type': 'image/jpeg',
      'x-resplit-attest-soft-fail': 'true',
      ...headers,
    },
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
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_test',
        name: 'emit_receipt',
        input: scanned,
      },
    ],
    stop_reason: 'tool_use',
  }
}

function scannedReceipt(overrides = {}) {
  return {
    merchantName: 'Cafe Test',
    merchantAddress: null,
    transactionDate: '2026-07-05',
    currencyCode: 'USD',
    currencySymbol: '$',
    lineItems: [{ name: 'Coffee', amount: 9, quantity: 1 }],
    subtotal: 9,
    total: 10,
    extras: [{ label: 'Tax', amount: 1, kind: 'tax' }],
    ...overrides,
  }
}

function stubProviders({ azure = azureRaw(), scanned = scannedReceipt() } = {}) {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (u === 'https://api.anthropic.com/v1/messages') {
      calls.anthropic++
      calls.anthropicBodies.push(JSON.parse(init.body))
      return Response.json(anthropicToolResponse(scanned), { status: 200 })
    }
    if (init.method === 'POST' && u.includes(':analyze')) {
      calls.azureSubmit++
      return new Response('', {
        status: 202,
        headers: {
          'operation-location': 'https://test.cognitiveservices.azure.com/documentintelligence/documentModels/prebuilt-receipt/analyzeResults/op-receipt?api-version=2024-11-30',
        },
      })
    }
    if (u.includes('/analyzeResults/')) {
      calls.azurePoll++
      return Response.json(azure, { status: 200 })
    }
    throw new Error(`unexpected fetch ${init.method} ${u}`)
  }
}

test('POST /ocr/dual-scan returns dual succeeded envelope when Azure and Anthropic succeed', async () => {
  stubProviders()
  const env = makeEnv({ ANTHROPIC_API_KEY: 'anthropic-key', LLM_SCAN_ALLOWED_KEY_IDS: 'kid-1' })
  const res = await handleOcr(dualScanRequest(new Uint8Array([1, 2, 3]), { 'x-resplit-attest-key-id': 'kid-1' }), env)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.v, 1)
  assert.equal(body.mode, 'dual')
  assert.equal(body.status, 'succeeded')
  assert.equal(body.azure.status, 'succeeded')
  assert.equal(body.azure.raw.analyzeResult.documents[0].fields.Total.valueCurrency.amount, 10)
  assert.equal(body.llm.status, 'succeeded')
  assert.equal(body.llm.provider, 'anthropic')
  assert.equal(body.llm.model, 'claude-sonnet-5')
  assert.equal(body.llm.scanned.total, 10)
  assert.deepEqual(body.divergence, {
    totalsAgree: true,
    azureTotal: 10,
    llmTotal: 10,
    extrasKindsDelta: [],
    llmRecoveredAmount: 0,
  })
  assert.equal(calls.azureSubmit, 1)
  assert.equal(calls.azurePoll, 1)
  assert.equal(calls.anthropic, 1)
  assert.equal(calls.anthropicBodies[0].tool_choice.name, 'emit_receipt')
  assert.equal(calls.anthropicBodies[0].tools[0].input_schema.additionalProperties, false)
})

test('POST /ocr/dual-scan dark mode returns Azure success plus LLM provider_unavailable', async () => {
  stubProviders()
  const env = makeEnv()
  const res = await handleOcr(dualScanRequest(new Uint8Array([2, 2, 2])), env)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.status, 'partial')
  assert.equal(body.azure.status, 'succeeded')
  assert.equal(body.llm.status, 'provider_unavailable')
  assert.equal(body.llm.scanned, null)
  assert.equal(body.divergence, null)
  assert.equal(calls.anthropic, 0)
})

test('POST /ocr/dual-scan allowlist miss returns Azure success plus LLM not_allowed', async () => {
  stubProviders()
  const env = makeEnv({ ANTHROPIC_API_KEY: 'anthropic-key', LLM_SCAN_ALLOWED_KEY_IDS: 'kid-allowed' })
  const res = await handleOcr(dualScanRequest(new Uint8Array([3, 3, 3]), { 'x-resplit-attest-key-id': 'kid-miss' }), env)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.status, 'partial')
  assert.equal(body.azure.status, 'succeeded')
  assert.equal(body.llm.status, 'not_allowed')
  assert.equal(calls.anthropic, 0)
})

test('POST /ocr/dual-scan LLM daily cap trip returns Azure success plus LLM rate_limited', async () => {
  stubProviders()
  const env = makeEnv({ ANTHROPIC_API_KEY: 'anthropic-key', LLM_SCAN_ALLOWED_KEY_IDS: 'kid-1', LLM_SCAN_DAILY_CAP: '1' })
  const day = new Date().toISOString().slice(0, 10)
  await env.ATTEST_KV.put(`llmcount:${day}`, '1')
  const res = await handleOcr(dualScanRequest(new Uint8Array([4, 4, 4]), { 'x-resplit-attest-key-id': 'kid-1' }), env)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.status, 'partial')
  assert.equal(body.azure.status, 'succeeded')
  assert.equal(body.llm.status, 'rate_limited')
  assert.equal(calls.anthropic, 0)
})

test('POST /ocr/dual-scan divergence reports positive LLM recovered amount for recovered fee', async () => {
  stubProviders({
    azure: azureRaw({ total: 12, tax: 1 }),
    scanned: scannedReceipt({
      total: 14,
      extras: [
        { label: 'Tax', amount: 1, kind: 'tax' },
        { label: 'Bag fee', amount: 2, kind: 'fee' },
      ],
    }),
  })
  const env = makeEnv({ ANTHROPIC_API_KEY: 'anthropic-key', LLM_SCAN_ALLOWED_KEY_IDS: 'kid-1' })
  const res = await handleOcr(dualScanRequest(new Uint8Array([5, 5, 5]), { 'x-resplit-attest-key-id': 'kid-1' }), env)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.status, 'succeeded')
  assert.deepEqual(body.divergence, {
    totalsAgree: false,
    azureTotal: 12,
    llmTotal: 14,
    extrasKindsDelta: ['fee'],
    llmRecoveredAmount: 2,
  })
  assert.equal(calls.azureSubmit, 1)
  assert.equal(calls.anthropic, 1)
})
