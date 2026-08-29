// Z.AI (GLM) vision transport for the LLM receipt leg, OpenAI-compatible chat
// completions. Same boundary contract as anthropic.mjs: this module owns only the
// provider call and returns the identical shaped result; router.mjs owns auth,
// caps, cache, envelopes, and monitoring. Errors stay data-shaped so a provider
// failure never escapes as a thrown route exception. Selected by llm-provider.mjs
// when LLM_SCAN_PROVIDER=zai; the default Anthropic path is untouched.

import {
  RECEIPT_SYSTEM_PROMPT,
  LLM_FETCH_TIMEOUT_MS,
  LLM_MAX_TOKENS,
  receiptSchema,
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

// GLM has no strict tool schema, so the prompt spells out the emit_receipt keys
// verbatim from receiptSchema (the same object Anthropic receives as input_schema).
function describeSchema(schema) {
  const type = (s) => (Array.isArray(s.type) ? s.type.join('|') : s.type)
  const field = (name, s) => {
    if (s.enum) return `${name}: one of ${s.enum.join('|')}`
    if (s.type === 'array') return `${name}: array of {${Object.entries(s.items.properties).map(([n, p]) => field(n, p)).join(', ')}}`
    return `${name}: ${type(s)}`
  }
  return Object.entries(schema.properties).map(([name, s]) => field(name, s)).join('; ')
}

const TOOL_INSTRUCTION = 'emit the receipt via the emit_receipt tool with EXACTLY its schema.'
const JSON_INSTRUCTION = `emit ONLY a JSON object with exactly the emit_receipt schema keys (${describeSchema(receiptSchema)}). Every key is required; use null where allowed. No prose, no code fence.`

export const ZAI_RECEIPT_SYSTEM_PROMPT = RECEIPT_SYSTEM_PROMPT.replace(TOOL_INSTRUCTION, JSON_INSTRUCTION)

/**
 * Pull the first JSON object out of a chat completion's text: strips ```json
 * fences and any prose around the braces. Returns null when nothing parses.
 */
export function extractJsonObject(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  const unfenced = text.replace(/```[a-zA-Z]*\n?/g, '')
  const start = unfenced.indexOf('{')
  const end = unfenced.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(unfenced.slice(start, end + 1))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('')
  }
  return ''
}

function buildRequestBody({ imageBytes, mediaType, model }) {
  return {
    model,
    temperature: 0,
    max_tokens: LLM_MAX_TOKENS,
    thinking: { type: 'disabled' },
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
  const fail = (httpStatus, errorBody) => ({
    ok: false, httpStatus, scanned: null, latencyMs: Date.now() - start, model, errorBody, providerStarted, inputPx,
  })
  try {
    const config = readConfig(env)

    const prepared = await prepareLlmImage(imageBytes, contentType, env, zaiTargetMaxEdge(env))
    if (!prepared.ok) return fail(prepared.httpStatus, prepared.reason)
    inputPx = prepared.longEdge

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort('timeout'), LLM_FETCH_TIMEOUT_MS)
    let res
    try {
      // Once fetch is invoked, conservatively account for a paid provider attempt:
      // a transport timeout cannot prove Z.AI did not accept the request.
      providerStarted = true
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
        })),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeout)
    }

    if (res.status !== 200) {
      const errorBody = await res.text().catch(() => '')
      return fail(res.status, errorBody.slice(0, 500))
    }

    const body = await res.json().catch(() => null)
    const choice = Array.isArray(body?.choices) ? body.choices[0] : null
    // A length stop means the JSON was cut mid-object: never return a partial
    // that happens to parse (a truncated lineItems array looks whole).
    if (choice?.finish_reason === 'length') return fail(502, 'llm_truncated')
    const scanned = extractJsonObject(messageText(choice?.message))
    if (!scanned) return fail(502, 'llm_invalid_json')
    const violation = receiptShapeViolation(scanned)
    if (violation) return fail(502, `llm_schema_violation:${violation}`)
    return { ok: true, httpStatus: 200, scanned, latencyMs: Date.now() - start, model, errorBody: null, providerStarted, inputPx }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return fail(error instanceof ZaiConfigError ? 503 : 502, message.slice(0, 500))
  }
}
