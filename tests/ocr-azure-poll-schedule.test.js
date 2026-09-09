import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  azurePollSchedule,
  handleOcr,
  ocrPollDelayMs,
  ocrPollMaxAttempts,
} from '../worker/src/ocr/router.mjs'

function makeKV() {
  const store = new Map()
  return {
    async get(key) { return store.get(key) ?? null },
    async put(key, value) { store.set(key, value) },
    async delete(key) { store.delete(key) },
  }
}

test('Azure polling uses fast early windows, then the production ceiling cadence', () => {
  assert.equal(azurePollSchedule({}), 'fixed_1500')
  assert.equal(azurePollSchedule({ OCR_AZURE_POLL_SCHEDULE: 'unknown' }), 'fixed_1500')
  assert.equal(ocrPollMaxAttempts({}), 19)
  assert.equal(
    azurePollSchedule({ OCR_AZURE_POLL_SCHEDULE: 'adaptive_250_3s' }),
    'adaptive_250_3s',
  )
  const adaptive = { OCR_AZURE_POLL_SCHEDULE: 'adaptive_250_3s' }
  assert.equal(ocrPollMaxAttempts(adaptive), 29)
  assert.equal(ocrPollDelayMs(0, {}), 1500)
  assert.equal(ocrPollDelayMs(27, {}), 1500)

  assert.equal(ocrPollDelayMs(0, adaptive), 250)
  assert.equal(ocrPollDelayMs(11, adaptive), 250)
  assert.equal(ocrPollDelayMs(12, adaptive), 1500)
  assert.equal(ocrPollDelayMs(28, adaptive), 1500)
})

test('POST /ocr/analyze fast polling and telemetry are opt-in', async () => {
  const realFetch = globalThis.fetch
  const realLog = console.log
  const logs = []
  console.log = (line) => logs.push(String(line))
  let polls = 0
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (init.method === 'POST' && u.includes(':analyze')) {
      return new Response('', {
        status: 202,
        headers: {
          'operation-location': 'https://test.cognitiveservices.azure.com/documentintelligence/documentModels/prebuilt-receipt/analyzeResults/op-receipt?api-version=2024-11-30',
        },
      })
    }
    if (u.includes('/analyzeResults/')) {
      polls++
      if (polls === 1) return Response.json({ status: 'running' }, { status: 200 })
      return Response.json({
        status: 'succeeded',
        analyzeResult: { documents: [{ docType: 'receipt' }] },
      }, { status: 200 })
    }
    throw new Error(`unexpected fetch ${init.method} ${u}`)
  }

  try {
    const started = Date.now()
    const response = await handleOcr(
      new Request('https://fx.resplit.app/ocr/analyze', {
        method: 'POST',
        headers: {
          'content-type': 'image/jpeg',
          'x-resplit-attest-soft-fail': 'true',
        },
        body: new Uint8Array([1, 2, 3]),
      }),
      {
        ATTEST_KV: makeKV(),
        AZURE_OCR_ENDPOINT: 'https://test.cognitiveservices.azure.com',
        AZURE_OCR_KEY: 'test-key',
        LLM_SCAN_ALLOW_SOFT_FAIL: 'true',
        LLM_SCAN_KILL_SWITCH: 'true',
        OCR_AZURE_POLL_SCHEDULE: 'adaptive_250_3s',
      },
    )
    const elapsed = Date.now() - started
    const body = await response.json()
    logs.push('DEBUG BODY ' + JSON.stringify(body))
    assert.equal(response.status, 200)
    assert.equal(body.status, 'partial')
    assert.equal(polls, 2)
    assert.ok(elapsed >= 220, `expected the 250ms running window, got ${elapsed}ms`)
    assert.ok(elapsed < 1000, `early poll must not use the old 1500ms window, got ${elapsed}ms`)
  } finally {
    globalThis.fetch = realFetch
    console.log = realLog
  }
  const telemetryLog = logs.find((line) => line.includes('"signal":"dual_scan"'))
  const telemetry = JSON.parse(telemetryLog.replace(/^\[OCR_MONITORING\]\s*/, ''))
  assert.equal(telemetry.azure_poll_schedule, 'adaptive_250_3s')
  assert.equal(telemetry.azure_poll_attempts, 2)
  assert.ok(telemetry.azure_poll_elapsed_ms >= 220)
  assert.ok(telemetry.azure_poll_elapsed_ms < 1000)
})
