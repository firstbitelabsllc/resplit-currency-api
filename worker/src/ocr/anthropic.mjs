// Anthropic Messages vision transport for /ocr/dual-scan. This module owns only the
// provider call and returns a shaped result; router.mjs owns auth, caps, cache,
// envelopes, and monitoring. Like azure.mjs, errors stay data-shaped at the
// boundary so provider failures never escape as thrown route exceptions.

import { PhotonImage, SamplingFilter, fliph, flipv, resize } from '@cf-wasm/photon'

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
// Anthropic's vision docs recommend keeping both axes at or below 1568px to
// avoid server-side downscaling and its latency/token penalty. Azure still gets
// the original bytes; this ceiling applies only inside the LLM transport.
const ANTHROPIC_TARGET_MAX_IMAGE_DIMENSION = 1568
// ReceiptImagePreprocessor caps the canonical iOS upload at a 4032px long edge.
// A real remote Worker transforms 4032x3024 inside the 128 MiB isolate, while a
// near-square 3800x3800 decode does not. Gate at the proven envelope before
// Photon so large/crafted inputs fail only the optional LLM leg deterministically.
const PHOTON_MAX_SOURCE_PIXELS = 4032 * 3024
const PHOTON_JPEG_QUALITY = 90
const IMAGE_TRANSFORM_ERROR = 'llm_image_transform_failed'
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
const readU32LE = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0
const readU24LE = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)

function readJpegExifOrientation(b) {
  if (b.length < 4 || b[0] !== 0xFF || b[1] !== 0xD8) return 1
  let markerOffset = 2
  while (markerOffset + 4 <= b.length) {
    if (b[markerOffset] !== 0xFF) {
      markerOffset += 1
      continue
    }
    let marker = b[markerOffset + 1]
    while (marker === 0xFF && markerOffset + 2 < b.length) {
      markerOffset += 1
      marker = b[markerOffset + 1]
    }
    if (marker === 0xDA || marker === 0xD9) break // SOS/EOI: metadata is complete.
    if ((marker >= 0xD0 && marker <= 0xD8) || marker === 0x01) {
      markerOffset += 2
      continue
    }

    const segmentLength = readU16BE(b, markerOffset + 2)
    const segmentEnd = markerOffset + 2 + segmentLength
    if (segmentLength < 2 || segmentEnd > b.length) break
    const payloadOffset = markerOffset + 4
    if (
      marker === 0xE1 &&
      payloadOffset + 14 <= segmentEnd &&
      b[payloadOffset] === 0x45 && b[payloadOffset + 1] === 0x78 &&
      b[payloadOffset + 2] === 0x69 && b[payloadOffset + 3] === 0x66 &&
      b[payloadOffset + 4] === 0 && b[payloadOffset + 5] === 0
    ) {
      const tiffOffset = payloadOffset + 6
      const littleEndian = b[tiffOffset] === 0x49 && b[tiffOffset + 1] === 0x49
      const bigEndian = b[tiffOffset] === 0x4D && b[tiffOffset + 1] === 0x4D
      if (littleEndian || bigEndian) {
        const read16 = littleEndian ? readU16LE : readU16BE
        const read32 = littleEndian ? readU32LE : readU32BE
        if (read16(b, tiffOffset + 2) === 42) {
          const ifdOffset = tiffOffset + read32(b, tiffOffset + 4)
          if (ifdOffset + 2 <= segmentEnd) {
            const entryCount = read16(b, ifdOffset)
            const entriesOffset = ifdOffset + 2
            const boundedEntryCount = Math.min(entryCount, Math.floor((segmentEnd - entriesOffset) / 12))
            for (let entryIndex = 0; entryIndex < boundedEntryCount; entryIndex += 1) {
              const entryOffset = entriesOffset + entryIndex * 12
              if (
                read16(b, entryOffset) === 0x0112 &&
                read16(b, entryOffset + 2) === 3 &&
                read32(b, entryOffset + 4) === 1
              ) {
                const orientation = read16(b, entryOffset + 8)
                return orientation >= 1 && orientation <= 8 ? orientation : 1
              }
            }
          }
        }
      }
    }
    markerOffset = segmentEnd
  }
  return 1
}

// Read pixel dimensions from the container header, WITHOUT decoding the image.
// Returns { width, height } or null when the dimensions cannot be read locally;
// a sniffed supported image with no trustworthy dimensions is rejected before
// Photon so compressed input cannot bypass the bounded-decode contract.
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
    if (mediaType === 'image/webp') {
      // WEBP's first payload chunk is one of VP8X (extended), VP8L (lossless),
      // or VP8 (lossy). Reading the canvas here keeps the 128 MiB Photon guard
      // ahead of decode rather than trusting compressed input size.
      if (b.length < 21) return null
      const c0 = b[12]
      const c1 = b[13]
      const c2 = b[14]
      const c3 = b[15]
      if (c0 === 0x56 && c1 === 0x50 && c2 === 0x38 && c3 === 0x58) { // VP8X
        if (b.length < 30 || readU32LE(b, 16) < 10) return null
        return { width: readU24LE(b, 24) + 1, height: readU24LE(b, 27) + 1 }
      }
      if (c0 === 0x56 && c1 === 0x50 && c2 === 0x38 && c3 === 0x4C) { // VP8L
        if (b.length < 25 || b[20] !== 0x2F) return null
        return {
          width: 1 + b[21] + ((b[22] & 0x3F) << 8),
          height: 1 + (b[22] >> 6) + (b[23] << 2) + ((b[24] & 0x0F) << 10),
        }
      }
      if (c0 === 0x56 && c1 === 0x50 && c2 === 0x38 && c3 === 0x20) { // "VP8 "
        if (b.length < 30 || b[23] !== 0x9D || b[24] !== 0x01 || b[25] !== 0x2A) return null
        return { width: readU16LE(b, 26) & 0x3FFF, height: readU16LE(b, 28) & 0x3FFF }
      }
    }
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

function hasValidDimensions(dimensions) {
  return Number.isFinite(dimensions?.width) && dimensions.width > 0 &&
    Number.isFinite(dimensions?.height) && dimensions.height > 0
}

function boundedTargetDimensions(dimensions) {
  const scale = Math.min(
    1,
    ANTHROPIC_TARGET_MAX_IMAGE_DIMENSION / Math.max(dimensions.width, dimensions.height),
  )
  return {
    width: Math.max(1, Math.round(dimensions.width * scale)),
    height: Math.max(1, Math.round(dimensions.height * scale)),
  }
}

function applyExifOrientation(image, orientation) {
  if (orientation === 1) return image

  if (orientation === 2) {
    fliph(image)
    return image
  }
  if (orientation === 3) {
    fliph(image)
    flipv(image)
    return image
  }
  if (orientation === 4) {
    flipv(image)
    return image
  }

  const sourceWidth = image.get_width()
  const sourceHeight = image.get_height()
  const sourcePixels = image.get_raw_pixels()
  if (sourcePixels.length !== sourceWidth * sourceHeight * 4) {
    throw new Error('decoded image pixels violate the RGBA contract')
  }

  const outputWidth = sourceHeight
  const outputHeight = sourceWidth
  const outputPixels = new Uint8Array(sourcePixels.length)

  for (let sourceY = 0; sourceY < sourceHeight; sourceY++) {
    for (let sourceX = 0; sourceX < sourceWidth; sourceX++) {
      let outputX
      let outputY
      switch (orientation) {
        case 5:
          outputX = sourceY
          outputY = sourceX
          break
        case 6:
          outputX = sourceHeight - 1 - sourceY
          outputY = sourceX
          break
        case 7:
          outputX = sourceHeight - 1 - sourceY
          outputY = sourceWidth - 1 - sourceX
          break
        case 8:
          outputX = sourceY
          outputY = sourceWidth - 1 - sourceX
          break
        default:
          throw new Error('decoded image orientation violates the EXIF contract')
      }

      const sourceOffset = (sourceY * sourceWidth + sourceX) * 4
      const outputOffset = (outputY * outputWidth + outputX) * 4
      outputPixels[outputOffset] = sourcePixels[sourceOffset]
      outputPixels[outputOffset + 1] = sourcePixels[sourceOffset + 1]
      outputPixels[outputOffset + 2] = sourcePixels[sourceOffset + 2]
      outputPixels[outputOffset + 3] = sourcePixels[sourceOffset + 3]
    }
  }

  return new PhotonImage(outputPixels, outputWidth, outputHeight)
}

function resizeImageWithPhoton(imageBytes, options) {
  const bytes = imageBytes instanceof Uint8Array ? imageBytes : new Uint8Array(imageBytes)
  let inputImage
  let workingImage
  try {
    inputImage = PhotonImage.new_from_byteslice(bytes)
    const decodedWidth = inputImage.get_width()
    const decodedHeight = inputImage.get_height()
    if (
      decodedWidth !== options.sourceWidth ||
      decodedHeight !== options.sourceHeight ||
      decodedWidth * decodedHeight > PHOTON_MAX_SOURCE_PIXELS
    ) {
      throw new Error('decoded image dimensions violate the bounded source contract')
    }
    // Resize while the source remains in its raw JPEG orientation, then release
    // the large source before materializing any rotation. Applying EXIF on the
    // small image keeps the peak below the proven 128 MiB Worker envelope.
    workingImage = resize(inputImage, options.width, options.height, SamplingFilter.Lanczos3)
    inputImage.free()
    inputImage = undefined

    const orientedImage = applyExifOrientation(workingImage, options.orientation)
    if (orientedImage !== workingImage) {
      workingImage.free()
      workingImage = orientedImage
    }
    return workingImage.get_bytes_jpeg(options.quality)
  } finally {
    workingImage?.free()
    inputImage?.free()
  }
}

/**
 * Bound only the Anthropic leg to a 1568px long edge. Dimensions come from the
 * JPEG/PNG/GIF/WebP container before any decode, so a small image passes
 * byte-identically and a compressed decompression bomb fails before Photon.
 *
 * Photon runs as pinned Wasm inside the Worker and returns JPEG because receipt
 * photos are opaque and Anthropic needs one truthful media type after encoding.
 * The output is independently sniffed and dimension-checked before it can reach
 * the paid provider; decode/resize failures stay a data-shaped LLM-leg failure.
 */
async function prepareAnthropicImage(imageBytes, mediaType, env) {
  const bytes = imageBytes instanceof Uint8Array ? imageBytes : new Uint8Array(imageBytes)
  const dimensions = readImageDimensions(bytes, mediaType)
  const orientation = mediaType === 'image/jpeg' ? readJpegExifOrientation(bytes) : 1
  // Photon does not expose a bounded animated-GIF decode contract. Reject that
  // optional LLM leg rather than trusting the logical-screen header while a
  // frame descriptor or cumulative animation payload can allocate more.
  if (mediaType === 'image/gif' || !hasValidDimensions(dimensions)) {
    return { ok: false, reason: IMAGE_TRANSFORM_ERROR }
  }

  const needsTransform = orientation !== 1 ||
    Math.max(dimensions.width, dimensions.height) > ANTHROPIC_TARGET_MAX_IMAGE_DIMENSION
  if (!needsTransform) return { ok: true, imageBytes: bytes, mediaType }
  if (dimensions.width * dimensions.height > PHOTON_MAX_SOURCE_PIXELS) {
    return { ok: false, reason: IMAGE_TRANSFORM_ERROR }
  }

  try {
    const target = boundedTargetDimensions(dimensions)
    const imageResizer = typeof env.__TEST_LLM_IMAGE_RESIZER === 'function'
      ? env.__TEST_LLM_IMAGE_RESIZER
      : resizeImageWithPhoton
    const transformed = new Uint8Array(await imageResizer(bytes, {
      sourceWidth: dimensions.width,
      sourceHeight: dimensions.height,
      width: target.width,
      height: target.height,
      quality: PHOTON_JPEG_QUALITY,
      orientation,
    }))
    const transformedType = sniffSupportedImageType(transformed)
    const transformedDimensions = readImageDimensions(transformed, transformedType)
    if (
      transformedType !== 'image/jpeg' ||
      transformed.byteLength === 0 ||
      transformed.byteLength > ANTHROPIC_MAX_IMAGE_BYTES ||
      !hasValidDimensions(transformedDimensions) ||
      Math.max(transformedDimensions.width, transformedDimensions.height) > ANTHROPIC_TARGET_MAX_IMAGE_DIMENSION
    ) {
      return { ok: false, reason: IMAGE_TRANSFORM_ERROR }
    }

    return { ok: true, imageBytes: transformed, mediaType: 'image/jpeg' }
  } catch {
    return { ok: false, reason: IMAGE_TRANSFORM_ERROR }
  }
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
 * @returns {Promise<{ ok: boolean, httpStatus: number, scanned: unknown, latencyMs: number, model: string, errorBody: string | null, providerStarted: boolean }>}
 */
export async function scanReceiptWithAnthropic(imageBytes, contentType, env) {
  const start = Date.now()
  let model = (env.LLM_SCAN_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL
  let providerStarted = false
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
      return { ok: false, httpStatus, scanned: null, latencyMs: Date.now() - start, model, errorBody: image.reason, providerStarted }
    }

    const prepared = await prepareAnthropicImage(imageBytes, image.mediaType, env)
    if (!prepared.ok) {
      return {
        ok: false,
        httpStatus: 502,
        scanned: null,
        latencyMs: Date.now() - start,
        model,
        errorBody: IMAGE_TRANSFORM_ERROR,
        providerStarted,
      }
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort('timeout'), FETCH_TIMEOUT_MS)
    let res
    try {
      // Once fetch is invoked, conservatively account for a paid provider attempt:
      // a transport timeout cannot prove Anthropic did not accept the request.
      providerStarted = true
      res = await fetch(ANTHROPIC_MESSAGES_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.key,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(buildRequestBody({
          imageBytes: prepared.imageBytes,
          mediaType: prepared.mediaType,
          model,
        })),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeout)
    }

    if (res.status !== 200) {
      const errorBody = await res.text().catch(() => '')
      return { ok: false, httpStatus: res.status, scanned: null, latencyMs: Date.now() - start, model, errorBody: errorBody.slice(0, 500), providerStarted }
    }

    const body = await res.json().catch(() => null)
    // A max_tokens stop means the tool_use was truncated: the emitted receipt is a
    // partial (missing line items, cut-off amounts). Never return it as a success —
    // a partial that looks whole is worse than an explicit failure the caller retries.
    if (body?.stop_reason === 'max_tokens') {
      return { ok: false, httpStatus: 502, scanned: null, latencyMs: Date.now() - start, model, errorBody: 'llm_truncated', providerStarted }
    }
    const scanned = toolInputFromMessagesBody(body)
    if (!scanned) {
      return { ok: false, httpStatus: 502, scanned: null, latencyMs: Date.now() - start, model, errorBody: 'missing emit_receipt tool_use', providerStarted }
    }
    const violation = receiptShapeViolation(scanned)
    if (violation) {
      return { ok: false, httpStatus: 502, scanned: null, latencyMs: Date.now() - start, model, errorBody: `llm_schema_violation:${violation}`, providerStarted }
    }
    return { ok: true, httpStatus: 200, scanned, latencyMs: Date.now() - start, model, errorBody: null, providerStarted }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const httpStatus = error instanceof AnthropicConfigError ? 503 : 502
    return { ok: false, httpStatus, scanned: null, latencyMs: Date.now() - start, model, errorBody: message.slice(0, 500), providerStarted }
  }
}
