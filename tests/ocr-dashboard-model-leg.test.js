import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { handleOcr } from '../worker/src/ocr/router.mjs'

const dashboard = JSON.parse(readFileSync(new URL('../grafana/dashboards/resplit-ocr.json', import.meta.url)))
const panel = (id) => dashboard.panels.find((entry) => entry.id === id)

// Evaluate the configured JSON-label population against real producer rows.
// This checks population semantics locally; it is not a Loki execution proof.
function queriedRows({ expr }, rows) {
  const filters = [...expr.matchAll(/\|\s+(\w+)(!?=)"([^"]*)"/g)]
    .filter(([, key]) => key !== '__error__')
  const field = expr.match(/\| unwrap (\w+)/)?.[1]
  return rows.filter((row) => filters.every(([, key, op, value]) => {
    const label = row[key] == null ? '' : String(row[key])
    return op === '=' ? label === value : label !== value
  }) && (!field || (row[field] != null && Number.isFinite(Number(row[field])))))
}

test('every model-leg target extracts the prefixed monitoring payload and filters parse/unwrap errors', async () => {
  const { lines } = await scanFixture()
  assert.equal(lines.length, 1)
  assert.throws(() => JSON.parse(lines[0]), SyntaxError, 'the live producer is not a bare JSON line')
  for (const id of [901, 902, 903, 904, 905]) {
    for (const { expr } of panel(id).targets) {
      assert.ok(expr.includes('| regexp `(?P<payload>\\{.*\\})` | line_format `{{.payload}}` | json | __error__=""'), `panel ${id}: extract before JSON parsing`)
      const pattern = expr.match(/\| regexp `([^`]+)`/)[1].replace('(?P<payload>', '(?<payload>')
      const payload = new RegExp(pattern).exec(lines[0]).groups.payload
      assert.equal(JSON.parse(payload).signal, 'dual_scan')
      if (expr.includes('| unwrap ')) assert.match(expr, /\| unwrap \w+ \| __error__="" \[/, `panel ${id}: filter numeric conversion errors`)
    }
  }
})

test('millisecond quantiles select fresh analyze attempts including partial failures with known timing', async () => {
  const success = await scanFixture({ replay: true })
  const failure = await scanFixture({ llmStatus: 500 })
  const malformed = await scanFixture({ content: 'invalid JSON' })
  const legacy = await scanFixture({ routes: ['dual-scan'] })
  const rows = [...success.rows, ...failure.rows, ...malformed.rows, ...legacy.rows]
  for (const id of [901, 902]) {
    assert.equal(panel(id).fieldConfig.defaults.unit, 'ms', `panel ${id}: 5000 ms must represent five seconds`)
    for (const target of panel(id).targets) {
      assert.match(target.expr, /unwrap (?:llm|total)_ms/)
      assert.match(target.expr, /route="analyze" \| cache="miss"/)
      assert.doesNotMatch(target.expr, /\| status="succeeded"/)
      assert.deepEqual(queriedRows(target, rows), [success.rows[0], failure.rows[0], malformed.rows[0]])
      const field = id === 901 ? 'llm_ms' : 'total_ms'
      const unknown = { ...success.rows[0], [field]: null }
      const zero = { ...success.rows[0], [field]: 0 }
      assert.deepEqual(queriedRows(target, [unknown, zero]), [zero])
    }
  }
})

test('known provider-metered token queries exclude replays and unknown usage but keep partial metered failures and zero', async () => {
  const success = await scanFixture({ replay: true })
  const malformed = await scanFixture({ content: 'invalid JSON' })
  const partial = await scanFixture({ azureFailed: true })
  const legacy = await scanFixture({ routes: ['dual-scan'] })
  assert.equal(partial.rows[0].status, 'partial')
  assert.equal(partial.rows[0].llm_input_tokens, 1000)
  assert.equal(malformed.rows[0].llm_input_tokens, null, 'the producer discards malformed-output usage')
  assert.equal(panel(903).targets.length, 2)
  assert.match(panel(903).title, /KNOWN provider-metered/)
  assert.match(panel(903).description, /Unknown usage is excluded/)
  assert.match(panel(903).description, /not total billing/)
  for (const target of panel(903).targets) {
    assert.match(target.expr, /\| json\s*\|[^\n]*\bcache="miss"\s*\|/)
    assert.match(target.expr, /unwrap llm_(?:input|output)_tokens/)
    assert.match(target.expr, /route="analyze"/)
    assert.doesNotMatch(target.expr, /\| status="succeeded"/)
    const field = target.expr.match(/unwrap (\w+)/)[1]
    const unknown = { ...success.rows[0], [field]: null }
    const zero = { ...success.rows[0], [field]: 0 }
    const rows = [...success.rows, ...malformed.rows, ...partial.rows, ...legacy.rows, unknown, zero]
    assert.deepEqual(queriedRows(target, rows), [success.rows[0], partial.rows[0], zero])
  }
})

test('fresh analyze outcomes preserve LLM failures without replay duplicates; drift labels all observations', async () => {
  const success = await scanFixture({ replay: true })
  const failure = await scanFixture({ llmStatus: 500 })
  const malformed = await scanFixture({ content: 'invalid JSON' })
  const legacy = await scanFixture({ routes: ['dual-scan'] })
  const target = panel(905).targets[0]
  assert.match(target.expr, /sum by \(llm_model, llm_status, llm_diagnostic\)/)
  assert.match(target.legendFormat, /\{\{llm_status\}\}/)
  assert.match(target.legendFormat, /\{\{llm_diagnostic\}\}/)
  assert.doesNotMatch(target.legendFormat, /\{\{status\}\}/)
  assert.match(target.expr, /route="analyze" \| cache="miss"/)
  assert.doesNotMatch(target.expr, /\| status="succeeded"/)
  assert.deepEqual(queriedRows(target, [...success.rows, ...failure.rows, ...malformed.rows, ...legacy.rows]),
    [success.rows[0], failure.rows[0], malformed.rows[0]])
  assert.match(panel(904).title, /all routes, including cache replays/)
  assert.match(panel(904).targets[1].legendFormat, /composite succeeded observations/)
})

// Exercise the actual log producer with local-only provider fixtures. This binds
// the dashboard filters to cache and LLM fields, independently of query spelling.
async function scanFixture({ llmStatus = 200, content, replay = false, routes, azureFailed = false } = {}) {
  const originalFetch = globalThis.fetch
  const originalLog = console.log
  const originalWarn = console.warn
  const rows = []
  const lines = []
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
    if (row.signal === 'dual_scan') { rows.push(row); lines.push(line) }
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
      if (azureFailed) return Response.json({ status: 'failed' })
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
    for (const route of routes ?? (replay ? ['analyze', 'dual-scan', 'analyze'] : ['analyze'])) {
      const response = await handleOcr(new Request(`https://fx.resplit.app/ocr/${route}`, {
        method: 'POST', headers: { 'content-type': 'image/jpeg', 'x-resplit-attest-soft-fail': 'true' }, body: image,
      }), env)
      assert.equal(response.status, 200)
      await response.json()
    }
    return { rows, lines, providerCalls }
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
