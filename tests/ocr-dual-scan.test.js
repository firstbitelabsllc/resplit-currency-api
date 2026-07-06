import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { handleOcr } from '../worker/src/ocr/router.mjs'
import { setOcrSentrySdkForTests, resetOcrSentrySdkForTests } from '../worker/src/ocr/monitoring.mjs'

// --- App Attest assertion builders (attested-path tests) -----------------------
// Mirrors tests/ocr-attest.test.js so the dual-scan attested branch (attest === 'pass')
// is exercised with a genuine ES256 assertion, not stubbed. The auth-bypass fix means
// only an attested device (or the explicit dev-unlock flag) may reach the paid LLM leg.
const APP_ID = 'GXS8378HLM.com.superfit.Resplit'

function concatBytes(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const a of arrs) { out.set(a, off); off += a.length }
  return out
}
function cborBytes(b) {
  const len = b.length
  let head
  if (len < 24) head = Uint8Array.of(0x40 | len)
  else if (len < 256) head = Uint8Array.of(0x58, len)
  else head = Uint8Array.of(0x59, (len >> 8) & 0xff, len & 0xff)
  return concatBytes(head, b)
}
function cborText(s) {
  const b = new TextEncoder().encode(s)
  return concatBytes(Uint8Array.of(0x60 | b.length), b)
}
function cborAssertion(signatureDer, authData) {
  return concatBytes(
    Uint8Array.of(0xa2),
    cborText('signature'), cborBytes(signatureDer),
    cborText('authenticatorData'), cborBytes(authData),
  )
}
function rawToDer(raw) {
  const enc = (b) => {
    let i = 0
    while (i < b.length - 1 && b[i] === 0) i++
    let v = b.subarray(i)
    if (v[0] & 0x80) v = concatBytes(Uint8Array.of(0x00), v)
    return concatBytes(Uint8Array.of(0x02, v.length), v)
  }
  const r = enc(raw.subarray(0, 32))
  const s = enc(raw.subarray(32, 64))
  const body = concatBytes(r, s)
  return concatBytes(Uint8Array.of(0x30, body.length), body)
}
const sha256Bytes = async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b))
function bytesToB64(bytes) {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}
async function buildAuthData(signCount) {
  const rpIdHash = await sha256Bytes(new TextEncoder().encode(APP_ID))
  const ad = new Uint8Array(37)
  ad.set(rpIdHash, 0)
  ad[32] = 0x00
  new DataView(ad.buffer).setUint32(33, signCount)
  return ad
}
async function buildAssertion(privateKey, clientData, signCount) {
  const authData = await buildAuthData(signCount)
  const clientDataHash = await sha256Bytes(clientData)
  const signedData = concatBytes(authData, clientDataHash)
  const rawSig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, signedData))
  return bytesToB64(cborAssertion(rawToDer(rawSig), authData))
}
// Seed env.ATTEST_KV with a registered key; return the private key for signing.
async function seedAttestedKey(env, keyId) {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey))
  await env.ATTEST_KV.put(`attest:${keyId}`, JSON.stringify({ publicKeyB64: bytesToB64(spki), signCount: 0 }))
  return keyPair.privateKey
}
// An attested (verified-assertion) dual-scan request — deliberately NO soft-fail header.
function attestedDualScanRequest(imageBytes, { keyId, assertionB64 }) {
  return new Request('https://fx.resplit.app/ocr/dual-scan', {
    method: 'POST',
    headers: {
      'content-type': 'image/jpeg',
      'x-resplit-attest-key-id': keyId,
      'x-resplit-attest-assertion': assertionB64,
    },
    body: imageBytes,
  })
}

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

test('POST /ocr/dual-scan returns dual succeeded envelope for an attested, allowlisted device', async () => {
  // Attested path: a genuine App Attest assertion (attest === 'pass') + an allowlisted
  // keyId is the ONLY non-dev-unlock way to reach the paid LLM leg after the auth fix.
  stubProviders()
  const env = makeEnv({ ANTHROPIC_API_KEY: 'anthropic-key', LLM_SCAN_ALLOWED_KEY_IDS: 'kid-1' })
  const image = new Uint8Array([1, 2, 3])
  const privateKey = await seedAttestedKey(env, 'kid-1')
  const assertionB64 = await buildAssertion(privateKey, image, 1)
  const res = await handleOcr(attestedDualScanRequest(image, { keyId: 'kid-1', assertionB64 }), env)
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
  // Findings #3/#4: strict tool use + a safer max_tokens ceiling for dense receipts.
  assert.equal(calls.anthropicBodies[0].tools[0].strict, true)
  assert.equal(calls.anthropicBodies[0].max_tokens, 4096)
})

test('POST /ocr/dual-scan soft-fail with an allowlisted keyId is still not_allowed without the unlock flag', async () => {
  // AUTH-BYPASS REGRESSION: kid-1 IS allowlisted, but the request is soft-fail
  // (unverified). The raw x-resplit-attest-key-id header must NOT unlock the paid leg —
  // only an attested device or the explicit LLM_SCAN_ALLOW_SOFT_FAIL flag may.
  stubProviders()
  const env = makeEnv({ ANTHROPIC_API_KEY: 'anthropic-key', LLM_SCAN_ALLOWED_KEY_IDS: 'kid-1' })
  const res = await handleOcr(dualScanRequest(new Uint8Array([1, 1, 1]), { 'x-resplit-attest-key-id': 'kid-1' }), env)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.status, 'partial')
  assert.equal(body.azure.status, 'succeeded')
  assert.equal(body.llm.status, 'not_allowed')
  assert.equal(calls.anthropic, 0)
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
  const env = makeEnv({ ANTHROPIC_API_KEY: 'anthropic-key', LLM_SCAN_ALLOW_SOFT_FAIL: 'true', LLM_SCAN_DAILY_CAP: '1' })
  const day = new Date().toISOString().slice(0, 10)
  await env.ATTEST_KV.put(`llmcount:${day}`, '1')
  const res = await handleOcr(dualScanRequest(new Uint8Array([4, 4, 4])), env)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.status, 'partial')
  assert.equal(body.azure.status, 'succeeded')
  assert.equal(body.llm.status, 'rate_limited')
  assert.equal(calls.anthropic, 0)
})

test('POST /ocr/dual-scan enforces the default LLM daily cap when LLM_SCAN_DAILY_CAP is non-numeric', async () => {
  // FAIL-CLOSED: a malformed cap ('' or 'fifty') must resolve to the documented default
  // 50, never NaN — `current + 1 > NaN` is always false, which would lift the cap to
  // infinity and let the paid leg run unbounded.
  stubProviders()
  for (const badCap of ['', 'fifty']) {
    const env = makeEnv({ ANTHROPIC_API_KEY: 'anthropic-key', LLM_SCAN_ALLOW_SOFT_FAIL: 'true', LLM_SCAN_DAILY_CAP: badCap })
    const day = new Date().toISOString().slice(0, 10)
    await env.ATTEST_KV.put(`llmcount:${day}`, '50') // at the default cap
    const res = await handleOcr(dualScanRequest(new Uint8Array([2, 2, 2])), env)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.llm.status, 'rate_limited', `cap=${JSON.stringify(badCap)} must enforce the default 50`)
    assert.equal(calls.anthropic, 0, `cap=${JSON.stringify(badCap)} must not reach Anthropic`)
  }
})

test('POST /ocr/dual-scan totals disagreement emits an ocr_totals_divergence Sentry warning; agreement does not (P8 alert wiring)', async () => {
  const captured = { messages: [], scopes: [] }
  setOcrSentrySdkForTests({
    captureMessage(m) { captured.messages.push(m) },
    flush() { return Promise.resolve(true) },
    withScope(cb) {
      const scope = { tags: {}, contexts: {}, level: null, setLevel(l) { this.level = l }, setTag(k, v) { this.tags[k] = v }, setContext(k, v) { this.contexts[k] = v } }
      captured.scopes.push(scope)
      cb(scope)
    },
  })
  try {
    // Disagree: azure 12 vs llm 14 -> the watched signal fires at warning level.
    stubProviders({
      azure: azureRaw({ total: 12, tax: 1 }),
      scanned: scannedReceipt({ total: 14 }),
    })
    const env = makeEnv({ ANTHROPIC_API_KEY: 'anthropic-key', LLM_SCAN_ALLOW_SOFT_FAIL: 'true', SENTRY_DSN: 'https://ocr@example.ingest.sentry.io/1' })
    const res = await handleOcr(dualScanRequest(new Uint8Array([9, 1, 9])), env)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.divergence.totalsAgree, false)
    const divScope = captured.scopes.find((s) => s.tags['monitoring.signal'] === 'ocr_totals_divergence')
    assert.ok(divScope, 'a totals disagreement must emit an ocr_totals_divergence Sentry issue')
    assert.equal(divScope.level, 'warning', 'divergence is a warning, not an error — the scan itself worked')
    assert.equal(divScope.contexts.ocrTotalsDivergence.azureTotal, 12)
    assert.equal(divScope.contexts.ocrTotalsDivergence.llmTotal, 14)
    assert.equal(captured.messages.some((m) => /totals_divergence/.test(m)), true)

    // Agree: default 10 vs 10 -> no divergence capture (fresh image, cache miss).
    const before = captured.scopes.length
    stubProviders()
    const res2 = await handleOcr(dualScanRequest(new Uint8Array([9, 2, 9])), env)
    assert.equal(res2.status, 200)
    const body2 = await res2.json()
    assert.equal(body2.divergence.totalsAgree, true)
    const newDivScopes = captured.scopes.slice(before).filter((s) => s.tags['monitoring.signal'] === 'ocr_totals_divergence')
    assert.equal(newDivScopes.length, 0, 'agreeing totals must not alert')
  } finally {
    resetOcrSentrySdkForTests()
  }
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
  const env = makeEnv({ ANTHROPIC_API_KEY: 'anthropic-key', LLM_SCAN_ALLOW_SOFT_FAIL: 'true' })
  const res = await handleOcr(dualScanRequest(new Uint8Array([5, 5, 5])), env)
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

test('POST /ocr/dual-scan soft-fail unlock admits keyless device when LLM_SCAN_ALLOW_SOFT_FAIL=true', async () => {
  stubProviders()
  const env = makeEnv({ ANTHROPIC_API_KEY: 'anthropic-key', LLM_SCAN_ALLOW_SOFT_FAIL: 'true' })
  const res = await handleOcr(dualScanRequest(new Uint8Array([7, 7, 7])), env)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.status, 'succeeded')
  assert.equal(body.llm.status, 'succeeded')
  assert.equal(calls.anthropic, 1)
})

test('POST /ocr/dual-scan does NOT cache an LLM-failed partial — retry re-runs the LLM leg', async () => {
  // Anthropic fails transiently on the first call (HTTP 500 → provider_error),
  // then succeeds on the retry of the SAME image. If the partial were cached, the
  // second request would be served the pinned failure and never re-hit Anthropic.
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (u === 'https://api.anthropic.com/v1/messages') {
      calls.anthropic++
      if (calls.anthropic === 1) {
        return new Response('anthropic upstream boom', { status: 500 })
      }
      return Response.json(anthropicToolResponse(scannedReceipt()), { status: 200 })
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
      return Response.json(azureRaw(), { status: 200 })
    }
    throw new Error(`unexpected fetch ${init.method} ${u}`)
  }

  const env = makeEnv({ ANTHROPIC_API_KEY: 'anthropic-key', LLM_SCAN_ALLOW_SOFT_FAIL: 'true' })
  const image = new Uint8Array([9, 9, 9])

  const res1 = await handleOcr(dualScanRequest(image), env)
  const body1 = await res1.json()
  assert.equal(body1.status, 'partial')
  assert.equal(body1.azure.status, 'succeeded')
  assert.equal(body1.llm.status, 'provider_error')
  assert.equal(calls.anthropic, 1)

  // The failed partial must NOT be pinned in KV for this image+gate+model.
  const cacheKeys = [...env.ATTEST_KV.store.keys()].filter((k) => k.startsWith('cache:dualScan:'))
  assert.equal(cacheKeys.length, 0, 'LLM-failed partial must not be cached')

  const res2 = await handleOcr(dualScanRequest(image), env)
  const body2 = await res2.json()
  assert.equal(body2.status, 'succeeded')
  assert.equal(body2.llm.status, 'succeeded')
  assert.equal(body2.llm.scanned.total, 10)
  // Proof the retry actually re-ran the LLM leg instead of serving a cached failure.
  assert.equal(calls.anthropic, 2)

  // A fully-succeeded result IS cached — a third request is served without a 3rd LLM call.
  const res3 = await handleOcr(dualScanRequest(image), env)
  const body3 = await res3.json()
  assert.equal(body3.status, 'succeeded')
  assert.equal(body3.llm.status, 'succeeded')
  assert.equal(calls.anthropic, 2, 'succeeded result should be cached and not re-hit Anthropic')
})

test('POST /ocr/dual-scan soft-fail stays not_allowed when unlock var is absent', async () => {
  stubProviders()
  const env = makeEnv({ ANTHROPIC_API_KEY: 'anthropic-key' })
  const res = await handleOcr(dualScanRequest(new Uint8Array([8, 8, 8])), env)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.status, 'partial')
  assert.equal(body.llm.status, 'not_allowed')
  assert.equal(calls.anthropic, 0)
})

test('POST /ocr/dual-scan does NOT cache a truncated LLM leg (stop_reason max_tokens)', async () => {
  // Anthropic returns a partial tool_use with stop_reason 'max_tokens'. The leg must
  // fail (provider_error, scanned null) and the truncated partial must never be cached.
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (u === 'https://api.anthropic.com/v1/messages') {
      calls.anthropic++
      const truncated = anthropicToolResponse(scannedReceipt())
      truncated.stop_reason = 'max_tokens'
      return Response.json(truncated, { status: 200 })
    }
    if (init.method === 'POST' && u.includes(':analyze')) {
      calls.azureSubmit++
      return new Response('', { status: 202, headers: { 'operation-location': 'https://test.cognitiveservices.azure.com/documentintelligence/documentModels/prebuilt-receipt/analyzeResults/op-receipt?api-version=2024-11-30' } })
    }
    if (u.includes('/analyzeResults/')) {
      calls.azurePoll++
      return Response.json(azureRaw(), { status: 200 })
    }
    throw new Error(`unexpected fetch ${init.method} ${u}`)
  }
  const env = makeEnv({ ANTHROPIC_API_KEY: 'anthropic-key', LLM_SCAN_ALLOW_SOFT_FAIL: 'true' })
  const res = await handleOcr(dualScanRequest(new Uint8Array([6, 6, 6])), env)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.status, 'partial')
  assert.equal(body.azure.status, 'succeeded')
  assert.equal(body.llm.status, 'provider_error')
  assert.equal(body.llm.scanned, null)
  const cacheKeys = [...env.ATTEST_KV.store.keys()].filter((k) => k.startsWith('cache:dualScan:'))
  assert.equal(cacheKeys.length, 0, 'a truncated LLM leg must not be cached')
})

test('POST /ocr/dual-scan reports a failed LLM leg to Sentry (paid-leg error observability)', async () => {
  // Azure succeeds, Anthropic 500s -> llm provider_error. With a DSN set, the paid leg's
  // failure must surface as a Sentry issue tagged ocr_llm_error (finding #7).
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (u === 'https://api.anthropic.com/v1/messages') {
      calls.anthropic++
      return new Response('anthropic upstream boom', { status: 500 })
    }
    if (init.method === 'POST' && u.includes(':analyze')) {
      calls.azureSubmit++
      return new Response('', { status: 202, headers: { 'operation-location': 'https://test.cognitiveservices.azure.com/documentintelligence/documentModels/prebuilt-receipt/analyzeResults/op-receipt?api-version=2024-11-30' } })
    }
    if (u.includes('/analyzeResults/')) {
      calls.azurePoll++
      return Response.json(azureRaw(), { status: 200 })
    }
    throw new Error(`unexpected fetch ${init.method} ${u}`)
  }
  const captured = { messages: [], scopes: [] }
  setOcrSentrySdkForTests({
    captureMessage(m) { captured.messages.push(m) },
    flush() { return Promise.resolve(true) },
    withScope(cb) {
      const scope = { tags: {}, contexts: {}, setLevel() {}, setTag(k, v) { this.tags[k] = v }, setContext(k, v) { this.contexts[k] = v } }
      captured.scopes.push(scope)
      cb(scope)
    },
  })
  try {
    const env = makeEnv({ ANTHROPIC_API_KEY: 'anthropic-key', LLM_SCAN_ALLOW_SOFT_FAIL: 'true', SENTRY_DSN: 'https://ocr@example.ingest.sentry.io/1' })
    const res = await handleOcr(dualScanRequest(new Uint8Array([7, 7, 7])), env)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.llm.status, 'provider_error')
    const llmScope = captured.scopes.find((s) => s.tags['monitoring.signal'] === 'ocr_llm_error')
    assert.ok(llmScope, 'a failed llm leg must emit an ocr_llm_error Sentry issue')
    assert.equal(captured.messages.some((m) => /llm_error/.test(m)), true, 'the captured message names llm_error')
    // Azure succeeded — the azure-leg capture must NOT fire here.
    assert.equal(captured.scopes.some((s) => s.tags['monitoring.signal'] === 'ocr_provider_error'), false)
  } finally {
    resetOcrSentrySdkForTests()
  }
})
