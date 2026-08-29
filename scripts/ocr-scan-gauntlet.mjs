#!/usr/bin/env node
// Replay the 16-receipt ground-truth set through the worker's LLM provider seam
// (no Worker, no Azure) and print latency p50/p95 plus total-exact / item-count
// parity. Provider selection is the same env the Worker reads, so the parity run
// repeats for either provider by changing only env:
//
//   ZAI_API_KEY=… LLM_SCAN_PROVIDER=zai LLM_SCAN_MODEL=glm-5.3-flash LLM_SCAN_MAX_EDGE=1600 \
//     node scripts/ocr-scan-gauntlet.mjs
//   ANTHROPIC_API_KEY=… LLM_SCAN_PROVIDER=anthropic LLM_SCAN_MODEL=claude-sonnet-5 \
//     node scripts/ocr-scan-gauntlet.mjs
//
// Optional: OCR_GAUNTLET_SET=<path to set json> OCR_GAUNTLET_CONCURRENCY=3

import { readFile } from 'node:fs/promises'
import { scanReceiptWithLlm, llmProvider, llmModel, llmMaxEdge } from '../worker/src/ocr/llm-provider.mjs'

const SET_PATH = process.env.OCR_GAUNTLET_SET ||
  `${process.env.HOME}/.shadow/plans/resplit-observability/evidence/2026-08-28-scan-model-gauntlet-set.json`
const CONCURRENCY = Math.max(1, parseInt(process.env.OCR_GAUNTLET_CONCURRENCY || '3', 10) || 3)

const env = {
  LLM_SCAN_PROVIDER: process.env.LLM_SCAN_PROVIDER,
  LLM_SCAN_MODEL: process.env.LLM_SCAN_MODEL,
  LLM_SCAN_BASE_URL: process.env.LLM_SCAN_BASE_URL,
  LLM_SCAN_MAX_EDGE: process.env.LLM_SCAN_MAX_EDGE,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  ZAI_API_KEY: process.env.ZAI_API_KEY,
}

const percentile = (values, p) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

async function runOne(receipt) {
  const bytes = new Uint8Array(await readFile(receipt.path))
  const result = await scanReceiptWithLlm(bytes, 'image/jpeg', env)
  const total = typeof result.scanned?.total === 'number' ? result.scanned.total : null
  const items = Array.isArray(result.scanned?.lineItems) ? result.scanned.lineItems.length : null
  const row = {
    id: receipt.id,
    ok: result.ok,
    httpStatus: result.httpStatus,
    latencyMs: result.latencyMs,
    inputPx: result.inputPx,
    total,
    expectedTotal: receipt.total,
    totalExact: total !== null && Math.abs(total - receipt.total) < 0.011,
    items,
    expectedItems: receipt.items,
    itemsExact: items === receipt.items,
    error: result.ok ? null : String(result.errorBody || '').slice(0, 120),
  }
  const flag = row.ok ? (row.totalExact ? 'total=OK ' : 'total=MISS') : 'ERROR     '
  console.log(`${row.id}  ${String(row.latencyMs).padStart(6)} ms  px=${row.inputPx}  ${flag}  items ${row.items}/${row.expectedItems}  ${row.error || ''}`)
  return row
}

async function main() {
  const set = JSON.parse(await readFile(SET_PATH, 'utf8'))
  console.log(`provider=${llmProvider(env)} model=${llmModel(env)} maxEdge=${llmMaxEdge(env) || 'transport default'} receipts=${set.length} concurrency=${CONCURRENCY}`)
  const rows = []
  const queue = [...set]
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length > 0) rows.push(await runOne(queue.shift()))
  }))
  const okRows = rows.filter((r) => r.ok)
  const latencies = okRows.map((r) => r.latencyMs)
  console.log('')
  console.log(`n=${rows.length} errors=${rows.length - okRows.length} p50=${percentile(latencies, 50)} ms p95=${percentile(latencies, 95)} ms max=${Math.max(...latencies)} ms`)
  console.log(`total exact ${rows.filter((r) => r.totalExact).length}/${rows.length}, item count exact ${rows.filter((r) => r.itemsExact).length}/${rows.length}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
