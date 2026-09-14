// Optional OpenAI vision leg. The existing router still owns authentication,
// admission, accounting, cache, response selection and public envelopes.
import {
  RECEIPT_JSON_SYSTEM_PROMPT, receiptSchema, receiptShapeViolation,
  prepareLlmImage, bytesToBase64, llmMaxEdge, LLM_FETCH_TIMEOUT_MS, LLM_MAX_TOKENS,
} from './anthropic.mjs'

export const OPENAI_PROVIDER = 'openai'
export const DEFAULT_OPENAI_MODEL = 'gpt-6-astra'

function httpFailureCode(status) {
  return status === 429 ? 'upstream_rate_limited' : 'upstream_rejected'
}

function bodyFailureCode(error, signal) {
  if (signal?.aborted) return 'transport_timeout'
  return error?.name === 'SyntaxError' ? 'malformed_output' : 'transport_error'
}

export function openaiModel(env) {
  return String(env.LLM_SCAN_MODEL || DEFAULT_OPENAI_MODEL).trim() || DEFAULT_OPENAI_MODEL
}

export async function scanReceiptWithOpenAI(imageBytes, contentType, env) {
  const started = Date.now()
  const model = openaiModel(env)
  let providerStarted = false
  let inputPx = null
  const fail = (httpStatus, errorBody, failureCode = null) => ({
    ok: false, httpStatus, scanned: null, model, providerStarted, inputPx,
    latencyMs: Date.now() - started, errorBody, failureCode,
  })
  if (!env.OPENAI_API_KEY) return fail(503, 'OPENAI_API_KEY must be configured (wrangler secret)')
  try {
    const prepared = await prepareLlmImage(imageBytes, contentType, env, llmMaxEdge(env) || 1568)
    if (!prepared.ok) return fail(prepared.httpStatus, prepared.reason)
    inputPx = prepared.longEdge
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort('timeout'), LLM_FETCH_TIMEOUT_MS)
    try {
      providerStarted = true
      let response
      try {
        response = await fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY}` },
          signal: controller.signal,
          body: JSON.stringify({
            model, store: false, reasoning: { effort: 'low' }, max_output_tokens: LLM_MAX_TOKENS,
            instructions: RECEIPT_JSON_SYSTEM_PROMPT,
            input: [{ role: 'user', content: [
              { type: 'input_image', image_url: `data:${prepared.mediaType};base64,${bytesToBase64(prepared.imageBytes)}`, detail: 'high' },
              { type: 'input_text', text: 'Extract this receipt.' },
            ] }],
            text: { format: { type: 'json_schema', name: 'emit_receipt', strict: true, schema: receiptSchema } },
          }),
        })
      } catch (error) {
        return fail(502, null, bodyFailureCode(error, controller.signal))
      }
      if (!response.ok) {
        let errorBody = ''
        let failureCode = httpFailureCode(response.status)
        try {
          errorBody = await response.text()
        } catch { /* The HTTP status still supplies the closed provider code. */ }
        return fail(response.status, errorBody.slice(0, 500), failureCode)
      }
      let body
      try {
        body = await response.json()
      } catch (error) {
        return fail(502, null, bodyFailureCode(error, controller.signal))
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return fail(502, 'llm_invalid_shape', 'malformed_output')
      }
      if (body.status !== 'completed') return fail(502, `llm_incomplete:${body.incomplete_details?.reason || body.status || 'unknown'}`, 'malformed_output')
      const content = Array.isArray(body.output) ? body.output.flatMap(item => Array.isArray(item?.content) ? item.content : []) : []
      if (content.some(item => item?.type === 'refusal')) return fail(502, 'llm_refusal', 'malformed_output')
      const text = content.filter(item => item?.type === 'output_text' && typeof item.text === 'string').map(item => item.text).join('')
      if (!text) return fail(502, 'llm_invalid_shape', 'malformed_output')
      let scanned
      try { scanned = JSON.parse(text) } catch { return fail(502, 'llm_invalid_json', 'malformed_output') }
      const violation = receiptShapeViolation(scanned)
      if (violation) return fail(502, `llm_schema_violation:${violation}`, 'malformed_output')
      return { ok: true, httpStatus: response.status, scanned, model, providerStarted, inputPx, latencyMs: Date.now() - started, errorBody: null, failureCode: null }
    } finally {
      clearTimeout(timeout)
    }
  } catch (error) {
    return fail(502, String(error instanceof Error ? error.message : error).slice(0, 500))
  }
}
