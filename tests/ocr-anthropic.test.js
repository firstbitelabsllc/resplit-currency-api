import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { scanReceiptWithAnthropic, receiptShapeViolation } from '../worker/src/ocr/anthropic.mjs'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const realFetch = globalThis.fetch

let lastBody
beforeEach(() => { lastBody = null })
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

function anthropicToolResponse(input, { stopReason = 'tool_use' } = {}) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    content: [{ type: 'tool_use', id: 'toolu_test', name: 'emit_receipt', input }],
    stop_reason: stopReason,
  }
}

// Stub the Anthropic endpoint with a single JSON response; capture the request body.
function stubAnthropic(response, status = 200) {
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(String(url), ANTHROPIC_URL)
    lastBody = JSON.parse(init.body)
    return Response.json(response, { status })
  }
}

const env = () => ({ ANTHROPIC_API_KEY: 'anthropic-key', LLM_SCAN_MODEL: 'claude-sonnet-5' })
const image = new Uint8Array([1, 2, 3])

test('request uses strict tool use and a 4096 max_tokens ceiling', async () => {
  stubAnthropic(anthropicToolResponse(scannedReceipt()))
  const res = await scanReceiptWithAnthropic(image, 'image/jpeg', env())
  assert.equal(res.ok, true)
  assert.equal(lastBody.max_tokens, 4096) // finding #3: safer ceiling for dense receipts
  assert.equal(lastBody.tools[0].strict, true) // finding #4: Anthropic strict tool use
  assert.equal(lastBody.tools[0].input_schema.additionalProperties, false)
})

test('a valid tool input returns ok:true with the scanned receipt', async () => {
  stubAnthropic(anthropicToolResponse(scannedReceipt()))
  const res = await scanReceiptWithAnthropic(image, 'image/jpeg', env())
  assert.equal(res.ok, true)
  assert.equal(res.httpStatus, 200)
  assert.equal(res.scanned.total, 10)
  assert.equal(res.errorBody, null)
})

test('a truncated response (stop_reason max_tokens) returns ok:false llm_truncated, not a partial', async () => {
  // Partial tool_use + stop_reason max_tokens: the model was cut off mid-emit.
  stubAnthropic(anthropicToolResponse(scannedReceipt(), { stopReason: 'max_tokens' }))
  const res = await scanReceiptWithAnthropic(image, 'image/jpeg', env())
  assert.equal(res.ok, false)
  assert.equal(res.httpStatus, 502)
  assert.equal(res.scanned, null)
  assert.equal(res.errorBody, 'llm_truncated')
})

test('a tool input with a string amount returns ok:false llm_schema_violation', async () => {
  // amount must be a JSON number, not a string — strict:true guards the happy path,
  // this server-side check backstops a model/provider that ignores the schema.
  const bad = scannedReceipt({ lineItems: [{ name: 'Coffee', amount: '9', quantity: 1 }] })
  stubAnthropic(anthropicToolResponse(bad))
  const res = await scanReceiptWithAnthropic(image, 'image/jpeg', env())
  assert.equal(res.ok, false)
  assert.equal(res.httpStatus, 502)
  assert.equal(res.scanned, null)
  assert.match(res.errorBody, /^llm_schema_violation:/)
})

test('a tool input with an out-of-enum extras kind returns ok:false llm_schema_violation', async () => {
  const bad = scannedReceipt({ extras: [{ label: 'Mystery', amount: 1, kind: 'wormhole' }] })
  stubAnthropic(anthropicToolResponse(bad))
  const res = await scanReceiptWithAnthropic(image, 'image/jpeg', env())
  assert.equal(res.ok, false)
  assert.match(res.errorBody, /^llm_schema_violation:/)
})

test('a missing emit_receipt tool_use returns ok:false', async () => {
  stubAnthropic({ id: 'msg', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'no tool' }], stop_reason: 'end_turn' })
  const res = await scanReceiptWithAnthropic(image, 'image/jpeg', env())
  assert.equal(res.ok, false)
  assert.equal(res.errorBody, 'missing emit_receipt tool_use')
})

// --- receiptShapeViolation unit coverage --------------------------------------

test('receiptShapeViolation accepts a well-formed receipt', () => {
  assert.equal(receiptShapeViolation(scannedReceipt()), null)
  // nullable fields may be null
  assert.equal(receiptShapeViolation(scannedReceipt({ subtotal: null, total: null, currencyCode: null })), null)
})

test('receiptShapeViolation rejects string amounts, missing keys, and bad kinds', () => {
  assert.equal(receiptShapeViolation(null), 'not_object')
  assert.match(receiptShapeViolation({ ...scannedReceipt(), total: undefined, missing: true }) || '', /^(missing:total|total)$/)
  assert.equal(receiptShapeViolation(scannedReceipt({ total: '10' })), 'total')
  assert.equal(receiptShapeViolation(scannedReceipt({ lineItems: [{ name: 'x', amount: '9', quantity: 1 }] })), 'lineItem.amount')
  assert.equal(receiptShapeViolation(scannedReceipt({ extras: [{ label: 'x', amount: '1', kind: 'tax' }] })), 'extra.amount')
  assert.equal(receiptShapeViolation(scannedReceipt({ extras: [{ label: 'x', amount: 1, kind: 'nope' }] })), 'extra.kind')
})
