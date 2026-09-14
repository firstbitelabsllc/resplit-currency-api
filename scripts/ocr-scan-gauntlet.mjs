#!/usr/bin/env node
// Replay the canonical receipt fixtures through the Worker provider seam. The
// runner preserves fixture order and ground truth; it never repairs model output
// or exposes receipt names, amounts, paths, images, or provider bodies in reports.
//
//   OCR_GAUNTLET_SET=Tests/Fixtures/Receipts/corpus.jsonl \
//     OCR_GAUNTLET_ROOT=/path/to/resplit-ios \
//     LLM_SCAN_PROVIDER=openai LLM_SCAN_MODEL=gpt-6-astra \
//     node scripts/ocr-scan-gauntlet.mjs
//
// Provider credentials stay in the existing provider-specific environment
// variables. Change only the provider/model/tier between paired runs.

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { extname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { scanReceiptWithLlm, llmProvider, llmModel, llmMaxEdge } from '../worker/src/ocr/llm-provider.mjs'
import { RECEIPT_PROMPT_REVISION, RECEIPT_JSON_SYSTEM_PROMPT } from '../worker/src/ocr/anthropic.mjs'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const DEFAULT_SET_PATH = `${process.env.HOME || ''}/.shadow/plans/resplit-observability/evidence/2026-08-28-scan-model-gauntlet-set.json`
const CORPUS_FIELDS = [
  'merchantName', 'merchantAddress', 'transactionDate', 'transactionTime',
  'currencyCode', 'currencySymbol', 'lineItems', 'subtotal', 'total', 'extras',
]

export function percentile(values, p) {
  const finite = values.filter(Number.isFinite)
  if (finite.length === 0) return null
  const sorted = [...finite].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

function parseJsonLines(text) {
  return text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line))
}

export async function loadReceiptSet({ env = process.env, setPath = null } = {}) {
  const path = setPath || env.OCR_GAUNTLET_SET || DEFAULT_SET_PATH
  const text = await readFile(path, 'utf8')
  let receipts
  if (extname(path).toLowerCase() === '.jsonl') {
    receipts = parseJsonLines(text)
  } else {
    try {
      receipts = JSON.parse(text)
    } catch {
      receipts = parseJsonLines(text)
    }
  }
  if (!Array.isArray(receipts)) throw new TypeError('receipt fixture set must be a JSON array or JSONL')
  return { receipts, sourceFormat: extname(path).toLowerCase() === '.jsonl' ? 'jsonl' : 'json' }
}

function receiptId(receipt, index) {
  return typeof receipt?.id === 'string' && receipt.id.length > 0 ? receipt.id : `fixture-${index + 1}`
}

function imagePathFor(receipt, root) {
  const imagePath = receipt?.image_path ?? receipt?.path
  if (typeof imagePath !== 'string' || imagePath.length === 0) return null
  return isAbsolute(imagePath) ? imagePath : resolve(root, imagePath)
}

function expectedReceipt(receipt) {
  return receipt?.expected && typeof receipt.expected === 'object' ? receipt.expected : receipt
}

function explicitLocale(receipt) {
  // Only fixture-authored labels count. Currency, tags, merchant names, and
  // model output are deliberately not used to infer language or locale.
  const value = receipt?.locale ?? receipt?.expected?.locale
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function hasGroundTruth(value) {
  return value !== null && value !== undefined && !(typeof value === 'string' && value.trim() === '')
}

async function collectReceiptInventory(receipts, { root = REPO_ROOT, sourceFormat = 'unknown' } = {}) {
  const eligible = []
  const exclusionCounts = Object.create(null)
  const excludedIds = Object.create(null)
  for (let index = 0; index < receipts.length; index += 1) {
    const receipt = receipts[index]
    const id = receiptId(receipt, index)
    const imagePath = imagePathFor(receipt, root)
    let reason = null
    if (!imagePath) reason = receipt?.private === true ? 'private_image_not_committed' : 'no_image_path'
    else {
      try {
        const info = await stat(imagePath)
        if (!info.isFile()) reason = 'image_file_missing'
      } catch {
        reason = 'image_file_missing'
      }
    }
    if (reason) {
      exclusionCounts[reason] = (exclusionCounts[reason] || 0) + 1
      ;(excludedIds[reason] ||= []).push(id)
      continue
    }
    eligible.push({ receipt, id, imagePath, expected: expectedReceipt(receipt), index })
  }

  const fieldCoverage = Object.fromEntries(CORPUS_FIELDS.map((field) => [field, 0]))
  const currencies = Object.create(null)
  const locales = Object.create(null)
  let lineItemCount = 0
  let namedItemCount = 0
  let unnamedItemCount = 0
  let missingAmountCount = 0
  let printedZeroCount = 0
  for (const entry of eligible) {
    const expected = entry.expected
    for (const field of CORPUS_FIELDS) {
      if (hasGroundTruth(expected?.[field])) fieldCoverage[field] += 1
    }
    if (typeof expected?.currencyCode === 'string' && expected.currencyCode.trim()) {
      currencies[expected.currencyCode] = (currencies[expected.currencyCode] || 0) + 1
    }
    const locale = explicitLocale(entry.receipt) || 'unlabeled'
    locales[locale] = (locales[locale] || 0) + 1
    const items = Array.isArray(expected?.lineItems) ? expected.lineItems : []
    lineItemCount += items.length
    for (const item of items) {
      if (hasGroundTruth(item?.name)) namedItemCount += 1
      else unnamedItemCount += 1
      if (typeof item?.amount !== 'number' || !Number.isFinite(item.amount)) missingAmountCount += 1
      else if (item.amount === 0) printedZeroCount += 1
    }
  }
  const localeLabelsPresent = eligible.some((entry) => explicitLocale(entry.receipt) !== null)
  const inventory = {
    source_format: sourceFormat,
    fixture_count: receipts.length,
    eligible_image_count: eligible.length,
    excluded_count: receipts.length - eligible.length,
    exclusions: Object.fromEntries(Object.entries(exclusionCounts).sort(([a], [b]) => a.localeCompare(b))),
    excluded_fixture_ids: Object.fromEntries(Object.entries(excludedIds).sort(([a], [b]) => a.localeCompare(b))),
    field_coverage: Object.fromEntries(CORPUS_FIELDS.map((field) => [field, {
      present: fieldCoverage[field],
      denominator: eligible.length,
    }])),
    line_items: {
      total: lineItemCount,
      names_present: namedItemCount,
      names_missing: unnamedItemCount,
      amounts_missing_or_unreadable: missingAmountCount,
      printed_zero_amounts: printedZeroCount,
    },
    currency_distribution: Object.fromEntries(Object.entries(currencies).sort(([a], [b]) => a.localeCompare(b))),
    locale_labels_present: localeLabelsPresent,
    locale_denominators: Object.fromEntries(Object.entries(locales).sort(([a], [b]) => a.localeCompare(b))),
  }
  return { summary: inventory, eligible }
}

export async function inventoryReceiptSet(receipts, options = {}) {
  const { summary } = await collectReceiptInventory(receipts, options)
  return summary
}

function safeFailureCode(result) {
  const code = result?.failureCode
  return typeof code === 'string' && /^[a-z0-9_:-]{1,80}$/i.test(code)
    ? code
    : (result?.ok ? null : 'provider_error')
}

function mimeTypeFor(path) {
  switch (extname(path).toLowerCase()) {
    case '.png': return 'image/png'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    default: return 'image/jpeg'
  }
}

// `scan` and `readImage` are injectable so inventory/scoring can be tested
// without provider credentials or network access.
export async function runProviderReplay({
  set,
  sourceFormat = 'injected',
  root = process.env.OCR_GAUNTLET_ROOT || REPO_ROOT,
  env = process.env,
  concurrency = 3,
  scan = scanReceiptWithLlm,
  readImage = async (entry) => new Uint8Array(await readFile(entry.imagePath)),
  onRow = null,
} = {}) {
  let receipts = set
  if (!receipts) {
    const loaded = await loadReceiptSet({ env })
    receipts = loaded.receipts
    sourceFormat = loaded.sourceFormat
  }
  const { summary: inventory, eligible } = await collectReceiptInventory(receipts, { root, sourceFormat })
  const rows = []
  const queue = [...eligible]
  const workers = Math.max(1, Math.min(concurrency, queue.length || 1))
  await Promise.all(Array.from({ length: workers }, async () => {
    while (queue.length > 0) {
      const entry = queue.shift()
      const started = performance.now()
      let result
      let scanLatency = null
      try {
        const bytes = await readImage(entry)
        result = await scan(bytes, mimeTypeFor(entry.imagePath), env)
        scanLatency = Number.isFinite(result?.latencyMs) ? result.latencyMs : null
      } catch {
        result = { ok: false, httpStatus: null, scanned: null, failureCode: 'runner_error', providerStarted: false, inputPx: null }
      }
      const wallMs = Math.max(0, performance.now() - started)
      if (scanLatency === null) scanLatency = wallMs
      const scanned = result?.scanned
      const expected = entry.expected
      const expectedTotal = typeof expected?.total === 'number' ? expected.total : null
      const actualTotal = typeof scanned?.total === 'number' ? scanned.total : null
      const actualItems = Array.isArray(scanned?.lineItems) ? scanned.lineItems.length : null
      const expectedItems = Array.isArray(expected?.lineItems)
        ? expected.lineItems.length
        : (Number.isInteger(entry.receipt?.items) ? entry.receipt.items : null)
      const row = {
        id: entry.id,
        ok: result?.ok === true,
        http_status: Number.isInteger(result?.httpStatus) ? result.httpStatus : null,
        wall_ms: wallMs,
        scan_ms: scanLatency,
        input_px: Number.isInteger(result?.inputPx) ? result.inputPx : null,
        provider_started: result?.providerStarted === true,
        failure_code: safeFailureCode(result),
        total_exact: expectedTotal !== null && actualTotal !== null && Math.abs(actualTotal - expectedTotal) < 0.011,
        items_exact: expectedItems !== null && actualItems !== null && actualItems === expectedItems,
      }
      rows.push(row)
      if (onRow) onRow(row)
    }
  }))
  rows.sort((a, b) => a.id.localeCompare(b.id))
  const scanLatencies = rows.map((row) => row.scan_ms)
  const wallLatencies = rows.map((row) => row.wall_ms)
  const promptHash = createHash('sha256').update(RECEIPT_JSON_SYSTEM_PROMPT).digest('hex')
  return {
    observed_at: new Date().toISOString(),
    provider: llmProvider(env),
    model: llmModel(env),
    max_edge: llmMaxEdge(env) || null,
    prompt_revision: RECEIPT_PROMPT_REVISION,
    prompt_sha256: promptHash,
    n: rows.length,
    errors: rows.filter((row) => !row.ok).length,
    latency_ms: {
      definition: 'scan_ms comes from the provider seam and includes image preprocessing; wall_ms covers fixture read plus scan. Both include failed attempts.',
      scan_p50: percentile(scanLatencies, 50),
      scan_p95: percentile(scanLatencies, 95),
      scan_max: scanLatencies.length ? Math.max(...scanLatencies) : null,
      end_to_end_p50: percentile(wallLatencies, 50),
      end_to_end_p95: percentile(wallLatencies, 95),
      end_to_end_max: wallLatencies.length ? Math.max(...wallLatencies) : null,
      attempts_included: rows.length,
    },
    total_exact: rows.filter((row) => row.total_exact).length,
    items_exact: rows.filter((row) => row.items_exact).length,
    inventory: {
      source_format: inventory.source_format,
      fixture_count: inventory.fixture_count,
      eligible_image_count: inventory.eligible_image_count,
      excluded_count: inventory.excluded_count,
      exclusions: inventory.exclusions,
      excluded_fixture_ids: inventory.excluded_fixture_ids,
      field_coverage: inventory.field_coverage,
      line_items: inventory.line_items,
      currency_distribution: inventory.currency_distribution,
      locale_labels_present: inventory.locale_labels_present,
      locale_denominators: inventory.locale_denominators,
    },
    rows,
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = {
    LLM_SCAN_PROVIDER: process.env.LLM_SCAN_PROVIDER,
    LLM_SCAN_MODEL: process.env.LLM_SCAN_MODEL,
    LLM_SCAN_BASE_URL: process.env.LLM_SCAN_BASE_URL,
    LLM_SCAN_MAX_EDGE: process.env.LLM_SCAN_MAX_EDGE,
    LLM_SCAN_SERVICE_TIER: process.env.LLM_SCAN_SERVICE_TIER,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ZAI_API_KEY: process.env.ZAI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  }
  const concurrency = Math.max(1, parseInt(process.env.OCR_GAUNTLET_CONCURRENCY || '3', 10) || 3)
  const report = await runProviderReplay({ env, concurrency })
  const { rows, ...summary } = report
  console.log(JSON.stringify(summary, null, 2))
  for (const row of rows) {
    console.error(`${row.id}  ${String(Math.round(row.scan_ms)).padStart(6)} ms  ${row.ok ? 'OK' : `FAIL:${row.failure_code}`}  total=${row.total_exact ? 'exact' : 'other'}  items=${row.items_exact ? 'exact' : 'other'}`)
  }
}
