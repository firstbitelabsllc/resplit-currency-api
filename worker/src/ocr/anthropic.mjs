// Anthropic Messages vision transport for /ocr/dual-scan. This module owns only the
// provider call and returns a shaped result; router.mjs owns auth, caps, cache,
// envelopes, and monitoring. Like azure.mjs, errors stay data-shaped at the
// boundary so provider failures never escape as thrown route exceptions.

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_MODEL = 'claude-sonnet-5'
const FETCH_TIMEOUT_MS = 60_000

// Anthropic vision input limits — the exact ceilings the API enforces, sourced
// from the production 400 bodies (Sentry RESPLIT-CURRENCY-API-G/-E/-B):
//   media_type must be one of image/jpeg|png|gif|webp        (…media_type: Input should be…)
//   decoded image bytes must be <= 10 MiB                     (…image exceeds 10 MB maximum: … > 10485760 bytes)
//   neither dimension may exceed 8000 px                      (…image dimensions exceed max allowed size: 8000 pixels)
// Azure DI is more permissive (accepts HEIF, larger files, up to 10000 px), so the
// SAME image passes Azure and 400s the paid Anthropic leg — killing the rescue path.
const SUPPORTED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const ANTHROPIC_MAX_IMAGE_BYTES = 10 * 1024 * 1024 // 10485760
const ANTHROPIC_MAX_IMAGE_DIMENSION = 8000
// Dense receipts (many line items + extras) can exceed a small ceiling and get
// truncated mid tool_use. 4096 gives headroom; a truncated response is still
// caught below via stop_reason and rejected rather than returned as a partial.
const MAX_TOKENS = 4096

// Mirrors receiptSchema.required/enum so a returned tool input is validated
// server-side before we trust it — strict:true guards the happy path, this guards
// against a model/provider that ignores or partially honors the schema.
const EXTRA_KINDS = new Set([
  'tax', 'tip', 'fee', 'serviceCharge', 'mandate', 'surcharge', 'discount', 'credit', 'rounding', 'payment', 'unknown',
])
const REQUIRED_RECEIPT_KEYS = [
  'merchantName', 'merchantAddress', 'transactionDate', 'currencyCode', 'currencySymbol',
  'lineItems', 'subtotal', 'total', 'extras',
]

export const LLM_PROVIDER = 'anthropic'

export const RECEIPT_SYSTEM_PROMPT = 'You are a precise receipt-extraction engine. Read the receipt image and emit the receipt via the emit_receipt tool with EXACTLY its schema. All amounts are JSON numbers. Comma-decimal 12,50 means 12.50. Strip thousands separators (1.234,50 -> 1234.50 and 4,500 -> 4500). No-decimal currencies (JPY/KRW) stay integers. currencyCode is ISO-4217. Put every tax/tip/service-charge/mandate/discount line into extras with the correct kind (an included service charge is serviceCharge, not tip). Negative line items like coupons stay in lineItems with negative amounts. LINE-ITEM GRANULARITY: emit EXACTLY one lineItems entry per printed product line on the receipt — never merge two printed lines into one, and never split one printed line into several. A line printed as "N x unit_price" (or "N @ price") is ONE entry: quantity=N and amount = the line total for that row. Do not create extra entries for quantity multipliers, size/modifier sub-lines, or blank rows. Match the printed line count of purchased items.'

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

// Sniff the true image type from magic bytes. Returns a media_type Anthropic
// accepts, or null when the leading bytes are not one of the supported formats.
// The declared Content-Type is NOT trusted — a client that mislabels a JPEG as
// image/jpg or image/heic (common on iOS) 400s the provider on media_type alone.
function sniffSupportedImageType(b) {
  if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg'
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 &&
      b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A) return 'image/png'
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  return null
}

// Recognize magic bytes for formats Azure tolerates but Anthropic rejects, so a
// genuinely-unsupported image is skipped with a clean reason instead of a wasted
// paid 400. HEIC/HEIF (iPhone default), BMP, TIFF, and PDF all fall here.
function looksLikeUnsupportedImage(b) {
  if (b.length >= 8 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return true // ISOBMFF "ftyp" (HEIC/HEIF/AVIF)
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4D) return true // BMP "BM"
  if (b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2A && b[3] === 0x00) ||
      (b[0] === 0x4D && b[1] === 0x4D && b[2] === 0x00 && b[3] === 0x2A))) return true // TIFF
  if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return true // "%PDF"
  return false
}

const readU16BE = (b, i) => (b[i] << 8) | b[i + 1]
const readU32BE = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0
const readU16LE = (b, i) => b[i] | (b[i + 1] << 8)

// Read pixel dimensions from the container header, WITHOUT decoding the image
// (Workers has no native image decode). Returns { width, height } or null when the
// dimensions can't be read — a null NEVER rejects (fail-open), so a header we can't
// parse degrades to the prior behavior rather than false-rejecting a valid receipt.
function readImageDimensions(b, mediaType) {
  try {
    if (mediaType === 'image/png') {
      // IHDR is the first chunk: 8-byte sig + 4-byte len + "IHDR" then width,height.
      if (b.length < 24) return null
      return { width: readU32BE(b, 16), height: readU32BE(b, 20) }
    }
    if (mediaType === 'image/gif') {
      if (b.length < 10) return null
      return { width: readU16LE(b, 6), height: readU16LE(b, 8) }
    }
    if (mediaType === 'image/jpeg') {
      // Walk marker segments to the Start-Of-Frame (SOFn) that carries dimensions.
      let i = 2 // past SOI (FF D8)
      while (i + 9 < b.length) {
        if (b[i] !== 0xFF) { i++; continue }
        let marker = b[i + 1]
        while (marker === 0xFF && i + 1 < b.length) { i++; marker = b[i + 1] } // skip fill bytes
        // Standalone markers (RST0-7, SOI, EOI, TEM) carry no length payload.
        if ((marker >= 0xD0 && marker <= 0xD9) || marker === 0x01) { i += 2; continue }
        const segLen = readU16BE(b, i + 2)
        if (segLen < 2) return null
        // SOF0-SOF15 hold frame dimensions, EXCEPT DHT(C4), JPGext(C8), DAC(CC).
        const isSof = marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC
        if (isSof) {
          if (i + 8 >= b.length) return null
          return { height: readU16BE(b, i + 5), width: readU16BE(b, i + 7) }
        }
        i += 2 + segLen
      }
      return null
    }
    // WEBP dimensions live in three sub-format-specific bit layouts (VP8/VP8L/VP8X);
    // the packed bit-parse is fragile and WEBP receipts are near-nonexistent on iOS,
    // so we fail-open here (still sniffed + byte-size-checked) rather than risk a
    // false-reject that would kill a valid scan. An oversize WEBP 400s at Anthropic
    // exactly as it did before — no regression, just no new dimension guard.
  } catch {
    return null
  }
  return null
}

const normalizeMediaType = (value) => String(value || '').split(';')[0].trim().toLowerCase()

/**
 * Resolve the media_type to declare to Anthropic and validate the image against
 * Anthropic's input limits BEFORE the paid call. Byte-sniffing wins over the
 * declared Content-Type (fixing the media_type 400); a genuinely-unsupported or
 * oversize image is rejected with a machine-readable reason so the caller skips a
 * guaranteed 400 and Sentry groups the cause cleanly.
 *
 * @param {ArrayBuffer | Uint8Array} imageBytes
 * @param {string} declaredContentType
 * @returns {{ ok: true, mediaType: string } | { ok: false, reason: 'llm_unsupported_media' | 'llm_image_too_large' | 'llm_image_dimensions' }}
 */
export function resolveAnthropicImage(imageBytes, declaredContentType) {
  const b = imageBytes instanceof Uint8Array ? imageBytes : new Uint8Array(imageBytes)

  const sniffed = sniffSupportedImageType(b)
  let mediaType
  if (sniffed) {
    mediaType = sniffed
  } else if (looksLikeUnsupportedImage(b)) {
    return { ok: false, reason: 'llm_unsupported_media' }
  } else {
    // Unidentifiable bytes: defer to the declared type IF it is supported (prior
    // behavior — a valid supported image always carries identifiable magic, so this
    // only catches bytes we can't fingerprint), otherwise reject rather than 400.
    const declared = normalizeMediaType(declaredContentType)
    if (SUPPORTED_MEDIA_TYPES.has(declared)) mediaType = declared
    else return { ok: false, reason: 'llm_unsupported_media' }
  }

  if (b.byteLength > ANTHROPIC_MAX_IMAGE_BYTES) return { ok: false, reason: 'llm_image_too_large' }

  const dims = readImageDimensions(b, mediaType)
  if (dims && (dims.width > ANTHROPIC_MAX_IMAGE_DIMENSION || dims.height > ANTHROPIC_MAX_IMAGE_DIMENSION)) {
    return { ok: false, reason: 'llm_image_dimensions' }
  }

  return { ok: true, mediaType }
}

function buildRequestBody({ imageBytes, mediaType, model }) {
  return {
    model,
    max_tokens: MAX_TOKENS,
    system: RECEIPT_SYSTEM_PROMPT,
    tools: [
      {
        name: 'emit_receipt',
        description: 'Emit the extracted receipt fields.',
        // Anthropic strict tool use (supported on claude-sonnet-5, the deployed
        // model): input_schema already has additionalProperties:false + full
        // required arrays on every object, so the model's tool_use.input is
        // guaranteed to validate against the schema. Server-side validation below
        // is the backstop for any model/provider that ignores strict.
        strict: true,
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
              media_type: mediaType,
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

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v)
const isNumberOrNull = (v) => v === null || isNumber(v)
const isStringOrNull = (v) => v === null || typeof v === 'string'

// Validate the model's tool input against receiptSchema server-side. Returns a
// short violation code on mismatch (amount as a string, missing key, bad extras
// kind, …), or null when the shape is sound. Never trust the LLM's shape blindly.
export function receiptShapeViolation(scanned) {
  if (!scanned || typeof scanned !== 'object' || Array.isArray(scanned)) return 'not_object'
  for (const key of REQUIRED_RECEIPT_KEYS) {
    if (!(key in scanned)) return `missing:${key}`
  }
  if (!isStringOrNull(scanned.merchantName)) return 'merchantName'
  if (!isStringOrNull(scanned.merchantAddress)) return 'merchantAddress'
  if (!isStringOrNull(scanned.transactionDate)) return 'transactionDate'
  if (!isStringOrNull(scanned.currencyCode)) return 'currencyCode'
  if (!isStringOrNull(scanned.currencySymbol)) return 'currencySymbol'
  if (!isNumberOrNull(scanned.subtotal)) return 'subtotal'
  if (!isNumberOrNull(scanned.total)) return 'total'

  if (!Array.isArray(scanned.lineItems)) return 'lineItems'
  for (const item of scanned.lineItems) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return 'lineItem'
    if (typeof item.name !== 'string') return 'lineItem.name'
    if (!isNumberOrNull(item.amount)) return 'lineItem.amount'
    if (!isNumberOrNull(item.quantity)) return 'lineItem.quantity'
  }

  if (!Array.isArray(scanned.extras)) return 'extras'
  for (const extra of scanned.extras) {
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return 'extra'
    if (typeof extra.label !== 'string') return 'extra.label'
    if (!isNumber(extra.amount)) return 'extra.amount'
    if (!EXTRA_KINDS.has(extra.kind)) return 'extra.kind'
  }

  return null
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

    // Normalize/validate the image at the boundary BEFORE spending the paid call.
    // A mislabeled-but-supported image gets its media_type corrected; a genuinely
    // unsupported or oversize image is rejected here so we never fire a request
    // Anthropic is guaranteed to 400 (Sentry RESPLIT-CURRENCY-API-G/-E/-B). The
    // reason is machine-readable so the router's Sentry capture groups it cleanly.
    const image = resolveAnthropicImage(imageBytes, contentType)
    if (!image.ok) {
      const httpStatus = image.reason === 'llm_unsupported_media' ? 415 : 413
      return { ok: false, httpStatus, scanned: null, latencyMs: Date.now() - start, model, errorBody: image.reason }
    }

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
        body: JSON.stringify(buildRequestBody({ imageBytes, mediaType: image.mediaType, model })),
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
    // A max_tokens stop means the tool_use was truncated: the emitted receipt is a
    // partial (missing line items, cut-off amounts). Never return it as a success —
    // a partial that looks whole is worse than an explicit failure the caller retries.
    if (body?.stop_reason === 'max_tokens') {
      return { ok: false, httpStatus: 502, scanned: null, latencyMs: Date.now() - start, model, errorBody: 'llm_truncated' }
    }
    const scanned = toolInputFromMessagesBody(body)
    if (!scanned) {
      return { ok: false, httpStatus: 502, scanned: null, latencyMs: Date.now() - start, model, errorBody: 'missing emit_receipt tool_use' }
    }
    const violation = receiptShapeViolation(scanned)
    if (violation) {
      return { ok: false, httpStatus: 502, scanned: null, latencyMs: Date.now() - start, model, errorBody: `llm_schema_violation:${violation}` }
    }
    return { ok: true, httpStatus: 200, scanned, latencyMs: Date.now() - start, model, errorBody: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const httpStatus = error instanceof AnthropicConfigError ? 503 : 502
    return { ok: false, httpStatus, scanned: null, latencyMs: Date.now() - start, model, errorBody: message.slice(0, 500) }
  }
}
