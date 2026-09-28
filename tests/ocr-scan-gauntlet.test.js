import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultComparisonCases, inventoryReceiptSet, loadReceiptSet, runProviderMatrix,
  runProviderReplay, percentile, validateProviderCases,
} from '../scripts/ocr-scan-gauntlet.mjs'

function hashedId(id) {
  return createHash('sha256').update(id).digest('hex').slice(0, 16)
}

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
  a: { ok: true, httpStatus: 200, latencyMs: 100, inputPx: 1600, providerStarted: true, scanned: { total: 10, lineItems: [{}, {}] } },
  b: { ok: true, httpStatus: 200, latencyMs: 300, inputPx: 1600, providerStarted: true, scanned: { total: 20.49, lineItems: [{}] } },
  c: { ok: false, httpStatus: 502, latencyMs: 200, inputPx: null, providerStarted: true, scanned: null, errorBody: 'llm_invalid_json' },
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
    assert.equal(report.latency_ms.provider_attempts_included, 3)
    assert.equal(report.latency_ms.pre_provider_failures, 0)
    assert.equal(report.total_exact, 1)
    assert.equal(report.items_exact, 2)
    assert.equal(seen.length, 3)
    assert.equal(seen.every((s) => s.provider === 'zai' && s.contentType === 'image/jpeg'), true)
    const oneCentMismatch = report.rows.find((row) => row.id === hashedId('b'))
    assert.equal(oneCentMismatch.total_exact, false)
    const c = report.rows.find((row) => row.id === hashedId('c'))
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

test('provider replay separates and safely classifies an image rejected before the provider call', async () => {
  const { root, set } = await fixtureReplaySet()
  try {
    const report = await runProviderReplay({
      set: set.slice(0, 1),
      root,
      env: { LLM_SCAN_PROVIDER: 'openai' },
      scan: async () => ({
        ok: false, httpStatus: 413, latencyMs: 0, providerStarted: false,
        scanned: null, errorBody: 'llm_image_dimensions',
      }),
      readImage: () => new Uint8Array([0xff]),
    })
    assert.equal(report.rows[0].failure_code, 'input_dimensions_unsupported')
    assert.equal(report.latency_ms.provider_attempts_included, 0)
    assert.equal(report.latency_ms.pre_provider_failures, 1)
    assert.equal(report.correctness.structured_output.unknown, 1)
    assert.equal(JSON.stringify(report).includes('llm_image_dimensions'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('money scoring requires exact currency minor units and rejects excess fractional precision', async () => {
  const { root, set: baseSet } = await fixtureReplaySet()
  try {
    const expected = [
      { ...baseSet[0], currencyCode: 'USD', total: 4.5, lineItems: [{ name: 'item', amount: 4.5 }] },
      { ...baseSet[1], currencyCode: 'JPY', total: 4, lineItems: [{ name: 'item', amount: 4 }] },
      { ...baseSet[2], currencyCode: 'KWD', total: 4.504, lineItems: [{ name: 'item', amount: 4.504 }] },
    ]
    const returned = {
      a: { total: 4.504, lineItems: [{ name: 'item', amount: 4.504 }] },
      b: { total: 4.1, lineItems: [{ name: 'item', amount: 4.1 }] },
      c: { total: 4.504, lineItems: [{ name: 'item', amount: 4.504 }] },
    }
    const report = await runProviderReplay({
      set: expected,
      root,
      env: { LLM_SCAN_PROVIDER: 'openai', LLM_SCAN_MODEL: 'gpt-6-astra' },
      scan: async (bytes) => ({
        ok: true, httpStatus: 200, latencyMs: 10,
        scanned: returned[String.fromCharCode(bytes[0])],
      }),
      readImage: (entry) => new Uint8Array([entry.id.charCodeAt(0)]),
    })
    assert.equal(report.total_exact, 1)
    assert.equal(report.total_exact_denominator, 3)
    assert.equal(report.correctness.item_amount_sequence.error_rate, 2 / 3)
    assert.equal(report.rows.find((row) => row.id === hashedId('a')).total_exact, false)
    assert.equal(report.rows.find((row) => row.id === hashedId('b')).total_exact, false)
    assert.equal(report.rows.find((row) => row.id === hashedId('c')).total_exact, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('locale-aware item-name WER tokenizes English and Japanese words and leaves unlabeled rows unscored', async () => {
  const { root, set: baseSet } = await fixtureReplaySet()
  try {
    const fixtures = [
      {
        ...baseSet[0],
        locale: 'en-US',
        lineItems: [{ name: 'ＦＯＯ fresh' }, { name: 'eggs' }],
      },
      {
        ...baseSet[1],
        locale: 'ja-JP',
        lineItems: [{ name: 'りんごを食べる' }],
      },
      {
        ...baseSet[2],
        currencyCode: 'JPY',
        merchantName: '東京店',
        lineItems: [{ name: 'receipt line' }],
      },
    ]
    const outputs = {
      a: [{ name: 'foo fresh eggs' }],
      b: [{ name: 'りんごを飲む' }],
      c: [{ name: 'unrelated text' }],
    }
    const report = await runProviderReplay({
      set: fixtures,
      root,
      env: { LLM_SCAN_PROVIDER: 'openai' },
      scan: async (bytes) => ({
        ok: true,
        httpStatus: 200,
        latencyMs: 10,
        providerStarted: String.fromCharCode(bytes[0]) !== 'b',
        scanned: { total: 1, lineItems: outputs[String.fromCharCode(bytes[0])] },
      }),
      readImage: (entry) => new Uint8Array([entry.id.charCodeAt(0)]),
    })

    const allNames = report.correctness.item_name
    assert.equal(allNames.word_sequence_edit_distance, 2)
    assert.equal(allNames.reference_word_tokens, 7)
    assert.equal(allNames.wer, 2 / 7)

    const providerNames = report.provider_started.correctness.item_name
    assert.equal(providerNames.word_sequence_edit_distance, 1)
    assert.equal(providerNames.reference_word_tokens, 4)
    assert.equal(providerNames.wer, 1 / 4)
    assert.equal(report.provider_started.correctness.by_locale['en-US'].name_wer, 1 / 4)
    assert.equal(report.provider_started.correctness.by_locale.unlabeled.name_wer, null)

    const byLocale = report.correctness.by_locale
    assert.equal(byLocale['en-US'].name_word_sequence_edit_distance, 1)
    assert.equal(byLocale['en-US'].name_reference_word_tokens, 4)
    assert.equal(byLocale['en-US'].name_wer, 1 / 4)
    assert.equal(byLocale['ja-JP'].name_word_sequence_edit_distance, 1)
    assert.equal(byLocale['ja-JP'].name_reference_word_tokens, 3)
    assert.equal(byLocale['ja-JP'].name_wer, 1 / 3)
    assert.equal(byLocale.unlabeled.name_word_sequence_edit_distance, 0)
    assert.equal(byLocale.unlabeled.name_reference_word_tokens, 0)
    assert.equal(byLocale.unlabeled.name_wer, null)
    assert.equal(report.rows.find((row) => row.id === hashedId('c')).name_word_sequence_edit_distance, null)
    assert.equal(report.rows.find((row) => row.id === hashedId('c')).name_reference_word_tokens, 0)
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
    assert.deepEqual(inventory.excluded_fixture_ids.private_image_not_committed, [hashedId('private-no-bytes')])
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

test('comparison matrix reads each fixture image once, pairs the same bytes and prompt, and keeps missing distinct from zero', async () => {
  const { root, set: baseSet } = await fixtureReplaySet()
  try {
    const fixture = {
      ...baseSet[0],
      merchantName: 'PRIVATE SHOP',
      locale: 'en-US',
      lineItems: [
        { name: 'Unknown price', amount: null },
        { name: 'Printed free item', amount: 0 },
      ],
    }
    const exactOutput = {
      total: 10,
      lineItems: [
        { name: 'Unknown price', amount: null },
        { name: 'Printed free item', amount: 0 },
      ],
    }
    const imageBytes = new Uint8Array([17, 29, 43])
    const readEntries = []
    const calls = []
    const cases = [
      { name: 'glm', env: { LLM_SCAN_PROVIDER: 'zai', LLM_SCAN_MODEL: 'glm-test', LLM_SCAN_MAX_EDGE: '1568' }, pricing: null },
      {
        name: 'astra_fast',
        env: { LLM_SCAN_PROVIDER: 'openai', LLM_SCAN_MODEL: 'gpt-6-astra', LLM_SCAN_SERVICE_TIER: 'fast' },
        pricing: { input_usd_per_million: 10, cached_input_usd_per_million: 1, output_usd_per_million: 50, service_tier_multiplier: 2 },
      },
      {
        name: 'future_connector',
        env: { LLM_SCAN_PROVIDER: 'vendor', LLM_SCAN_MODEL: 'vision-2', LLM_SCAN_VENDOR_REGION: 'us-east' },
        credential_env: 'VENDOR_API_KEY',
      },
    ]
    const report = await runProviderMatrix({
      set: [fixture],
      root,
      env: { ZAI_API_KEY: 'secret-zai', OPENAI_API_KEY: 'secret-openai', VENDOR_API_KEY: 'secret-vendor' },
      cases,
      concurrency: 2,
      readImage: async (entry) => { readEntries.push(entry.id); return imageBytes },
      scan: async (bytes, _contentType, env) => {
        assert.strictEqual(bytes, imageBytes)
        calls.push(env.LLM_SCAN_SERVICE_TIER || 'standard')
        if (env.LLM_SCAN_PROVIDER === 'vendor') assert.equal(env.VENDOR_API_KEY, 'secret-vendor')
        assert.equal(env.OPENAI_API_KEY === 'secret-openai', env.LLM_SCAN_PROVIDER === 'openai')
        const fast = env.LLM_SCAN_SERVICE_TIER === 'fast'
        return {
          ok: true, httpStatus: 200, latencyMs: 20, providerStarted: true, inputPx: 1568,
          structuredOutputValid: true,
          serviceTierRequested: fast ? 'fast' : 'not_applicable',
          serviceTierServed: fast ? 'priority' : null,
          servedModel: env.LLM_SCAN_MODEL,
          usage: { inputTokens: 1000, cachedInputTokens: 100, outputTokens: 100, totalTokens: 1100 },
          scanned: exactOutput,
        }
      },
    })
    assert.equal(defaultComparisonCases().length, 2)
    assert.equal(defaultComparisonCases().every((entry) => entry.env.LLM_SCAN_PROVIDER === 'openai'), true)
    assert.equal(report.schema_version, 2)
    assert.equal(report.case_order, 'configured')
    assert.equal(report.same_prompt, true)
    assert.equal(report.eligible_images_read_once, 1)
    assert.deepEqual(readEntries, [fixture.id])
    assert.deepEqual(calls.sort(), ['fast', 'standard', 'standard'])
    assert.equal(report.cases.length, 3)
    const [glm, astra] = report.cases
    assert.equal(glm.report.n, 1)
    assert.equal(astra.report.n, 1)
    assert.equal(glm.report.rows[0].id, astra.report.rows[0].id)
    assert.equal(glm.report.rows[0].fixture_read_ms, astra.report.rows[0].fixture_read_ms)
    assert.equal(astra.report.service_tier_served.priority, 1)
    assert.equal(astra.cost_estimate.usd, 0.0282)
    assert.equal(astra.report.correctness.item_name.cer, 0)
    assert.equal(astra.report.correctness.item_amount_sequence.error_rate, 0)
    assert.equal(astra.report.correctness.item_amount_sequence.expected_unknown, 1)
    assert.equal(astra.report.correctness.item_amount_sequence.expected_printed_zero, 1)
    assert.equal(astra.report.correctness.item_amount_sequence.returned_unknown, 1)
    assert.equal(astra.report.correctness.item_amount_sequence.returned_zero, 1)
    assert.equal(astra.report.provider_started.attempts, 1)
    assert.equal(astra.report.provider_started.total_exact_denominator, 1)
    assert.equal(astra.report.provider_started.correctness.item_amount_sequence.error_rate, 0)
    assert.equal(Number.isFinite(astra.report.latency_ms.fixture_read_p50), true)
    assert.equal(report.cases[2].report.provider, 'vendor')
    const serialized = JSON.stringify(report)
    assert.equal(serialized.includes('PRIVATE SHOP'), false)
    assert.equal(serialized.includes('secret-openai'), false)
    assert.equal(serialized.includes('secret-zai'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rotating matrix order balances provider position and separates model quality from admission failures', async () => {
  const { root, set } = await fixtureReplaySet()
  try {
    const calls = []
    const report = await runProviderMatrix({
      set: set.slice(0, 2),
      root,
      env: {
        OCR_GAUNTLET_CASE_ORDER: 'rotating',
        ZAI_API_KEY: 'secret-zai',
        OPENAI_API_KEY: 'secret-openai',
      },
      cases: [
        { name: 'glm', env: { LLM_SCAN_PROVIDER: 'zai' }, credential_env: 'ZAI_API_KEY' },
        { name: 'astra', env: { LLM_SCAN_PROVIDER: 'openai', LLM_SCAN_MODEL: 'gpt-6-astra' }, credential_env: 'OPENAI_API_KEY' },
      ],
      concurrency: 1,
      readImage: async (entry) => new Uint8Array([entry.id.charCodeAt(0)]),
      scan: async (bytes, _contentType, env) => {
        const id = String.fromCharCode(bytes[0])
        calls.push(`${id}:${env.LLM_SCAN_PROVIDER}`)
        if (id === 'a') {
          return {
            ok: false,
            httpStatus: 413,
            latencyMs: 0,
            providerStarted: false,
            failureCode: 'input_dimensions_unsupported',
            scanned: null,
          }
        }
        return {
          ok: true,
          httpStatus: 200,
          latencyMs: 5,
          providerStarted: true,
          structuredOutputValid: true,
          scanned: { total: 20.5, lineItems: [{}] },
        }
      },
    })

    assert.deepEqual(calls, ['a:zai', 'a:openai', 'b:openai', 'b:zai'])
    assert.equal(report.schema_version, 2)
    assert.equal(report.case_order, 'rotating')
    for (const entry of report.cases) {
      assert.equal(entry.report.errors, 1)
      assert.equal(entry.report.total_exact_denominator, 2)
      assert.equal(entry.report.provider_started.attempts, 1)
      assert.equal(entry.report.provider_started.errors, 0)
      assert.equal(entry.report.provider_started.total_exact, 1)
      assert.equal(entry.report.provider_started.total_exact_denominator, 1)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('provider matrix configuration rejects credential injection and unsafe pricing', () => {
  assert.throws(() => validateProviderCases([
    { name: 'bad', env: { LLM_SCAN_PROVIDER: 'openai', OPENAI_API_KEY: 'must-not-be-accepted' } },
  ]), /credentials must come from the process environment/)
  assert.throws(() => validateProviderCases([
    { name: 'bad', env: { LLM_SCAN_PROVIDER: 'openai' }, pricing: { input_usd_per_million: -1, output_usd_per_million: 50 } },
  ]), /finite non-negative rates/)
  assert.throws(() => validateProviderCases([
    { name: 'bad', env: { LLM_SCAN_PROVIDER: 'openai', LLM_SCAN_BASE_URL: 'https://user:password@example.com/v1' } },
  ]), /without embedded credentials or query data/)
  assert.throws(() => validateProviderCases([
    { name: 'bad', env: { LLM_SCAN_PROVIDER: 'vendor' }, credential_env: 'VENDOR_SECRET' },
  ]), /safe name and configuration object/)
})

test('a named credential_env aliases into the provider key so mixed-aggregator matrices run in one pass', async () => {
  const { root, set } = await fixtureReplaySet()
  try {
    const seen = []
    const report = await runProviderMatrix({
      set: set.slice(0, 1),
      root,
      env: {
        ZAI_API_KEY: 'secret-zai',
        OPENROUTER_API_KEY: 'secret-or',
      },
      cases: [
        { name: 'zai_native', env: { LLM_SCAN_PROVIDER: 'zai' } },
        {
          name: 'or_via_zai_transport',
          env: {
            LLM_SCAN_PROVIDER: 'zai',
            LLM_SCAN_MODEL: 'google/gemini-2.5-flash-lite',
            LLM_SCAN_BASE_URL: 'https://openrouter.ai/api/v1',
          },
          credential_env: 'OPENROUTER_API_KEY',
        },
      ],
      concurrency: 1,
      readImage: async () => new Uint8Array([1]),
      scan: async (_bytes, _contentType, env) => {
        seen.push({ model: env.LLM_SCAN_MODEL || 'glm-default', zai: env.ZAI_API_KEY, or: env.OPENROUTER_API_KEY })
        return {
          ok: true, httpStatus: 200, latencyMs: 5, providerStarted: true,
          structuredOutputValid: true, scanned: { total: 20.5, lineItems: [{}] },
        }
      },
    })
    const native = seen.find((s) => s.model === 'glm-default')
    const orCase = seen.find((s) => s.model !== 'glm-default')
    assert.ok(native && orCase)
    // The native case sees only its own provider key.
    assert.equal(native.zai, 'secret-zai')
    assert.equal(native.or, undefined)
    // The named credential rides AND aliases into the transport's built-in key
    // slot, so the zai transport authenticates against OpenRouter unchanged.
    assert.equal(orCase.or, 'secret-or')
    assert.equal(orCase.zai, 'secret-or')
    // Secrets never reach the report.
    assert.equal(JSON.stringify(report).includes('secret-or'), false)
    assert.equal(JSON.stringify(report).includes('secret-zai'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
