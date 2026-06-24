const test = require('node:test')
const assert = require('node:assert/strict')

const { computeRateSanity } = require('../scripts/validate-package')

// Regression for the single-source FX publish gap: a wrong-but-positive
// upstream rate cleared every structural check and shipped as authoritative.
// computeRateSanity is the value-sanity gate that catches it.

test('computeRateSanity flags a gross >2x day-over-day jump (bad upstream value)', () => {
  const prior = { usd: 1.08, jpy: 170, gbp: 0.85 }
  const today = { usd: 1.09, jpy: 510, gbp: 0.85 } // jpy tripled — wrong upstream rate
  const { gross } = computeRateSanity(today, prior)
  assert.equal(gross.length, 1)
  assert.equal(gross[0].code, 'jpy')
  assert.ok(gross[0].ratio > 2, `expected >2x, got ${gross[0].ratio}`)
})

test('computeRateSanity catches a too-small jump too (rate halved)', () => {
  const { gross } = computeRateSanity({ jpy: 70 }, { jpy: 170 }) // 0.41x
  assert.equal(gross.length, 1)
  assert.equal(gross[0].code, 'jpy')
})

test('computeRateSanity passes normal day-over-day moves silently', () => {
  const prior = { usd: 1.08, jpy: 170, gbp: 0.85 }
  const today = { usd: 1.085, jpy: 171.2, gbp: 0.853 } // <1%
  const { gross, warns } = computeRateSanity(today, prior)
  assert.equal(gross.length, 0)
  assert.equal(warns.length, 0)
})

test('computeRateSanity warns (does NOT block) a >15% but <2x move — volatile currency', () => {
  const { gross, warns } = computeRateSanity({ ars: 1920 }, { ars: 1600 }) // +20%
  assert.equal(gross.length, 0)
  assert.equal(warns.length, 1)
  assert.equal(warns[0].code, 'ars')
})

test('computeRateSanity skips currencies missing or invalid in the prior day', () => {
  const prior = { usd: 1.08, zero: 0, nan: Number.NaN }
  const today = { usd: 1.08, zero: 5, nan: 9, brandnew: 100 }
  const { gross, warns } = computeRateSanity(today, prior)
  assert.equal(gross.length, 0)
  assert.equal(warns.length, 0)
})
