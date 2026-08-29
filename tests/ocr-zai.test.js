import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  scanReceiptWithZai,
  extractJsonObject,
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

test('extractJsonObject strips code fences and surrounding prose', () => {
  assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 })
  assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(extractJsonObject('Here you go:\n```\n{"a":{"b":[1,2]}}\n```\nDone.'), { a: { b: [1, 2] } })
  assert.equal(extractJsonObject('no json here'), null)
  assert.equal(extractJsonObject('{"a":'), null)
  assert.equal(extractJsonObject(''), null)
  assert.equal(extractJsonObject(null), null)
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
  assert.equal(res.inputPx, 800)
  assert.equal(typeof res.latencyMs, 'number')

  assert.equal(lastUrl, `${DEFAULT_ZAI_BASE_URL}/chat/completions`)
  assert.equal(lastInit.headers.authorization, 'Bearer zai-key-must-not-leak')
  assert.equal(lastBody.model, 'glm-5.3-flash')
  assert.equal(lastBody.temperature, 0)
  assert.equal(lastBody.max_tokens, LLM_MAX_TOKENS)
  assert.deepEqual(lastBody.thinking, { type: 'disabled' })
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

test('happy path: fenced JSON content is parsed', async () => {
  stubZai(chatCompletion('```json\n' + JSON.stringify(scannedReceipt({ total: 12.5 })) + '\n```'))
  const res = await scanReceiptWithZai(image, 'image/jpeg', env())
  assert.equal(res.ok, true)
  assert.equal(res.scanned.total, 12.5)
})

test('array-shaped message content is joined before parsing', async () => {
  stubZai(chatCompletion([{ type: 'text', text: '```json\n' }, { type: 'text', text: JSON.stringify(scannedReceipt()) + '\n```' }]))
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
  assert.equal(res.errorBody, 'timeout')
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
