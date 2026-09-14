import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inventoryReceiptSet, loadReceiptSet, runProviderReplay, percentile } from '../scripts/ocr-scan-gauntlet.mjs'

function replaySet() {
  return [
    { id: 'a', path: '/dev/null', total: 10, items: 2 },
    { id: 'b', path: '/dev/null', total: 20.5, items: 1 },
    { id: 'c', path: '/dev/null', total: 5, items: 3 },
  ]
}

async function fixtureReplaySet() {
  const root = await mkdtemp(join(tmpdir(), 'ocr-gauntlet-legacy-'))
  await mkdir(join(root, 'images'))
  const set = replaySet().map((receipt) => ({ ...receipt, path: `images/${receipt.id}.jpg` }))
  for (const receipt of set) await writeFile(join(root, receipt.path), Buffer.from([0xff, 0xd8, 0xff]))
  return { root, set }
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
  assert.equal(percentile([300, Number.NaN, 100], 50), 100)
})

test('provider replay carries the provider env and measures failed attempts without exposing provider bodies', async () => {
  const { root, set } = await fixtureReplaySet()
  try {
    const seen = []
    const report = await runProviderReplay({
      set,
      root,
      env: { LLM_SCAN_PROVIDER: 'zai', LLM_SCAN_MODEL: 'glm-5.3-flash', LLM_SCAN_MAX_EDGE: '1600' },
      scan: async (bytes, contentType, env) => {
        seen.push({ contentType, provider: env.LLM_SCAN_PROVIDER })
        return fakeResults[String.fromCharCode(bytes[0])]
      },
      readImage: (entry) => new Uint8Array([entry.id.charCodeAt(0)]),
    })
    assert.equal(report.provider, 'zai')
    assert.equal(report.model, 'glm-5.3-flash')
    assert.equal(report.max_edge, 1600)
    assert.equal(report.n, 3)
    assert.equal(report.errors, 1)
    assert.equal(report.latency_ms.scan_p50, 200)
    assert.equal(report.latency_ms.scan_p95, 300)
    assert.equal(report.latency_ms.scan_max, 300)
    assert.equal(report.latency_ms.attempts_included, 3)
    assert.equal(report.total_exact, 2)
    assert.equal(report.items_exact, 2)
    assert.equal(seen.length, 3)
    assert.equal(seen.every((s) => s.provider === 'zai' && s.contentType === 'image/jpeg'), true)
    const c = report.rows.find((row) => row.id === 'c')
    assert.equal(c.failure_code, 'provider_error')
    assert.equal(c.total_exact, false)
    assert.equal(c.input_px, null)
    assert.equal(JSON.stringify(report).includes('llm_invalid_json'), false)
    assert.equal(JSON.stringify(report).includes('expected_total'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('provider replay defaults to the anthropic dimension when the env names no provider', async () => {
  const { root, set } = await fixtureReplaySet()
  try {
    const report = await runProviderReplay({
      set: set.slice(0, 1),
      root,
      env: {},
      scan: async () => fakeResults.a,
      readImage: () => new Uint8Array([0xFF]),
    })
    assert.equal(report.provider, 'anthropic')
    assert.equal(report.model, 'claude-sonnet-5')
    assert.equal(report.max_edge, null)
    assert.equal(report.total_exact, 1)
    assert.equal(report.errors, 0)
    assert.match(report.prompt_sha256, /^[0-9a-f]{64}$/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('JSONL corpus inventory reports explicit exclusions, coverage and zero/null counts without inferring locale', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocr-gauntlet-'))
  try {
    await mkdir(join(root, 'images'))
    await writeFile(join(root, 'images', 'receipt.jpg'), Buffer.from([0xff, 0xd8, 0xff]))
    const receipts = [
      {
        id: 'eligible-1', image_path: 'images/receipt.jpg', expected: {
          merchantName: 'PRIVATE SHOP', currencyCode: 'EUR', total: 4.5,
          lineItems: [
            { name: 'Known item', amount: null },
            { name: 'Printed promo', amount: 0 },
          ],
        },
      },
      { id: 'private-no-bytes', image_path: null, private: true, expected: { currencyCode: 'USD' } },
      { id: 'missing-file', image_path: 'images/gone.jpg', expected: { currencyCode: 'MYR' } },
    ]
    const jsonl = receipts.map((receipt) => JSON.stringify(receipt)).join('\n') + '\n'
    const setPath = join(root, 'corpus.jsonl')
    await writeFile(setPath, jsonl)
    const loaded = await loadReceiptSet({ setPath })
    assert.equal(loaded.sourceFormat, 'jsonl')
    assert.equal(loaded.receipts.length, 3)

    const inventory = await inventoryReceiptSet(loaded.receipts, { root, sourceFormat: loaded.sourceFormat })
    assert.equal(inventory.fixture_count, 3)
    assert.equal(inventory.eligible_image_count, 1)
    assert.equal(inventory.excluded_count, 2)
    assert.equal(inventory.exclusions.private_image_not_committed, 1)
    assert.equal(inventory.exclusions.image_file_missing, 1)
    assert.deepEqual(inventory.excluded_fixture_ids.private_image_not_committed, ['private-no-bytes'])
    assert.equal(inventory.field_coverage.currencyCode.present, 1)
    assert.equal(inventory.field_coverage.currencyCode.denominator, 1)
    assert.equal(inventory.line_items.total, 2)
    assert.equal(inventory.line_items.names_present, 2)
    assert.equal(inventory.line_items.amounts_missing_or_unreadable, 1)
    assert.equal(inventory.line_items.printed_zero_amounts, 1)
    assert.equal(inventory.currency_distribution.EUR, 1)
    assert.equal(inventory.locale_labels_present, false)
    assert.deepEqual(inventory.locale_denominators, { unlabeled: 1 })
    assert.equal(JSON.stringify(inventory).includes('PRIVATE SHOP'), false)
    assert.equal(JSON.stringify(inventory).includes('receipt.jpg'), false)

    const report = await runProviderReplay({
      set: loaded.receipts,
      sourceFormat: loaded.sourceFormat,
      root,
      env: { LLM_SCAN_PROVIDER: 'openai', LLM_SCAN_MODEL: 'gpt-6-astra' },
      scan: async () => ({
        ok: true, httpStatus: 200, latencyMs: 35, inputPx: 1568,
        scanned: { total: 4.5, lineItems: [{ name: 'MODEL ONLY TEXT', amount: 987654321.123 }, { name: 'MODEL ZERO', amount: 0 }] },
        errorBody: 'RAW PROVIDER BODY',
      }),
    })
    assert.equal(report.n, 1)
    assert.equal(report.inventory.fixture_count, 3)
    assert.equal(report.inventory.eligible_image_count, 1)
    assert.equal(report.total_exact, 1)
    assert.equal(report.rows[0].items_exact, true)
    assert.deepEqual(report.inventory.locale_denominators, { unlabeled: 1 })
    const serialized = JSON.stringify(report)
    assert.equal(serialized.includes('PRIVATE SHOP'), false)
    assert.equal(serialized.includes('MODEL ONLY TEXT'), false)
    assert.equal(serialized.includes('RAW PROVIDER BODY'), false)
    assert.equal(serialized.includes('receipt.jpg'), false)
    assert.equal(serialized.includes('987654321.123'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
