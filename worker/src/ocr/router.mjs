// /ocr/* router — our own OCR endpoint. The Azure key lives ONLY in env (a wrangler
// secret) and never reaches the client. Modeled on worker/src/sideload/router.mjs:
// requestId -> log -> OPTIONS -> App Attest gate -> handler -> Sentry-catch.
//
// Contract: /ocr/scan returns the versioned envelope
//   { v:1, mode:"raw", provider:"azure-di-v4", scanId, status, kv_extras, raw:{…AnalyzeResultV4} }
// The `mode` discriminator lets a future Worker deploy flip to mode:"scanned"
// (server-side ScannedReceipt) with no app update.
// `kv_extras` makes the opt-in second layout analyze diagnosable from the envelope:
//   "off" (flag disabled) | "merged" (pairs merged) | "empty" (layout succeeded, no pairs)
//   | "failed" (layout submit/poll failed; base receipt result still returned).

import { errorResponse, jsonResponse } from '../http.mjs'
import { requestCorrelationHeaders, resolveRequestId } from '../request-id.mjs'
import { captureFxRouteFailure } from '../monitoring.mjs'
import { CORS_HEADERS, handlePreflight } from '../sideload/cors.mjs'
import { logOcrMonitoringEvent, captureOcrProviderFailure, captureOcrLlmFailure } from './monitoring.mjs'
import {
  submitReceiptAnalyze,
  getReceiptAnalyzeResult,
  submitLayoutKeyValueAnalyze,
  getLayoutKeyValueAnalyzeResult,
  OCR_PROVIDER,
} from './azure.mjs'
import { scanReceiptWithAnthropic, LLM_PROVIDER } from './anthropic.mjs'
import { verifyAssertion, AttestError } from './attest.mjs'
import { verifyAttestation } from './attestation.mjs'

const RESPONSE_HEADERS = { ...CORS_HEADERS, 'Cache-Control': 'no-store' }
const ENVELOPE_VERSION = 1

const APP_ID = 'GXS8378HLM.com.superfit.Resplit'
const PER_DEVICE_DAILY_CAP = 200
const SOFT_FAIL_DAILY_CAP = 20
const CACHE_TTL_SECONDS = 600
const POLL_INTERVAL_MS = 1500
const POLL_MAX_ATTEMPTS = 18 // ~27s ceiling
const DEFAULT_LLM_SCAN_MODEL = 'claude-sonnet-5'
const DEFAULT_LLM_SCAN_DAILY_CAP = 50
const ENABLED_ENV_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled'])

const sha256Hex = async (bytes) => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest).map((b) => b.toString(16).padStart(2, '0')).join('')
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * @param {Request} request
 * @param {Record<string, any>} env  // expects env.ATTEST_KV (KVNamespace), env.AZURE_OCR_*
 * @returns {Promise<Response>}
 */
export async function handleOcr(request, env) {
  const requestId = resolveRequestId(request)
  const url = new URL(request.url)
  const method = request.method

  if (method === 'OPTIONS') return handlePreflight(request, requestId)

  if (!env.ATTEST_KV) {
    // A missing binding takes the whole OCR surface down, so it must be visible on
    // the same dashboard as scan traffic — not just a silent 503 in CF analytics.
    logOcrMonitoringEvent('error', { signal: 'ocr_misconfigured', reason: 'attest_kv_unbound', requestId }, env)
    return errorResponse('OCR_MISCONFIGURED', 'attest store not bound', 503, requestId, RESPONSE_HEADERS)
  }

  try {
    if (method === 'GET' && url.pathname === '/ocr/challenge') {
      return await issueChallenge(env, requestId)
    }
    if (method === 'POST' && url.pathname === '/ocr/attest') {
      return await handleAttest(request, env, requestId)
    }
    if (method === 'POST' && url.pathname === '/ocr/scan') {
      return await handleScan(request, env, requestId)
    }
    if (method === 'POST' && url.pathname === '/ocr/dual-scan') {
      return await handleDualScan(request, env, requestId)
    }
    return errorResponse('NOT_FOUND', 'OCR route not found', 404, requestId, RESPONSE_HEADERS)
  } catch (error) {
    if (error instanceof AttestError) {
      logOcrMonitoringEvent('warn', { signal: 'attest_reject', code: error.code, requestId }, env)
      return errorResponse('ATTEST_REJECTED', error.code, 401, requestId, RESPONSE_HEADERS)
    }
    await captureFxRouteFailure(error, { route: 'ocr', signal: 'ocr_route_exception', requestId, path: url.pathname }, env)
    logOcrMonitoringEvent('error', { signal: 'ocr_exception', error: String(error?.message || error), requestId }, env)
    return errorResponse('OCR_FAILED', error instanceof Error ? error.message : String(error), 502, requestId, RESPONSE_HEADERS)
  }
}

async function issueChallenge(env, requestId) {
  const challenge = crypto.randomUUID() + crypto.randomUUID()
  await env.ATTEST_KV.put(`challenge:${challenge}`, '1', { expirationTtl: 300 })
  return jsonResponse({ challenge }, { status: 200, requestId, headers: RESPONSE_HEADERS })
}

async function handleAttest(request, env, requestId) {
  const body = await request.json().catch(() => null)
  const keyId = body?.keyId
  const attestationObjectB64 = body?.attestationObject
  const challenge = body?.challenge
  if (!keyId || !attestationObjectB64 || !challenge) {
    return errorResponse('BAD_REQUEST', 'keyId, attestationObject, challenge required', 400, requestId, RESPONSE_HEADERS)
  }
  // Single-use challenge.
  const seen = await env.ATTEST_KV.get(`challenge:${challenge}`)
  if (!seen) return errorResponse('BAD_CHALLENGE', 'unknown or expired challenge', 400, requestId, RESPONSE_HEADERS)
  await env.ATTEST_KV.delete(`challenge:${challenge}`)

  await verifyAttestation({ keyId, attestationObjectB64, challenge, appId: APP_ID, kv: env.ATTEST_KV })
  logOcrMonitoringEvent('info', { signal: 'attest_register', phase: 'attest', requestId }, env)
  return jsonResponse({ ok: true }, { status: 200, requestId, headers: RESPONSE_HEADERS })
}

async function handleScan(request, env, requestId) {
  const start = Date.now()
  const scanId = crypto.randomUUID()
  const clientVersion = request.headers.get('x-resplit-client-version') || 'unknown'
  const softFail = request.headers.get('x-resplit-attest-soft-fail') === 'true'
  const keyId = request.headers.get('x-resplit-attest-key-id') || ''
  const assertionB64 = request.headers.get('x-resplit-attest-assertion') || ''
  const contentType = request.headers.get('content-type') || 'image/jpeg'

  if (scanKillSwitchEnabled(env)) {
    return scanDisabled(env, { scanId, requestId, clientVersion })
  }

  const imageBytes = new Uint8Array(await request.arrayBuffer())
  if (imageBytes.length === 0) {
    return errorResponse('BAD_REQUEST', 'empty image body', 400, requestId, RESPONSE_HEADERS)
  }

  // --- Auth gate ---
  // The daily caps bound Azure ANALYZE CALLS, not HTTP requests: with the opt-in
  // key-value add-on enabled every scan fires a second layout analyze, so each
  // request charges the counter for the Azure work it can trigger.
  const azureUnits = keyValueExtrasEnabled(env) ? 2 : 1
  let attest = 'reject'
  let deviceKey = keyId
  if (softFail || !keyId || !assertionB64) {
    // Soft-fail / dev path: tighter cap keyed on IP, no hard block.
    attest = 'soft_fail'
    deviceKey = `ip:${request.headers.get('cf-connecting-ip') || 'unknown'}`
    const ok = await underCap(env, deviceKey, SOFT_FAIL_DAILY_CAP, azureUnits)
    if (!ok) return rateLimited(env, { scanId, attest, requestId, clientVersion })
  } else {
    await verifyAssertion({ keyId, assertionB64, clientData: imageBytes, appId: APP_ID, kv: env.ATTEST_KV })
    attest = 'pass'
    const ok = await underCap(env, deviceKey, PER_DEVICE_DAILY_CAP, azureUnits)
    if (!ok) return rateLimited(env, { scanId, attest, requestId, clientVersion })
  }

  // --- Idempotency (don't re-bill Azure for the same image) ---
  const imageHash = await sha256Hex(imageBytes)
  const cacheKey = `cache:${imageHash}`
  const cached = await env.ATTEST_KV.get(cacheKey)
  if (cached) {
    logOcrMonitoringEvent('info', {
      signal: 'scan', phase: 'scan', mode: 'raw', provider: OCR_PROVIDER, status: 'ok',
      attest, cache: 'hit', total_ms: Date.now() - start, scanId, requestId, client_version: clientVersion,
    }, env)
    return new Response(cached, { status: 200, headers: { ...RESPONSE_HEADERS, 'content-type': 'application/json', ...requestCorrelationHeaders(requestId) } })
  }

  // --- Azure forward (server-side; key never leaves the Worker) ---
  const azureStart = Date.now()
  const submit = await submitReceiptAnalyze(imageBytes, contentType, env)
  if (!submit.ok || !submit.operationId) {
    return finishScan(env, { scanId, attest, status: azureStatus(submit.httpStatus), raw: null, requestId, clientVersion, start, azureStart, azureStatus: submit.httpStatus, cache: 'miss' })
  }

  let result = null
  let azureHttp = submit.httpStatus
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    const poll = await getReceiptAnalyzeResult(submit.operationId, env)
    azureHttp = poll.httpStatus
    if (!poll.ok) break
    if (poll.status === 'succeeded') { result = poll.body; break }
    if (poll.status === 'failed') break
    await sleep(POLL_INTERVAL_MS)
  }

  let kvExtras = 'off'
  if (result && keyValueExtrasEnabled(env)) {
    const merge = await mergeLayoutKeyValuePairs({
      imageBytes, contentType, env, baseResult: result, scanId, requestId,
    })
    result = merge.result
    kvExtras = merge.kvExtras
  }

  const status = result ? 'ok' : 'provider_error'
  return finishScan(env, {
    scanId, attest, status, raw: result, requestId, clientVersion, start, azureStart,
    azureStatus: azureHttp, cache: 'miss', cacheKey, kvExtras,
  })
}

async function handleDualScan(request, env, requestId) {
  const start = Date.now()
  const scanId = crypto.randomUUID()
  const clientVersion = request.headers.get('x-resplit-client-version') || 'unknown'
  const softFail = request.headers.get('x-resplit-attest-soft-fail') === 'true'
  const keyId = request.headers.get('x-resplit-attest-key-id') || ''
  const assertionB64 = request.headers.get('x-resplit-attest-assertion') || ''
  const contentType = request.headers.get('content-type') || 'image/jpeg'

  if (scanKillSwitchEnabled(env)) {
    return scanDisabled(env, { scanId, requestId, clientVersion })
  }

  const imageBytes = new Uint8Array(await request.arrayBuffer())
  if (imageBytes.length === 0) {
    return errorResponse('BAD_REQUEST', 'empty image body', 400, requestId, RESPONSE_HEADERS)
  }

  const azureUnits = 1
  let attest = 'reject'
  let deviceKey = keyId
  if (softFail || !keyId || !assertionB64) {
    attest = 'soft_fail'
    deviceKey = `ip:${request.headers.get('cf-connecting-ip') || 'unknown'}`
    const ok = await underCap(env, deviceKey, SOFT_FAIL_DAILY_CAP, azureUnits)
    if (!ok) return rateLimitedDualScan(env, { scanId, attest, requestId, clientVersion })
  } else {
    await verifyAssertion({ keyId, assertionB64, clientData: imageBytes, appId: APP_ID, kv: env.ATTEST_KV })
    attest = 'pass'
    const ok = await underCap(env, deviceKey, PER_DEVICE_DAILY_CAP, azureUnits)
    if (!ok) return rateLimitedDualScan(env, { scanId, attest, requestId, clientVersion })
  }

  const imageHash = await sha256Hex(imageBytes)
  const llmGate = readLlmGate(env, keyId, attest)
  const model = llmModel(env)
  const cacheKey = `cache:dualScan:${imageHash}:${llmGate.cacheKey}:${model}`
  const cached = await env.ATTEST_KV.get(cacheKey)
  if (cached) {
    const cachedBody = JSON.parse(cached)
    logDualScanMonitoring(env, {
      body: cachedBody, requestId, clientVersion, attest, cache: 'hit',
      azureLatencyMs: null, totalMs: Date.now() - start,
    })
    return new Response(cached, { status: 200, headers: { ...RESPONSE_HEADERS, 'content-type': 'application/json', ...requestCorrelationHeaders(requestId) } })
  }

  const azurePromise = runAzureRawLeg({ imageBytes, contentType, env })
  const llmPromise = runLlmLeg({ imageBytes, contentType, env, gate: llmGate, model })

  const [azureSettled, llmSettled] = await Promise.allSettled([azurePromise, llmPromise])
  const azure = settledValue(azureSettled, () => ({
    status: 'provider_error',
    raw: null,
    httpStatus: 502,
    latencyMs: null,
  }))
  const llm = settledValue(llmSettled, () => ({
    status: 'provider_error',
    provider: LLM_PROVIDER,
    model,
    scanned: null,
    latencyMs: null,
    httpStatus: 502,
    errorBody: 'llm_leg_threw',
  }))
  const divergence = computeDivergence(azure.raw, llm.scanned, azure.status, llm.status)
  const status = dualScanStatus(azure.status, llm.status)
  const body = dualScanEnvelope({ scanId, status, azure, llm, divergence })
  const bodyJson = JSON.stringify(body)
  // Cache ONLY a fully-succeeded LLM leg. Previously an azure-only partial (LLM
  // failed) was pinned for CACHE_TTL_SECONDS: a transient Anthropic failure then
  // got served back on EVERY retry of the same image for the whole TTL, so the
  // user could never recover the LLM leg until it expired. Azure-only partials
  // now stay uncached and re-run the LLM on retry. (A future all-legs-succeeded
  // gate would also require azure.status === 'succeeded', but today an LLM
  // success is the scarce, worth-caching outcome.)
  if (llm.status === 'succeeded') {
    await env.ATTEST_KV.put(cacheKey, bodyJson, { expirationTtl: CACHE_TTL_SECONDS })
  }

  const totalMs = Date.now() - start
  logDualScanMonitoring(env, {
    body, requestId, clientVersion, attest, cache: 'miss',
    azureLatencyMs: azure.latencyMs, totalMs,
  })

  if (azure.status === 'provider_error') {
    await captureOcrProviderFailure({
      scanId, requestId, azureStatus: azure.httpStatus, attest, clientVersion, kvExtras: 'off', totalMs,
    }, env)
  }

  // The paid LLM leg needs its own error observability: a provider_error here covers
  // an Anthropic API error, a truncated tool_use, a schema violation, or a timeout
  // (all mapped to provider_error/502 upstream). Without this, the money leg's
  // failures were invisible in Sentry — only the Azure leg was captured.
  if (llm.status === 'provider_error') {
    await captureOcrLlmFailure({
      scanId, requestId, llmStatus: llm.status, httpStatus: llm.httpStatus,
      reason: llm.errorBody, model: llm.model, attest, clientVersion, totalMs,
    }, env)
  }

  return new Response(bodyJson, {
    status: dualScanHttpStatus(status),
    headers: { ...RESPONSE_HEADERS, 'content-type': 'application/json', ...requestCorrelationHeaders(requestId) },
  })
}

function envelope({ status, raw, scanId, kvExtras }) {
  return { v: ENVELOPE_VERSION, mode: 'raw', provider: OCR_PROVIDER, scanId, status, kv_extras: kvExtras ?? 'off', raw: raw ?? null }
}

function dualScanEnvelope({ scanId, status, azure, llm, divergence }) {
  return {
    v: ENVELOPE_VERSION,
    mode: 'dual',
    scanId,
    status,
    azure: { status: azure.status, raw: azure.raw ?? null },
    llm: {
      status: llm.status,
      provider: LLM_PROVIDER,
      model: llm.model,
      scanned: llm.scanned ?? null,
      latencyMs: llm.latencyMs,
    },
    divergence,
  }
}

function keyValueExtrasEnabled(env) {
  return enabledEnvFlag(env.AZURE_OCR_KV_EXTRAS)
}

function scanKillSwitchEnabled(env) {
  return enabledEnvFlag(env.OCR_SCAN_KILL_SWITCH)
}

function enabledEnvFlag(value) {
  return ENABLED_ENV_VALUES.has(String(value || '').trim().toLowerCase())
}

// Returns { result, kvExtras } so the envelope can distinguish "no adjustments on
// this receipt" (empty) from "the layout call broke" (failed) — without this the
// add-on degrades silently and field reports are undiagnosable.
async function mergeLayoutKeyValuePairs({ imageBytes, contentType, env, baseResult, scanId, requestId }) {
  const failed = () => {
    logOcrMonitoringEvent('warn', { signal: 'kv_extras_failed', phase: 'scan', scanId, requestId }, env)
    return { result: baseResult, kvExtras: 'failed' }
  }

  const submit = await submitLayoutKeyValueAnalyze(imageBytes, contentType, env)
  if (!submit.ok || !submit.operationId) return failed()

  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    const poll = await getLayoutKeyValueAnalyzeResult(submit.operationId, env)
    if (!poll.ok) break
    if (poll.status === 'succeeded') {
      return mergeKeyValuePairs(baseResult, poll.body)
    }
    if (poll.status === 'failed') break
    await sleep(POLL_INTERVAL_MS)
  }

  return failed()
}

function mergeKeyValuePairs(baseResult, layoutResult) {
  const keyValuePairs = layoutResult?.analyzeResult?.keyValuePairs
  if (!Array.isArray(keyValuePairs) || keyValuePairs.length === 0) {
    return { result: baseResult, kvExtras: 'empty' }
  }

  return {
    result: {
      ...baseResult,
      analyzeResult: {
        ...(baseResult?.analyzeResult || {}),
        keyValuePairs,
      },
    },
    kvExtras: 'merged',
  }
}

async function finishScan(env, ctx) {
  const env_ = env
  const body = JSON.stringify(envelope({ status: ctx.status, raw: ctx.raw, scanId: ctx.scanId, kvExtras: ctx.kvExtras }))
  if (ctx.status === 'ok' && ctx.cacheKey) {
    await env_.ATTEST_KV.put(ctx.cacheKey, body, { expirationTtl: CACHE_TTL_SECONDS })
  }
  const totalMs = Date.now() - ctx.start
  logOcrMonitoringEvent(ctx.status === 'ok' ? 'info' : 'warn', {
    signal: 'scan', phase: 'scan', mode: 'raw', provider: OCR_PROVIDER, status: ctx.status,
    kv_extras: ctx.kvExtras ?? 'off',
    attest: ctx.attest, cache: ctx.cache, azure_status: ctx.azureStatus,
    azure_ms: Date.now() - ctx.azureStart, total_ms: totalMs,
    scanId: ctx.scanId, requestId: ctx.requestId, client_version: ctx.clientVersion,
  }, env_)
  // A provider_error 502 is the user-facing "scan failed" outcome on the money/scan
  // path. The Loki line above is not a Sentry issue — without this leg a prod scan
  // failure is un-trendable/un-alertable the way the FX path's 502 already is.
  if (ctx.status === 'provider_error') {
    await captureOcrProviderFailure({
      scanId: ctx.scanId, requestId: ctx.requestId, azureStatus: ctx.azureStatus,
      attest: ctx.attest, clientVersion: ctx.clientVersion, kvExtras: ctx.kvExtras, totalMs,
    }, env_)
  }
  const httpStatus = ctx.status === 'ok' ? 200 : 502
  return new Response(body, { status: httpStatus, headers: { ...RESPONSE_HEADERS, 'content-type': 'application/json', ...requestCorrelationHeaders(ctx.requestId) } })
}

function azureStatus(httpStatus) {
  if (httpStatus === 429) return 'rate_limited'
  return 'provider_error'
}

async function runAzureRawLeg({ imageBytes, contentType, env }) {
  const start = Date.now()
  const submit = await submitReceiptAnalyze(imageBytes, contentType, env)
  if (!submit.ok || !submit.operationId) {
    return {
      status: azureStatus(submit.httpStatus),
      raw: null,
      httpStatus: submit.httpStatus,
      latencyMs: Date.now() - start,
    }
  }

  let raw = null
  let httpStatus = submit.httpStatus
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    const poll = await getReceiptAnalyzeResult(submit.operationId, env)
    httpStatus = poll.httpStatus
    if (!poll.ok) break
    if (poll.status === 'succeeded') { raw = poll.body; break }
    if (poll.status === 'failed') break
    await sleep(POLL_INTERVAL_MS)
  }

  return {
    status: raw ? 'succeeded' : azureStatus(httpStatus),
    raw,
    httpStatus,
    latencyMs: Date.now() - start,
  }
}

async function runLlmLeg({ imageBytes, contentType, env, gate, model }) {
  if (gate.status !== 'allowed') {
    return {
      status: gate.status,
      provider: LLM_PROVIDER,
      model,
      scanned: null,
      latencyMs: 0,
      httpStatus: gate.httpStatus,
      errorBody: null,
    }
  }

  const underDailyCap = await underLlmDailyCap(env)
  if (!underDailyCap) {
    return {
      status: 'rate_limited',
      provider: LLM_PROVIDER,
      model,
      scanned: null,
      latencyMs: 0,
      httpStatus: 429,
      errorBody: null,
    }
  }

  const result = await scanReceiptWithAnthropic(imageBytes, contentType, env)
  return {
    status: result.ok ? 'succeeded' : azureStatus(result.httpStatus),
    provider: LLM_PROVIDER,
    model: result.model || model,
    scanned: result.scanned ?? null,
    latencyMs: result.latencyMs,
    httpStatus: result.httpStatus,
    // Carries 'llm_truncated' / 'llm_schema_violation:…' / provider error text so the
    // Sentry capture below can tag WHY the paid leg failed, not just that it did.
    errorBody: result.errorBody ?? null,
  }
}

function readLlmGate(env, keyId, attest) {
  if (!env.ANTHROPIC_API_KEY) {
    return { status: 'provider_unavailable', httpStatus: 503, cacheKey: 'provider_unavailable' }
  }

  // PRE-LAUNCH DEV UNLOCK: the iOS client ships SoftFailReceiptScannerAttestationProvider
  // by default (no attested keyId exists yet), so a keyId allowlist alone is unreachable.
  // LLM_SCAN_ALLOW_SOFT_FAIL='true' admits soft-fail devices, still bounded by the
  // SOFT_FAIL_DAILY_CAP per-IP counter and the global LLM daily cap. FLIP TO 'false'
  // AT PUBLIC LAUNCH (launch checklist row) — then only allowlisted attested keys pass.
  if (env.LLM_SCAN_ALLOW_SOFT_FAIL === 'true' && attest === 'soft_fail') {
    return { status: 'allowed', httpStatus: 200, cacheKey: 'allowed:soft_fail' }
  }

  // AUTH: the allowlist branch admits a device ONLY when its App Attest assertion
  // was actually verified (attest === 'pass'). The x-resplit-attest-key-id header
  // on a soft-fail / unverified request is UNAUTHENTICATED — trusting it here would
  // let anyone spoof an allowlisted keyId and unlock the paid LLM leg. A soft_fail
  // device may pass only through the explicit dev-unlock branch above; every other
  // unverified request is not_allowed regardless of the header it carries.
  if (attest !== 'pass') {
    return { status: 'not_allowed', httpStatus: 403, cacheKey: `not_allowed:${keyId || 'missing'}` }
  }

  const allowed = new Set(String(env.LLM_SCAN_ALLOWED_KEY_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean))
  if (!keyId || !allowed.has(keyId)) {
    return { status: 'not_allowed', httpStatus: 403, cacheKey: `not_allowed:${keyId || 'missing'}` }
  }

  return { status: 'allowed', httpStatus: 200, cacheKey: `allowed:${keyId}` }
}

function llmModel(env) {
  return (env.LLM_SCAN_MODEL || DEFAULT_LLM_SCAN_MODEL).trim() || DEFAULT_LLM_SCAN_MODEL
}

// A daily cap read from env config: parse to a non-negative integer, else fall
// back to the documented default. A non-numeric/empty cap (e.g. '' or 'fifty')
// must NEVER become NaN — `current + 1 > NaN` is always false, which silently
// lifts the cap to infinity and lets the paid leg run unbounded.
function resolveDailyCap(rawValue, fallback) {
  const parsed = parseInt(String(rawValue ?? ''), 10)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}

// A KV counter value: parse to a non-negative integer, else 0. A corrupt/absent
// counter must never become NaN (which would fail the cap check open); 0 is the
// safe, self-healing floor.
function readCounter(rawValue) {
  const parsed = parseInt(String(rawValue ?? '0'), 10)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0
}

async function underLlmDailyCap(env) {
  const cap = resolveDailyCap(env.LLM_SCAN_DAILY_CAP, DEFAULT_LLM_SCAN_DAILY_CAP)
  const day = new Date().toISOString().slice(0, 10)
  const key = `llmcount:${day}`
  const current = readCounter(await env.ATTEST_KV.get(key))
  if (current + 1 > cap) return false
  await env.ATTEST_KV.put(key, String(current + 1), { expirationTtl: 172800 })
  return true
}

function settledValue(result, fallback) {
  if (result.status === 'fulfilled') return result.value
  return fallback(result.reason)
}

function dualScanStatus(azureStatus_, llmStatus) {
  if (azureStatus_ === 'succeeded' && llmStatus === 'succeeded') return 'succeeded'
  if (azureStatus_ === 'succeeded' || llmStatus === 'succeeded') return 'partial'
  if (azureStatus_ === 'rate_limited' || llmStatus === 'rate_limited') return 'rate_limited'
  return 'provider_error'
}

function dualScanHttpStatus(status) {
  if (status === 'rate_limited') return 429
  if (status === 'provider_error') return 502
  return 200
}

export function computeDivergence(azureRaw, llmScanned, azureStatus_, llmStatus) {
  if (azureStatus_ !== 'succeeded' || llmStatus !== 'succeeded') return null

  const azureTotal = azureRawTotal(azureRaw)
  const llmTotal = finiteNumberOrNull(llmScanned?.total)
  const azureKinds = azureExtraKinds(azureRaw)
  const llmKinds = new Set((Array.isArray(llmScanned?.extras) ? llmScanned.extras : [])
    .map((extra) => extra?.kind)
    .filter((kind) => typeof kind === 'string' && kind.length > 0))
  const extrasKindsDelta = Array.from(llmKinds)
    .filter((kind) => !azureKinds.has(kind))
    .sort()

  // Both legs succeeded but a total can still be missing (no Azure Total field, or
  // llm total null). Uncomparable is NOT disagreement: totalsAgree stays null rather
  // than falsely asserting the totals differ, and llmRecoveredAmount stays null too.
  const comparable = azureTotal != null && llmTotal != null
  return {
    totalsAgree: comparable ? azureTotal === llmTotal : null,
    azureTotal,
    llmTotal,
    extrasKindsDelta,
    llmRecoveredAmount: comparable ? Number((llmTotal - azureTotal).toFixed(2)) : null,
  }
}

function firstAzureDocument(raw) {
  const documents = raw?.analyzeResult?.documents
  return Array.isArray(documents) ? documents[0] : null
}

function azureField(raw, name) {
  return firstAzureDocument(raw)?.fields?.[name] ?? null
}

function azureRawTotal(raw) {
  return numberFromAzureField(azureField(raw, 'Total'))
}

function numberFromAzureField(field) {
  if (!field || typeof field !== 'object') return finiteNumberOrNull(field)
  return finiteNumberOrNull(
    field.valueNumber ??
    field.valueCurrency?.amount ??
    field.valueObject?.amount ??
    field.amount ??
    field.content
  )
}

export function finiteNumberOrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/[^0-9,.-]/g, '')
  if (!cleaned) return null
  const negative = cleaned.trimStart().startsWith('-')
  const body = cleaned.replace(/-/g, '')
  const normalized = normalizeSeparators(body)
  if (normalized == null) return null
  const parsed = Number(normalized)
  if (!Number.isFinite(parsed)) return null
  return negative ? -parsed : parsed
}

// Resolve thousands vs decimal separators the way the lab's EXTRACT_PROMPT does:
// the LAST separator is the decimal, the other is thousands; a lone comma before a
// 3-digit group is a thousands separator ('1,234' -> 1234, '4,500' -> 4500), while
// 1-2 trailing digits is a decimal ('12,50' -> 12.50). Fixes '$1,234' -> 1.234.
function normalizeSeparators(body) {
  const hasComma = body.includes(',')
  const hasDot = body.includes('.')

  if (hasComma && hasDot) {
    // Both present: the last-occurring separator is the decimal point.
    const decimalSep = body.lastIndexOf(',') > body.lastIndexOf('.') ? ',' : '.'
    const thousandsSep = decimalSep === ',' ? '.' : ','
    return body.split(thousandsSep).join('').replace(decimalSep, '.')
  }

  if (hasComma) {
    const parts = body.split(',')
    // Multiple commas (1,234,567) are all thousands separators.
    if (parts.length > 2) return parts.join('')
    const last = parts[parts.length - 1]
    // A single comma before exactly 3 digits is a thousands separator; 1-2 trailing
    // digits (or an empty group) reads as a decimal per the lab's ambiguity rule.
    if (last.length === 3) return parts.join('')
    return parts.join('.')
  }

  // Dot-only or no separators: leave as-is; Number() handles the decimal dot.
  return body
}

function azureExtraKinds(raw) {
  const fields = firstAzureDocument(raw)?.fields || {}
  const kinds = new Set()
  for (const [name, field] of Object.entries(fields)) {
    if (numberFromAzureField(field) == null) continue
    const lower = name.toLowerCase()
    if (lower.includes('tax')) kinds.add('tax')
    if (lower.includes('tip') || lower.includes('gratuity')) kinds.add('tip')
  }
  return kinds
}

function logDualScanMonitoring(env, { body, requestId, clientVersion, attest, cache, azureLatencyMs, totalMs }) {
  const divergence = body.divergence || {}
  logOcrMonitoringEvent(body.status === 'provider_error' ? 'warn' : 'info', {
    signal: 'dual_scan',
    phase: 'scan',
    mode: 'dual',
    status: body.status,
    azure_status: body.azure?.status,
    llm_status: body.llm?.status,
    llm_provider: body.llm?.provider,
    llm_model: body.llm?.model,
    attest,
    cache,
    azure_ms: azureLatencyMs,
    llm_ms: body.llm?.latencyMs ?? null,
    total_ms: totalMs,
    totals_agree: divergence.totalsAgree ?? null,
    azure_total: divergence.azureTotal ?? null,
    llm_total: divergence.llmTotal ?? null,
    extras_kinds_delta: divergence.extrasKindsDelta ?? null,
    llm_recovered_amount: divergence.llmRecoveredAmount ?? null,
    scanId: body.scanId,
    requestId,
    client_version: clientVersion,
  }, env)
}

async function rateLimited(env, { scanId, attest, requestId, clientVersion }) {
  logOcrMonitoringEvent('warn', {
    signal: 'scan', phase: 'scan', status: 'rate_limited', attest, scanId, requestId, client_version: clientVersion,
  }, env)
  const body = JSON.stringify(envelope({ status: 'rate_limited', raw: null, scanId }))
  return new Response(body, { status: 429, headers: { ...RESPONSE_HEADERS, 'content-type': 'application/json', ...requestCorrelationHeaders(requestId) } })
}

async function rateLimitedDualScan(env, { scanId, attest, requestId, clientVersion }) {
  const body = dualScanEnvelope({
    scanId,
    status: 'rate_limited',
    azure: { status: 'rate_limited', raw: null },
    llm: { status: 'not_started', provider: LLM_PROVIDER, model: llmModel(env), scanned: null, latencyMs: 0 },
    divergence: null,
  })
  logDualScanMonitoring(env, {
    body, requestId, clientVersion, attest, cache: 'skip', azureLatencyMs: 0, totalMs: 0,
  })
  return new Response(JSON.stringify(body), { status: 429, headers: { ...RESPONSE_HEADERS, 'content-type': 'application/json', ...requestCorrelationHeaders(requestId) } })
}

function scanDisabled(env, { scanId, requestId, clientVersion }) {
  logOcrMonitoringEvent('warn', {
    signal: 'scan', phase: 'scan', status: 'disabled', scanId, requestId, client_version: clientVersion,
  }, env)
  return errorResponse('OCR_DISABLED', 'OCR scan temporarily disabled', 503, requestId, {
    ...RESPONSE_HEADERS,
    'Retry-After': '300',
  })
}

// Sliding daily counter in KV, denominated in Azure analyze calls. Returns true
// if the request's `units` still fit under the cap (and charges them). A request
// that would overshoot is rejected whole — the cap is a billing ceiling, so
// partial admission would defeat it.
async function underCap(env, deviceKey, cap, units = 1) {
  const day = new Date().toISOString().slice(0, 10)
  const key = `count:${deviceKey}:${day}`
  const current = readCounter(await env.ATTEST_KV.get(key))
  if (current + units > cap) return false
  await env.ATTEST_KV.put(key, String(current + units), { expirationTtl: 172800 })
  return true
}
