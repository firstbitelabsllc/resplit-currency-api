// Anthropic Messages vision transport for /ocr/dual-scan. This module owns only the
// provider call and returns a shaped result; router.mjs owns auth, caps, cache,
// envelopes, and monitoring. Like azure.mjs, errors stay data-shaped at the
// boundary so provider failures never escape as thrown route exceptions.

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_MODEL = 'claude-sonnet-5'
const FETCH_TIMEOUT_MS = 60_000

export const LLM_PROVIDER = 'anthropic'

export const RECEIPT_SYSTEM_PROMPT = 'You are a precise receipt-extraction engine. Read the receipt image and emit the receipt via the emit_receipt tool with EXACTLY its schema. All amounts are JSON numbers. Comma-decimal 12,50 means 12.50. Strip thousands separators (1.234,50 -> 1234.50 and 4,500 -> 4500). No-decimal currencies (JPY/KRW) stay integers. currencyCode is ISO-4217. Put every tax/tip/service-charge/mandate/discount line into extras with the correct kind (an included service charge is serviceCharge, not tip). Negative line items like coupons stay in lineItems with negative amounts.'

class AnthropicConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AnthropicConfigError'
  }
}

function readConfig(env) {
  const key = env.ANTHROPIC_API_KEY || ''
  const model = (env.LLM_SCAN_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL
  if (!key) {
    throw new AnthropicConfigError('ANTHROPIC_API_KEY must be configured (wrangler secret)')
  }
  return { key, model }
}

const receiptSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    merchantName: { type: ['string', 'null'] },
    merchantAddress: { type: ['string', 'null'] },
    transactionDate: { type: ['string', 'null'] },
    currencyCode: { type: ['string', 'null'] },
    currencySymbol: { type: ['string', 'null'] },
    lineItems: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          amount: { type: ['number', 'null'] },
          quantity: { type: ['number', 'null'] },
        },
        required: ['name', 'amount', 'quantity'],
      },
    },
    subtotal: { type: ['number', 'null'] },
    total: { type: ['number', 'null'] },
    extras: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string' },
          amount: { type: 'number' },
          kind: {
            type: 'string',
            enum: ['tax', 'tip', 'fee', 'serviceCharge', 'mandate', 'surcharge', 'discount', 'credit', 'rounding', 'payment', 'unknown'],
          },
        },
        required: ['label', 'amount', 'kind'],
      },
    },
  },
  required: [
    'merchantName',
    'merchantAddress',
    'transactionDate',
    'currencyCode',
    'currencySymbol',
    'lineItems',
    'subtotal',
    'total',
    'extras',
  ],
}

function bytesToBase64(imageBytes) {
  const bytes = imageBytes instanceof Uint8Array ? imageBytes : new Uint8Array(imageBytes)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

function buildRequestBody({ imageBytes, contentType, model }) {
  return {
    model,
    max_tokens: 2048,
    system: RECEIPT_SYSTEM_PROMPT,
    tools: [
      {
        name: 'emit_receipt',
        description: 'Emit the extracted receipt fields.',
        input_schema: receiptSchema,
      },
    ],
    tool_choice: { type: 'tool', name: 'emit_receipt' },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: contentType || 'image/jpeg',
              data: bytesToBase64(imageBytes),
            },
          },
          {
            type: 'text',
            text: 'Extract this receipt and call emit_receipt.',
          },
        ],
      },
    ],
  }
}

function toolInputFromMessagesBody(body) {
  const content = Array.isArray(body?.content) ? body.content : []
  const toolUse = content.find((part) => part?.type === 'tool_use' && part?.name === 'emit_receipt')
  return toolUse?.input ?? null
}

/**
 * @param {ArrayBuffer | Uint8Array} imageBytes
 * @param {string} contentType
 * @param {{ ANTHROPIC_API_KEY?: string, LLM_SCAN_MODEL?: string }} env
 * @returns {Promise<{ ok: boolean, httpStatus: number, scanned: unknown, latencyMs: number, model: string, errorBody: string | null }>}
 */
export async function scanReceiptWithAnthropic(imageBytes, contentType, env) {
  const start = Date.now()
  let model = (env.LLM_SCAN_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL
  try {
    const config = readConfig(env)
    model = config.model
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort('timeout'), FETCH_TIMEOUT_MS)
    let res
    try {
      res = await fetch(ANTHROPIC_MESSAGES_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.key,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(buildRequestBody({ imageBytes, contentType, model })),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeout)
    }

    if (res.status !== 200) {
      const errorBody = await res.text().catch(() => '')
      return { ok: false, httpStatus: res.status, scanned: null, latencyMs: Date.now() - start, model, errorBody: errorBody.slice(0, 500) }
    }

    const body = await res.json().catch(() => null)
    const scanned = toolInputFromMessagesBody(body)
    if (!scanned) {
      return { ok: false, httpStatus: 502, scanned: null, latencyMs: Date.now() - start, model, errorBody: 'missing emit_receipt tool_use' }
    }
    return { ok: true, httpStatus: 200, scanned, latencyMs: Date.now() - start, model, errorBody: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const httpStatus = error instanceof AnthropicConfigError ? 503 : 502
    return { ok: false, httpStatus, scanned: null, latencyMs: Date.now() - start, model, errorBody: message.slice(0, 500) }
  }
}
