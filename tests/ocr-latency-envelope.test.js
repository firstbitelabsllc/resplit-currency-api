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
    LLM_SCAN_ALLOW_SOFT_FAIL: 'true',
    ANTHROPIC_API_KEY: 'anthropic-key',
    ...extra,
  }
}

const realFetch = globalThis.fetch
beforeEach(() => { stubProviders() })
afterEach(() => { globalThis.fetch = realFetch })

function jpegFixture(seed) {
  return new Uint8Array([
    0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08,
    0x02, 0x58, 0x03, 0x20, 0x03,
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    seed,
  ])
}

function analyzeRequest(imageBytes) {
  return new Request('https://fx.resplit.app/ocr/analyze', {
    method: 'POST',
    headers: { 'content-type': 'image/jpeg', 'x-resplit-attest-soft-fail': 'true' },
    body: imageBytes,
  })
}

function stubProviders() {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (u === 'https://api.anthropic.com/v1/messages') {
      return Response.json({
        id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
        content: [{
          type: 'tool_use', id: 'toolu_test', name: 'emit_receipt',
          input: {
            merchantName: 'Cafe Test', merchantAddress: null, transactionDate: '2026-07-05',
            currencyCode: 'USD', currencySymbol: '$',
            lineItems: [{ name: 'Coffee', amount: 9, quantity: 1 }],
            subtotal: 9, total: 10, extras: [{ label: 'Tax', amount: 1, kind: 'tax' }],
          },
        }],
        stop_reason: 'tool_use',
      }, { status: 200 })
    }
    if (init.method === 'POST' && u.includes(':analyze')) {
      return new Response('', {
        status: 202,
        headers: {
          'operation-location':
            'https://test.cognitiveservices.azure.com/documentintelligence/documentModels/prebuilt-receipt/analyzeResults/op-receipt?api-version=2024-11-30',
        },
      })
    }
    if (u.includes('/analyzeResults/')) {
      return Response.json({
        status: 'succeeded',
        analyzeResult: {
          documents: [{
            docType: 'receipt',
            fields: {
              Total: { type: 'currency', valueCurrency: { amount: 10, currencyCode: 'USD' } },
              TotalTax: { type: 'currency', valueCurrency: { amount: 1, currencyCode: 'USD' } },
            },
          }],
        },
      }, { status: 200 })
    }
    throw new Error(`unexpected fetch ${init.method} ${u}`)
  }
}

test('POST /ocr/analyze shipped envelope exposes numeric latencyMs on azure and llm legs', async () => {
  const res = await handleOcr(analyzeRequest(jpegFixture(77)), makeEnv())
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.v, 2)
  const azure = body.engines.find((engine) => engine.id === 'azure')
  const llm = body.engines.find((engine) => engine.id === 'llm')
  assert.equal(typeof azure.latencyMs, 'number')
  assert.equal(Number.isFinite(azure.latencyMs), true)
  assert.equal(typeof llm.latencyMs, 'number')
  assert.equal(Number.isFinite(llm.latencyMs), true)
  assert.equal(azure.latencyMs >= 0, true)
  assert.equal(llm.latencyMs >= 0, true)
})
