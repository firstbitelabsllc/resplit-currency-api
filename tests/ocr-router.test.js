import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { handleOcr } from '../worker/src/ocr/router.mjs'
import { setOcrSentrySdkForTests, resetOcrSentrySdkForTests } from '../worker/src/ocr/monitoring.mjs'

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
beforeEach(() => { azureCalls = { submit: 0, poll: 0, receiptSubmit: 0, layoutSubmit: 0, receiptPoll: 0, layoutPoll: 0, layoutUrls: [] } })
afterEach(() => { globalThis.fetch = realFetch })

function stubAzure() {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (init.method === 'POST' && u.includes(':analyze')) {
      azureCalls.submit++
      const isLayout = u.includes('/documentModels/prebuilt-layout:analyze')
      if (isLayout) {
        azureCalls.layoutSubmit++
        azureCalls.layoutUrls.push(u)
        return new Response('', { status: 202, headers: { 'operation-location': 'https://test.cognitiveservices.azure.com/documentintelligence/documentModels/prebuilt-layout/analyzeResults/op-layout?api-version=2024-11-30' } })
      }
      azureCalls.receiptSubmit++
      return new Response('', { status: 202, headers: { 'operation-location': 'https://test.cognitiveservices.azure.com/documentintelligence/documentModels/prebuilt-receipt/analyzeResults/op-receipt?api-version=2024-11-30' } })
    }
    if (u.includes('/analyzeResults/')) {
      azureCalls.poll++
      if (u.includes('/documentModels/prebuilt-layout/analyzeResults/')) {
        azureCalls.layoutPoll++
        return Response.json({
          status: 'succeeded',
          analyzeResult: {
            keyValuePairs: [
              {
                key: { content: 'Loyalty credit' },
                value: { content: '-$10.00' },
                confidence: 0.91,
              },
            ],
          },
        }, { status: 200 })
      }
      azureCalls.receiptPoll++
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
  assert.equal(azureCalls.layoutSubmit, 0, 'key-value add-on is opt-in because it doubles Azure analyzes')
  assert.equal(body.kv_extras, 'off', 'flag-off scans declare kv_extras off in the envelope')
})

test('POST /ocr/scan merges opt-in Azure layout keyValuePairs into the raw receipt envelope', async () => {
  stubAzure()
  const env = makeEnv({ AZURE_OCR_KV_EXTRAS: 'enabled' })
  const res = await handleOcr(scanRequest(new Uint8Array([1, 2, 3])), env)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.status, 'ok')
  assert.equal(body.raw.analyzeResult.documents[0].docType, 'receipt')
  assert.deepEqual(body.raw.analyzeResult.keyValuePairs, [
    {
      key: { content: 'Loyalty credit' },
      value: { content: '-$10.00' },
      confidence: 0.91,
    },
  ])
  assert.equal(azureCalls.receiptSubmit, 1)
  assert.equal(azureCalls.layoutSubmit, 1)
  assert.equal(azureCalls.receiptPoll, 1)
  assert.equal(azureCalls.layoutPoll, 1)
  assert.equal(new URL(azureCalls.layoutUrls[0]).searchParams.get('features'), 'keyValuePairs')
  assert.equal(body.kv_extras, 'merged', 'successful merge is declared in the envelope')
})

test('kv-extras: layout analyze failure degrades to the base receipt result and declares kv_extras failed', async () => {
  stubAzure()
  const baseFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (u.includes('/documentModels/prebuilt-layout/analyzeResults/')) {
      azureCalls.poll++
      azureCalls.layoutPoll++
      return Response.json({ status: 'failed' }, { status: 200 })
    }
    return baseFetch(url, init)
  }
  const env = makeEnv({ AZURE_OCR_KV_EXTRAS: 'enabled' })
  const res = await handleOcr(scanRequest(new Uint8Array([4, 4, 4])), env)
  assert.equal(res.status, 200, 'a broken add-on must not fail the scan')
  const body = await res.json()
  assert.equal(body.status, 'ok')
  assert.equal(body.kv_extras, 'failed')
  assert.equal(body.raw.analyzeResult.keyValuePairs, undefined, 'base result is returned unmerged')
})

test('kv-extras: daily cap is denominated in Azure analyzes, so the doubled call cannot overshoot it', async () => {
  stubAzure()
  const env = makeEnv({ AZURE_OCR_KV_EXTRAS: 'enabled' })
  const day = new Date().toISOString().slice(0, 10)
  // 19/20 used: a flag-on scan needs 2 units and must be rejected, not partially admitted.
  await env.ATTEST_KV.put(`count:ip:unknown:${day}`, '19')
  const res = await handleOcr(scanRequest(new Uint8Array([6, 6, 6])), env)
  assert.equal(res.status, 429)
  assert.equal(azureCalls.submit, 0, 'capped request must not reach Azure at all')
})

test('kv-extras: a flag-on scan charges the daily counter 2 units (both Azure analyzes)', async () => {
  stubAzure()
  const env = makeEnv({ AZURE_OCR_KV_EXTRAS: 'enabled' })
  const day = new Date().toISOString().slice(0, 10)
  const res = await handleOcr(scanRequest(new Uint8Array([7, 7, 7])), env)
  assert.equal(res.status, 200)
  assert.equal(await env.ATTEST_KV.get(`count:ip:unknown:${day}`), '2')
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

test('missing ATTEST_KV binding emits a structured ocr_misconfigured error so it is visible on the dashboard', async () => {
  const env = makeEnv({ ATTEST_KV: undefined })
  const origError = console.error
  const lines = []
  console.error = (line) => lines.push(line)
  try {
    await handleOcr(scanRequest(new Uint8Array([1])), env)
  } finally {
    console.error = origError
  }
  const monitoringLine = lines.find((l) => typeof l === 'string' && l.startsWith('[OCR_MONITORING] '))
  assert.ok(monitoringLine, 'a misconfigured binding must emit an [OCR_MONITORING] line, not 503 silently')
  const json = JSON.parse(monitoringLine.replace('[OCR_MONITORING] ', ''))
  assert.equal(json.signal, 'ocr_misconfigured')
  assert.equal(json.reason, 'attest_kv_unbound')
  assert.equal(json.domain, 'ocr')
})

test('empty image body is a 400', async () => {
  stubAzure()
  const res = await handleOcr(scanRequest(new Uint8Array([])), makeEnv())
  assert.equal(res.status, 400)
})

test('a provider_error 502 reports to Sentry (scan-path failure is not log-only)', async () => {
  // Azure submit returns 500 -> no operationId -> finishScan yields provider_error 502.
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (init.method === 'POST' && u.includes(':analyze')) {
      return new Response('azure exploded', { status: 500 })
    }
    throw new Error(`unexpected fetch ${init.method} ${u}`)
  }
  const calls = { captureMessage: [], flush: [], scopes: [] }
  setOcrSentrySdkForTests({
    captureMessage(m) { calls.captureMessage.push(m) },
    flush(t) { calls.flush.push(t); return Promise.resolve(true) },
    withScope(cb) {
      const scope = { tags: {}, contexts: {}, setLevel() {}, setTag(k, v) { this.tags[k] = v }, setContext(k, v) { this.contexts[k] = v } }
      calls.scopes.push(scope)
      cb(scope)
    },
  })
  try {
    const env = makeEnv({ SENTRY_DSN: 'https://ocr@example.ingest.sentry.io/1' })
    const res = await handleOcr(scanRequest(new Uint8Array([3, 3, 3])), env)
    assert.equal(res.status, 502)
    const body = await res.json()
    assert.equal(body.status, 'provider_error')
    assert.equal(calls.captureMessage.length, 1, 'provider_error must surface as a Sentry issue')
    assert.match(calls.captureMessage[0], /provider_error/)
    assert.equal(calls.scopes[0].tags['monitoring.signal'], 'ocr_provider_error')
    assert.equal(calls.scopes[0].tags['ocr.azure_status'], '500')
  } finally {
    resetOcrSentrySdkForTests()
  }
})

test('an ok scan does NOT report to Sentry (no vanity events on success)', async () => {
  stubAzure()
  const calls = { captureMessage: [] }
  setOcrSentrySdkForTests({
    captureMessage(m) { calls.captureMessage.push(m) },
    flush() { return Promise.resolve(true) },
    withScope(cb) { cb({ setLevel() {}, setTag() {}, setContext() {} }) },
  })
  try {
    const env = makeEnv({ SENTRY_DSN: 'https://ocr@example.ingest.sentry.io/1' })
    const res = await handleOcr(scanRequest(new Uint8Array([2, 2, 2])), env)
    assert.equal(res.status, 200)
    assert.equal(calls.captureMessage.length, 0, 'a successful scan must not emit a Sentry event')
  } finally {
    resetOcrSentrySdkForTests()
  }
})

test('GET /ocr/challenge issues a single-use challenge', async () => {
  const env = makeEnv()
  const res = await handleOcr(new Request('https://fx.resplit.app/ocr/challenge', { method: 'GET' }), env)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.ok(body.challenge && body.challenge.length > 16)
  assert.equal(await env.ATTEST_KV.get(`challenge:${body.challenge}`), '1')
})
