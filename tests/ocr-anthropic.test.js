import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { PhotonImage } from '@cf-wasm/photon'
import { scanReceiptWithAnthropic, receiptShapeViolation } from '../worker/src/ocr/anthropic.mjs'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const realFetch = globalThis.fetch

let lastBody
beforeEach(() => { lastBody = null })
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

function anthropicToolResponse(input, { stopReason = 'tool_use' } = {}) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    content: [{ type: 'tool_use', id: 'toolu_test', name: 'emit_receipt', input }],
    stop_reason: stopReason,
  }
}

// Stub the Anthropic endpoint with a single JSON response; capture the request body.
function stubAnthropic(response, status = 200) {
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(String(url), ANTHROPIC_URL)
    lastBody = JSON.parse(init.body)
    return Response.json(response, { status })
  }
}

const env = () => ({ ANTHROPIC_API_KEY: 'anthropic-key', LLM_SCAN_MODEL: 'claude-sonnet-5' })
const image = new Uint8Array([
  0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08,
  0x02, 0x58, 0x03, 0x20, 0x03,
  0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
])

function jpegWithDimensions(width, height) {
  return new Uint8Array([
    0xFF, 0xD8,
    0xFF, 0xC0,
    0x00, 0x11,
    0x08,
    (height >> 8) & 0xFF, height & 0xFF,
    (width >> 8) & 0xFF, width & 0xFF,
    0x03,
    0x01, 0x22, 0x00,
    0x02, 0x11, 0x01,
    0x03, 0x11, 0x01,
  ])
}

function exifOrientationSegment(orientation, littleEndian = false) {
  const tiff = littleEndian
    ? [
        0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00,
        0x01, 0x00,
        0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00,
        orientation, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
      ]
    : [
        0x4D, 0x4D, 0x00, 0x2A, 0x00, 0x00, 0x00, 0x08,
        0x00, 0x01,
        0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01,
        0x00, orientation, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
      ]
  return new Uint8Array([
    0xFF, 0xE1, 0x00, 0x22,
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
    ...tiff,
  ])
}

function jpegWithExifOrientation(width, height, orientation, littleEndian = false) {
  return new Uint8Array([
    0xFF, 0xD8,
    ...exifOrientationSegment(orientation, littleEndian),
    ...jpegWithDimensions(width, height).subarray(2),
  ])
}

function jpegBytesWithExifOrientation(jpeg, orientation) {
  return new Uint8Array([
    ...jpeg.subarray(0, 2),
    ...exifOrientationSegment(orientation),
    ...jpeg.subarray(2),
  ])
}

function asymmetricQuadrantJpeg(width = 1600, height = 1000) {
  const colors = {
    red: [240, 20, 20, 255],
    green: [20, 240, 20, 255],
    blue: [20, 20, 240, 255],
    yellow: [240, 240, 20, 255],
  }
  const pixels = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = y < height / 2
        ? (x < width / 2 ? colors.red : colors.green)
        : (x < width / 2 ? colors.blue : colors.yellow)
      const offset = (y * width + x) * 4
      pixels[offset] = color[0]
      pixels[offset + 1] = color[1]
      pixels[offset + 2] = color[2]
      pixels[offset + 3] = color[3]
    }
  }
  const image = new PhotonImage(pixels, width, height)
  try {
    return image.get_bytes_jpeg(95)
  } finally {
    image.free()
  }
}

function decodedCornerLabels(jpeg) {
  const colors = {
    red: [240, 20, 20],
    green: [20, 240, 20],
    blue: [20, 20, 240],
    yellow: [240, 240, 20],
  }
  const image = PhotonImage.new_from_byteslice(jpeg)
  try {
    const width = image.get_width()
    const height = image.get_height()
    const pixels = image.get_raw_pixels()
    const samples = [
      [Math.floor(width * 0.1), Math.floor(height * 0.1)],
      [Math.floor(width * 0.9), Math.floor(height * 0.1)],
      [Math.floor(width * 0.1), Math.floor(height * 0.9)],
      [Math.floor(width * 0.9), Math.floor(height * 0.9)],
    ]
    const sampledColors = samples.map(([x, y]) => {
      const offset = (y * width + x) * 4
      return [...pixels.subarray(offset, offset + 3)]
    })
    const labels = sampledColors.map((sample) => {
      // Photon blends exact-angle rotations toward white. Compare the direction
      // of each color's distance from white so hue survives that lightening.
      const sampleVector = sample.map((component) => 255 - component)
      const sampleMagnitude = Math.hypot(...sampleVector)
      return Object.entries(colors).reduce((nearest, [label, color]) => {
        const colorVector = color.map((component) => 255 - component)
        const similarity = colorVector.reduce((sum, component, index) => {
          return sum + component * sampleVector[index]
        }, 0) / (Math.hypot(...colorVector) * sampleMagnitude)
        return similarity > nearest.similarity ? { label, similarity } : nearest
      }, { label: null, similarity: Number.NEGATIVE_INFINITY }).label
    })
    return { width, height, labels, sampledColors }
  } finally {
    image.free()
  }
}

function base64Bytes(value) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}

function webpVp8xBytes(width, height) {
  const widthMinusOne = width - 1
  const heightMinusOne = height - 1
  return new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x16, 0x00, 0x00, 0x00,
    0x57, 0x45, 0x42, 0x50,
    0x56, 0x50, 0x38, 0x58,
    0x0A, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    widthMinusOne & 0xFF, (widthMinusOne >> 8) & 0xFF, (widthMinusOne >> 16) & 0xFF,
    heightMinusOne & 0xFF, (heightMinusOne >> 8) & 0xFF, (heightMinusOne >> 16) & 0xFF,
  ])
}

function webpVp8lBytes(width, height) {
  const widthMinusOne = width - 1
  const heightMinusOne = height - 1
  return new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x11, 0x00, 0x00, 0x00,
    0x57, 0x45, 0x42, 0x50,
    0x56, 0x50, 0x38, 0x4C,
    0x05, 0x00, 0x00, 0x00,
    0x2F,
    widthMinusOne & 0xFF,
    ((widthMinusOne >> 8) & 0x3F) | ((heightMinusOne & 0x03) << 6),
    (heightMinusOne >> 2) & 0xFF,
    (heightMinusOne >> 10) & 0x0F,
  ])
}

function webpVp8Bytes(width, height) {
  return new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x16, 0x00, 0x00, 0x00,
    0x57, 0x45, 0x42, 0x50,
    0x56, 0x50, 0x38, 0x20,
    0x0A, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00,
    0x9D, 0x01, 0x2A,
    width & 0xFF, (width >> 8) & 0x3F,
    height & 0xFF, (height >> 8) & 0x3F,
  ])
}

function unreadableWebpBytes() {
  return new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00,
    0x57, 0x45, 0x42, 0x50,
  ])
}

function fakeImageResizer({
  outputBytes = jpegWithDimensions(1568, 392),
  throwOnResize = false,
} = {}) {
  const calls = []
  return {
    calls,
    async resize(imageBytes, options) {
      calls.push({ imageBytes: new Uint8Array(imageBytes), options })
      if (throwOnResize) throw new Error('photon resize unavailable')
      return outputBytes
    },
  }
}

test('request uses strict tool use and a 4096 max_tokens ceiling', async () => {
  stubAnthropic(anthropicToolResponse(scannedReceipt()))
  const res = await scanReceiptWithAnthropic(image, 'image/jpeg', env())
  assert.equal(res.ok, true)
  assert.equal(lastBody.max_tokens, 4096) // finding #3: safer ceiling for dense receipts
  assert.equal(lastBody.tools[0].strict, true) // finding #4: Anthropic strict tool use
  assert.equal(lastBody.tools[0].input_schema.additionalProperties, false)
})

test('a valid tool input returns ok:true with the scanned receipt', async () => {
  stubAnthropic(anthropicToolResponse(scannedReceipt()))
  const res = await scanReceiptWithAnthropic(image, 'image/jpeg', env())
  assert.equal(res.ok, true)
  assert.equal(res.httpStatus, 200)
  assert.equal(res.scanned.total, 10)
  assert.equal(res.errorBody, null)
})

test('an image at the 1568px boundary passes through byte-identically without invoking Photon', async () => {
  const bounded = jpegWithDimensions(1568, 1200)
  const resizer = fakeImageResizer()
  stubAnthropic(anthropicToolResponse(scannedReceipt()))

  const res = await scanReceiptWithAnthropic(bounded, 'image/jpeg', {
    ...env(),
    __TEST_LLM_IMAGE_RESIZER: resizer.resize,
  })

  assert.equal(res.ok, true)
  assert.equal(resizer.calls.length, 0)
  const source = lastBody.messages[0].content[0].source
  assert.equal(source.media_type, 'image/jpeg')
  assert.deepEqual(base64Bytes(source.data), bounded)
})

test('an image over 1568px is scale-down transformed before only the Anthropic call', async () => {
  const original = jpegWithDimensions(3136, 784)
  const transformed = jpegWithDimensions(1568, 392)
  const resizer = fakeImageResizer({ outputBytes: transformed })
  stubAnthropic(anthropicToolResponse(scannedReceipt()))

  const res = await scanReceiptWithAnthropic(original, 'image/jpeg', {
    ...env(),
    __TEST_LLM_IMAGE_RESIZER: resizer.resize,
  })

  assert.equal(res.ok, true)
  assert.deepEqual(resizer.calls, [{
    imageBytes: original,
    options: { sourceWidth: 3136, sourceHeight: 784, width: 1568, height: 392, quality: 90, orientation: 1 },
  }])
  const source = lastBody.messages[0].content[0].source
  assert.equal(source.media_type, 'image/jpeg')
  assert.deepEqual(base64Bytes(source.data), transformed)
})

test('all WebP container variants expose bounded dimensions without invoking Photon', async (t) => {
  const cases = [
    ['VP8X', webpVp8xBytes(1568, 800)],
    ['VP8L', webpVp8lBytes(1568, 800)],
    ['VP8', webpVp8Bytes(1568, 800)],
  ]
  for (const [name, original] of cases) {
    await t.test(name, async () => {
      const resizer = fakeImageResizer()
      stubAnthropic(anthropicToolResponse(scannedReceipt()))
      const res = await scanReceiptWithAnthropic(original, 'image/webp', {
        ...env(),
        __TEST_LLM_IMAGE_RESIZER: resizer.resize,
      })
      assert.equal(res.ok, true)
      assert.equal(resizer.calls.length, 0, 'a bounded WebP must not pay for an unnecessary transform')
      const source = lastBody.messages[0].content[0].source
      assert.equal(source.media_type, 'image/webp')
      assert.deepEqual(base64Bytes(source.data), original)
    })
  }
})

test('WebP over 1568px is measured from its header then transformed before the Anthropic call', async () => {
  const original = webpVp8xBytes(3136, 1568)
  const transformed = jpegWithDimensions(1568, 784)
  const resizer = fakeImageResizer({ outputBytes: transformed })
  stubAnthropic(anthropicToolResponse(scannedReceipt()))

  const res = await scanReceiptWithAnthropic(original, 'image/webp', {
    ...env(),
    __TEST_LLM_IMAGE_RESIZER: resizer.resize,
  })

  assert.equal(res.ok, true)
  assert.deepEqual(resizer.calls, [{
    imageBytes: original,
    options: { sourceWidth: 3136, sourceHeight: 1568, width: 1568, height: 784, quality: 90, orientation: 1 },
  }])
  assert.deepEqual(base64Bytes(lastBody.messages[0].content[0].source.data), transformed)
})

test('an unreadable supported-image header fails before the paid provider', async () => {
  let providerCalls = 0
  globalThis.fetch = async () => {
    providerCalls++
    return Response.json(anthropicToolResponse(scannedReceipt()), { status: 200 })
  }
  const res = await scanReceiptWithAnthropic(unreadableWebpBytes(), 'image/webp', env())

  assert.equal(res.ok, false)
  assert.equal(res.httpStatus, 502)
  assert.equal(res.errorBody, 'llm_image_transform_failed')
  assert.equal(res.providerStarted, false)
  assert.equal(providerCalls, 0)
})

test('image transform failures are data-shaped and never start the paid provider', async (t) => {
  const original = jpegWithDimensions(1569, 800)
  const cases = [
    ['resizer throw', { throwOnResize: true }],
    ['malformed transformed image', { outputBytes: new Uint8Array([1, 2, 3]) }],
    ['valid JPEG still over the bound', { outputBytes: jpegWithDimensions(1569, 800) }],
  ]

  for (const [name, options] of cases) {
    await t.test(name, async () => {
      let providerCalls = 0
      globalThis.fetch = async () => {
        providerCalls++
        return Response.json(anthropicToolResponse(scannedReceipt()), { status: 200 })
      }
      const resizer = fakeImageResizer(options)
      const res = await scanReceiptWithAnthropic(original, 'image/jpeg', {
        ...env(),
        __TEST_LLM_IMAGE_RESIZER: resizer.resize,
      })
      assert.equal(res.ok, false)
      assert.equal(res.httpStatus, 502)
      assert.equal(res.errorBody, 'llm_image_transform_failed')
      assert.equal(res.providerStarted, false)
      assert.equal(providerCalls, 0)
    })
  }
})

test('an image at the proven 4032x3024 Photon pixel budget remains eligible for scale-down', async () => {
  const original = jpegWithDimensions(4032, 3024)
  const transformed = jpegWithDimensions(1568, 1176)
  const resizer = fakeImageResizer({ outputBytes: transformed })
  stubAnthropic(anthropicToolResponse(scannedReceipt()))

  const res = await scanReceiptWithAnthropic(original, 'image/jpeg', {
    ...env(),
    __TEST_LLM_IMAGE_RESIZER: resizer.resize,
  })

  assert.equal(res.ok, true)
  assert.deepEqual(resizer.calls, [{
    imageBytes: original,
    options: { sourceWidth: 4032, sourceHeight: 3024, width: 1568, height: 1176, quality: 90, orientation: 1 },
  }])
  assert.deepEqual(base64Bytes(lastBody.messages[0].content[0].source.data), transformed)
})

test('big- and little-endian EXIF orientation reaches the bounded pixel transform', async (t) => {
  const cases = [
    ['big-endian Rotate 90 CW', jpegWithExifOrientation(4032, 3024, 6), 6, jpegWithDimensions(1176, 1568)],
    ['little-endian Rotate 180', jpegWithExifOrientation(3000, 1500, 3, true), 3, jpegWithDimensions(1568, 784)],
  ]

  for (const [name, original, orientation, transformed] of cases) {
    await t.test(name, async () => {
      const resizer = fakeImageResizer({ outputBytes: transformed })
      stubAnthropic(anthropicToolResponse(scannedReceipt()))
      const res = await scanReceiptWithAnthropic(original, 'image/jpeg', {
        ...env(),
        __TEST_LLM_IMAGE_RESIZER: resizer.resize,
      })

      assert.equal(res.ok, true)
      assert.equal(resizer.calls.length, 1)
      assert.equal(resizer.calls[0].options.orientation, orientation)
      assert.equal(Math.max(resizer.calls[0].options.width, resizer.calls[0].options.height), 1568)
      assert.deepEqual(base64Bytes(lastBody.messages[0].content[0].source.data), transformed)
    })
  }
})

test('a bounded JPEG with non-upright EXIF is still pixel-normalized before Anthropic', async () => {
  const original = jpegWithExifOrientation(1200, 800, 6)
  const transformed = jpegWithDimensions(800, 1200)
  const resizer = fakeImageResizer({ outputBytes: transformed })
  stubAnthropic(anthropicToolResponse(scannedReceipt()))

  const res = await scanReceiptWithAnthropic(original, 'image/jpeg', {
    ...env(),
    __TEST_LLM_IMAGE_RESIZER: resizer.resize,
  })

  assert.equal(res.ok, true)
  assert.deepEqual(resizer.calls, [{
    imageBytes: original,
    options: { sourceWidth: 1200, sourceHeight: 800, width: 1200, height: 800, quality: 90, orientation: 6 },
  }])
  assert.deepEqual(base64Bytes(lastBody.messages[0].content[0].source.data), transformed)
})

test('real Photon bakes all eight EXIF orientations into the bounded JPEG pixels', async (t) => {
  const base = asymmetricQuadrantJpeg()
  const cases = [
    [1, ['red', 'green', 'blue', 'yellow'], 1568, 980],
    [2, ['green', 'red', 'yellow', 'blue'], 1568, 980],
    [3, ['yellow', 'blue', 'green', 'red'], 1568, 980],
    [4, ['blue', 'yellow', 'red', 'green'], 1568, 980],
    [5, ['red', 'blue', 'green', 'yellow'], 980, 1568],
    [6, ['blue', 'red', 'yellow', 'green'], 980, 1568],
    [7, ['yellow', 'green', 'blue', 'red'], 980, 1568],
    [8, ['green', 'yellow', 'red', 'blue'], 980, 1568],
  ]

  for (const [orientation, expectedLabels, expectedWidth, expectedHeight] of cases) {
    await t.test(`orientation ${orientation}`, async () => {
      stubAnthropic(anthropicToolResponse(scannedReceipt()))
      const result = await scanReceiptWithAnthropic(
        jpegBytesWithExifOrientation(base, orientation),
        'image/jpeg',
        env(),
      )

      assert.equal(result.ok, true)
      const source = lastBody.messages[0].content[0].source
      assert.equal(source.media_type, 'image/jpeg')
      const decoded = decodedCornerLabels(base64Bytes(source.data))
      assert.deepEqual({ width: decoded.width, height: decoded.height, labels: decoded.labels }, {
        width: expectedWidth,
        height: expectedHeight,
        labels: expectedLabels,
      }, JSON.stringify(decoded.sampledColors))
    })
  }
})

test('an image beyond the proven Photon pixel budget fails before decode or the paid provider', async () => {
  const original = jpegWithDimensions(4032, 3025)
  const resizer = fakeImageResizer()
  let providerCalls = 0
  globalThis.fetch = async () => {
    providerCalls++
    return Response.json(anthropicToolResponse(scannedReceipt()), { status: 200 })
  }

  const res = await scanReceiptWithAnthropic(original, 'image/jpeg', {
    ...env(),
    __TEST_LLM_IMAGE_RESIZER: resizer.resize,
  })

  assert.equal(res.ok, false)
  assert.equal(res.httpStatus, 502)
  assert.equal(res.errorBody, 'llm_image_transform_failed')
  assert.equal(res.providerStarted, false)
  assert.equal(resizer.calls.length, 0)
  assert.equal(providerCalls, 0)
})

test('a truncated response (stop_reason max_tokens) returns ok:false llm_truncated, not a partial', async () => {
  // Partial tool_use + stop_reason max_tokens: the model was cut off mid-emit.
  stubAnthropic(anthropicToolResponse(scannedReceipt(), { stopReason: 'max_tokens' }))
  const res = await scanReceiptWithAnthropic(image, 'image/jpeg', env())
  assert.equal(res.ok, false)
  assert.equal(res.httpStatus, 502)
  assert.equal(res.scanned, null)
  assert.equal(res.errorBody, 'llm_truncated')
})

test('a tool input with a string amount returns ok:false llm_schema_violation', async () => {
  // amount must be a JSON number, not a string — strict:true guards the happy path,
  // this server-side check backstops a model/provider that ignores the schema.
  const bad = scannedReceipt({ lineItems: [{ name: 'Coffee', amount: '9', quantity: 1 }] })
  stubAnthropic(anthropicToolResponse(bad))
  const res = await scanReceiptWithAnthropic(image, 'image/jpeg', env())
  assert.equal(res.ok, false)
  assert.equal(res.httpStatus, 502)
  assert.equal(res.scanned, null)
  assert.match(res.errorBody, /^llm_schema_violation:/)
})

test('a tool input with an out-of-enum extras kind returns ok:false llm_schema_violation', async () => {
  const bad = scannedReceipt({ extras: [{ label: 'Mystery', amount: 1, kind: 'wormhole' }] })
  stubAnthropic(anthropicToolResponse(bad))
  const res = await scanReceiptWithAnthropic(image, 'image/jpeg', env())
  assert.equal(res.ok, false)
  assert.match(res.errorBody, /^llm_schema_violation:/)
})

test('a missing emit_receipt tool_use returns ok:false', async () => {
  stubAnthropic({ id: 'msg', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'no tool' }], stop_reason: 'end_turn' })
  const res = await scanReceiptWithAnthropic(image, 'image/jpeg', env())
  assert.equal(res.ok, false)
  assert.equal(res.errorBody, 'missing emit_receipt tool_use')
})

// --- receiptShapeViolation unit coverage --------------------------------------

test('receiptShapeViolation accepts a well-formed receipt', () => {
  assert.equal(receiptShapeViolation(scannedReceipt()), null)
  // nullable fields may be null
  assert.equal(receiptShapeViolation(scannedReceipt({ subtotal: null, total: null, currencyCode: null })), null)
})

test('receiptShapeViolation rejects string amounts, missing keys, and bad kinds', () => {
  assert.equal(receiptShapeViolation(null), 'not_object')
  assert.match(receiptShapeViolation({ ...scannedReceipt(), total: undefined, missing: true }) || '', /^(missing:total|total)$/)
  assert.equal(receiptShapeViolation(scannedReceipt({ total: '10' })), 'total')
  assert.equal(receiptShapeViolation(scannedReceipt({ lineItems: [{ name: 'x', amount: '9', quantity: 1 }] })), 'lineItem.amount')
  assert.equal(receiptShapeViolation(scannedReceipt({ extras: [{ label: 'x', amount: '1', kind: 'tax' }] })), 'extra.amount')
  assert.equal(receiptShapeViolation(scannedReceipt({ extras: [{ label: 'x', amount: 1, kind: 'nope' }] })), 'extra.kind')
})
