import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runGauntlet } from '../scripts/ocr-scan-gauntlet.mjs'

test('gauntlet names glm-5.3-flash and a second OSS model even when the API key is missing', async () => {
  const report = await runGauntlet({
    apiKey: '',
    currentOcr: { n: 30, total_ms_p50: 10984, total_ms_p95: 28779 },
  })
  const models = report.runs.map((run) => run.model)
  assert.equal(models.includes('glm-5.3-flash'), true)
  assert.equal(models.includes('glm-4.5v'), true)
  assert.equal(models.includes('current-ocr-worker'), true)
  for (const run of report.runs) {
    assert.equal('wall_ms' in run, true)
    assert.equal('receipt_shaped' in run, true)
  }
})
