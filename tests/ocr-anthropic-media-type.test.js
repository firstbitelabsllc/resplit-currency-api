import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { scanReceiptWithAnthropic, resolveAnthropicImage } from '../worker/src/ocr/anthropic.mjs'

// Regression coverage for the /ocr/dual-scan Anthropic (paid) leg 400s that killed
// the LLM rescue path in production (Sentry RESPLIT-CURRENCY-API-G / -E / -B). The
// worker forwarded the caller's declared Content-Type verbatim as Anthropic's
// image.source.media_type and never bounded image size/dimensions, so images Azure
// tolerates (HEIC, >10 MiB, >8000 px) 400'd the Anthropic leg. Azure is the more
// permissive engine, so the SAME image passed Azure and failed the rescue leg.
//
// These tests assert the boundary is now normalized/validated BEFORE the paid call:
//  - a supported image with a wrong declared type has media_type corrected (rescue works)
//  - a genuinely unsupported image (HEIC) is skipped with a clean machine reason (no wasted 400)
//  - an oversize image (bytes / dimensions) is skipped with a clean machine reason

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const realFetch = globalThis.fetch

let lastBody
let fetchCalls
beforeEach(() => { lastBody = null; fetchCalls = 0 })
afterEach(() => { globalThis.fetch = realFetch })

function scannedReceipt(overrides = {}) {
  return {
    merchantName: 'Cafe Test',
    merchantAddress: null,
    transactionDate: '2026-07-05',
    currencyCode: 'USD',
    currencySymbol: '$',
    lineItems: [{ name: 'Coffee', amount: 9, quantity: 1 }],
    subtotal: 9,
    total: 10,
    extras: [{ label: 'Tax', amount: 1, kind: 'tax' }],
    ...overrides,
  }
}

function anthropicToolResponse(input) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    content: [{ type: 'tool_use', id: 'toolu_test', name: 'emit_receipt', input }],
    stop_reason: 'tool_use',
  }
}

// Stub that MIRRORS Anthropic's real media_type validation, so a test faithfully
// reproduces the prod 400 when an unsupported media_type reaches the provider.
const SUPPORTED = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
function stubAnthropic({ scanned = scannedReceipt() } = {}) {
  globalThis.fetch = async (url, init = {}) => {
    fetchCalls++
    assert.equal(String(url), ANTHROPIC_URL)
    lastBody = JSON.parse(init.body)
    const src = lastBody.messages[0].content[0].source
    if (!SUPPORTED.includes(src.media_type)) {
      return Response.json({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: "messages.0.content.0.image.source.base64.media_type: Input should be 'image/jpeg', 'image/png', 'image/gif' or 'image/webp'",
        },
        request_id: 'req_test',
      }, { status: 400 })
    }
    return Response.json(anthropicToolResponse(scanned), { status: 200 })
  }
}

const env = () => ({ ANTHROPIC_API_KEY: 'anthropic-key', LLM_SCAN_MODEL: 'claude-sonnet-5' })

// --- Fixture byte builders (real magic numbers) --------------------------------
// A minimal JPEG: SOI + APP0/JFIF header, no SOF (so no readable dimensions).
function jpegBytes(padTo = 0) {
  const head = [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00]
  const out = padTo > head.length ? new Uint8Array(padTo) : new Uint8Array(head.length)
  out.set(head, 0)
  return out
}
// A JPEG carrying a SOF0 frame header that declares width/height.
function jpegWithDimensions(width, height) {
  return new Uint8Array([
    0xFF, 0xD8,             // SOI
    0xFF, 0xC0,             // SOF0
    0x00, 0x11,             // segment length (17)
    0x08,                   // precision
    (height >> 8) & 0xFF, height & 0xFF,
    (width >> 8) & 0xFF, width & 0xFF,
    0x03,                   // components
    0x01, 0x22, 0x00,
    0x02, 0x11, 0x01,
    0x03, 0x11, 0x01,
  ])
}
function pngBytes(width, height) {
  return new Uint8Array([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,   // PNG signature
    0x00, 0x00, 0x00, 0x0D,                           // IHDR length (13)
    0x49, 0x48, 0x44, 0x52,                           // "IHDR"
    (width >>> 24) & 0xFF, (width >>> 16) & 0xFF, (width >>> 8) & 0xFF, width & 0xFF,
    (height >>> 24) & 0xFF, (height >>> 16) & 0xFF, (height >>> 8) & 0xFF, height & 0xFF,
    0x08, 0x06, 0x00, 0x00, 0x00,                     // bit depth, color type, etc.
  ])
}
// An ISOBMFF ftyp box with the HEIC major brand — iPhone's default photo container.
function heicBytes() {
  return new Uint8Array([
    0x00, 0x00, 0x00, 0x18,                           // box size (24)
    0x66, 0x74, 0x79, 0x70,                           // "ftyp"
    0x68, 0x65, 0x69, 0x63,                           // major brand "heic"
    0x00, 0x00, 0x00, 0x00,                           // minor version
    0x6D, 0x69, 0x66, 0x31,                           // compatible brand "mif1"
    0x68, 0x65, 0x69, 0x63,                           // compatible brand "heic"
  ])
}

// --- The regression: media_type correction (RESPLIT-CURRENCY-API-G) ------------

test('rescue: a valid JPEG mislabeled image/jpg has media_type corrected so the LLM leg succeeds', async () => {
  stubAnthropic()
  const res = await scanReceiptWithAnthropic(jpegWithDimensions(800, 600), 'image/jpg', env())
  // On current main the declared 'image/jpg' is forwarded verbatim -> Anthropic 400
  // -> the paid rescue leg dies. With the fix it is sniffed to 'image/jpeg'.
  assert.equal(res.ok, true, 'the paid rescue leg must succeed for a valid JPEG mislabeled image/jpg')
  assert.equal(res.scanned.total, 10)
  assert.equal(lastBody.messages[0].content[0].source.media_type, 'image/jpeg')
  assert.equal(fetchCalls, 1)
})

test('sniff wins over a wrong declared type: PNG bytes declared image/jpeg send media_type image/png', async () => {
  stubAnthropic()
  const res = await scanReceiptWithAnthropic(pngBytes(800, 600), 'image/jpeg', env())
  assert.equal(res.ok, true)
  assert.equal(lastBody.messages[0].content[0].source.media_type, 'image/png')
  assert.equal(fetchCalls, 1)
})

// --- Genuinely unsupported bytes are skipped, not sent (RESPLIT-CURRENCY-API-G b) ---

test('HEIC: unsupported bytes skip the Anthropic call with a clean reason (no wasted 400)', async () => {
  stubAnthropic()
  const res = await scanReceiptWithAnthropic(heicBytes(), 'image/heic', env())
  assert.equal(res.ok, false)
  assert.equal(res.errorBody, 'llm_unsupported_media')
  assert.equal(res.scanned, null)
  assert.equal(fetchCalls, 0, 'must not burn a paid Anthropic call that is guaranteed to 400')
})

// --- Oversize image bytes are skipped (RESPLIT-CURRENCY-API-E) ------------------

test('oversize bytes: an image over Anthropic 10 MiB limit skips the call with llm_image_too_large', async () => {
  stubAnthropic()
  const big = jpegBytes(10 * 1024 * 1024 + 1)
  const res = await scanReceiptWithAnthropic(big, 'image/jpeg', env())
  assert.equal(res.ok, false)
  assert.equal(res.errorBody, 'llm_image_too_large')
  assert.equal(fetchCalls, 0)
})

// --- Oversize dimensions are skipped (RESPLIT-CURRENCY-API-B) -------------------

test('oversize dimensions: a JPEG over 8000 px/axis skips the call with llm_image_dimensions', async () => {
  stubAnthropic()
  const res = await scanReceiptWithAnthropic(jpegWithDimensions(9000, 1200), 'image/jpeg', env())
  assert.equal(res.ok, false)
  assert.equal(res.errorBody, 'llm_image_dimensions')
  assert.equal(fetchCalls, 0)
})

test('oversize dimensions: a PNG over 8000 px/axis skips the call with llm_image_dimensions', async () => {
  stubAnthropic()
  const res = await scanReceiptWithAnthropic(pngBytes(1000, 8600), 'image/png', env())
  assert.equal(res.ok, false)
  assert.equal(res.errorBody, 'llm_image_dimensions')
  assert.equal(fetchCalls, 0)
})

// --- No false rejections: the happy path and fail-open are preserved -----------

test('happy path: a truthful image/jpeg at or below the 1568px LLM bound still calls Anthropic and succeeds', async () => {
  stubAnthropic()
  const res = await scanReceiptWithAnthropic(jpegWithDimensions(1200, 1500), 'image/jpeg', env())
  assert.equal(res.ok, true)
  assert.equal(fetchCalls, 1)
  assert.equal(lastBody.messages[0].content[0].source.media_type, 'image/jpeg')
})

test('unidentifiable bytes with a supported declared type fail before the paid provider', async () => {
  stubAnthropic()
  const res = await scanReceiptWithAnthropic(new Uint8Array([1, 2, 3]), 'image/jpeg', env())
  assert.equal(res.ok, false)
  assert.equal(res.errorBody, 'llm_image_transform_failed')
  assert.equal(fetchCalls, 0)
})

test('GIF fails closed before Photon because logical-screen dimensions do not bound animation frames', async () => {
  stubAnthropic()
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x06, 0xE8, 0x03])
  const res = await scanReceiptWithAnthropic(gif, 'image/gif', env())
  assert.equal(res.ok, false)
  assert.equal(res.errorBody, 'llm_image_transform_failed')
  assert.equal(fetchCalls, 0)
})

// --- resolveAnthropicImage pure-resolver unit coverage -------------------------

test('resolveAnthropicImage: sniff overrides declared type for every supported format', () => {
  assert.deepEqual(resolveAnthropicImage(jpegBytes(), 'image/jpg'), { ok: true, mediaType: 'image/jpeg' })
  assert.deepEqual(resolveAnthropicImage(pngBytes(10, 10), 'image/jpeg'), { ok: true, mediaType: 'image/png' })
  assert.deepEqual(
    resolveAnthropicImage(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x0A, 0x00, 0x0A, 0x00]), 'image/png'),
    { ok: true, mediaType: 'image/gif' },
  )
})

test('resolveAnthropicImage: strips Content-Type parameters on the fail-open declared path', () => {
  assert.deepEqual(
    resolveAnthropicImage(new Uint8Array([1, 2, 3]), 'image/jpeg; charset=binary'),
    { ok: true, mediaType: 'image/jpeg' },
  )
})

test('resolveAnthropicImage: rejects HEIC/BMP/TIFF/PDF magic as unsupported', () => {
  assert.equal(resolveAnthropicImage(heicBytes(), 'image/heic').reason, 'llm_unsupported_media')
  assert.equal(resolveAnthropicImage(new Uint8Array([0x42, 0x4D, 0, 0]), 'image/bmp').reason, 'llm_unsupported_media')
  assert.equal(resolveAnthropicImage(new Uint8Array([0x49, 0x49, 0x2A, 0x00]), '').reason, 'llm_unsupported_media')
  assert.equal(resolveAnthropicImage(new Uint8Array([0x25, 0x50, 0x44, 0x46]), 'application/pdf').reason, 'llm_unsupported_media')
})

test('resolveAnthropicImage: rejects an unidentifiable body whose declared type is also unsupported', () => {
  assert.equal(resolveAnthropicImage(new Uint8Array([9, 9, 9]), 'image/heic').reason, 'llm_unsupported_media')
})

test('resolveAnthropicImage: dimension guard is inclusive at the 8000 px boundary', () => {
  assert.equal(resolveAnthropicImage(jpegWithDimensions(8000, 8000), 'image/jpeg').ok, true)
  assert.equal(resolveAnthropicImage(jpegWithDimensions(8001, 100), 'image/jpeg').reason, 'llm_image_dimensions')
  assert.equal(resolveAnthropicImage(pngBytes(100, 8001), 'image/png').reason, 'llm_image_dimensions')
})
