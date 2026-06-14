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
import { resolveRequestId } from '../request-id.mjs'
import { captureFxRouteFailure } from '../monitoring.mjs'
import { CORS_HEADERS, handlePreflight } from '../sideload/cors.mjs'
import { logOcrMonitoringEvent } from './monitoring.mjs'
import {
  submitReceiptAnalyze,
  getReceiptAnalyzeResult,
  submitLayoutKeyValueAnalyze,
  getLayoutKeyValueAnalyzeResult,
  OCR_PROVIDER,
} from './azure.mjs'
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
const KV_EXTRAS_ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled'])

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
    return new Response(cached, { status: 200, headers: { ...RESPONSE_HEADERS, 'content-type': 'application/json', 'x-request-id': requestId } })
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

function envelope({ status, raw, scanId, kvExtras }) {
  return { v: ENVELOPE_VERSION, mode: 'raw', provider: OCR_PROVIDER, scanId, status, kv_extras: kvExtras ?? 'off', raw: raw ?? null }
}

function keyValueExtrasEnabled(env) {
  return KV_EXTRAS_ENABLED_VALUES.has(String(env.AZURE_OCR_KV_EXTRAS || '').trim().toLowerCase())
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
  logOcrMonitoringEvent(ctx.status === 'ok' ? 'info' : 'warn', {
    signal: 'scan', phase: 'scan', mode: 'raw', provider: OCR_PROVIDER, status: ctx.status,
    kv_extras: ctx.kvExtras ?? 'off',
    attest: ctx.attest, cache: ctx.cache, azure_status: ctx.azureStatus,
    azure_ms: Date.now() - ctx.azureStart, total_ms: Date.now() - ctx.start,
    scanId: ctx.scanId, requestId: ctx.requestId, client_version: ctx.clientVersion,
  }, env_)
  const httpStatus = ctx.status === 'ok' ? 200 : 502
  return new Response(body, { status: httpStatus, headers: { ...RESPONSE_HEADERS, 'content-type': 'application/json', 'x-request-id': ctx.requestId } })
}

function azureStatus(httpStatus) {
  if (httpStatus === 429) return 'rate_limited'
  return 'provider_error'
}

async function rateLimited(env, { scanId, attest, requestId, clientVersion }) {
  logOcrMonitoringEvent('warn', {
    signal: 'scan', phase: 'scan', status: 'rate_limited', attest, scanId, requestId, client_version: clientVersion,
  }, env)
  const body = JSON.stringify(envelope({ status: 'rate_limited', raw: null, scanId }))
  return new Response(body, { status: 429, headers: { ...RESPONSE_HEADERS, 'content-type': 'application/json', 'x-request-id': requestId } })
}

// Sliding daily counter in KV, denominated in Azure analyze calls. Returns true
// if the request's `units` still fit under the cap (and charges them). A request
// that would overshoot is rejected whole — the cap is a billing ceiling, so
// partial admission would defeat it.
async function underCap(env, deviceKey, cap, units = 1) {
  const day = new Date().toISOString().slice(0, 10)
  const key = `count:${deviceKey}:${day}`
  const current = parseInt((await env.ATTEST_KV.get(key)) || '0', 10)
  if (current + units > cap) return false
  await env.ATTEST_KV.put(key, String(current + units), { expirationTtl: 172800 })
  return true
}
