#!/usr/bin/env node
/**
 * Time GLM-5.3-Flash + one other open-source multimodal on the same receipt
 * image, and record the current Worker OCR path from live last-month logs
 * (or an honest miss). Does not ship a new OCR vendor.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_RECEIPT = path.join(repoRoot, 'ocr-lab/processed/test_receipt.jpg')
const ZAI_URL = process.env.ZAI_BASE_URL || 'https://api.z.ai/api/paas/v4/chat/completions'

function receiptShaped(text) {
  if (!text || typeof text !== 'string') return false
  const lower = text.toLowerCase()
  return (
    (lower.includes('total') || lower.includes('merchant') || lower.includes('amount')) &&
    /\d/.test(text)
  )
}

async function chatVision({ apiKey, model, imagePath, prompt }) {
  const bytes = fs.readFileSync(imagePath)
  const b64 = bytes.toString('base64')
  const mime = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg'
  const started = Date.now()
  const res = await fetch(ZAI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
          ],
        },
      ],
      max_tokens: 800,
      temperature: 0,
    }),
  })
  const wallMs = Date.now() - started
  const raw = await res.text()
  let parsed
  try { parsed = JSON.parse(raw) } catch { parsed = { raw: raw.slice(0, 400) } }
  const text = parsed?.choices?.[0]?.message?.content
  const content = typeof text === 'string' ? text : JSON.stringify(text || '')
  return {
    model,
    http_status: res.status,
    wall_ms: wallMs,
    receipt_shaped: res.ok && receiptShaped(content),
    error: res.ok ? null : String(parsed?.error?.message || parsed?.raw || raw).slice(0, 300),
  }
}

export async function runGauntlet({
  imagePath = DEFAULT_RECEIPT,
  currentOcr = null,
  apiKey = process.env.ZAI_API_KEY || process.env.Z_AI_API_KEY,
} = {}) {
  const prompt = 'Extract this receipt as JSON with merchant, date, currency, line items, tax, and total. Reply JSON only.'
  const models = [
    process.env.ZAI_FLASH_MODEL || 'glm-5.3-flash',
    process.env.ZAI_OSS_MODEL || 'glm-4.5v',
  ]
  const runs = []
  if (!apiKey) {
    for (const model of models) {
      runs.push({
        model,
        http_status: null,
        wall_ms: null,
        receipt_shaped: false,
        error: 'ZAI_API_KEY missing',
      })
    }
  } else {
    for (const model of models) {
      try {
        runs.push(await chatVision({ apiKey, model, imagePath, prompt }))
      } catch (error) {
        runs.push({
          model,
          http_status: null,
          wall_ms: null,
          receipt_shaped: false,
          error: String(error.message || error).slice(0, 300),
        })
      }
    }
  }
  runs.push({
    model: 'current-ocr-worker',
    source: 'loki_OCR_MONITORING_30d',
    wall_ms: currentOcr?.total_ms_p50 ?? null,
    p95_ms: currentOcr?.total_ms_p95 ?? null,
    n: currentOcr?.n ?? null,
    receipt_shaped: Boolean(currentOcr?.n),
    error: currentOcr ? null : 'current path recorded envelope not supplied',
  })
  return {
    observed_at: new Date().toISOString(),
    image: path.relative(repoRoot, imagePath),
    runs,
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const currentPath = process.argv[2]
  const currentOcr = currentPath ? JSON.parse(fs.readFileSync(currentPath, 'utf8')) : null
  const result = await runGauntlet({ currentOcr })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}
