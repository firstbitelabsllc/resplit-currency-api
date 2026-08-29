#!/usr/bin/env node
// Replay the 16-receipt ground-truth set through the worker's LLM provider seam
// (no Worker, no Azure) and print latency p50/p95 plus total-exact / item-count
// parity. The provider dimension is the same env the Worker reads
// (LLM_SCAN_PROVIDER anthropic|zai, LLM_SCAN_MODEL, LLM_SCAN_BASE_URL,
// LLM_SCAN_MAX_EDGE, ANTHROPIC_API_KEY / ZAI_API_KEY), so the parity run repeats
// for either provider by changing only env. Latency includes the Photon
// scale-down, the same accounting as llm_ms in production.
//
//   ZAI_API_KEY=… LLM_SCAN_PROVIDER=zai LLM_SCAN_MODEL=glm-5.3-flash LLM_SCAN_MAX_EDGE=1600 \
//     node scripts/ocr-scan-gauntlet.mjs
//   ANTHROPIC_API_KEY=… LLM_SCAN_PROVIDER=anthropic LLM_SCAN_MODEL=claude-sonnet-5 \
//     node scripts/ocr-scan-gauntlet.mjs
//
// Optional: OCR_GAUNTLET_SET=<path to set json> OCR_GAUNTLET_CONCURRENCY=3

import { readFile } from 'node:fs/promises'
import { scanReceiptWithLlm, llmProvider, llmModel, llmMaxEdge } from '../worker/src/ocr/llm-provider.mjs'

const DEFAULT_SET_PATH = `${process.env.HOME || ''}/.shadow/plans/resplit-observability/evidence/2026-08-28-scan-model-gauntlet-set.json`

export function percentile(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

// `scan` and `readImage` are injectable so the scoring and the provider
// dimension are testable without a key or the network.
export async function runProviderReplay({
  set,
  env = process.env,
  concurrency = 3,
  scan = scanReceiptWithLlm,
  readImage = async (receipt) => new Uint8Array(await readFile(receipt.path)),
  onRow = null,
} = {}) {
  const receipts = set ?? JSON.parse(await readFile(process.env.OCR_GAUNTLET_SET || DEFAULT_SET_PATH, 'utf8'))
  const rows = []
  const queue = [...receipts]
  const workers = Math.max(1, Math.min(concurrency, receipts.length))
  await Promise.all(Array.from({ length: workers }, async () => {
    while (queue.length > 0) {
      const receipt = queue.shift()
      const result = await scan(await readImage(receipt), 'image/jpeg', env)
      const total = typeof result.scanned?.total === 'number' ? result.scanned.total : null
      const items = Array.isArray(result.scanned?.lineItems) ? result.scanned.lineItems.length : null
      const row = {
        id: receipt.id,
        ok: result.ok,
        http_status: result.httpStatus,
        wall_ms: result.latencyMs,
        input_px: result.inputPx ?? null,
        total,
        expected_total: receipt.total,
        total_exact: total !== null && Math.abs(total - receipt.total) < 0.011,
        items,
        expected_items: receipt.items,
        items_exact: items === receipt.items,
        error: result.ok ? null : String(result.errorBody || '').slice(0, 120),
      }
      rows.push(row)
      if (onRow) onRow(row)
    }
  }))
  const latencies = rows.filter((r) => r.ok).map((r) => r.wall_ms)
  return {
    observed_at: new Date().toISOString(),
    provider: llmProvider(env),
    model: llmModel(env),
    max_edge: llmMaxEdge(env) || null,
    n: rows.length,
    errors: rows.length - latencies.length,
    p50_ms: percentile(latencies, 50),
    p95_ms: percentile(latencies, 95),
    max_ms: latencies.length ? Math.max(...latencies) : null,
    total_exact: rows.filter((r) => r.total_exact).length,
    items_exact: rows.filter((r) => r.items_exact).length,
    rows,
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = {
    LLM_SCAN_PROVIDER: process.env.LLM_SCAN_PROVIDER,
    LLM_SCAN_MODEL: process.env.LLM_SCAN_MODEL,
    LLM_SCAN_BASE_URL: process.env.LLM_SCAN_BASE_URL,
    LLM_SCAN_MAX_EDGE: process.env.LLM_SCAN_MAX_EDGE,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ZAI_API_KEY: process.env.ZAI_API_KEY,
  }
  const concurrency = Math.max(1, parseInt(process.env.OCR_GAUNTLET_CONCURRENCY || '3', 10) || 3)
  console.error(`provider=${llmProvider(env)} model=${llmModel(env)} maxEdge=${llmMaxEdge(env) || 'transport default'} concurrency=${concurrency}`)
  const report = await runProviderReplay({
    env,
    concurrency,
    onRow: (row) => console.error(
      `${row.id}  ${String(row.wall_ms).padStart(6)} ms  px=${row.input_px}  ${row.ok ? (row.total_exact ? 'total=OK  ' : 'total=MISS') : 'ERROR     '}  items ${row.items}/${row.expected_items}  ${row.error || ''}`,
    ),
  })
  const { rows, ...summary } = report
  console.log(JSON.stringify(summary, null, 2))
}
