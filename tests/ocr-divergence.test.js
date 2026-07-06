import { test } from 'node:test'
import assert from 'node:assert/strict'
import { finiteNumberOrNull, computeDivergence } from '../worker/src/ocr/router.mjs'

// --- finding #5: comma/decimal separator heuristic ----------------------------

test('finiteNumberOrNull treats a lone comma before 3 digits as a thousands separator', () => {
  assert.equal(finiteNumberOrNull('$1,234'), 1234) // was 1.234 before the fix
  assert.equal(finiteNumberOrNull('4,500'), 4500)
})

test('finiteNumberOrNull treats a comma before 1-2 digits as a decimal (lab rule)', () => {
  assert.equal(finiteNumberOrNull('12,50'), 12.5) // ambiguous 2-digit -> decimal
})

test('finiteNumberOrNull resolves mixed separators by last-separator-is-decimal', () => {
  assert.equal(finiteNumberOrNull('1.234,50'), 1234.5) // European: . thousands, , decimal
  assert.equal(finiteNumberOrNull('$1,234,567.89'), 1234567.89) // US: , thousands, . decimal
})

test('finiteNumberOrNull handles plain numbers, negatives, and multi-group thousands', () => {
  assert.equal(finiteNumberOrNull(10), 10)
  assert.equal(finiteNumberOrNull('10.00'), 10)
  assert.equal(finiteNumberOrNull('1234'), 1234)
  assert.equal(finiteNumberOrNull('1,234,567'), 1234567)
  assert.equal(finiteNumberOrNull('-1,234'), -1234)
  assert.equal(finiteNumberOrNull('not a number'), null)
  assert.equal(finiteNumberOrNull(null), null)
})

// --- finding #6: divergence totalsAgree null handling -------------------------

function azureRaw(total) {
  const fields = total == null ? {} : { Total: { type: 'currency', valueCurrency: { amount: total } } }
  return { analyzeResult: { documents: [{ docType: 'receipt', fields }] } }
}

test('computeDivergence compares totals when both are present', () => {
  const agree = computeDivergence(azureRaw(10), { total: 10, extras: [] }, 'succeeded', 'succeeded')
  assert.equal(agree.totalsAgree, true)
  assert.equal(agree.llmRecoveredAmount, 0)

  const disagree = computeDivergence(azureRaw(12), { total: 14, extras: [] }, 'succeeded', 'succeeded')
  assert.equal(disagree.totalsAgree, false)
  assert.equal(disagree.llmRecoveredAmount, 2)
})

test('computeDivergence returns totalsAgree null when a total is missing (uncomparable != disagree)', () => {
  const noAzureTotal = computeDivergence(azureRaw(null), { total: 10, extras: [] }, 'succeeded', 'succeeded')
  assert.equal(noAzureTotal.totalsAgree, null)
  assert.equal(noAzureTotal.azureTotal, null)
  assert.equal(noAzureTotal.llmTotal, 10)
  assert.equal(noAzureTotal.llmRecoveredAmount, null)

  const noLlmTotal = computeDivergence(azureRaw(10), { total: null, extras: [] }, 'succeeded', 'succeeded')
  assert.equal(noLlmTotal.totalsAgree, null)
  assert.equal(noLlmTotal.llmRecoveredAmount, null)
})

test('computeDivergence returns null entirely unless both legs succeeded', () => {
  assert.equal(computeDivergence(azureRaw(10), { total: 10 }, 'succeeded', 'provider_error'), null)
  assert.equal(computeDivergence(azureRaw(10), { total: 10 }, 'rate_limited', 'succeeded'), null)
})
