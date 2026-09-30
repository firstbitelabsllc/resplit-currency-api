import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { handleOcr } from '../worker/src/ocr/router.mjs'

const dashboard = JSON.parse(readFileSync(new URL('../grafana/dashboards/resplit-ocr.json', import.meta.url)))
const panel = (id) => dashboard.panels.find((entry) => entry.id === id)

test('raw LLM and total millisecond quantiles use Grafana milliseconds', () => {
  for (const id of [901, 902]) {
    assert.equal(panel(id).fieldConfig.defaults.unit, 'ms', `panel ${id}: 5000 ms must represent five seconds`)
    for (const target of panel(id).targets) assert.match(target.expr, /unwrap (?:llm|total)_ms/)
  }
})

test('both billed-token queries exclude shared-cache replays', () => {
  assert.equal(panel(903).targets.length, 2)
  for (const target of panel(903).targets) {
    assert.match(target.expr, /\| json\s*\|[^\n]*\bcache="miss"\s*\|/)
    assert.match(target.expr, /unwrap llm_(?:input|output)_tokens/)
  }
})

test('model outcomes preserve LLM failure status and malformed-output diagnostic', () => {
  const target = panel(905).targets[0]
  assert.match(target.expr, /sum by \(llm_model, llm_status, llm_diagnostic\)/)
  assert.match(target.legendFormat, /\{\{llm_status\}\}/)
  assert.match(target.legendFormat, /\{\{llm_diagnostic\}\}/)
  assert.doesNotMatch(target.legendFormat, /\{\{status\}\}/)
})

// Exercise the actual log producer with local-only provider fixtures. This binds
// the dashboard filters to cache and LLM fields, independently of query spelling.
async function scanFixture({ llmStatus = 200, content, replay = false } = {}) {
  const originalFetch = globalThis.fetch
  const originalLog = console.log
  const originalWarn = console.warn
  const rows = []
  let providerCalls = 0
  const store = new Map()
  const env = {
    ATTEST_KV: { async get(k) { return store.get(k) ?? null }, async put(k, v) { store.set(k, v) } },
    AZURE_OCR_ENDPOINT: 'https://fixture.cognitiveservices.azure.com', AZURE_OCR_KEY: 'fixture',
    LLM_SCAN_BASE_URL: 'https://openrouter.ai/api/v1', OPENROUTER_API_KEY: 'fixture',
    LLM_SCAN_PROVIDER: 'zai', LLM_SCAN_MODEL: 'google/gemini-2.5-flash-lite', LLM_SCAN_ALLOW_SOFT_FAIL: 'true',
  }
  const receipt = {
    merchantName: 'Cafe', merchantAddress: null, transactionDate: '2026-09-30',
    currencyCode: 'USD', currencySymbol: '$', lineItems: [{ name: 'Coffee', amount: 10, quantity: 1 }],
    subtotal: 10, total: 10, extras: [],
  }
  const capture = (line) => {
    if (typeof line !== 'string' || !line.startsWith('[OCR_MONITORING] ')) return
    const row = JSON.parse(line.slice('[OCR_MONITORING] '.length))
    if (row.signal === 'dual_scan') rows.push(row)
  }
  console.log = console.warn = capture
  globalThis.fetch = async (url, init = {}) => {
    const address = String(url)
    if (address === 'https://openrouter.ai/api/v1/chat/completions') {
      providerCalls++
      return Response.json({
        choices: [{ message: { content: content ?? JSON.stringify(receipt) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1000, completion_tokens: 200 },
      }, { status: llmStatus })
    }
    if (init.method === 'POST' && address.includes(':analyze')) {
      return new Response(null, { status: 202, headers: {
        'operation-location': 'https://fixture.cognitiveservices.azure.com/analyzeResults/fixture',
      } })
    }
    if (address.includes('/analyzeResults/')) {
      return Response.json({ status: 'succeeded', analyzeResult: { documents: [{ fields: {
        Total: { type: 'currency', valueCurrency: { amount: 10, currencyCode: 'USD' } },
      } }] } })
    }
    throw new Error(`unexpected fixture fetch: ${address}`)
  }
  const image = new Uint8Array([
    0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 2, 88, 3, 32, 3,
    1, 34, 0, 2, 17, 1, 3, 17, 1,
  ])
  try {
    for (const route of replay ? ['analyze', 'dual-scan', 'analyze'] : ['analyze']) {
      const response = await handleOcr(new Request(`https://fx.resplit.app/ocr/${route}`, {
        method: 'POST', headers: { 'content-type': 'image/jpeg', 'x-resplit-attest-soft-fail': 'true' }, body: image,
      }), env)
      assert.equal(response.status, 200)
      await response.json()
    }
    return { rows, providerCalls }
  } finally {
    globalThis.fetch = originalFetch
    console.log = originalLog
    console.warn = originalWarn
  }
}

test('one provider call produces a miss and two cross-route hits carrying the same usage', async () => {
  const { rows, providerCalls } = await scanFixture({ replay: true })
  assert.equal(providerCalls, 1)
  assert.deepEqual(rows.map((row) => row.cache), ['miss', 'hit', 'hit'])
  assert.deepEqual(rows.map((row) => row.llm_input_tokens), [1000, 1000, 1000])
  assert.deepEqual(rows.map((row) => row.llm_output_tokens), [200, 200, 200])
})

test('Azure success leaves failed and malformed LLM legs visible despite composite partial status', async () => {
  for (const [options, diagnostic] of [
    [{ llmStatus: 500 }, 'upstream_rejected'],
    [{ content: 'invalid JSON' }, 'malformed_output'],
  ]) {
    const { rows } = await scanFixture(options)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].azure_status, 'succeeded')
    assert.equal(rows[0].status, 'partial')
    assert.equal(rows[0].llm_status, 'provider_error')
    assert.equal(rows[0].llm_diagnostic, diagnostic)
  }
})
