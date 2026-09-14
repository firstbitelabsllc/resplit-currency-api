// Optional OpenAI vision leg. The existing router still owns authentication,
// admission, accounting, cache, response selection and public envelopes.
import {
  RECEIPT_JSON_SYSTEM_PROMPT, receiptSchema, receiptShapeViolation,
  prepareLlmImage, bytesToBase64, llmMaxEdge, LLM_FETCH_TIMEOUT_MS, LLM_MAX_TOKENS,
} from './anthropic.mjs'

export const OPENAI_PROVIDER = 'openai'
export const DEFAULT_OPENAI_MODEL = 'gpt-6-astra'

export function openaiModel(env) {
  return String(env.LLM_SCAN_MODEL || DEFAULT_OPENAI_MODEL).trim() || DEFAULT_OPENAI_MODEL
}

export async function scanReceiptWithOpenAI(imageBytes, contentType, env) {
  const started = Date.now()
  const model = openaiModel(env)
  let providerStarted = false
  let inputPx = null
  const fail = (httpStatus, errorBody) => ({
    ok: false, httpStatus, scanned: null, model, providerStarted, inputPx,
    latencyMs: Date.now() - started, errorBody,
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
      const response = await fetch('https://api.openai.com/v1/responses', {
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
      if (!response.ok) return fail(response.status, (await response.text()).slice(0, 500))
      const body = await response.json()
      if (body.status !== 'completed') return fail(502, `llm_incomplete:${body.incomplete_details?.reason || body.status || 'unknown'}`)
      const content = (body.output || []).flatMap(item => item.content || [])
      if (content.some(item => item.type === 'refusal')) return fail(502, 'llm_refusal')
      const text = content.filter(item => item.type === 'output_text').map(item => item.text).join('')
      let scanned
      try { scanned = JSON.parse(text) } catch { return fail(502, 'llm_invalid_json') }
      const violation = receiptShapeViolation(scanned)
      if (violation) return fail(502, `llm_schema_violation:${violation}`)
      return { ok: true, httpStatus: response.status, scanned, model, providerStarted, inputPx, latencyMs: Date.now() - started, errorBody: null }
    } finally {
      clearTimeout(timeout)
    }
  } catch (error) {
    return fail(502, String(error instanceof Error ? error.message : error).slice(0, 500))
  }
}
