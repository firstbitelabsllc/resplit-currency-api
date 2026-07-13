import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { handleOcr } from '../worker/src/ocr/router.mjs'
import { setOcrSentrySdkForTests, resetOcrSentrySdkForTests } from '../worker/src/ocr/monitoring.mjs'
import { setSentryWorkerSdkForTests, resetSentryWorkerSdkForTests } from '../worker/src/monitoring.mjs'

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

function concat(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const a of arrs) { out.set(a, off); off += a.length }
  return out
}

function cborBytes(bytes) {
  if (bytes.length < 24) return concat(Uint8Array.of(0x40 | bytes.length), bytes)
  return concat(Uint8Array.of(0x58, bytes.length), bytes)
}

function cborText(text) {
  const bytes = new TextEncoder().encode(text)
  return concat(Uint8Array.of(0x60 | bytes.length), bytes)
}

function cborAssertion(signature, authenticatorData) {
  return concat(
    Uint8Array.of(0xa2),
    cborText('signature'), cborBytes(signature),
    cborText('authenticatorData'), cborBytes(authenticatorData),
  )
}

function bytesToB64(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

async function seedAttestKey(env, keyId) {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey))
  await env.ATTEST_KV.put(`attest:${keyId}`, JSON.stringify({ publicKeyB64: bytesToB64(spki), signCount: 0 }))
}

test('POST /ocr/scan (soft-fail) returns the versioned envelope wrapping the Azure result', async () => {
  stubAzure()
  const env = makeEnv()
  const res = await handleOcr(scanRequest(new Uint8Array([1, 2, 3]), { 'x-resplit-trace-id': 'trace-ocr-scan' }), env)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-request-id'), 'trace-ocr-scan')
  assert.equal(res.headers.get('x-resplit-trace-id'), 'trace-ocr-scan')
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

test('POST /ocr/scan preserves a successful paid result when structured logging throws', async () => {
  stubAzure()
  const originalLog = console.log
  console.log = () => { throw new Error('log sink unavailable') }
  let res
  try {
    res = await handleOcr(scanRequest(new Uint8Array([1, 4, 1])), makeEnv())
  } finally {
    console.log = originalLog
  }

  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.v, 1)
  assert.equal(body.mode, 'raw')
  assert.equal(body.status, 'ok')
  assert.equal(azureCalls.submit, 1)
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

test('cache-first accounting: a cap-1 duplicate raw scan is served twice for one Azure debit', async () => {
  stubAzure()
  const env = makeEnv({ SOFT_FAIL_DAILY_CAP: '1' })
  const image = new Uint8Array([9, 9, 1, 1])
  const day = new Date().toISOString().slice(0, 10)

  const first = await handleOcr(scanRequest(image), env)
  const replay = await handleOcr(scanRequest(image), env)

  assert.equal(first.status, 200)
  assert.equal(replay.status, 200, 'a cache hit performs no paid work and must not consume or require another cap unit')
  assert.equal(azureCalls.submit, 1, 'the duplicate image must reach Azure exactly once')
  assert.equal(await env.ATTEST_KV.get(`count:ip:unknown:${day}`), '1', 'only the cache miss debits the legacy budget')
  assert.deepEqual(await replay.json(), await first.json(), 'cache-first accounting must preserve the exact response envelope')
})

test('cache-first accounting: invalid App Attest cannot read a seeded raw cache entry', async () => {
  const env = makeEnv()
  const image = new Uint8Array([4, 2, 4, 2])
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', image))
  const imageHash = Array.from(digest).map((byte) => byte.toString(16).padStart(2, '0')).join('')
  await env.ATTEST_KV.put(`cache:${imageHash}`, JSON.stringify({
    v: 1,
    mode: 'raw',
    provider: 'azure-di-v4',
    scanId: 'seeded-cache-must-not-leak',
    status: 'ok',
    kv_extras: 'off',
    raw: { seeded: true },
  }))

  const response = await handleOcr(scanRequest(image, {
    'x-resplit-attest-soft-fail': 'false',
    'x-resplit-attest-key-id': 'unregistered-key',
    'x-resplit-attest-assertion': 'AA==',
  }), env)

  assert.equal(response.status, 401, 'authentication must complete before any cache read can return data')
  assert.doesNotMatch(await response.text(), /seeded-cache-must-not-leak/)
  assert.equal(azureCalls.submit, 0)
})

test('SIG rejects preserve the public 401 contract while logging a PII-free discriminator', async () => {
  const env = makeEnv()
  const image = new TextEncoder().encode('IMAGE_BYTES_MUST_NOT_LEAK')
  const keyId = 'key-id-must-not-leak'
  await seedAttestKey(env, keyId)
  const authData = new Uint8Array(37)
  const cases = [
    ['der_sequence', Uint8Array.of(0x31), '2.0.0+4023', '2.0.0+4023'],
    ['der_integer', concat(Uint8Array.of(0x30, 0x26, 0x02, 0x21), new Uint8Array(33).fill(1), Uint8Array.of(0x02, 0x01, 0x01)), 'amFuZUBleGFtcGxlLmNvbQ', 'unknown'],
    ['verify_false', Uint8Array.of(0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01), 'untrusted version; do-not-log', 'unknown'],
  ]
  const warnings = []
  const assertions = []
  const unsafeClientVersion = cases[1][2]
  const originalWarn = console.warn
  console.warn = (line) => warnings.push(line)
  const responses = []
  try {
    for (const [reason, signature, clientVersion] of cases) {
      const assertion = bytesToB64(cborAssertion(signature, authData))
      assertions.push(assertion)
      responses.push(await handleOcr(scanRequest(image, {
        'x-resplit-attest-soft-fail': 'false',
        'x-resplit-attest-key-id': keyId,
        'x-resplit-attest-assertion': assertion,
        'x-resplit-client-version': clientVersion,
      }), env))
    }
  } finally {
    console.warn = originalWarn
  }

  for (const response of responses) {
    assert.equal(response.status, 401)
    const body = await response.json()
    assert.equal(body.error, 'ATTEST_REJECTED')
    assert.equal(body.message, 'SIG')
    assert.equal('reason' in body, false, 'the public rejection contract must not expose the internal discriminator')
  }
  const events = warnings
    .filter((line) => typeof line === 'string' && line.startsWith('[OCR_MONITORING] '))
    .map((line) => JSON.parse(line.replace('[OCR_MONITORING] ', '')))
    .filter((event) => event.signal === 'attest_reject')
  assert.equal(events.length, 3)
  assert.deepEqual(events.map((event) => event.reason), ['der_sequence', 'der_integer', 'verify_false'])
  for (const [index, event] of events.entries()) {
    assert.equal(event.code, 'SIG')
    assert.equal(event.path, '/ocr/scan')
    assert.equal(event.client_version, cases[index][3])
    assert.equal(Object.keys(event).some((key) => /key|assertion|body|hash|signature/i.test(key)), false)
    assert.doesNotMatch(JSON.stringify(event), /IMAGE_BYTES_MUST_NOT_LEAK|ASSERTION_MUST_NOT_LEAK|key-id-must-not-leak/)
    assert.equal(JSON.stringify(event).includes(unsafeClientVersion), false)
    for (const assertion of assertions) assert.equal(JSON.stringify(event).includes(assertion), false)
  }
})

test('POST /ocr/scan keeps a successful provider result when the cache write fails and emits one PII-free signal', async () => {
  stubAzure()
  const env = makeEnv({ AZURE_OCR_KEY: 'azure-key-must-not-leak', SENTRY_RELEASE: 'release-cache-test' })
  const originalPut = env.ATTEST_KV.put.bind(env.ATTEST_KV)
  env.ATTEST_KV.put = async (key, value, options) => {
    if (key.startsWith('cache:')) throw new Error('cache backend unavailable')
    return originalPut(key, value, options)
  }
  const image = new TextEncoder().encode('IMAGE_BYTES_MUST_NOT_LEAK')
  const warnings = []
  const logs = []
  const originalWarn = console.warn
  const originalLog = console.log
  console.warn = (line) => warnings.push(line)
  console.log = (line) => logs.push(line)
  let res
  try {
    res = await handleOcr(scanRequest(image, {
      'x-resplit-attest-key-id': 'device-key-must-not-leak',
      'x-resplit-client-version': 'cache-failure-test',
      'x-resplit-trace-id': 'trace-cache-write-raw',
    }), env)
  } finally {
    console.warn = originalWarn
    console.log = originalLog
  }

  assert.equal(res.status, 200, 'cache availability must not replace a successful OCR result with a 502')
  const body = await res.json()
  assert.equal(body.v, 1)
  assert.equal(body.mode, 'raw')
  assert.equal(body.provider, 'azure-di')
  assert.equal(body.status, 'ok')
  assert.deepEqual(body.raw, {
    status: 'succeeded',
    analyzeResult: { documents: [{ docType: 'receipt' }] },
  })
  assert.equal(azureCalls.receiptSubmit, 1)
  assert.equal(azureCalls.receiptPoll, 1)

  const cacheFailureLines = warnings.filter((line) => typeof line === 'string' && line.startsWith('[OCR_MONITORING] '))
    .map((line) => JSON.parse(line.replace('[OCR_MONITORING] ', '')))
    .filter((event) => event.signal === 'ocr_cache_write_failed')
  assert.equal(cacheFailureLines.length, 1, 'one cache-write failure must emit exactly one structured signal')
  const [event] = cacheFailureLines
  assert.equal(event.route, 'scan')
  assert.equal(event.scanId, body.scanId)
  assert.equal(event.release, 'release-cache-test')
  assert.equal('requestId' in event, false)
  assert.equal('client_version' in event, false)
  assert.equal(Object.keys(event).some((key) => /image|key|device/i.test(key)), false)
  assert.doesNotMatch(JSON.stringify(event), /IMAGE_BYTES_MUST_NOT_LEAK|azure-key-must-not-leak|device-key-must-not-leak|cache:/)

  const successEvents = logs.filter((line) => typeof line === 'string' && line.startsWith('[OCR_MONITORING] '))
    .map((line) => JSON.parse(line.replace('[OCR_MONITORING] ', '')))
    .filter((event_) => event_.signal === 'scan' && event_.status === 'ok')
  assert.equal(successEvents.length, 1, 'cache degradation must not suppress normal success telemetry')
  assert.equal(successEvents[0].scanId, body.scanId)
})

test('POST /ocr/scan keeps provider success when cache-failure logging throws', async () => {
  stubAzure()
  const env = makeEnv()
  const originalPut = env.ATTEST_KV.put.bind(env.ATTEST_KV)
  env.ATTEST_KV.put = async (key, value, options) => {
    if (key.startsWith('cache:')) throw new Error('cache backend unavailable')
    return originalPut(key, value, options)
  }
  const originalWarn = console.warn
  console.warn = () => { throw new Error('logging unavailable') }
  try {
    const res = await handleOcr(scanRequest(new Uint8Array([4, 3, 2, 1])), env)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.status, 'ok')
    assert.equal(body.raw.analyzeResult.documents[0].docType, 'receipt')
  } finally {
    console.warn = originalWarn
  }
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

test('kill switch returns 503 before billing Azure or touching the daily counter', async () => {
  stubAzure()
  const env = makeEnv({ OCR_SCAN_KILL_SWITCH: 'enabled' })
  const day = new Date().toISOString().slice(0, 10)
  const res = await handleOcr(scanRequest(new Uint8Array([8, 8, 8])), env)
  assert.equal(res.status, 503)
  assert.equal(res.headers.get('retry-after'), '300')
  const body = await res.json()
  assert.equal(body.error, 'OCR_DISABLED')
  assert.equal(azureCalls.submit, 0, 'disabled scans must not reach Azure')
  assert.equal(await env.ATTEST_KV.get(`count:ip:unknown:${day}`), null, 'disabled scans must not spend cap units')
})

test('kill switch returns before reading the request body', async () => {
  const env = makeEnv({ OCR_SCAN_KILL_SWITCH: 'enabled' })
  const unreadableBody = new ReadableStream({
    pull() {
      throw new Error('disabled OCR must not consume the image body')
    },
  })
  const req = new Request('https://fx.resplit.app/ocr/scan', {
    method: 'POST',
    headers: { 'content-type': 'image/jpeg', 'x-resplit-attest-soft-fail': 'true' },
    body: unreadableBody,
    duplex: 'half',
  })

  const res = await handleOcr(req, env)
  assert.equal(res.status, 503)
  const body = await res.json()
  assert.equal(body.error, 'OCR_DISABLED')
})

test('kill switch emits structured OCR monitoring for the disabled scan state', async () => {
  const env = makeEnv({ OCR_SCAN_KILL_SWITCH: 'enabled' })
  const origWarn = console.warn
  const lines = []
  console.warn = (line) => lines.push(line)
  try {
    await handleOcr(scanRequest(new Uint8Array([8, 8, 8])), env)
  } finally {
    console.warn = origWarn
  }
  const monitoringLine = lines.find((l) => typeof l === 'string' && l.startsWith('[OCR_MONITORING] '))
  assert.ok(monitoringLine, 'disabled scans must emit an [OCR_MONITORING] line')
  const json = JSON.parse(monitoringLine.replace('[OCR_MONITORING] ', ''))
  assert.equal(json.signal, 'scan')
  assert.equal(json.status, 'disabled')
  assert.equal(json.domain, 'ocr')
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

test('a provider_error keeps its versioned 502 envelope when OCR Sentry flush rejects', async () => {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (init.method === 'POST' && u.includes(':analyze')) {
      return new Response('azure exploded', { status: 500 })
    }
    throw new Error(`unexpected fetch ${init.method} ${u}`)
  }
  setOcrSentrySdkForTests({
    captureMessage() {},
    flush() { return Promise.reject(new Error('OCR Sentry flush unavailable')) },
    withScope(cb) { cb({ setLevel() {}, setTag() {}, setContext() {} }) },
  })
  setSentryWorkerSdkForTests({
    captureException() {},
    flush() { return Promise.resolve(true) },
    withScope(cb) { cb({ setLevel() {}, setTag() {}, setContext() {} }) },
  })
  try {
    const env = makeEnv({ SENTRY_DSN: 'https://ocr@example.ingest.sentry.io/1' })
    const res = await handleOcr(scanRequest(new Uint8Array([3, 4, 3])), env)
    assert.equal(res.status, 502)
    const body = await res.json()
    assert.equal(body.v, 1)
    assert.equal(body.mode, 'raw')
    assert.equal(body.status, 'provider_error')
  } finally {
    resetOcrSentrySdkForTests()
    resetSentryWorkerSdkForTests()
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
