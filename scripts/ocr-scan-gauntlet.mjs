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

function reportFixtureId(id) {
  return createHash('sha256').update(String(id)).digest('hex').slice(0, 16)
}

function safeReportLabel(value, pattern, fallback = 'unknown') {
  return typeof value === 'string' && pattern.test(value) ? value : fallback
}

function safeCurrency(value) {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : null
}

function safeLocale(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  try { return Intl.getCanonicalLocales(value.trim())[0] || null } catch { return null }
}

function normalizedNameSequence(items) {
  const normalizedItems = items.map((item) => typeof item?.name === 'string'
    ? item.name.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ')
    : '')
  return Array.from(normalizedItems.join('\u241e'))
}

const NAME_ITEM_BOUNDARY = Symbol('name-item-boundary')

function normalizedNameWordSequence(items, locale) {
  const segmenter = new Intl.Segmenter(locale, { granularity: 'word' })
  return items.flatMap((item, index) => {
    const name = typeof item?.name === 'string'
      ? item.name.normalize('NFKC').toLocaleLowerCase(locale)
      : ''
    const words = [...segmenter.segment(name)]
      .filter((part) => part.isWordLike)
      .map((part) => part.segment)
    return index === 0 ? words : [NAME_ITEM_BOUNDARY, ...words]
  })
}

function editDistance(left, right) {
  const a = left
  const b = right
  if (a.length > b.length) return editDistance(b, a)
  let previous = Array.from({ length: a.length + 1 }, (_, index) => index)
  for (let row = 1; row <= b.length; row += 1) {
    const current = [row]
    for (let column = 1; column <= a.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (a[column - 1] === b[row - 1] ? 0 : 1),
      )
    }
    previous = current
  }
  return previous[a.length]
}

function currencyFractionDigits(currencyCode) {
  if (!safeCurrency(currencyCode)) return null
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: currencyCode }).resolvedOptions().maximumFractionDigits
  } catch {
    return null
  }
}

function currencyMinorUnits(value, currencyCode) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return { state: 'unknown', value: null }
  const digits = currencyFractionDigits(currencyCode)
  if (digits === null) return { state: 'unscaled', value }
  const scaled = value * (10 ** digits)
  const rounded = Math.round(scaled)
  // Tolerate only IEEE-754 representation noise. Extra precision such as 4.504
  // for USD remains non-canonical and cannot be rounded into a correct answer.
  const tolerance = Math.max(1e-9, Number.EPSILON * Math.abs(scaled) * 4)
  if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > tolerance) {
    return { state: 'noncanonical', value: null }
  }
  return { state: 'minor_units', value: rounded }
}

function amountsExactlyEqual(expected, actual, currencyCode) {
  const expectedAmount = currencyMinorUnits(expected, currencyCode)
  const actualAmount = currencyMinorUnits(actual, currencyCode)
  if (expectedAmount.state === 'minor_units' && actualAmount.state === 'minor_units') {
    return expectedAmount.value === actualAmount.value
  }
  // Without a valid currency, retain strict numeric equality instead of
  // inventing a decimal scale or rounding either side.
  return expectedAmount.state === 'unscaled' && actualAmount.state === 'unscaled' && expected === actual
}

function amountToken(value, currencyCode, side) {
  const amount = currencyMinorUnits(value, currencyCode)
  if (amount.state === 'unknown') return 'unknown'
  if (amount.state === 'minor_units') return `minor:${amount.value}`
  if (amount.state === 'unscaled') return `number:${String(value)}`
  // Unsupported precision always counts as an error, even when the reference
  // contains the same non-canonical decimal.
  return `noncanonical:${side}:${String(value)}`
}

function safeTokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function sumKnown(rows, key) {
  const values = rows.map((row) => row[key]).filter(Number.isSafeInteger)
  return { value: values.reduce((sum, value) => sum + value, 0), attempts: values.length }
}

function estimateCost(rows, pricing) {
  if (!pricing || !Number.isFinite(pricing.input_usd_per_million)
    || !Number.isFinite(pricing.output_usd_per_million)) return null
  const pricedRows = rows.filter((row) => Number.isSafeInteger(row.input_tokens)
    && Number.isSafeInteger(row.output_tokens))
  const input = pricedRows.reduce((sum, row) => sum + row.input_tokens, 0)
  const cached = pricedRows.reduce((sum, row) => sum + Math.min(row.input_tokens, Number.isSafeInteger(row.cached_input_tokens) ? row.cached_input_tokens : 0), 0)
  const output = pricedRows.reduce((sum, row) => sum + row.output_tokens, 0)
  const cachedRate = Number.isFinite(pricing.cached_input_usd_per_million)
    ? pricing.cached_input_usd_per_million
    : pricing.input_usd_per_million
  const multiplier = Number.isFinite(pricing.service_tier_multiplier) ? pricing.service_tier_multiplier : 1
  const uncachedInputTokens = Math.max(0, input - cached)
  const usd = (uncachedInputTokens * pricing.input_usd_per_million
    + cached * cachedRate
    + output * pricing.output_usd_per_million) / 1_000_000 * multiplier
  return {
    usd: Number(usd.toFixed(6)),
    currency: 'USD',
    priced_attempts: pricedRows.length,
    attempts_without_usage: rows.length - pricedRows.length,
    multiplier,
    rates_usd_per_million: {
      input: pricing.input_usd_per_million,
      cached_input: cachedRate,
      output: pricing.output_usd_per_million,
    },
    excludes_attempts_without_provider_usage: true,
  }
}

const MATRIX_ENV_KEYS = new Set([
  'LLM_SCAN_PROVIDER', 'LLM_SCAN_MODEL', 'LLM_SCAN_BASE_URL',
  'LLM_SCAN_MAX_EDGE', 'LLM_SCAN_SERVICE_TIER',
])

const BUILT_IN_CREDENTIAL_ENV = Object.freeze({
  anthropic: 'ANTHROPIC_API_KEY',
  zai: 'ZAI_API_KEY',
  openai: 'OPENAI_API_KEY',
})

function safeProviderOption(key) {
  return /^LLM_SCAN_[A-Z0-9_]{1,64}$/.test(key)
    && !/(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|BEARER)/.test(key)
}

export function defaultComparisonCases() {
  const astraPrices = {
    input_usd_per_million: 10,
    cached_input_usd_per_million: 1,
    output_usd_per_million: 50,
  }
  return [
    {
      name: 'astra_standard',
      env: { LLM_SCAN_PROVIDER: 'openai', LLM_SCAN_MODEL: 'gpt-6-astra', LLM_SCAN_MAX_EDGE: '1568', LLM_SCAN_SERVICE_TIER: 'default' },
      pricing: { ...astraPrices, service_tier_multiplier: 1 },
    },
    {
      name: 'astra_fast',
      env: { LLM_SCAN_PROVIDER: 'openai', LLM_SCAN_MODEL: 'gpt-6-astra', LLM_SCAN_MAX_EDGE: '1568', LLM_SCAN_SERVICE_TIER: 'fast' },
      pricing: { ...astraPrices, service_tier_multiplier: 2 },
    },
  ]
}

export function validateProviderCases(cases) {
  if (!Array.isArray(cases) || cases.length === 0) throw new TypeError('provider case list must be a non-empty array')
  const names = new Set()
  return cases.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.name !== 'string' || !/^[a-z0-9_-]{1,48}$/i.test(entry.name)
      || !entry.env || typeof entry.env !== 'object' || Array.isArray(entry.env)
      || (entry.credential_env !== undefined && (typeof entry.credential_env !== 'string'
        || !/^[A-Z][A-Z0-9_]{0,62}_API_KEY$/.test(entry.credential_env)))) {
      throw new TypeError('provider cases require a safe name and configuration object')
    }
    if (names.has(entry.name)) throw new TypeError('provider case names must be unique')
    names.add(entry.name)
    if (Object.keys(entry.env).some((key) => !MATRIX_ENV_KEYS.has(key) && !safeProviderOption(key))) {
      throw new TypeError('provider case contains unsupported configuration; credentials must come from the process environment')
    }
    if (typeof entry.env.LLM_SCAN_BASE_URL === 'string') {
      let endpoint
      try { endpoint = new URL(entry.env.LLM_SCAN_BASE_URL) } catch { throw new TypeError('provider base URL must be an HTTPS URL without embedded credentials or query data') }
      if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        throw new TypeError('provider base URL must be an HTTPS URL without embedded credentials or query data')
      }
    }
    let pricing = null
    if (entry.pricing !== null && entry.pricing !== undefined) {
      const fields = ['input_usd_per_million', 'cached_input_usd_per_million', 'output_usd_per_million', 'service_tier_multiplier']
      if (!entry.pricing || typeof entry.pricing !== 'object' || Array.isArray(entry.pricing)
        || Object.entries(entry.pricing).some(([key, value]) => !fields.includes(key) || !Number.isFinite(value) || value < 0)
        || !Number.isFinite(entry.pricing.input_usd_per_million)
        || !Number.isFinite(entry.pricing.output_usd_per_million)) {
        throw new TypeError('provider case pricing must contain finite non-negative rates')
      }
      pricing = { ...entry.pricing }
    }
    return { name: entry.name, env: { ...entry.env }, credential_env: entry.credential_env || null, pricing }
  })
}

function aggregateCorrectness(rows) {
  const localeGroups = Object.create(null)
  let totalExact = 0
  let totalDenominator = 0
  let itemCountExact = 0
  let itemCountDenominator = 0
  let nameEditDistance = 0
  let nameReferenceCharacters = 0
  let nameWordEditDistance = 0
  let nameReferenceWordTokens = 0
  let amountEditDistance = 0
  let amountReferenceItems = 0
  let expectedUnknownAmounts = 0
  let expectedZeroAmounts = 0
  let returnedUnknownAmounts = 0
  let returnedZeroAmounts = 0
  let structuredValid = 0
  let structuredInvalid = 0
  let structuredUnknown = 0

  for (const row of rows) {
    const locale = row.locale
    const group = localeGroups[locale] ||= {
      receipts: 0,
      receipt_total_exact: 0,
      receipt_total_denominator: 0,
      item_count_exact: 0,
      item_count_denominator: 0,
      structured_output_valid: 0,
      structured_output_invalid: 0,
      structured_output_unknown: 0,
      name_sequence_edit_distance: 0,
      name_reference_characters: 0,
      name_word_sequence_edit_distance: 0,
      name_reference_word_tokens: 0,
      amount_sequence_edit_distance: 0,
      amount_reference_items: 0,
    }
    group.receipts += 1
    if (row.total_scored) totalDenominator += 1
    if (row.total_exact) totalExact += 1
    if (row.total_scored) group.receipt_total_denominator += 1
    if (row.total_exact) group.receipt_total_exact += 1
    if (row.items_scored) {
      itemCountDenominator += 1
      if (row.items_exact) itemCountExact += 1
      group.item_count_denominator += 1
      if (row.items_exact) group.item_count_exact += 1
      nameEditDistance += row.name_sequence_edit_distance
      nameReferenceCharacters += row.name_reference_characters
      if (Number.isSafeInteger(row.name_word_sequence_edit_distance)) {
        nameWordEditDistance += row.name_word_sequence_edit_distance
        nameReferenceWordTokens += row.name_reference_word_tokens
        group.name_word_sequence_edit_distance += row.name_word_sequence_edit_distance
        group.name_reference_word_tokens += row.name_reference_word_tokens
      }
      amountEditDistance += row.amount_sequence_edit_distance
      amountReferenceItems += row.amount_reference_items
      expectedUnknownAmounts += row.expected_unknown_amounts
      expectedZeroAmounts += row.expected_zero_amounts
      returnedUnknownAmounts += row.returned_unknown_amounts
      returnedZeroAmounts += row.returned_zero_amounts
      group.name_sequence_edit_distance += row.name_sequence_edit_distance
      group.name_reference_characters += row.name_reference_characters
      group.amount_sequence_edit_distance += row.amount_sequence_edit_distance
      group.amount_reference_items += row.amount_reference_items
    }
    if (row.structured_output_valid === true) {
      structuredValid += 1
      group.structured_output_valid += 1
    } else if (row.structured_output_valid === false) {
      structuredInvalid += 1
      group.structured_output_invalid += 1
    } else {
      structuredUnknown += 1
      group.structured_output_unknown += 1
    }
  }

  for (const group of Object.values(localeGroups)) {
    group.receipt_total_accuracy = group.receipt_total_denominator
      ? group.receipt_total_exact / group.receipt_total_denominator : null
    group.item_count_accuracy = group.item_count_denominator
      ? group.item_count_exact / group.item_count_denominator : null
    group.name_cer = group.name_reference_characters ? group.name_sequence_edit_distance / group.name_reference_characters : null
    group.name_wer = group.name_reference_word_tokens
      ? group.name_word_sequence_edit_distance / group.name_reference_word_tokens : null
    group.amount_sequence_error_rate = group.amount_reference_items ? group.amount_sequence_edit_distance / group.amount_reference_items : null
  }

  return {
    receipt_total: { exact: totalExact, denominator: totalDenominator },
    item_count: { exact: itemCountExact, denominator: itemCountDenominator },
    item_name: {
      metric: 'unicode character error rate over ordered item names joined by a visible item-boundary marker; NFKC, lowercase, collapsed whitespace',
      sequence_edit_distance: nameEditDistance,
      reference_characters: nameReferenceCharacters,
      cer: nameReferenceCharacters ? nameEditDistance / nameReferenceCharacters : null,
      word_metric: 'locale-aware word error rate over ordered item names tokenized with Intl.Segmenter; NFKC, locale-aware lowercase, item-boundary tokens included in the reference denominator; only explicit valid locale labels are scored',
      word_sequence_edit_distance: nameWordEditDistance,
      reference_word_tokens: nameReferenceWordTokens,
      wer: nameReferenceWordTokens ? nameWordEditDistance / nameReferenceWordTokens : null,
    },
    item_amount_sequence: {
      metric: 'Levenshtein error rate over ordered amount tokens in exact currency minor units; unknown is distinct from printed zero; non-canonical precision is an error; scoring only, never output repair',
      sequence_edit_distance: amountEditDistance,
      reference_items: amountReferenceItems,
      error_rate: amountReferenceItems ? amountEditDistance / amountReferenceItems : null,
      expected_unknown: expectedUnknownAmounts,
      expected_printed_zero: expectedZeroAmounts,
      returned_unknown: returnedUnknownAmounts,
      returned_zero: returnedZeroAmounts,
    },
    by_locale: Object.fromEntries(Object.entries(localeGroups).sort(([a], [b]) => a.localeCompare(b))),
    locale_limit: 'Only valid fixture-authored locale labels are used for WER. Unlabeled receipts remain in the unlabeled denominator with WER unscored; currency is not used to infer locale.',
    structured_output: {
      valid: structuredValid,
      invalid: structuredInvalid,
      unknown: structuredUnknown,
      attempts: rows.length,
    },
  }
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
  return safeLocale(value)
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
      ;(excludedIds[reason] ||= []).push(reportFixtureId(id))
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
    const currency = safeCurrency(expected?.currencyCode)
    if (currency) {
      currencies[currency] = (currencies[currency] || 0) + 1
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

function summarizeProviderReplay(rows, inventory, env) {
  rows.sort((a, b) => a.id.localeCompare(b.id))
  const providerAttempts = rows.filter((row) => row.provider_started)
  const preProviderFailures = rows.filter((row) => !row.provider_started)
  const scanLatencies = providerAttempts.map((row) => row.scan_ms)
  const postReadLatencies = rows.map((row) => row.post_read_wall_ms)
  const fixtureReadLatencies = rows.map((row) => row.fixture_read_ms)
  const preProviderLatencies = preProviderFailures.map((row) => row.scan_ms)
  const promptHash = createHash('sha256').update(RECEIPT_JSON_SYSTEM_PROMPT).digest('hex')
  const correctness = aggregateCorrectness(rows)
  const providerStartedCorrectness = aggregateCorrectness(providerAttempts)
  const inputTokens = sumKnown(rows, 'input_tokens')
  const cachedInputTokens = sumKnown(rows, 'cached_input_tokens')
  const outputTokens = sumKnown(rows, 'output_tokens')
  const totalTokens = sumKnown(rows, 'total_tokens')
  return {
    observed_at: new Date().toISOString(),
    provider: safeReportLabel(llmProvider(env), /^[a-z0-9_-]{1,32}$/i),
    model: safeReportLabel(llmModel(env), /^[A-Za-z0-9._:-]{1,128}$/),
    max_edge: llmMaxEdge(env) || null,
    prompt_revision: RECEIPT_PROMPT_REVISION,
    prompt_sha256: promptHash,
    n: rows.length,
    errors: rows.filter((row) => !row.ok).length,
    service_tier_requested: llmProvider(env) === 'openai'
      ? safeReportLabel(env.LLM_SCAN_SERVICE_TIER || 'default', /^[a-z0-9_-]{1,32}$/i)
      : 'not_applicable',
    service_tier_served: Object.fromEntries([...new Set(rows.map((row) => row.service_tier_served).filter(Boolean))]
      .map((tier) => [tier, rows.filter((row) => row.service_tier_served === tier).length])),
    latency_ms: {
      definition: 'scan_* uses provider-started attempts, including failed provider calls; pre_provider_* reports rows rejected before a provider call; post_read_wall_* measures runner time after shared fixture bytes are available; fixture_read_* is separate.',
      scan_p50: percentile(scanLatencies, 50),
      scan_p95: percentile(scanLatencies, 95),
      scan_max: scanLatencies.length ? Math.max(...scanLatencies) : null,
      provider_attempts_included: providerAttempts.length,
      pre_provider_failures: preProviderFailures.length,
      pre_provider_p50: percentile(preProviderLatencies, 50),
      pre_provider_p95: percentile(preProviderLatencies, 95),
      pre_provider_max: preProviderLatencies.length ? Math.max(...preProviderLatencies) : null,
      post_read_wall_p50: percentile(postReadLatencies, 50),
      post_read_wall_p95: percentile(postReadLatencies, 95),
      post_read_wall_max: postReadLatencies.length ? Math.max(...postReadLatencies) : null,
      fixture_read_p50: percentile(fixtureReadLatencies, 50),
      fixture_read_p95: percentile(fixtureReadLatencies, 95),
      fixture_read_max: fixtureReadLatencies.length ? Math.max(...fixtureReadLatencies) : null,
      attempts_included: rows.length,
    },
    total_exact: rows.filter((row) => row.total_exact).length,
    total_exact_denominator: rows.filter((row) => row.total_scored).length,
    items_exact: rows.filter((row) => row.items_exact).length,
    items_exact_denominator: rows.filter((row) => row.items_scored).length,
    correctness,
    provider_started: {
      attempts: providerAttempts.length,
      errors: providerAttempts.filter((row) => !row.ok).length,
      total_exact: providerAttempts.filter((row) => row.total_exact).length,
      total_exact_denominator: providerAttempts.filter((row) => row.total_scored).length,
      items_exact: providerAttempts.filter((row) => row.items_exact).length,
      items_exact_denominator: providerAttempts.filter((row) => row.items_scored).length,
      correctness: providerStartedCorrectness,
    },
    usage_tokens: {
      input: inputTokens.value,
      cached_input: cachedInputTokens.value,
      output: outputTokens.value,
      total: totalTokens.value,
      attempts_with_input_usage: inputTokens.attempts,
      attempts_with_output_usage: outputTokens.attempts,
    },
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

function safeFailureCode(result) {
  const code = result?.failureCode
  const allowed = new Set([
    'input_too_large', 'input_dimensions_unsupported', 'input_unsupported_media', 'input_transform_failed',
    'transport_timeout', 'transport_error', 'malformed_output', 'upstream_rate_limited',
    'upstream_rejected', 'upstream_balance_exhausted', 'upstream_daily_cap',
    'upstream_quota_exhausted', 'upstream_plan_expired', 'upstream_model_unavailable',
    'upstream_model_busy', 'upstream_policy_restricted', 'upstream_key_restricted',
    'upstream_unknown_model', 'upstream_model_method_unsupported', 'upstream_api_permission_denied',
    'upstream_request_invalid',
    'llm_daily_cap', 'scan_rate_limited', 'operator_disabled',
    'unknown', 'runner_error', 'provider_unavailable',
  ])
  if (!result?.providerStarted && result?.httpStatus === 413) {
    return result?.errorBody === 'llm_image_dimensions' ? 'input_dimensions_unsupported' : 'input_too_large'
  }
  if (!result?.providerStarted && result?.httpStatus === 415) return 'input_unsupported_media'
  if (!result?.providerStarted && result?.httpStatus === 502 && String(result?.errorBody || '').includes('image_transform')) return 'input_transform_failed'
  return allowed.has(code) ? code : (result?.ok ? null : 'provider_error')
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
  preloadedFixtureReadMs = null,
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
      let result
      let scanLatency = null
      let fixtureReadMs = 0
      let postReadWallMs = 0
      try {
        const readStarted = performance.now()
        const bytes = await readImage(entry)
        fixtureReadMs = Number.isFinite(preloadedFixtureReadMs)
          ? preloadedFixtureReadMs
          : Math.max(0, performance.now() - readStarted)
        const scanStarted = performance.now()
        result = await scan(bytes, mimeTypeFor(entry.imagePath), env)
        postReadWallMs = Math.max(0, performance.now() - scanStarted)
        scanLatency = Number.isFinite(result?.latencyMs) ? result.latencyMs : null
      } catch {
        result = { ok: false, httpStatus: null, scanned: null, failureCode: 'runner_error', providerStarted: false, inputPx: null }
      }
      if (scanLatency === null) scanLatency = postReadWallMs
      const scanned = result?.scanned
      const expected = entry.expected
      const expectedTotal = typeof expected?.total === 'number' ? expected.total : null
      const actualTotal = typeof scanned?.total === 'number' ? scanned.total : null
      const actualItems = Array.isArray(scanned?.lineItems) ? scanned.lineItems.length : null
      const expectedItems = Array.isArray(expected?.lineItems)
        ? expected.lineItems.length
        : (Number.isInteger(entry.receipt?.items) ? entry.receipt.items : null)
      const expectedItemRows = Array.isArray(expected?.lineItems) ? expected.lineItems : []
      const actualItemRows = Array.isArray(scanned?.lineItems) ? scanned.lineItems : []
      const expectedNames = normalizedNameSequence(expectedItemRows)
      const actualNames = normalizedNameSequence(actualItemRows)
      const scoredLocale = explicitLocale(entry.receipt)
      const expectedNameWords = scoredLocale && Array.isArray(expected?.lineItems)
        ? normalizedNameWordSequence(expectedItemRows, scoredLocale)
        : null
      const actualNameWords = expectedNameWords === null
        ? []
        : normalizedNameWordSequence(actualItemRows, scoredLocale)
      const currencyCode = safeCurrency(expected?.currencyCode) || safeCurrency(scanned?.currencyCode)
      const expectedAmountTokens = expectedItemRows.map((item) => amountToken(item?.amount, currencyCode, 'reference'))
      const actualAmountTokens = actualItemRows.map((item) => amountToken(item?.amount, currencyCode, 'returned'))
      const structuredOutputValid = typeof result?.structuredOutputValid === 'boolean'
        ? result.structuredOutputValid
        : (result?.ok === true ? true : (result?.failureCode === 'malformed_output' ? false : null))
      const provider = llmProvider(env)
      const serviceTierRequested = provider === 'openai'
        ? safeReportLabel(result?.serviceTierRequested || env.LLM_SCAN_SERVICE_TIER || 'default', /^[a-z0-9_-]{1,32}$/i)
        : 'not_applicable'
      const safeServedTier = ['auto', 'default', 'flex', 'fast', 'priority', 'ultrafast'].includes(result?.serviceTierServed)
        ? result.serviceTierServed
        : null
      const usage = result?.usage && typeof result.usage === 'object' ? result.usage : {}
      const locale = scoredLocale || 'unlabeled'
      const row = {
        id: reportFixtureId(entry.id),
        ok: result?.ok === true,
        http_status: Number.isInteger(result?.httpStatus) ? result.httpStatus : null,
        fixture_read_ms: fixtureReadMs,
        post_read_wall_ms: postReadWallMs,
        scan_ms: scanLatency,
        input_px: Number.isInteger(result?.inputPx) ? result.inputPx : null,
        provider_started: result?.providerStarted === true,
        failure_code: safeFailureCode(result),
        service_tier_requested: serviceTierRequested,
        service_tier_served: safeServedTier,
        served_model: safeReportLabel(result?.servedModel, /^[A-Za-z0-9._:-]{1,128}$/),
        structured_output_valid: structuredOutputValid,
        input_tokens: safeTokenCount(usage.inputTokens),
        cached_input_tokens: safeTokenCount(usage.cachedInputTokens),
        output_tokens: safeTokenCount(usage.outputTokens),
        total_tokens: safeTokenCount(usage.totalTokens),
        locale,
        total_scored: expectedTotal !== null,
        total_exact: expectedTotal !== null && actualTotal !== null && amountsExactlyEqual(expectedTotal, actualTotal, currencyCode),
        items_scored: expectedItems !== null,
        items_exact: expectedItems !== null && actualItems !== null && actualItems === expectedItems,
        name_sequence_edit_distance: Array.isArray(expected?.lineItems) ? editDistance(expectedNames, actualNames) : 0,
        name_reference_characters: Array.isArray(expected?.lineItems) ? expectedNames.length : 0,
        name_word_sequence_edit_distance: expectedNameWords === null ? null : editDistance(expectedNameWords, actualNameWords),
        name_reference_word_tokens: expectedNameWords?.length || 0,
        amount_sequence_edit_distance: Array.isArray(expected?.lineItems) ? editDistance(expectedAmountTokens, actualAmountTokens) : 0,
        amount_reference_items: Array.isArray(expected?.lineItems) ? expectedAmountTokens.length : 0,
        expected_unknown_amounts: expectedItemRows.filter((item) => typeof item?.amount !== 'number' || !Number.isFinite(item.amount)).length,
        expected_zero_amounts: expectedItemRows.filter((item) => item?.amount === 0).length,
        returned_unknown_amounts: actualItemRows.filter((item) => typeof item?.amount !== 'number' || !Number.isFinite(item.amount)).length,
        returned_zero_amounts: actualItemRows.filter((item) => item?.amount === 0).length,
      }
      rows.push(row)
      if (onRow) onRow(row)
    }
  }))
  return summarizeProviderReplay(rows, inventory, env)
}

export async function runProviderMatrix({
  set,
  sourceFormat = 'injected',
  root = process.env.OCR_GAUNTLET_ROOT || REPO_ROOT,
  env = process.env,
  cases = defaultComparisonCases(),
  concurrency = 3,
  scan = scanReceiptWithLlm,
  readImage = async (entry) => new Uint8Array(await readFile(entry.imagePath)),
  onAttempt = null,
} = {}) {
  const providerCases = validateProviderCases(cases)
  const caseOrder = String(env?.OCR_GAUNTLET_CASE_ORDER || 'configured').trim().toLowerCase()
  if (!['configured', 'reverse', 'rotating'].includes(caseOrder)) {
    throw new TypeError('OCR_GAUNTLET_CASE_ORDER must be configured, reverse, or rotating')
  }
  let receipts = set
  if (!receipts) {
    const loaded = await loadReceiptSet({ env })
    receipts = loaded.receipts
    sourceFormat = loaded.sourceFormat
  }
  const { summary: inventory, eligible } = await collectReceiptInventory(receipts, { root, sourceFormat })
  const caseRows = new Map(providerCases.map((entry) => [entry.name, []]))
  const queue = [...eligible]
  const workers = Math.max(1, Math.min(concurrency, queue.length || 1))
  let fixtureOrdinal = 0

  // Pairing is per fixture: the same image bytes are read once and passed to
  // every configured provider before moving to the next fixture. This keeps
  // memory bounded while preventing one provider from seeing a later file edit.
  await Promise.all(Array.from({ length: workers }, async () => {
    while (queue.length > 0) {
      const entry = queue.shift()
      const currentFixtureOrdinal = fixtureOrdinal++
      let casesForFixture = providerCases
      if (caseOrder === 'reverse') {
        casesForFixture = [...providerCases].reverse()
      } else if (caseOrder === 'rotating' && providerCases.length > 1) {
        const offset = currentFixtureOrdinal % providerCases.length
        casesForFixture = [...providerCases.slice(offset), ...providerCases.slice(0, offset)]
      }
      let imageBytes
      let imageReadError = null
      let fixtureReadMs = 0
      try {
        const readStarted = performance.now()
        imageBytes = await readImage(entry)
        fixtureReadMs = Math.max(0, performance.now() - readStarted)
      } catch (error) {
        imageReadError = error
      }

      for (const providerCase of casesForFixture) {
        const credentialName = providerCase.credential_env
          || BUILT_IN_CREDENTIAL_ENV[String(providerCase.env.LLM_SCAN_PROVIDER || '').trim().toLowerCase()]
        const credential = credentialName && typeof env?.[credentialName] === 'string'
          ? { [credentialName]: env[credentialName] }
          : {}
        // A named credential_env also aliases into the provider's built-in key
        // name, so one matrix can pair cases from different aggregators (each
        // with its own key var) against the selected provider's transports.
        // Values stay inside the case env; reports never carry them.
        if (credentialName && credential[credentialName] !== undefined) {
          const builtin = BUILT_IN_CREDENTIAL_ENV[String(providerCase.env.LLM_SCAN_PROVIDER || '').trim().toLowerCase()]
          if (builtin && builtin !== credentialName) credential[builtin] = credential[credentialName]
        }
        const caseEnv = { ...credential, ...providerCase.env }
        const replay = await runProviderReplay({
          set: [entry.receipt], sourceFormat, root, env: caseEnv, concurrency: 1, scan,
          preloadedFixtureReadMs: fixtureReadMs,
          readImage: async () => {
            if (imageReadError) throw imageReadError
            return imageBytes
          },
        })
        caseRows.get(providerCase.name).push(...replay.rows)
        if (onAttempt && replay.rows[0]) onAttempt(providerCase.name, replay.rows[0])
      }
    }
  }))

  const promptHash = createHash('sha256').update(RECEIPT_JSON_SYSTEM_PROMPT).digest('hex')
  const results = providerCases.map((providerCase) => {
    const credentialName = providerCase.credential_env
      || BUILT_IN_CREDENTIAL_ENV[String(providerCase.env.LLM_SCAN_PROVIDER || '').trim().toLowerCase()]
    const credential = credentialName && typeof env?.[credentialName] === 'string'
      ? { [credentialName]: env[credentialName] }
      : {}
    if (credentialName && credential[credentialName] !== undefined) {
      const builtin = BUILT_IN_CREDENTIAL_ENV[String(providerCase.env.LLM_SCAN_PROVIDER || '').trim().toLowerCase()]
      if (builtin && builtin !== credentialName) credential[builtin] = credential[credentialName]
    }
    const caseEnv = { ...credential, ...providerCase.env }
    const report = summarizeProviderReplay(caseRows.get(providerCase.name), inventory, caseEnv)
    return {
      name: providerCase.name,
      report,
      cost_estimate: estimateCost(report.rows, providerCase.pricing),
      cost_note: providerCase.pricing ? 'Estimate uses the supplied public per-token rates and provider usage; attempts without usage are excluded.' : 'Unknown: no verified price supplied for this case.',
    }
  })
  return {
    schema_version: 2,
    observed_at: new Date().toISOString(),
    same_prompt: results.every((entry) => entry.report.prompt_sha256 === promptHash),
    prompt_revision: RECEIPT_PROMPT_REVISION,
    prompt_sha256: promptHash,
    pairing: 'For each eligible fixture, one image read is reused for every provider case; reports pair rows by hashed fixture id.',
    case_order: caseOrder,
    eligible_images_read_once: eligible.length,
    cases: results,
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const baseEnvKeys = [
    'LLM_SCAN_PROVIDER', 'LLM_SCAN_MODEL', 'LLM_SCAN_BASE_URL',
    'LLM_SCAN_MAX_EDGE', 'LLM_SCAN_SERVICE_TIER', 'OCR_GAUNTLET_SET', 'OCR_GAUNTLET_CASE_ORDER',
    'ANTHROPIC_API_KEY', 'ZAI_API_KEY', 'OPENAI_API_KEY',
  ]
  const runnerEnv = (cases = []) => {
    const keys = new Set([
      ...baseEnvKeys,
      ...cases.map((entry) => entry?.credential_env).filter((key) => typeof key === 'string'),
    ])
    return Object.fromEntries([...keys]
      .filter((key) => typeof process.env[key] === 'string')
      .map((key) => [key, process.env[key]]))
  }
  const concurrency = Math.max(1, parseInt(process.env.OCR_GAUNTLET_CONCURRENCY || '3', 10) || 3)
  if (process.env.OCR_GAUNTLET_MATRIX === '1') {
    let cases = defaultComparisonCases()
    if (process.env.OCR_GAUNTLET_CASES_JSON) {
      cases = JSON.parse(process.env.OCR_GAUNTLET_CASES_JSON)
    }
    const env = runnerEnv(cases)
    const report = await runProviderMatrix({
      env,
      cases,
      concurrency,
      onAttempt: (name, row) => console.error(`${row.id} ${name} ${String(Math.round(row.scan_ms)).padStart(6)} ms ${row.ok ? 'OK' : `FAIL:${row.failure_code}`}`),
    })
    console.log(JSON.stringify(report, null, 2))
  } else {
    const env = runnerEnv([{ env: { LLM_SCAN_PROVIDER: process.env.LLM_SCAN_PROVIDER } }])
    const report = await runProviderReplay({ env, concurrency })
    const { rows, ...summary } = report
    console.log(JSON.stringify(summary, null, 2))
    for (const row of rows) {
      console.error(`${row.id}  ${String(Math.round(row.scan_ms)).padStart(6)} ms  ${row.ok ? 'OK' : `FAIL:${row.failure_code}`}  total=${row.total_exact ? 'exact' : 'other'}  items=${row.items_exact ? 'exact' : 'other'}`)
    }
  }
}
