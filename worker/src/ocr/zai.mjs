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

/**
 * @param {ArrayBuffer | Uint8Array} imageBytes
 * @param {string} contentType
 * @param {{ ZAI_API_KEY?: string, LLM_SCAN_MODEL?: string, LLM_SCAN_BASE_URL?: string, LLM_SCAN_MAX_EDGE?: string }} env
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

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort('timeout'), LLM_FETCH_TIMEOUT_MS)
    try {
      // Once fetch is invoked, conservatively account for a paid provider attempt:
      // a transport timeout cannot prove Z.AI did not accept the request.
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
        return fail(502, null, bodyFailureCode(error, controller.signal))
      }

      if (res.status !== 200) {
        let errorBody = ''
        try {
          errorBody = await res.text()
        } catch { /* The HTTP status still supplies the closed provider code. */ }
        const failureCode = businessFailureCode(res.status, errorBody)
        return fail(res.status, errorBody.slice(0, 500), failureCode)
      }

      let body
      try {
        body = await res.json()
      } catch (error) {
        return fail(502, null, bodyFailureCode(error, controller.signal))
      }
      const choice = Array.isArray(body?.choices) ? body.choices[0] : null
      // A length stop means the JSON was cut mid-object: never return a partial
      // that happens to parse (a truncated lineItems array looks whole).
      if (choice?.finish_reason === 'length') return fail(502, 'llm_truncated', 'malformed_output')
      const rawOutput = messageText(choice?.message).trim()
      let scanned
      try { scanned = JSON.parse(rawOutput) } catch { return fail(502, 'llm_invalid_json', 'malformed_output') }
      const violation = receiptShapeViolation(scanned)
      if (violation) return fail(502, `llm_schema_violation:${violation}`, 'malformed_output')
      return {
        ok: true, httpStatus: 200, scanned, latencyMs: Date.now() - start, model,
        errorBody: null, failureCode: null, providerStarted, inputPx,
        serviceTierRequested: 'not_applicable', serviceTierServed: null,
        structuredOutputValid: true, usage: safeUsage(body.usage),
        servedModel: typeof body.model === 'string' ? body.model : null,
      }
    } finally {
      clearTimeout(timeout)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return fail(error instanceof ZaiConfigError ? 503 : 502, message.slice(0, 500))
  }
}
