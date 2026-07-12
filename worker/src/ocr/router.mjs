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
import {
  logOcrMonitoringEvent,
  captureOcrProviderFailure,
  captureOcrLlmFailure,
  captureOcrCacheWriteFailure,
  captureOcrTotalsDivergence,
} from './monitoring.mjs'
import {
  submitReceiptAnalyze,
  getReceiptAnalyzeResult,
  submitLayoutKeyValueAnalyze,
  getLayoutKeyValueAnalyzeResult,
  OCR_PROVIDER,
} from './azure.mjs'
import { scanReceiptWithAnthropic, receiptShapeViolation, LLM_PROVIDER } from './anthropic.mjs'
import { verifyAssertion, AttestError } from './attest.mjs'
import { verifyAttestation } from './attestation.mjs'
import { readOcrImageWithinBudget } from './ingress.mjs'
import { scheduleOcrAccountingShadow } from './accounting-shadow.mjs'
import {
  OcrAccountingError,
  ocrAccountingEnforced,
  reserveOcrAccounting,
  settleOcrAccounting,
} from './accounting-client.mjs'

const RESPONSE_HEADERS = { ...CORS_HEADERS, 'Cache-Control': 'no-store' }
const ENVELOPE_VERSION = 1

// App Attest RP-ID: assertions/attestations bind rpIdHash === SHA256(APP_ID), where
// APP_ID is <teamID>.<bundleID>. teamID is the App ID prefix under the app's CURRENT
// Apple team — ASC `GET /v1/bundleIds?filter[identifier]=com.superfit.Resplit` returns
// seedId QSL6XFT438 (FirstBite Labs LLC), the source of truth. GXS8378HLM was the
// pre-transfer Superfit prefix and is STALE for attest — do not revert. (The iOS
// ubiquity-kvstore entitlement legitimately keeps GXS8378HLM for iCloud data
// continuity; that prefix does not govern App Attest.)
const APP_ID = 'QSL6XFT438.com.superfit.Resplit'
const PER_DEVICE_DAILY_CAP = 200
const DEFAULT_SOFT_FAIL_DAILY_CAP = 20
const CACHE_TTL_SECONDS = 600
const POLL_INTERVAL_MS = 1500
const POLL_MAX_ATTEMPTS = 18 // ~27s ceiling
const DEFAULT_LLM_SCAN_MODEL = 'claude-sonnet-5'
const DEFAULT_LLM_SCAN_DAILY_CAP = 50
const ENABLED_ENV_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled'])
const LEGACY_PARTIAL_COMPAT_VERSIONS = new Set([
  '2.0.0+3798',
  '2.0.0+3801',
  '2.0.0+3811',
])
const LEGACY_PARTIAL_COMPAT_CURRENCIES = Object.freeze({
  USD: Object.freeze({ symbol: '$', scale: 100 }),
  EUR: Object.freeze({ symbol: '€', scale: 100 }),
  JPY: Object.freeze({ symbol: '¥', scale: 1 }),
})
const LEGACY_PARTIAL_LLM_STATUSES = new Set([
  'not_allowed',
  'not_started',
  'provider_error',
  'provider_unavailable',
  'rate_limited',
])
// `defaultClientVersion()` on iOS emits a numeric CFBundle short version with
// an optional numeric build suffix (for example, 2.2.0+4023). Do not log an
// arbitrary caller-controlled token here: App Attest rejects happen before an
// authenticated product request, so loose header values would create a PII
// and telemetry-cardinality sink.
const NATIVE_CLIENT_VERSION = /^\d{1,3}(?:\.\d{1,3}){0,2}(?:\+\d{1,8})?$/

function attestRejectClientVersion(request) {
  const value = request.headers.get('x-resplit-client-version')?.trim()
  return value && NATIVE_CLIENT_VERSION.test(value) ? value : 'unknown'
}

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
export async function handleOcr(request, env, ctx) {
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
      return await handleScan(request, env, requestId, ctx)
    }
    if (method === 'POST' && url.pathname === '/ocr/dual-scan') {
      return await handleDualScan(request, env, requestId, ctx)
    }
    if (method === 'POST' && url.pathname === '/ocr/analyze') {
      return await handleAnalyze(request, env, requestId, ctx)
    }
    return errorResponse('NOT_FOUND', 'OCR route not found', 404, requestId, RESPONSE_HEADERS)
  } catch (error) {
    if (error instanceof AttestError) {
      const event = {
        signal: 'attest_reject',
        code: error.code,
        requestId,
        path: url.pathname,
        client_version: attestRejectClientVersion(request),
      }
      // AttestError only admits its fixed SIG diagnostic vocabulary, so this
      // cannot turn request material into telemetry.
      if (error.reason) event.reason = error.reason
      logOcrMonitoringEvent('warn', event, env)
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

async function handleScan(request, env, requestId, ctx) {
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

  const ingress = await readOcrImageWithinBudget(request, env, {
    route: 'scan', requestId, clientVersion, responseHeaders: RESPONSE_HEADERS,
  })
  if (!ingress.ok) return ingress.response
  const { imageBytes } = ingress
  if (imageBytes.length === 0) {
    return errorResponse('BAD_REQUEST', 'empty image body', 400, requestId, RESPONSE_HEADERS)
  }

  // --- Auth gate ---
  // Authenticate (or resolve the bounded soft-fail principal) before reading the
  // cache. A valid cache entry is still protected by the same App Attest boundary,
  // but it performs no Azure work and therefore must not spend another provider
  // budget unit.
  const azureUnits = keyValueExtrasEnabled(env) ? 2 : 1
  const auth = await authenticateScan({ request, env, imageBytes, softFail, keyId, assertionB64 })
  const { attest } = auth

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

  const admission = await admitOcrWork({
    env, ctx, route: 'scan', requestId, scanId, auth,
    azureUnits, anthropicUnits: 0,
  })
  if (admission.status === 'rate_limited') {
    return rateLimited(env, { scanId, attest, requestId, clientVersion })
  }
  if (admission.status === 'unavailable') {
    return accountingUnavailableRaw(env, { scanId, attest, requestId, clientVersion })
  }

  // --- Azure forward (server-side; key never leaves the Worker) ---
  const azureStart = Date.now()
  let azureStartedUnits = 0
  try {
    const submit = await submitReceiptAnalyze(imageBytes, contentType, env)
    azureStartedUnits = submit.ok ? 1 : 0
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
        accountingEnforced: admission.enforced,
      })
      result = merge.result
      kvExtras = merge.kvExtras
      azureStartedUnits += merge.startedUnits
    }

    const status = result ? 'ok' : 'provider_error'
    return finishScan(env, {
      scanId, attest, status, raw: result, requestId, clientVersion, start, azureStart,
      azureStatus: azureHttp, cache: 'miss', cacheKey, kvExtras,
    })
  } finally {
    await settleOcrWork(env, {
      route: 'scan', requestId, scanId, reservation: admission.reservation,
      azureUnits: azureStartedUnits, anthropicUnits: 0,
    })
  }
}

// The legacy route: serves the EXACT v1 dual envelope shipped TestFlight builds
// parse, plus the two additive top-level fields (llmReasoning + aiModels).
async function handleDualScan(request, env, requestId, ctx) {
  return runOcrScan(request, env, requestId, ctx, { route: 'dual-scan', shapeEnvelope: shapeDualScanV1Envelope })
}

// The new route: same pipeline, served as the v2 N-engine envelope.
async function handleAnalyze(request, env, requestId, ctx) {
  return runOcrScan(request, env, requestId, ctx, { route: 'analyze', shapeEnvelope: shapeAnalyzeV2Envelope })
}

// Shared scan core for the multi-engine OCR routes. /ocr/dual-scan and /ocr/analyze
// run the IDENTICAL pipeline — kill switch, empty-body guard, App Attest, idempotency
// cache, cache-miss provider-budget debit, Azure OCR + Anthropic vision legs,
// divergence/consensus, cache write, Loki + Sentry monitoring — and differ ONLY in
// how the shape-neutral internal result is rendered into a response (shapeEnvelope).
// The gate logic lives here once so a naming/shape change on one route can never
// drift the other's auth or accounting order.
async function runOcrScan(request, env, requestId, ctx, { route, shapeEnvelope }) {
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

  const ingress = await readOcrImageWithinBudget(request, env, {
    route, requestId, clientVersion, responseHeaders: RESPONSE_HEADERS,
  })
  if (!ingress.ok) return ingress.response
  const { imageBytes } = ingress
  if (imageBytes.length === 0) {
    return errorResponse('BAD_REQUEST', 'empty image body', 400, requestId, RESPONSE_HEADERS)
  }

  // Authenticate before cache access. The daily provider cap is debited below only
  // when the shared cache misses and this request can perform paid work.
  const auth = await authenticateScan({ request, env, imageBytes, softFail, keyId, assertionB64 })
  const attest = auth.attest

  const imageHash = await sha256Hex(imageBytes)
  const llmGate = readLlmGate(env, keyId, attest)
  const model = llmModel(env)
  // The cached value is the shape-neutral internal result, NOT a v1/v2 envelope, so
  // the key is route-agnostic: dual-scan and analyze share one scan for the same
  // image+gate+model (the Azure+Anthropic work is byte-identical; only presentation
  // differs). The `v2core` token stops a read from parsing a pre-deploy v1-envelope
  // cache entry as an internal result.
  const cacheKey = `cache:dualScan:v2core:${imageHash}:${llmGate.cacheKey}:${model}`
  const cached = await env.ATTEST_KV.get(cacheKey)
  if (cached) {
    const result = JSON.parse(cached)
    logDualScanMonitoring(env, {
      result, route, requestId, clientVersion, attest, cache: 'hit',
      azureLatencyMs: null, totalMs: Date.now() - start,
    })
    return renderScan(shapeEnvelope, result, requestId)
  }

  const admission = await admitOcrWork({
    env, ctx, route, requestId, scanId, auth,
    azureUnits: 1,
    anthropicUnits: llmGate.status === 'allowed' ? 1 : 0,
  })
  if (admission.status === 'rate_limited') {
    return respondRateLimited(env, { route, shapeEnvelope, scanId, attest, requestId, clientVersion, start })
  }
  if (admission.status === 'unavailable') {
    return accountingUnavailableMulti(env, {
      route, shapeEnvelope, scanId, attest, requestId, clientVersion, start,
    })
  }

  const azurePromise = runAzureRawLeg({
    imageBytes,
    contentType,
    env,
    accountingEnforced: admission.enforced,
  })
  const llmPromise = runLlmLeg({
    imageBytes, contentType, env, gate: llmGate, model,
    accountingEnforced: admission.enforced,
    accountingAllowed: admission.anthropicAllowed,
  })

  const [azureSettled, llmSettled] = await Promise.allSettled([azurePromise, llmPromise])
  const azureLeg = settledValue(azureSettled, () => ({
    status: 'provider_error',
    raw: null,
    httpStatus: 502,
    latencyMs: null,
    accountingUnits: 0,
  }))
  const llmLeg = settledValue(llmSettled, () => ({
    status: 'provider_error',
    provider: LLM_PROVIDER,
    model,
    scanned: null,
    latencyMs: null,
    httpStatus: 502,
    errorBody: 'llm_leg_threw',
    accountingUnits: 0,
  }))
  const { accountingUnits: azureStartedUnits = 0, ...azure } = azureLeg
  const { accountingUnits: anthropicStartedUnits = 0, ...llm } = llmLeg
  await settleOcrWork(env, {
    route, requestId, scanId, reservation: admission.reservation,
    azureUnits: azureStartedUnits, anthropicUnits: anthropicStartedUnits,
  })
  const divergence = computeDivergence(azure.raw, llm.scanned, azure.status, llm.status)
  const status = dualScanStatus(azure.status, llm.status)
  const result = { scanId, status, azure, llm, divergence }

  // Cache ONLY a fully-succeeded LLM leg. Previously an azure-only partial (LLM
  // failed) was pinned for CACHE_TTL_SECONDS: a transient Anthropic failure then
  // got served back on EVERY retry of the same image for the whole TTL, so the
  // user could never recover the LLM leg until it expired. Azure-only partials
  // now stay uncached and re-run the LLM on retry. (A future all-legs-succeeded
  // gate would also require azure.status === 'succeeded', but today an LLM
  // success is the scarce, worth-caching outcome.)
  if (llm.status === 'succeeded') {
    await writeOcrCacheBestEffort(env, {
      cacheKey,
      value: JSON.stringify(result),
      route,
      scanId,
    })
  }

  const totalMs = Date.now() - start
  logDualScanMonitoring(env, {
    result, route, requestId, clientVersion, attest, cache: 'miss',
    azureLatencyMs: azure.latencyMs, totalMs,
  })
  logLegacyPartialCompatibilityShadow(env, { result, route, clientVersion })

  if (azure.status === 'provider_error') {
    await captureOcrProviderFailure({
      scanId, requestId, route, azureStatus: azure.httpStatus, attest, clientVersion, kvExtras: 'off', totalMs,
    }, env)
  }

  // The paid LLM leg needs its own error observability: a provider_error here covers
  // an Anthropic API error, a truncated tool_use, a schema violation, or a timeout
  // (all mapped to provider_error/502 upstream). Without this, the money leg's
  // failures were invisible in Sentry — only the Azure leg was captured.
  if (llm.status === 'provider_error') {
    await captureOcrLlmFailure({
      scanId, requestId, route, llmStatus: llm.status, httpStatus: llm.httpStatus,
      reason: llm.errorBody, model: llm.model, attest, clientVersion, totalMs,
    }, env)
  }

  // P8 alert wiring ("divergence telemetry is watched"): a SUCCEEDED scan whose
  // legs DISAGREE on the money total is the signal this endpoint exists to surface
  // — trendable in Sentry, not just an info log line. Cache-miss path only (the
  // first computation): a cached divergent result replayed on retry must not
  // re-alert for the same image. The alert fires for BOTH routes (same helper).
  if (divergence?.totalsAgree === false) {
    await captureOcrTotalsDivergence({
      scanId, requestId, route,
      azureTotal: divergence.azureTotal, llmTotal: divergence.llmTotal,
      llmRecoveredAmount: divergence.llmRecoveredAmount,
      extrasKindsDelta: divergence.extrasKindsDelta,
      model, attest, clientVersion, totalMs,
    }, env)
  }

  return renderScan(shapeEnvelope, result, requestId)
}

// Shared App Attest boundary. It intentionally does not mutate accounting: both
// route families must authenticate before cache access, then debit only on a miss.
// A verifyAssertion rejection throws AttestError, caught by handleOcr as a 401.
async function authenticateScan({ request, env, imageBytes, softFail, keyId, assertionB64 }) {
  if (softFail || !keyId || !assertionB64) {
    const principal = request.headers.get('cf-connecting-ip') || 'unknown'
    const deviceKey = `ip:${principal}`
    const azureSubjectCap = resolveDailyCap(env.SOFT_FAIL_DAILY_CAP, DEFAULT_SOFT_FAIL_DAILY_CAP)
    return { attest: 'soft_fail', deviceKey, principalKind: 'soft_fail', principal, azureSubjectCap }
  }
  await verifyAssertion({ keyId, assertionB64, clientData: imageBytes, appId: APP_ID, kv: env.ATTEST_KV })
  return {
    attest: 'pass',
    deviceKey: keyId,
    principalKind: 'attested',
    principal: keyId,
    azureSubjectCap: PER_DEVICE_DAILY_CAP,
  }
}

async function debitLegacyOcrBudget(env, auth, azureUnits) {
  return underCap(env, auth.deviceKey, auth.azureSubjectCap, azureUnits)
}

// One cache-miss admission seam serves all three OCR routes. Legacy and shadow
// preserve the installed KV behavior exactly. Enforce uses the global SQLite
// rendezvous synchronously and fails closed before either paid provider.
async function admitOcrWork({ env, ctx, route, requestId, scanId, auth, azureUnits, anthropicUnits }) {
  if (!ocrAccountingEnforced(env)) {
    const admitted = await debitLegacyOcrBudget(env, auth, azureUnits)
    if (!admitted) return { status: 'rate_limited', enforced: false, reservation: null }

    scheduleOcrAccountingShadow({
      env,
      ctx,
      route,
      requestId,
      scanId,
      principalKind: auth.principalKind,
      principal: auth.principal,
      azureUnits,
      anthropicUnits,
      azureSubjectCap: auth.azureSubjectCap,
      anthropicSubjectCap: auth.azureSubjectCap,
    })
    return {
      status: 'admitted',
      enforced: false,
      reservation: null,
      anthropicAllowed: true,
    }
  }

  let reservation
  try {
    reservation = await reserveOcrAccounting({
      env,
      scanId,
      principalKind: auth.principalKind,
      principal: auth.principal,
      azureUnits,
      anthropicUnits,
      azureSubjectCap: auth.azureSubjectCap,
      anthropicSubjectCap: auth.azureSubjectCap,
    })
  } catch (error) {
    logAccountingEvent(env, 'error', {
      signal: 'ocr_accounting_enforcement_failure',
      route,
      status: 'unavailable',
      reason: error instanceof OcrAccountingError ? error.reason : 'reservation_failed',
      requestId,
      scanId,
    })
    return { status: 'unavailable', enforced: true, reservation: null }
  }

  if (reservation.decision.azure?.allowed !== true) {
    await settleOcrWork(env, {
      route, requestId, scanId, reservation,
      azureUnits: 0, anthropicUnits: 0,
    })
    logAccountingEvent(env, 'warn', {
      signal: 'ocr_accounting_enforcement',
      route,
      status: 'blocked',
      provider: 'azure',
      requestId,
      scanId,
    })
    return { status: 'rate_limited', enforced: true, reservation: null }
  }

  const anthropicAllowed = anthropicUnits === 0 || reservation.decision.anthropic?.allowed === true
  logAccountingEvent(env, anthropicAllowed ? 'info' : 'warn', {
    signal: 'ocr_accounting_enforcement',
    route,
    status: anthropicAllowed ? 'admitted' : 'partially_admitted',
    azure_allowed: true,
    anthropic_allowed: anthropicAllowed,
    requestId,
    scanId,
  })
  return { status: 'admitted', enforced: true, reservation, anthropicAllowed }
}

async function settleOcrWork(env, { route, requestId, scanId, reservation, azureUnits, anthropicUnits }) {
  if (!reservation) return null
  try {
    const result = await settleOcrAccounting(reservation, { azureUnits, anthropicUnits })
    logAccountingEvent(env, 'info', {
      signal: 'ocr_accounting_enforcement',
      route,
      status: result.status,
      azure_units_committed: result.azure?.committedUnits ?? null,
      azure_units_refunded: result.azure?.refundedUnits ?? null,
      anthropic_units_committed: result.anthropic?.committedUnits ?? null,
      anthropic_units_refunded: result.anthropic?.refundedUnits ?? null,
      requestId,
      scanId,
    })
    return result
  } catch (error) {
    // A failed finalization deliberately leaves the original reservation charged.
    // This can reduce availability but cannot permit extra provider spend.
    logAccountingEvent(env, 'error', {
      signal: 'ocr_accounting_enforcement_failure',
      route,
      status: 'settlement_failed',
      reason: error instanceof OcrAccountingError ? error.reason : 'settlement_failed',
      requestId,
      scanId,
    })
    return null
  }
}

function logAccountingEvent(env, level, fields) {
  try {
    logOcrMonitoringEvent(level, { phase: 'accounting', enforced: true, ...fields }, env)
  } catch {
    // Accounting decisions remain authoritative when a telemetry sink regresses.
  }
}

function accountingUnavailableRaw(env, { scanId, attest, requestId, clientVersion }) {
  logOcrMonitoringEvent('error', {
    signal: 'scan', phase: 'scan', mode: 'raw', provider: OCR_PROVIDER,
    status: 'provider_error', accounting: 'unavailable', attest,
    scanId, requestId, client_version: clientVersion,
  }, env)
  const body = JSON.stringify(envelope({ status: 'provider_error', raw: null, scanId, kvExtras: 'off' }))
  return new Response(body, {
    status: 502,
    headers: { ...RESPONSE_HEADERS, 'content-type': 'application/json', ...requestCorrelationHeaders(requestId) },
  })
}

function accountingUnavailableMulti(env, { route, shapeEnvelope, scanId, attest, requestId, clientVersion, start }) {
  const result = {
    scanId,
    status: 'provider_error',
    azure: { status: 'provider_error', raw: null, httpStatus: 502, latencyMs: 0 },
    llm: {
      status: 'not_started', provider: LLM_PROVIDER, model: llmModel(env),
      scanned: null, latencyMs: 0, httpStatus: 502, errorBody: null,
    },
    divergence: null,
  }
  logDualScanMonitoring(env, {
    result, route, requestId, clientVersion, attest, cache: 'skip',
    azureLatencyMs: 0, totalMs: Date.now() - start,
  })
  return renderScan(shapeEnvelope, result, requestId)
}

// Serialize a shaped envelope; HTTP status is derived from the scan status so
// dual-scan and analyze return the same 200/429/502 for the same outcome.
function renderScan(shapeEnvelope, result, requestId) {
  return new Response(JSON.stringify(shapeEnvelope(result)), {
    status: dualScanHttpStatus(result.status),
    headers: { ...RESPONSE_HEADERS, 'content-type': 'application/json', ...requestCorrelationHeaders(requestId) },
  })
}

// Cap-exceeded response, shaped per-route from a rate_limited internal result so
// the divergence-free monitoring line is emitted uniformly for both routes.
function respondRateLimited(env, { route, shapeEnvelope, scanId, attest, requestId, clientVersion, start }) {
  const result = {
    scanId,
    status: 'rate_limited',
    azure: { status: 'rate_limited', raw: null, httpStatus: 429, latencyMs: 0 },
    llm: { status: 'not_started', provider: LLM_PROVIDER, model: llmModel(env), scanned: null, latencyMs: 0, httpStatus: 429, errorBody: null },
    divergence: null,
  }
  logDualScanMonitoring(env, {
    result, route, requestId, clientVersion, attest, cache: 'skip', azureLatencyMs: 0, totalMs: Date.now() - start,
  })
  return renderScan(shapeEnvelope, result, requestId)
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

// --- Response shaping (the ONLY per-route difference) --------------------------
const ANALYZE_ENVELOPE_VERSION = 2
// v2 engine identity. `azure-di-v4` is the aiModels label for the Azure Document
// Intelligence v4 receipt model; the llm engine contributes its resolved model id.
// True Azure model id (azure.mjs RECEIPT_MODEL_ID) — telemetry must name the
// real engine, not a marketing alias; aiModels keeps the human label.
const AZURE_ENGINE_MODEL = 'prebuilt-receipt'
const AZURE_AI_MODEL_LABEL = 'azure-di-v4'

// Legacy v1 dual envelope, byte-for-byte as shipped, PLUS the two additive
// top-level fields Leo asked clients to parse. Additive is safe: existing clients
// ignore unknown keys and every field dualScanEnvelope emits is unchanged.
function shapeDualScanV1Envelope(result) {
  const base = dualScanEnvelope({
    scanId: result.scanId, status: result.status,
    azure: result.azure, llm: result.llm, divergence: result.divergence,
  })
  base.llmReasoning = result.llm.status === 'succeeded'
  base.aiModels = contributingAiModels(result)
  return base
}

// v2 N-engine envelope. engines[] is an ARRAY so a THIRD engine is an append, not a
// schema break. consensus = today's divergence object, inner field names preserved
// (clients of this route are new). llmReasoning is true iff the vision-llm leg
// succeeded — a capped/failed leg did not reason about the receipt.
function shapeAnalyzeV2Envelope(result) {
  return {
    v: ANALYZE_ENVELOPE_VERSION,
    scanId: result.scanId,
    status: result.status,
    llmReasoning: result.llm.status === 'succeeded',
    aiModels: contributingAiModels(result),
    engines: [analyzeAzureEngine(result.azure), analyzeLlmEngine(result.llm)],
    consensus: result.divergence,
  }
}

// The engines that CONTRIBUTED (succeeded), in engine order: azure first, then the
// vision-llm. A capped or failed leg is omitted — it did not AI-reason the receipt.
function contributingAiModels(result) {
  const models = []
  if (result.azure.status === 'succeeded') models.push(AZURE_AI_MODEL_LABEL)
  if (result.llm.status === 'succeeded') models.push(result.llm.model)
  return models
}

function analyzeAzureEngine(azure) {
  return {
    id: 'azure',
    kind: 'ocr',
    provider: OCR_PROVIDER,
    model: AZURE_ENGINE_MODEL,
    status: azure.status,
    latencyMs: azure.latencyMs ?? null,
    raw: azure.raw ?? null,
  }
}

function analyzeLlmEngine(llm) {
  return {
    id: 'llm',
    kind: 'vision-llm',
    provider: LLM_PROVIDER,
    model: llm.model,
    status: llm.status,
    latencyMs: llm.latencyMs ?? null,
    scanned: llm.scanned ?? null,
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
async function mergeLayoutKeyValuePairs({
  imageBytes,
  contentType,
  env,
  baseResult,
  scanId,
  requestId,
  accountingEnforced = false,
}) {
  const failed = (startedUnits) => {
    try {
      logOcrMonitoringEvent('warn', { signal: 'kv_extras_failed', phase: 'scan', scanId, requestId }, env)
    } catch {
      // Preserve the accounting receipt even if the diagnostic sink regresses.
    }
    return { result: baseResult, kvExtras: 'failed', startedUnits }
  }

  let startedUnits = 0
  try {
    const submit = await submitLayoutKeyValueAnalyze(imageBytes, contentType, env)
    startedUnits = submit.ok ? 1 : 0
    if (!submit.ok || !submit.operationId) return failed(startedUnits)

    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      const poll = await getLayoutKeyValueAnalyzeResult(submit.operationId, env)
      if (!poll.ok) break
      if (poll.status === 'succeeded') {
        return { ...mergeKeyValuePairs(baseResult, poll.body), startedUnits }
      }
      if (poll.status === 'failed') break
      await sleep(POLL_INTERVAL_MS)
    }
  } catch (error) {
    if (!accountingEnforced) throw error
    // `startedUnits` is deliberately retained: once Azure accepted the analyze,
    // a later transport/config exception cannot prove the provider work was free.
  }

  return failed(startedUnits)
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
    await writeOcrCacheBestEffort(env_, {
      cacheKey: ctx.cacheKey,
      value: body,
      route: 'scan',
      scanId: ctx.scanId,
    })
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

// Cache persistence is an optimization after the paid providers have already
// produced a usable result. A transient KV outage must not discard that result
// or make the client pay for a retry. The warning deliberately excludes cache
// keys, image hashes/bytes, device identity, provider credentials, and raw errors.
async function writeOcrCacheBestEffort(env, { cacheKey, value, route, scanId }) {
  try {
    await env.ATTEST_KV.put(cacheKey, value, { expirationTtl: CACHE_TTL_SECONDS })
    return true
  } catch {
    try {
      logOcrMonitoringEvent('warn', {
        signal: 'ocr_cache_write_failed',
        phase: 'scan',
        route,
        status: 'degraded',
        scanId,
      }, env)
    } catch {
      // A broken log sink cannot mask a provider result the client can use.
    }
    try {
      await captureOcrCacheWriteFailure({ scanId, route }, env)
    } catch {
      // Keep this boundary fail-open even if the reporting helper regresses.
    }
    return false
  }
}

function azureStatus(httpStatus) {
  if (httpStatus === 429) return 'rate_limited'
  return 'provider_error'
}

async function runAzureRawLeg({ imageBytes, contentType, env, accountingEnforced = false }) {
  const start = Date.now()
  let accountingUnits = 0
  try {
    const submit = await submitReceiptAnalyze(imageBytes, contentType, env)
    accountingUnits = submit.ok ? 1 : 0
    if (!submit.ok || !submit.operationId) {
      return {
        status: azureStatus(submit.httpStatus),
        raw: null,
        httpStatus: submit.httpStatus,
        latencyMs: Date.now() - start,
        accountingUnits,
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
      accountingUnits,
    }
  } catch (error) {
    if (!accountingEnforced) throw error
    // Preserve the conservative provider-start receipt if polling throws after
    // Azure accepted the analyze request.
    return {
      status: 'provider_error',
      raw: null,
      httpStatus: 502,
      latencyMs: Date.now() - start,
      accountingUnits,
    }
  }
}

async function runLlmLeg({
  imageBytes, contentType, env, gate, model,
  accountingEnforced = false, accountingAllowed = true,
}) {
  if (gate.status !== 'allowed') {
    return {
      status: gate.status,
      provider: LLM_PROVIDER,
      model,
      scanned: null,
      latencyMs: 0,
      httpStatus: gate.httpStatus,
      errorBody: null,
      accountingUnits: 0,
    }
  }

  const underDailyCap = accountingEnforced ? accountingAllowed : await underLlmDailyCap(env)
  if (!underDailyCap) {
    return {
      status: 'rate_limited',
      provider: LLM_PROVIDER,
      model,
      scanned: null,
      latencyMs: 0,
      httpStatus: 429,
      errorBody: null,
      accountingUnits: 0,
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
    accountingUnits: result.providerStarted === true ? 1 : 0,
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
  const llmKinds = llmExtraKinds(llmScanned)
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

// Per-scan recovery telemetry: which receipt fields the vision-LLM leg populated
// that Azure's prebuilt parse LACKED. This is the product signal behind a pro-tier
// AI-scan subscription ("what the LLM catches that the prebuilt model misses"), so
// it is computed for BOTH routes. Every value is a boolean presence pair, a count,
// or an amount — never field TEXT — so the block is PII-safe. Robust to a failed
// leg: a null raw / null scanned reads as "not present" for that side.
export function computeRecovery(azure, llm) {
  const raw = azure?.raw ?? null
  const scanned = (llm?.scanned && typeof llm.scanned === 'object') ? llm.scanned : null
  const azureKinds = azureExtraKinds(raw)
  const llmKinds = llmExtraKinds(scanned)

  const merchant = presencePair(azureFieldHasContent(raw, 'MerchantName'), isNonEmptyString(scanned?.merchantName))
  const date = presencePair(azureFieldHasContent(raw, 'TransactionDate'), isNonEmptyString(scanned?.transactionDate))
  const tax = presencePair(azureKinds.has('tax'), llmKinds.has('tax'))
  const tip = presencePair(azureKinds.has('tip'), llmKinds.has('tip'))
  const total = presencePair(azureRawTotal(raw) != null, finiteNumberOrNull(scanned?.total) != null)

  const azureItems = azureItemsCount(raw)
  const llmItems = Array.isArray(scanned?.lineItems) ? scanned.lineItems.length : 0
  const fields = [merchant, date, tax, tip, total]

  return {
    merchant, date, tax, tip, total,
    azureItems,
    llmItems,
    // Extra line items the LLM read beyond Azure's count (>=0). A shorter LLM list
    // clamps to 0 — that is a different (possibly worse) read, not "recovery".
    itemsDelta: Math.max(0, llmItems - azureItems),
    // Headline pro-tier number: of the 5 tracked fields, how many the LLM populated
    // that Azure missed — the concrete "AI recovered this" tally.
    llmOnlyFieldCount: fields.filter((f) => f.llmOnly).length,
  }
}

// {azure, llm} presence booleans plus the derived llm-only signal (the pro-tier
// "LLM caught what Azure missed" per-field flag).
function presencePair(azurePresent, llmPresent) {
  const azure = Boolean(azurePresent)
  const llm = Boolean(llmPresent)
  return { azure, llm, llmOnly: llm && !azure }
}

function llmExtraKinds(scanned) {
  return new Set((Array.isArray(scanned?.extras) ? scanned.extras : [])
    .map((extra) => extra?.kind)
    .filter((kind) => typeof kind === 'string' && kind.length > 0))
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

// Azure DI names merchant as a valueString/content field and the date as valueDate;
// treat any non-empty resolved value as "present".
function azureFieldHasContent(raw, name) {
  const field = azureField(raw, name)
  if (!field || typeof field !== 'object') return false
  const value = field.valueString ?? field.valueDate ?? field.valuePhoneNumber ?? field.content ?? null
  if (typeof value === 'string') return value.trim().length > 0
  return value != null
}

// Azure DI v4 line items live under fields.Items.valueArray.
function azureItemsCount(raw) {
  const arr = firstAzureDocument(raw)?.fields?.Items?.valueArray
  return Array.isArray(arr) ? arr.length : 0
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

/**
 * Exact installed-build admission for the pre-3817 dual-scan decoder. This is
 * deliberately byte-exact: caller-controlled whitespace, suffixes, semantic
 * lookalikes, and newer builds must not broaden a compatibility carrier.
 */
export function isLegacyPartialCompatibilityVersion(value) {
  return typeof value === 'string' && LEGACY_PARTIAL_COMPAT_VERSIONS.has(value)
}

/**
 * Build a conservative historical-client DTO candidate from Azure's structured
 * receipt fields. This function is pure and fail-closed. It never changes the
 * provider result; the live caller currently uses only outcome/reason telemetry.
 *
 * The mapper intentionally supports only three currencies with explicit Azure
 * currency codes and minor-unit scales. It requires structured item/subtotal/
 * total money, rejects cross-field currency disagreement, and accepts at most a
 * one-minor-unit reconciliation delta at each arithmetic seam.
 */
export function mapLegacyPartialCompatibilityCandidate(azureRaw) {
  const documents = azureRaw?.analyzeResult?.documents
  if (!Array.isArray(documents) || documents.length !== 1) {
    return legacyPartialRejected('ambiguous_document')
  }
  const fields = documents[0]?.fields
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return legacyPartialRejected('ambiguous_document')
  }

  if (!fields.Total) return legacyPartialRejected('missing_total')
  const total = readLegacyPartialMoney(fields.Total)
  if (!total.ok) return legacyPartialRejected(total.reason)
  const currency = LEGACY_PARTIAL_COMPAT_CURRENCIES[total.currencyCode]
  if (!currency) return legacyPartialRejected('unsupported_currency')

  if (!fields.Subtotal) return legacyPartialRejected('missing_subtotal')
  const subtotal = readLegacyPartialMoney(fields.Subtotal)
  if (!subtotal.ok) return legacyPartialRejected(subtotal.reason)
  if (subtotal.currencyCode !== total.currencyCode) {
    return legacyPartialRejected('ambiguous_currency')
  }

  const items = fields.Items?.valueArray
  if (!Array.isArray(items) || items.length === 0) {
    return legacyPartialRejected('items_missing')
  }

  const lineItems = []
  for (const item of items) {
    const object = item?.valueObject
    const name = legacyPartialText(object?.Description, ['valueString', 'content'])
    if (!name) return legacyPartialRejected('missing_item_name')
    if (!object?.TotalPrice) return legacyPartialRejected('missing_item_amount')
    const amount = readLegacyPartialMoney(object.TotalPrice)
    if (!amount.ok) return legacyPartialRejected(amount.reason)
    if (amount.currencyCode !== total.currencyCode) {
      return legacyPartialRejected('ambiguous_currency')
    }

    const amountMinor = legacyPartialMinorUnits(amount.amount, currency.scale)
    if (amountMinor == null || amountMinor < 0) {
      return legacyPartialRejected('ambiguous_amount')
    }
    const quantity = legacyPartialQuantity(object.Quantity)
    if (quantity === undefined) return legacyPartialRejected('ambiguous_quantity')
    lineItems.push({
      name,
      amount: amountMinor / currency.scale,
      quantity,
    })
  }

  const totalMinor = legacyPartialMinorUnits(total.amount, currency.scale)
  const subtotalMinor = legacyPartialMinorUnits(subtotal.amount, currency.scale)
  if (totalMinor == null || subtotalMinor == null || totalMinor <= 0 || subtotalMinor < 0) {
    return legacyPartialRejected('ambiguous_amount')
  }

  const extras = []
  let extrasMinor = 0
  for (const [fieldName, label, kind] of [
    ['TotalTax', 'Tax', 'tax'],
    ['Tip', 'Tip', 'tip'],
  ]) {
    const field = fields[fieldName]
    if (!field) continue
    const extra = readLegacyPartialMoney(field)
    if (!extra.ok) return legacyPartialRejected(extra.reason)
    if (extra.currencyCode !== total.currencyCode) {
      return legacyPartialRejected('ambiguous_currency')
    }
    const amountMinor = legacyPartialMinorUnits(extra.amount, currency.scale)
    if (amountMinor == null || amountMinor < 0) {
      return legacyPartialRejected('ambiguous_amount')
    }
    extrasMinor += amountMinor
    extras.push({ label, amount: amountMinor / currency.scale, kind })
  }

  const itemMinor = lineItems.reduce(
    (sum, item) => sum + legacyPartialMinorUnits(item.amount, currency.scale),
    0,
  )
  if (
    Math.abs(itemMinor - subtotalMinor) > 1 ||
    Math.abs(subtotalMinor + extrasMinor - totalMinor) > 1
  ) {
    return legacyPartialRejected('arithmetic_mismatch')
  }

  const scanned = {
    merchantName: legacyPartialText(fields.MerchantName, ['valueString', 'content']),
    merchantAddress: legacyPartialText(fields.MerchantAddress, ['content', 'valueString']),
    transactionDate: legacyPartialDate(fields.TransactionDate),
    currencyCode: total.currencyCode,
    currencySymbol: currency.symbol,
    lineItems,
    subtotal: subtotalMinor / currency.scale,
    total: totalMinor / currency.scale,
    extras,
  }
  if (receiptShapeViolation(scanned) !== null) {
    return legacyPartialRejected('schema_invalid')
  }
  return { outcome: 'candidate', reason: 'arithmetic_verified', scanned }
}

function readLegacyPartialMoney(field) {
  const valueCurrency = field?.valueCurrency
  const amount = finiteNumberOrNull(valueCurrency?.amount)
  if (amount == null) return { ok: false, reason: 'ambiguous_amount' }

  const rawCurrencyCode = valueCurrency?.currencyCode
  if (typeof rawCurrencyCode !== 'string' || !/^[A-Z]{3}$/.test(rawCurrencyCode)) {
    return { ok: false, reason: 'ambiguous_currency' }
  }

  if (typeof field.content === 'string' && field.content.trim().length > 0) {
    const contentAmount = finiteNumberOrNull(field.content)
    const currency = LEGACY_PARTIAL_COMPAT_CURRENCIES[rawCurrencyCode]
    const contentMinor = currency
      ? legacyPartialMinorUnits(contentAmount, currency.scale)
      : null
    const structuredMinor = currency
      ? legacyPartialMinorUnits(amount, currency.scale)
      : null
    if (
      contentAmount == null ||
      (currency && (
        contentMinor == null ||
        structuredMinor == null ||
        Math.abs(contentMinor - structuredMinor) > 1
      ))
    ) {
      return { ok: false, reason: 'ambiguous_amount' }
    }
  }

  return { ok: true, amount, currencyCode: rawCurrencyCode }
}

function legacyPartialMinorUnits(amount, scale) {
  if (!Number.isFinite(amount)) return null
  const scaled = amount * scale
  const rounded = Math.round(scaled)
  return Math.abs(scaled - rounded) <= 0.000001 ? rounded : null
}

function legacyPartialText(field, keys) {
  for (const key of keys) {
    const value = field?.[key]
    if (typeof value !== 'string') continue
    const normalized = value.trim().replace(/\s+/g, ' ')
    if (normalized.length > 0 && normalized.length <= 500) return normalized
  }
  return null
}

function legacyPartialDate(field) {
  const date = legacyPartialText(field, ['valueDate'])
  return date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null
}

function legacyPartialQuantity(field) {
  if (field == null) return null
  const value = finiteNumberOrNull(field.valueNumber)
  if (value == null || value <= 0 || value > 10_000) return undefined
  const rounded = Math.round(value)
  return Math.abs(value - rounded) <= 0.0001 ? rounded : null
}

function legacyPartialRejected(reason) {
  return { outcome: 'rejected', reason, scanned: null }
}

function logLegacyPartialCompatibilityShadow(env, { result, route, clientVersion }) {
  if (!enabledEnvFlag(env.OCR_LEGACY_PARTIAL_COMPAT_SHADOW)) return
  if (route !== 'dual-scan' || !isLegacyPartialCompatibilityVersion(clientVersion)) return
  if (
    result.status !== 'partial' ||
    result.azure?.status !== 'succeeded' ||
    result.llm?.status === 'succeeded'
  ) return

  // This lane is observational until an independently proven activation change.
  // A mapper or log regression must never alter the historical response.
  try {
    const mapped = mapLegacyPartialCompatibilityCandidate(result.azure.raw)
    logOcrMonitoringEvent('info', {
      signal: 'ocr_legacy_partial_compat_shadow',
      route: 'dual-scan',
      compatibility_outcome: mapped.outcome,
      compatibility_version: clientVersion,
      compatibility_reason: mapped.reason,
      llm_status: LEGACY_PARTIAL_LLM_STATUSES.has(result.llm.status)
        ? result.llm.status
        : 'other',
    }, env)
  } catch {
    // Shadow classification and telemetry are never response dependencies.
  }
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

// Structured Loki line for a scan served by EITHER OCR route. `signal` stays
// 'dual_scan' so existing Grafana/Loki queries (scan volume, p95, totals-agree
// trend, the divergence alert) keep covering both routes; the new `route` field
// discriminates which one served. Reads the shape-neutral internal result, so it
// works identically on the cache-hit, cache-miss, and rate-limited paths.
function logDualScanMonitoring(env, { result, route, requestId, clientVersion, attest, cache, azureLatencyMs, totalMs }) {
  const divergence = result.divergence || {}
  const recovery = computeRecovery(result.azure, result.llm)
  // warn on provider errors AND on totals disagreement — a divergent money
  // total is never routine (P8 alert wiring; the Sentry capture rides the
  // cache-miss path, this level applies to hits too so log queries trend both).
  const level = result.status === 'provider_error' || divergence.totalsAgree === false ? 'warn' : 'info'
  logOcrMonitoringEvent(level, {
    signal: 'dual_scan',
    route: route ?? 'dual-scan',
    phase: 'scan',
    mode: 'dual',
    status: result.status,
    azure_status: result.azure?.status,
    llm_status: result.llm?.status,
    llm_provider: result.llm?.provider ?? LLM_PROVIDER,
    llm_model: result.llm?.model,
    llm_reasoning: result.llm?.status === 'succeeded',
    attest,
    cache,
    azure_ms: azureLatencyMs,
    llm_ms: result.llm?.latencyMs ?? null,
    total_ms: totalMs,
    totals_agree: divergence.totalsAgree ?? null,
    azure_total: divergence.azureTotal ?? null,
    llm_total: divergence.llmTotal ?? null,
    extras_kinds_delta: divergence.extrasKindsDelta ?? null,
    llm_recovered_amount: divergence.llmRecoveredAmount ?? null,
    // Recovery telemetry (pro-tier AI-scan signal): what the LLM leg caught that
    // Azure's prebuilt parse missed. Nested `recovery` block for the full per-field
    // picture PLUS flat headline metrics so simple Loki label filters work too.
    recovery,
    recovery_llm_only_fields: recovery.llmOnlyFieldCount,
    azure_items: recovery.azureItems,
    llm_items: recovery.llmItems,
    items_delta: recovery.itemsDelta,
    scanId: result.scanId,
    requestId,
    client_version: clientVersion,
  }, env)

  // One Analytics Engine datapoint per FRESH scan (cache miss only — a cache hit or
  // rate-limited request ran no new OCR, and a cache hit replays the original
  // scanId, so counting it would double the recovery tally). No-op without a bound
  // dataset; write errors are swallowed so telemetry never fails a scan.
  if (cache === 'miss') {
    writeOcrScanAnalytics(env, { result, route, recovery, azureLatencyMs, totalMs })
  }
}

// Workers Analytics Engine datapoint: zero added latency, SQL-queryable via the AE
// API, free tier. PII-safe — scanId is a per-scan random UUID (not a device/user
// id) and caps stay server-side; this is product telemetry, not user tracking.
function writeOcrScanAnalytics(env, { result, route, recovery, azureLatencyMs, totalMs }) {
  const dataset = env && env.OCR_SCAN_ANALYTICS
  if (!dataset || typeof dataset.writeDataPoint !== 'function') return
  try {
    dataset.writeDataPoint({
      // Sampling index (<=96 bytes): llmReasoning as '1'/'0' so pro-tier
      // (AI-reasoned) scans partition cleanly from plain OCR.
      indexes: [result.llm?.status === 'succeeded' ? '1' : '0'],
      blobs: [
        result.scanId,
        route,
        result.status,
        result.llm?.status ?? 'unknown',
        result.llm?.model ?? 'unknown',
      ],
      doubles: [
        recovery.azureItems,
        recovery.llmItems,
        recovery.itemsDelta,
        recovery.llmOnlyFieldCount,
        result.divergence?.llmRecoveredAmount ?? 0,
        azureLatencyMs ?? 0,
        result.llm?.latencyMs ?? 0,
        totalMs ?? 0,
      ],
    })
  } catch {
    // Telemetry must never break a scan.
  }
}

async function rateLimited(env, { scanId, attest, requestId, clientVersion }) {
  logOcrMonitoringEvent('warn', {
    signal: 'scan', phase: 'scan', status: 'rate_limited', attest, scanId, requestId, client_version: clientVersion,
  }, env)
  const body = JSON.stringify(envelope({ status: 'rate_limited', raw: null, scanId }))
  return new Response(body, { status: 429, headers: { ...RESPONSE_HEADERS, 'content-type': 'application/json', ...requestCorrelationHeaders(requestId) } })
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
