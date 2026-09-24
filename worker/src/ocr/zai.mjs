// Z.AI (GLM) vision transport for the LLM receipt leg, OpenAI-compatible chat
// completions. Same boundary contract as anthropic.mjs: this module owns only the
// provider call and returns the identical shaped result; router.mjs owns auth,
// caps, cache, envelopes, and monitoring. Errors stay data-shaped so a provider
// failure never escapes as a thrown route exception. Selected by llm-provider.mjs
// when LLM_SCAN_PROVIDER=zai; the default Anthropic path is untouched.

import {
  RECEIPT_JSON_SYSTEM_PROMPT,
  LLM_FETCH_TIMEOUT_MS,
  LLM_MAX_TOKENS,
  receiptShapeViolation,
  prepareLlmImage,
  llmMaxEdge,
  bytesToBase64,
} from './anthropic.mjs'

export const ZAI_PROVIDER = 'zai'
export const DEFAULT_ZAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4'
export const DEFAULT_ZAI_MODEL = 'glm-5.3-flash'
// Without an operator LLM_SCAN_MAX_EDGE the Z.AI leg keeps the same 1568px long
// edge the Anthropic leg has always used, so a provider flip alone changes no bytes.
const DEFAULT_TARGET_MAX_EDGE = 1568

class ZaiConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ZaiConfigError'
  }
}

export function zaiModel(env) {
  return (env.LLM_SCAN_MODEL || DEFAULT_ZAI_MODEL).trim() || DEFAULT_ZAI_MODEL
}

function readConfig(env) {
  const key = env.ZAI_API_KEY || ''
  if (!key) {
    throw new ZaiConfigError('ZAI_API_KEY must be configured (wrangler secret)')
  }
  const baseUrl = String(env.LLM_SCAN_BASE_URL || DEFAULT_ZAI_BASE_URL).trim().replace(/\/+$/, '') || DEFAULT_ZAI_BASE_URL
  return { key, model: zaiModel(env), url: `${baseUrl}/chat/completions` }
}

function zaiTargetMaxEdge(env) {
  return llmMaxEdge(env) || DEFAULT_TARGET_MAX_EDGE
}

export const ZAI_RECEIPT_SYSTEM_PROMPT = RECEIPT_JSON_SYSTEM_PROMPT

function httpFailureCode(status) {
  return status === 429 ? 'upstream_rate_limited' : 'upstream_rejected'
}

function businessFailureCode(status, responseText) {
  let code
  try {
    const body = JSON.parse(responseText)
    code = body?.code ?? body?.error?.code
  } catch { /* Keep the status-derived closed classification. */ }
  switch (String(code ?? '')) {
    case '1113': return 'upstream_balance_exhausted'
    case '1303':
    case '1302':
    case '1305': return 'upstream_rate_limited'
    case '1304': return 'upstream_daily_cap'
    case '1308':
    case '1310': return 'upstream_quota_exhausted'
    case '1309': return 'upstream_plan_expired'
    case '1311': return 'upstream_model_unavailable'
    case '1312': return 'upstream_model_busy'
    case '1313': return 'upstream_policy_restricted'
    case '1315': return 'upstream_key_restricted'
    case '1211': return 'upstream_unknown_model'
    case '1212': return 'upstream_model_method_unsupported'
    case '1220': return 'upstream_api_permission_denied'
    case '1210':
    case '1213':
    case '1214':
    case '1215': return 'upstream_request_invalid'
    default: return httpFailureCode(status)
  }
}

function bodyFailureCode(error, signal) {
  if (signal?.aborted) return 'transport_timeout'
  return error?.name === 'SyntaxError' ? 'malformed_output' : 'transport_error'
}

function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('')
  }
  return ''
}

function buildRequestBody({ imageBytes, mediaType, model, thinking }) {
  const body = {
    model,
    temperature: 0,
    max_tokens: LLM_MAX_TOKENS,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: ZAI_RECEIPT_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mediaType};base64,${bytesToBase64(imageBytes)}` } },
          { type: 'text', text: 'Extract this receipt.' },
        ],
      },
    ],
  }
  // The coding-plan endpoint pins thinking 'disabled' (deterministic JSON, the
  // deployed production behavior). The general usage-billed API rejects that
  // thinking syntax with code 1210 on BOTH glm-5.3-flash and glm-5.3-flashx
  // (observed on the wire 2026-09-24); omitting the key there lets each model
  // apply its default reasoning behavior.
  if (thinking) body.thinking = { type: thinking }
  return body
}

function safeUsage(value) {
  if (!value || typeof value !== 'object') return null
  const finiteCount = (number) => Number.isSafeInteger(number) && number >= 0 ? number : null
  const inputTokens = finiteCount(value.prompt_tokens)
  const cachedInputTokens = finiteCount(value.prompt_tokens_details?.cached_tokens) ?? 0
  const outputTokens = finiteCount(value.completion_tokens)
  const totalTokens = finiteCount(value.total_tokens)
  if (inputTokens === null && outputTokens === null && totalTokens === null) return null
  return { inputTokens, cachedInputTokens, outputTokens, totalTokens }
}

// Client-side scan budget: the iOS scanner abandons the visible wait at 90 s
// (r311), so a retry must leave headroom for the response round trip after
// the LLM leg settles.
const CLIENT_SCAN_BUDGET_MS = 90_000
const RETRY_MIN_DEADLINE_MS = 10_000
const RETRY_SAFETY_MARGIN_MS = 5_000

// True only when the operator explicitly opts in via per-environment config.
// Off by default: the deployed request path stays byte-identical until a
// paired bench proves the retry recovers more scans than it costs
// (ai/skills/ocr-perf-loop). Malformed failures are stochastic at temperature
// 0 (ro18 run-1 vs run-2: zero fixture overlap), so one bounded retry is the
// smallest candidate remedy; the bench verdict owns keep-or-revert.
function malformedRetryEnabled(env) {
  return String(env.LLM_SCAN_ZAI_RETRY_MALFORMED ?? '').trim() === '1'
}

// Billed truth across attempts: a scan that needed a retry paid for both
// provider calls, so the reported usage sums every metered attempt. The
// result shape stays frozen — aggregation lives inside the existing usage
// object, no new fields reach the router, cache, or client envelope.
function addUsage(a, b) {
  if (!a) return b
  if (!b) return a
  const sum = (x, y) => (x == null && y == null) ? null : (x ?? 0) + (y ?? 0)
  return {
    inputTokens: sum(a.inputTokens, b.inputTokens),
    cachedInputTokens: sum(a.cachedInputTokens, b.cachedInputTokens),
    outputTokens: sum(a.outputTokens, b.outputTokens),
    totalTokens: sum(a.totalTokens, b.totalTokens),
  }
}

/**
 * @param {ArrayBuffer | Uint8Array} imageBytes
 * @param {string} contentType
 * @param {{ ZAI_API_KEY?: string, LLM_SCAN_MODEL?: string, LLM_SCAN_BASE_URL?: string, LLM_SCAN_MAX_EDGE?: string, LLM_SCAN_ZAI_RETRY_MALFORMED?: string }} env
 * @returns {Promise<{ ok: boolean, httpStatus: number, scanned: unknown, latencyMs: number, model: string, errorBody: string | null, providerStarted: boolean, inputPx: number | null }>}
 */
export async function scanReceiptWithZai(imageBytes, contentType, env) {
  const start = Date.now()
  const model = zaiModel(env)
  let providerStarted = false
  let inputPx = null
  const fail = (httpStatus, errorBody, failureCode = null) => ({
    ok: false, httpStatus, scanned: null, latencyMs: Date.now() - start, model, errorBody, failureCode, providerStarted, inputPx,
    serviceTierRequested: 'not_applicable', serviceTierServed: null,
    structuredOutputValid: failureCode === 'malformed_output' ? false : null,
    usage: null, servedModel: null,
  })
  try {
    const config = readConfig(env)

    const prepared = await prepareLlmImage(imageBytes, contentType, env, zaiTargetMaxEdge(env))
    if (!prepared.ok) return fail(prepared.httpStatus, prepared.reason)
    inputPx = prepared.longEdge

    // One bounded provider attempt. Returns the final-shaped result plus the
    // attempt's metered usage and whether the failure class is retryable.
    const attempt = async (timeoutMs) => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort('timeout'), timeoutMs)
      try {
        // Once fetch is invoked, conservatively account for a paid provider
        // attempt: a transport timeout cannot prove Z.AI did not accept it.
        providerStarted = true
        let res
        try {
          res = await fetch(config.url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${config.key}`,
            },
            body: JSON.stringify(buildRequestBody({
              imageBytes: prepared.imageBytes,
              mediaType: prepared.mediaType,
              model: config.model,
              // Coding-plan deployments keep thinking pinned; the general API
              // omits the key (code 1210 otherwise).
              thinking: config.url.includes('/api/coding/') ? 'disabled' : null,
            })),
            signal: controller.signal,
          })
        } catch (error) {
          return { result: fail(502, null, bodyFailureCode(error, controller.signal)), usage: null, malformed: false }
        }

        if (res.status !== 200) {
          let errorBody = ''
          try {
            errorBody = await res.text()
          } catch { /* The HTTP status still supplies the closed provider code. */ }
          const failureCode = businessFailureCode(res.status, errorBody)
          return { result: fail(res.status, errorBody.slice(0, 500), failureCode), usage: null, malformed: false }
        }

        let body
        try {
          body = await res.json()
        } catch (error) {
          return { result: fail(502, null, bodyFailureCode(error, controller.signal)), usage: null, malformed: false }
        }
        const usage = safeUsage(body.usage)
        const choice = Array.isArray(body?.choices) ? body.choices[0] : null
        // A length stop means the JSON was cut mid-object: never return a partial
        // that happens to parse (a truncated lineItems array looks whole).
        if (choice?.finish_reason === 'length') {
          return { result: fail(502, 'llm_truncated', 'malformed_output'), usage, malformed: true }
        }
        const rawOutput = messageText(choice?.message).trim()
        let scanned
        try { scanned = JSON.parse(rawOutput) } catch {
          return { result: fail(502, 'llm_invalid_json', 'malformed_output'), usage, malformed: true }
        }
        const violation = receiptShapeViolation(scanned)
        if (violation) {
          return { result: fail(502, `llm_schema_violation:${violation}`, 'malformed_output'), usage, malformed: true }
        }
        return {
          result: {
            ok: true, httpStatus: 200, scanned, latencyMs: Date.now() - start, model,
            errorBody: null, failureCode: null, providerStarted, inputPx,
            serviceTierRequested: 'not_applicable', serviceTierServed: null,
            structuredOutputValid: true, usage,
            servedModel: typeof body.model === 'string' ? body.model : null,
          },
          usage, malformed: false,
        }
      } finally {
        clearTimeout(timeout)
      }
    }

    const first = await attempt(LLM_FETCH_TIMEOUT_MS)
    if (!first.malformed) return first.result

    // Retry at most once, only on malformed output, only while the deadline
    // math keeps the whole leg inside the client's 90 s budget. latencies stay
    // whole-leg: Date.now() - start includes both attempts by construction.
    const retryDeadlineMs = CLIENT_SCAN_BUDGET_MS - (Date.now() - start) - RETRY_SAFETY_MARGIN_MS
    if (!malformedRetryEnabled(env) || retryDeadlineMs < RETRY_MIN_DEADLINE_MS) return first.result

    const second = await attempt(Math.min(LLM_FETCH_TIMEOUT_MS, retryDeadlineMs))
    if (!second.result.ok) return second.result
    return { ...second.result, usage: addUsage(first.usage, second.result.usage) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return fail(error instanceof ZaiConfigError ? 503 : 502, message.slice(0, 500))
  }
}
