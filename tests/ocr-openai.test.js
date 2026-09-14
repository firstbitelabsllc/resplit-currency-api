import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { scanReceiptWithOpenAI } from '../worker/src/ocr/openai.mjs'
import { receiptSchema, RECEIPT_JSON_SYSTEM_PROMPT } from '../worker/src/ocr/anthropic.mjs'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })
const env = { OPENAI_API_KEY: 'test-key' }
const image = new Uint8Array([255,216,255,192,0,17,8,2,88,3,32,3,1,34,0,2,17,1,3,17,1])
const receipt = {
  merchantName: 'Cafe', merchantAddress: null, transactionDate: null,
  currencyCode: 'USD', currencySymbol: '$', subtotal: null, total: null, extras: [],
  lineItems: [{ name: 'Unreadable price', amount: null, quantity: null }, { name: 'Printed free item', amount: 0, quantity: 1 }],
}
const completed = scanned => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(scanned) }] }] })

test('OpenAI sends the shared contract and preserves null, printed zero and item identity unchanged', async () => {
  let request
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses')
    request = JSON.parse(init.body)
    return Response.json(completed(receipt))
  }
  const result = await scanReceiptWithOpenAI(image, 'image/jpeg', env)
  assert.equal(result.ok, true)
  assert.deepEqual(result.scanned, receipt)
  assert.equal(result.model, 'gpt-6-astra')
  assert.equal(result.inputPx, 800)
  assert.equal(result.providerStarted, true)
  assert.ok(Number.isFinite(result.latencyMs) && result.latencyMs >= 0)
  assert.deepEqual(request.reasoning, { effort: 'low' })
  assert.equal(request.store, false)
  assert.equal(request.instructions, RECEIPT_JSON_SYSTEM_PROMPT)
  assert.deepEqual(request.text.format.schema, receiptSchema)
  assert.equal(request.text.format.strict, true)
  assert.equal(request.input[0].content[0].detail, 'high')
})

test('missing OpenAI key and malformed input do not start a paid request', async () => {
  globalThis.fetch = async () => { assert.fail('must not contact provider') }
  for (const [bytes, config, status] of [[image, {}, 503], [new Uint8Array([1,2,3]), env, 502]]) {
    const result = await scanReceiptWithOpenAI(bytes, 'image/jpeg', config)
    assert.equal(result.ok, false)
    assert.equal(result.httpStatus, status)
    assert.equal(result.providerStarted, false)
  }
})

test('incomplete output is rejected even when its partial JSON happens to parse', async () => {
  globalThis.fetch = async () => Response.json({ ...completed(receipt), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })
  const result = await scanReceiptWithOpenAI(image, 'image/jpeg', env)
  assert.equal(result.ok, false)
  assert.equal(result.scanned, null)
  assert.equal(result.errorBody, 'llm_incomplete:max_output_tokens')
  assert.equal(result.failureCode, 'malformed_output')
})

test('refusal, invalid JSON and wrong amount types remain provider failures', async () => {
  const cases = [
    [{ status: 'completed', output: [{ content: [{ type: 'refusal', refusal: 'Cannot read' }] }] }, 'llm_refusal'],
    [{ status: 'completed', output: [{ content: [{ type: 'output_text', text: '{' }] }] }, 'llm_invalid_json'],
    [completed({ ...receipt, lineItems: [{ name: 'Broken', amount: '0', quantity: 1 }] }), 'llm_schema_violation:'],
  ]
  for (const [body, error] of cases) {
    globalThis.fetch = async () => Response.json(body)
    const result = await scanReceiptWithOpenAI(image, 'image/jpeg', env)
    assert.equal(result.ok, false)
    assert.equal(result.scanned, null)
    assert.ok(result.errorBody.startsWith(error))
    assert.equal(result.failureCode, 'malformed_output')
  }
})

test('rate limits retain HTTP status and transport failures retain attempted-call accounting', async () => {
  globalThis.fetch = async () => new Response('rate limited', { status: 429 })
  let result = await scanReceiptWithOpenAI(image, 'image/jpeg', env)
  assert.equal(result.httpStatus, 429)
  assert.equal(result.providerStarted, true)
  assert.equal(result.failureCode, 'upstream_rate_limited')
  globalThis.fetch = async () => { throw new DOMException('timeout', 'AbortError') }
  result = await scanReceiptWithOpenAI(image, 'image/jpeg', env)
  assert.equal(result.ok, false)
  assert.equal(result.providerStarted, true)
  assert.equal(result.scanned, null)
  assert.equal(result.failureCode, 'transport_error')
})
