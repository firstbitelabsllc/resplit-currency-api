import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  scanReceiptWithZai,
  ZAI_RECEIPT_SYSTEM_PROMPT,
  DEFAULT_ZAI_BASE_URL,
} from '../worker/src/ocr/zai.mjs'
import { RECEIPT_SYSTEM_PROMPT, LLM_FETCH_TIMEOUT_MS, LLM_MAX_TOKENS } from '../worker/src/ocr/anthropic.mjs'

// Z.AI (OpenAI-compatible chat completions) transport for the LLM receipt leg.
// Same boundary contract as anthropic.mjs: every failure is data-shaped, the
// paid call never fires on a config error, and the router sees one result shape.

const realFetch = globalThis.fetch
let lastUrl
let lastInit
let lastBody
beforeEach(() => { lastUrl = null; lastInit = null; lastBody = null })
afterEach(() => { globalThis.fetch = realFetch })

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

function chatCompletion(content, { finishReason = 'stop', model = 'glm-5.3-flash' } = {}) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 1000, completion_tokens: 200 },
  }
}

function stubZai(response, status = 200) {
  globalThis.fetch = async (url, init = {}) => {
    lastUrl = String(url)
    lastInit = init
    lastBody = JSON.parse(init.body)
    return Response.json(response, { status })
  }
}

const env = (extra = {}) => ({
  ZAI_API_KEY: 'zai-key-must-not-leak',
  LLM_SCAN_MODEL: 'glm-5.3-flash',
  ...extra,
})

function jpegWithDimensions(width, height) {
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
  ])
}

const image = jpegWithDimensions(800, 600)

function dataUrlBytes(url) {
  const match = /^data:([^;]+);base64,(.*)$/.exec(url)
  assert.ok(match, `expected a base64 data URL, got ${String(url).slice(0, 40)}`)
  return { mediaType: match[1], bytes: Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0)) }
}

test('the Z.AI system prompt is derived from RECEIPT_SYSTEM_PROMPT and asks for a bare JSON object', () => {
  assert.notEqual(ZAI_RECEIPT_SYSTEM_PROMPT, RECEIPT_SYSTEM_PROMPT)
  assert.match(ZAI_RECEIPT_SYSTEM_PROMPT, /ONLY a JSON object/)
  assert.equal(ZAI_RECEIPT_SYSTEM_PROMPT.includes('emit_receipt tool'), false)
  // Every schema key is named so a schema-less chat model knows the exact shape.
  for (const key of ['merchantName', 'merchantAddress', 'transactionDate', 'currencyCode', 'currencySymbol', 'lineItems', 'subtotal', 'total', 'extras']) {
    assert.ok(ZAI_RECEIPT_SYSTEM_PROMPT.includes(key), `prompt names ${key}`)
  }
  assert.ok(ZAI_RECEIPT_SYSTEM_PROMPT.includes('serviceCharge'))
  // The shared extraction rules survive the derivation.
  assert.ok(ZAI_RECEIPT_SYSTEM_PROMPT.includes('LINE-ITEM GRANULARITY'))
  assert.ok(ZAI_RECEIPT_SYSTEM_PROMPT.includes('Comma-decimal 12,50 means 12.50'))
})

test('happy path: unfenced JSON content returns ok:true with the shared result shape', async () => {
  stubZai(chatCompletion(JSON.stringify(scannedReceipt())))
  const res = await scanReceiptWithZai(image, 'image/jpeg', env())

  assert.equal(res.ok, true)
  assert.equal(res.httpStatus, 200)
  assert.deepEqual(res.scanned, scannedReceipt())
  assert.equal(res.model, 'glm-5.3-flash')
  assert.equal(res.errorBody, null)
  assert.equal(res.providerStarted, true)
  assert.equal(res.structuredOutputValid, true)
  assert.equal(res.serviceTierRequested, 'not_applicable')
  assert.equal(res.serviceTierServed, null)
  assert.deepEqual(res.usage, { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 200, totalTokens: null })
  assert.equal(res.servedModel, 'glm-5.3-flash')
  assert.equal(res.inputPx, 800)
  assert.equal(typeof res.latencyMs, 'number')

  assert.equal(lastUrl, `${DEFAULT_ZAI_BASE_URL}/chat/completions`)
  assert.equal(lastInit.headers.authorization, 'Bearer zai-key-must-not-leak')
  assert.equal(lastBody.model, 'glm-5.3-flash')
  assert.equal(lastBody.temperature, 0)
  assert.equal(lastBody.max_tokens, LLM_MAX_TOKENS)
  assert.deepEqual(lastBody.thinking, { type: 'disabled' })
  assert.deepEqual(lastBody.response_format, { type: 'json_object' })
  assert.equal(lastBody.messages[0].role, 'system')
  assert.equal(lastBody.messages[0].content, ZAI_RECEIPT_SYSTEM_PROMPT)
  assert.equal(lastBody.messages[1].role, 'user')
  const [imagePart, textPart] = lastBody.messages[1].content
  assert.equal(imagePart.type, 'image_url')
  const decoded = dataUrlBytes(imagePart.image_url.url)
  assert.equal(decoded.mediaType, 'image/jpeg')
  assert.deepEqual(decoded.bytes, image)
  assert.deepEqual(textPart, { type: 'text', text: 'Extract this receipt.' })
})

test('JSON mode output with prose or fences is rejected instead of repaired', async () => {
  for (const content of [
    '```json\n' + JSON.stringify(scannedReceipt()) + '\n```',
    'Here is the receipt: ' + JSON.stringify(scannedReceipt()),
  ]) {
    stubZai(chatCompletion(content))
    const res = await scanReceiptWithZai(image, 'image/jpeg', env())
    assert.equal(res.ok, false)
    assert.equal(res.failureCode, 'malformed_output')
    assert.equal(res.structuredOutputValid, false)
    assert.equal(res.scanned, null)
  }
})

test('array-shaped message content is joined before parsing', async () => {
  const serialized = JSON.stringify(scannedReceipt())
  stubZai(chatCompletion([{ type: 'text', text: serialized.slice(0, 24) }, { type: 'text', text: serialized.slice(24) }]))
  const res = await scanReceiptWithZai(image, 'image/jpeg', env())
  assert.equal(res.ok, true)
  assert.equal(res.scanned.total, 10)
})

test('LLM_SCAN_BASE_URL overrides the endpoint and a trailing slash is tolerated', async () => {
  stubZai(chatCompletion(JSON.stringify(scannedReceipt())))
  await scanReceiptWithZai(image, 'image/jpeg', env({ LLM_SCAN_BASE_URL: 'https://api.z.ai/api/paas/v4/' }))
  assert.equal(lastUrl, 'https://api.z.ai/api/paas/v4/chat/completions')
})

test('a schema-invalid JSON object is a data-shaped provider_error, never a throw', async () => {
  stubZai(chatCompletion(JSON.stringify(scannedReceipt({ total: '10.00' }))))
  const res = await scanReceiptWithZai(image, 'image/jpeg', env())
  assert.equal(res.ok, false)
  assert.equal(res.httpStatus, 502)
  assert.equal(res.scanned, null)
  assert.equal(res.errorBody, 'llm_schema_violation:total')
  assert.equal(res.providerStarted, true)
  assert.equal(res.structuredOutputValid, false)
})

test('JSON with undeclared receipt, line-item, or extra fields is rejected without repair', async () => {
  const valid = scannedReceipt()
  const cases = [
    [scannedReceipt({ providerMetadata: true }), 'llm_schema_violation:additional_property'],
    [
      scannedReceipt({
        lineItems: [{ ...valid.lineItems[0], unitPrice: 9 }],
      }),
      'llm_schema_violation:lineItem.additional_property',
    ],
    [
      scannedReceipt({
        extras: [{ ...valid.extras[0], rate: 0.1 }],
      }),
      'llm_schema_violation:extra.additional_property',
    ],
  ]

  for (const [scanned, diagnostic] of cases) {
    stubZai(chatCompletion(JSON.stringify(scanned)))
    const res = await scanReceiptWithZai(image, 'image/jpeg', env())
    assert.equal(res.ok, false)
    assert.equal(res.httpStatus, 502)
    assert.equal(res.scanned, null)
    assert.equal(res.errorBody, diagnostic)
    assert.equal(res.failureCode, 'malformed_output')
    assert.equal(res.structuredOutputValid, false)
  }
})

test('content without a JSON object is a data-shaped provider_error', async () => {
  stubZai(chatCompletion('I cannot read this receipt.'))
  const res = await scanReceiptWithZai(image, 'image/jpeg', env())
  assert.equal(res.ok, false)
  assert.equal(res.httpStatus, 502)
  assert.equal(res.errorBody, 'llm_invalid_json')
})

test('finish_reason length is llm_truncated, never a partial success', async () => {
  stubZai(chatCompletion(JSON.stringify(scannedReceipt()), { finishReason: 'length' }))
  const res = await scanReceiptWithZai(image, 'image/jpeg', env())
  assert.equal(res.ok, false)
  assert.equal(res.httpStatus, 502)
  assert.equal(res.errorBody, 'llm_truncated')
})

test('a non-200 upstream is surfaced with its status and a bounded error body', async () => {
  stubZai({ error: { message: 'rate limited' } }, 429)
  const res = await scanReceiptWithZai(image, 'image/jpeg', env())
  assert.equal(res.ok, false)
  assert.equal(res.httpStatus, 429)
  assert.match(res.errorBody, /rate limited/)
  assert.equal(res.providerStarted, true)
})

test('known Z.AI business errors map to closed diagnostics while retaining provider status', async () => {
  for (const [businessCode, expectedFailure] of [
    [1113, 'upstream_balance_exhausted'],
    [1304, 'upstream_daily_cap'],
    [1308, 'upstream_quota_exhausted'],
    [1309, 'upstream_plan_expired'],
    [1311, 'upstream_model_unavailable'],
    [1312, 'upstream_model_busy'],
    [1313, 'upstream_policy_restricted'],
    [1315, 'upstream_key_restricted'],
    [1210, 'upstream_request_invalid'],
    [1213, 'upstream_request_invalid'],
    [1214, 'upstream_request_invalid'],
    [1215, 'upstream_request_invalid'],
    [1211, 'upstream_unknown_model'],
    [1212, 'upstream_model_method_unsupported'],
    [1220, 'upstream_api_permission_denied'],
  ]) {
    stubZai({ code: businessCode, message: 'PRIVATE PROVIDER MESSAGE' }, 429)
    const res = await scanReceiptWithZai(image, 'image/jpeg', env())
    assert.equal(res.failureCode, expectedFailure)
    assert.equal(res.httpStatus, 429)
  }
})

test('a missing ZAI_API_KEY fails closed as 503 before any paid call', async () => {
  let fetches = 0
  globalThis.fetch = async () => { fetches++; return Response.json({}, { status: 200 }) }
  const res = await scanReceiptWithZai(image, 'image/jpeg', { LLM_SCAN_MODEL: 'glm-5.3-flash' })
  assert.equal(res.ok, false)
  assert.equal(res.httpStatus, 503)
  assert.equal(res.providerStarted, false)
  assert.match(res.errorBody, /ZAI_API_KEY/)
  assert.equal(fetches, 0)
})

test('an unsupported image is rejected before the paid call, like the Anthropic leg', async () => {
  let fetches = 0
  globalThis.fetch = async () => { fetches++; return Response.json({}, { status: 200 }) }
  const heic = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63])
  const res = await scanReceiptWithZai(heic, 'image/heic', env())
  assert.equal(res.ok, false)
  assert.equal(res.httpStatus, 415)
  assert.equal(res.errorBody, 'llm_unsupported_media')
  assert.equal(res.providerStarted, false)
  assert.equal(fetches, 0)
})

test('a transport timeout is a data-shaped provider_error with providerStarted true', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  globalThis.fetch = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error(String(init.signal.reason))))
  })
  const pending = scanReceiptWithZai(image, 'image/jpeg', env())
  // Let the async image preparation reach fetch before the clock advances.
  await new Promise((resolve) => setImmediate(resolve))
  t.mock.timers.tick(LLM_FETCH_TIMEOUT_MS)
  const res = await pending
  assert.equal(res.ok, false)
  assert.equal(res.httpStatus, 502)
  assert.equal(res.errorBody, null)
  assert.equal(res.failureCode, 'transport_timeout')
  assert.equal(res.providerStarted, true)
})

test('LLM_SCAN_MAX_EDGE bounds the image sent to Z.AI and reports the long edge', async () => {
  const original = jpegWithDimensions(4000, 3000)
  const transformed = jpegWithDimensions(1600, 1200)
  const calls = []
  stubZai(chatCompletion(JSON.stringify(scannedReceipt())))
  const res = await scanReceiptWithZai(original, 'image/jpeg', env({
    LLM_SCAN_MAX_EDGE: '1600',
    __TEST_LLM_IMAGE_RESIZER: async (bytes, options) => { calls.push(options); return transformed },
  }))
  assert.equal(res.ok, true)
  assert.equal(res.inputPx, 1600)
  assert.deepEqual(calls, [{ sourceWidth: 4000, sourceHeight: 3000, width: 1600, height: 1200, quality: 90, orientation: 1 }])
  const decoded = dataUrlBytes(lastBody.messages[1].content[0].image_url.url)
  assert.deepEqual(decoded.bytes, transformed)
})

test('without LLM_SCAN_MAX_EDGE the Z.AI leg keeps the shared 1568px ceiling', async () => {
  const original = jpegWithDimensions(4000, 3000)
  const transformed = jpegWithDimensions(1568, 1176)
  const calls = []
  stubZai(chatCompletion(JSON.stringify(scannedReceipt())))
  const res = await scanReceiptWithZai(original, 'image/jpeg', env({
    __TEST_LLM_IMAGE_RESIZER: async (bytes, options) => { calls.push(options); return transformed },
  }))
  assert.equal(res.ok, true)
  assert.equal(res.inputPx, 1568)
  assert.equal(calls[0].width, 1568)
})

// ---- bounded single retry on malformed output (LLM_SCAN_ZAI_RETRY_MALFORMED) ----
// Malformed GLM failures are stochastic at temperature 0 (ro18 run-1 vs run-2:
// zero fixture overlap), so one bounded retry is the candidate remedy. The
// default stays OFF: the deployed request path is byte-identical until the
// paired bench proves the retry recovers more scans than it costs.

function stubZaiSequence(responses) {
  let call = 0
  globalThis.fetch = async (url, init = {}) => {
    const response = responses[Math.min(call, responses.length - 1)]
    call += 1
    lastUrl = String(url)
    lastInit = init
    lastBody = JSON.parse(init.body)
    return Response.json(response.body, { status: response.status ?? 200 })
  }
  return () => call
}

test('malformed output does not retry unless the operator enables it (default off)', async () => {
  const calls = stubZaiSequence([{ body: chatCompletion('definitely not json') }])
  const res = await scanReceiptWithZai(image, 'image/jpeg', env())
  assert.equal(res.ok, false)
  assert.equal(res.failureCode, 'malformed_output')
  assert.equal(calls(), 1)
})

test('enabled retry rewrites a malformed first attempt into success and sums usage across attempts', async () => {
  const calls = stubZaiSequence([
    { body: chatCompletion('definitely not json') },
    { body: chatCompletion(JSON.stringify(scannedReceipt())) },
  ])
  const res = await scanReceiptWithZai(image, 'image/jpeg', env({ LLM_SCAN_ZAI_RETRY_MALFORMED: '1' }))
  assert.equal(res.ok, true)
  assert.deepEqual(res.scanned, scannedReceipt())
  assert.equal(res.providerStarted, true)
  assert.equal(calls(), 2)
  // The scan paid for both provider attempts, so billed usage sums them.
  assert.deepEqual(res.usage, { inputTokens: 2000, cachedInputTokens: 0, outputTokens: 400, totalTokens: null })
  assert.equal(typeof res.latencyMs, 'number')
})

test('enabled retry that fails malformed again returns the final failure without inventing success', async () => {
  const calls = stubZaiSequence([
    { body: chatCompletion('nope') },
    { body: chatCompletion('still nope') },
  ])
  const res = await scanReceiptWithZai(image, 'image/jpeg', env({ LLM_SCAN_ZAI_RETRY_MALFORMED: '1' }))
  assert.equal(res.ok, false)
  assert.equal(res.failureCode, 'malformed_output')
  assert.equal(res.structuredOutputValid, false)
  assert.equal(calls(), 2)
})

test('non-malformed provider failures never retry', async () => {
  const calls = stubZaiSequence([
    { body: { error: { message: 'rejected' } }, status: 400 },
    { body: chatCompletion(JSON.stringify(scannedReceipt())) },
  ])
  const res = await scanReceiptWithZai(image, 'image/jpeg', env({ LLM_SCAN_ZAI_RETRY_MALFORMED: '1' }))
  assert.equal(res.ok, false)
  assert.equal(res.failureCode, 'upstream_rejected')
  assert.equal(calls(), 1)
})

test('the retry stays inside the client budget: no second attempt when little time remains', async () => {
  const realNow = Date.now
  let firstCall = true
  // First read is the leg start; every later read reports 80s elapsed, which
  // leaves 90 - 80 - 5 = 5s — under the 10s retry minimum, so no second call.
  Date.now = () => {
    if (firstCall) { firstCall = false; return 0 }
    return 80_000
  }
  try {
    const calls = stubZaiSequence([
      { body: chatCompletion('nope') },
      { body: chatCompletion(JSON.stringify(scannedReceipt())) },
    ])
    const res = await scanReceiptWithZai(image, 'image/jpeg', env({ LLM_SCAN_ZAI_RETRY_MALFORMED: '1' }))
    assert.equal(res.ok, false)
    assert.equal(res.failureCode, 'malformed_output')
    assert.equal(calls(), 1)
  } finally {
    Date.now = realNow
  }
})
