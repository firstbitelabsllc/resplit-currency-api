import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runProviderReplay, percentile } from '../scripts/ocr-scan-gauntlet.mjs'

// The provider replay reads the same env the Worker reads and scores every row
// against ground truth; the scan seam is injected so no network or key is needed.
function replaySet() {
  return [
    { id: 'a', path: '/dev/null', total: 10, items: 2 },
    { id: 'b', path: '/dev/null', total: 20.5, items: 1 },
    { id: 'c', path: '/dev/null', total: 5, items: 3 },
  ]
}

const fakeResults = {
  a: { ok: true, httpStatus: 200, latencyMs: 100, inputPx: 1600, scanned: { total: 10, lineItems: [{}, {}] } },
  b: { ok: true, httpStatus: 200, latencyMs: 300, inputPx: 1600, scanned: { total: 20.49, lineItems: [{}] } },
  c: { ok: false, httpStatus: 502, latencyMs: 200, inputPx: null, scanned: null, errorBody: 'llm_invalid_json' },
}

test('percentile picks the nearest-rank value and is null on an empty sample', () => {
  assert.equal(percentile([], 50), null)
  assert.equal(percentile([300, 100, 200], 50), 200)
  assert.equal(percentile([300, 100, 200], 95), 300)
})

test('provider replay carries the zai env dimension and scores totals per row', async () => {
  const seen = []
  const report = await runProviderReplay({
    set: replaySet(),
    env: { LLM_SCAN_PROVIDER: 'zai', LLM_SCAN_MODEL: 'glm-5.3-flash', LLM_SCAN_MAX_EDGE: '1600' },
    scan: async (bytes, contentType, env) => {
      seen.push({ contentType, provider: env.LLM_SCAN_PROVIDER })
      return fakeResults[String.fromCharCode(bytes[0])]
    },
    readImage: (receipt) => new Uint8Array([receipt.id.charCodeAt(0)]),
  })
  assert.equal(report.provider, 'zai')
  assert.equal(report.model, 'glm-5.3-flash')
  assert.equal(report.max_edge, 1600)
  assert.equal(report.n, 3)
  assert.equal(report.errors, 1)
  assert.equal(report.p50_ms, 100)
  assert.equal(report.p95_ms, 300)
  assert.equal(report.max_ms, 300)
  assert.equal(report.total_exact, 2)
  assert.equal(report.items_exact, 2)
  assert.equal(seen.length, 3)
  assert.equal(seen.every((s) => s.provider === 'zai' && s.contentType === 'image/jpeg'), true)
  const c = report.rows.find((r) => r.id === 'c')
  assert.equal(c.error, 'llm_invalid_json')
  assert.equal(c.total_exact, false)
  assert.equal(c.input_px, null)
})

test('provider replay defaults to the anthropic dimension when the env names no provider', async () => {
  const report = await runProviderReplay({
    set: replaySet().slice(0, 1),
    env: {},
    scan: async () => fakeResults.a,
    readImage: () => new Uint8Array([0xFF]),
  })
  assert.equal(report.provider, 'anthropic')
  assert.equal(report.model, 'claude-sonnet-5')
  assert.equal(report.max_edge, null)
  assert.equal(report.total_exact, 1)
  assert.equal(report.errors, 0)
})
