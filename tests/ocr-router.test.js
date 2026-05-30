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
    ...extra,
  }
}

// Stub Azure: POST :analyze -> 202 + Operation-Location; GET analyzeResults -> succeeded.
let azureCalls
const realFetch = globalThis.fetch
beforeEach(() => { azureCalls = { submit: 0, poll: 0 } })
afterEach(() => { globalThis.fetch = realFetch })

function stubAzure() {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (init.method === 'POST' && u.includes(':analyze')) {
      azureCalls.submit++
      return new Response('', { status: 202, headers: { 'operation-location': 'https://test.cognitiveservices.azure.com/documentintelligence/documentModels/prebuilt-receipt/analyzeResults/op-123?api-version=2024-11-30' } })
    }
    if (u.includes('/analyzeResults/')) {
      azureCalls.poll++
      return Response.json({ status: 'succeeded', analyzeResult: { documents: [{ docType: 'receipt' }] } }, { status: 200 })
    }
    throw new Error(`unexpected fetch ${init.method} ${u}`)
  }
}

function scanRequest(imageBytes, headers = {}) {
  return new Request('https://fx.resplit.app/ocr/scan', {
    method: 'POST',
    headers: { 'content-type': 'image/jpeg', 'x-resplit-attest-soft-fail': 'true', ...headers },
    body: imageBytes,
  })
}

test('POST /ocr/scan (soft-fail) returns the versioned envelope wrapping the Azure result', async () => {
  stubAzure()
  const env = makeEnv()
  const res = await handleOcr(scanRequest(new Uint8Array([1, 2, 3])), env)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.v, 1)
  assert.equal(body.mode, 'raw')
  assert.equal(body.provider, 'azure-di')
  assert.equal(body.status, 'ok')
  assert.ok(body.scanId)
  // raw is the full Azure analyzeResults body (ReceiptScanStatusV4 shape) the iOS
  // OCRSnapshotMapper already consumes: { status, analyzeResult: { documents } }.
  assert.equal(body.raw.status, 'succeeded')
  assert.equal(body.raw.analyzeResult.documents[0].docType, 'receipt')
  assert.equal(azureCalls.submit, 1)
})

test('idempotency: the same image twice bills Azure once (second is a cache hit)', async () => {
  stubAzure()
  const env = makeEnv()
  const img = new Uint8Array([9, 8, 7, 6])
  const r1 = await handleOcr(scanRequest(img), env)
  const r2 = await handleOcr(scanRequest(img), env)
  assert.equal(r1.status, 200)
  assert.equal(r2.status, 200)
  assert.equal(azureCalls.submit, 1, 'Azure analyze should be called exactly once for identical images')
  assert.deepEqual(await r1.json(), await r2.json())
})

test('per-device (soft-fail/IP) cap returns 429 with rate_limited envelope', async () => {
  stubAzure()
  const env = makeEnv()
  const day = new Date().toISOString().slice(0, 10)
  // Pre-load the IP counter at the soft-fail cap.
  await env.ATTEST_KV.put(`count:ip:unknown:${day}`, '20')
  const res = await handleOcr(scanRequest(new Uint8Array([5, 5, 5])), env)
  assert.equal(res.status, 429)
  const body = await res.json()
  assert.equal(body.status, 'rate_limited')
  assert.equal(azureCalls.submit, 0, 'capped request must not reach Azure')
})

test('missing ATTEST_KV binding is a 503 misconfiguration, not a crash', async () => {
  const env = makeEnv({ ATTEST_KV: undefined })
  const res = await handleOcr(scanRequest(new Uint8Array([1])), env)
  assert.equal(res.status, 503)
})

test('empty image body is a 400', async () => {
  stubAzure()
  const res = await handleOcr(scanRequest(new Uint8Array([])), makeEnv())
  assert.equal(res.status, 400)
})

test('GET /ocr/challenge issues a single-use challenge', async () => {
  const env = makeEnv()
  const res = await handleOcr(new Request('https://fx.resplit.app/ocr/challenge', { method: 'GET' }), env)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.ok(body.challenge && body.challenge.length > 16)
  assert.equal(await env.ATTEST_KV.get(`challenge:${body.challenge}`), '1')
})
