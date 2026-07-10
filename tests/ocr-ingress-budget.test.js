import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { handleOcr } from '../worker/src/ocr/router.mjs'

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
const CONFIGURED_MAX_BYTES = 2 * 1024 * 1024
const OCR_ROUTES = [
  { path: '/ocr/scan', route: 'scan' },
  { path: '/ocr/dual-scan', route: 'dual-scan' },
  { path: '/ocr/analyze', route: 'analyze' },
]

function makeKV() {
  const store = new Map()
  const calls = { get: 0, put: 0, delete: 0 }
  return {
    store,
    calls,
    async get(key) { calls.get++; return store.has(key) ? store.get(key) : null },
    async put(key, value) { calls.put++; store.set(key, value) },
    async delete(key) { calls.delete++; store.delete(key) },
  }
}

function makeEnv(extra = {}) {
  return {
    ATTEST_KV: makeKV(),
    AZURE_OCR_ENDPOINT: 'https://test.cognitiveservices.azure.com',
    AZURE_OCR_KEY: 'test-key',
    SENTRY_ENVIRONMENT: 'test',
    ...extra,
  }
}

function scanRequest(path, bytes, headers = {}) {
  return new Request(`https://fx.resplit.app${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'image/jpeg',
      'x-resplit-attest-soft-fail': 'true',
      'x-resplit-client-version': '2.2.0-test',
      'x-resplit-trace-id': `trace-${path.slice(5).replace('/', '-')}`,
      ...headers,
    },
    body: bytes,
  })
}

function captureWarnings() {
  const lines = []
  const original = console.warn
  console.warn = (line) => lines.push(line)
  return {
    lines,
    restore() { console.warn = original },
  }
}

function assertSafeOversizeResponse(res, body, requestId) {
  assert.equal(res.status, 413)
  assert.equal(res.headers.get('x-request-id'), requestId)
  assert.equal(res.headers.get('x-resplit-trace-id'), requestId)
  assert.deepEqual(body, {
    error: 'OCR_PAYLOAD_TOO_LARGE',
    message: 'OCR image exceeds the 10485760 byte limit',
    requestId,
    traceId: requestId,
  })
  assert.equal('raw' in body, false)
  assert.equal('scanId' in body, false)
  assert.equal('image' in body, false)
  assert.equal('body' in body, false)
}

const realFetch = globalThis.fetch
let providerCalls

beforeEach(() => {
  providerCalls = 0
  globalThis.fetch = async () => {
    providerCalls++
    throw new Error('oversized OCR ingress must not call a provider')
  }
})

afterEach(() => {
  globalThis.fetch = realFetch
})

for (const { path, route } of OCR_ROUTES) {
  test(`POST ${path} rejects oversized declared Content-Length before reading or spending`, async () => {
    const env = makeEnv()
    const requestId = `trace-${route}`
    const req = scanRequest(path, new Uint8Array([1]), {
      'content-length': String(DEFAULT_MAX_BYTES + 1),
      'x-resplit-trace-id': requestId,
    })
    let bodyReads = 0
    Object.defineProperty(req, 'arrayBuffer', {
      value: async () => {
        bodyReads++
        throw new Error('declared oversize must be rejected before reading the body')
      },
    })

    const captured = captureWarnings()
    let res
    try {
      res = await handleOcr(req, env)
    } finally {
      captured.restore()
    }
    const body = await res.json()

    assertSafeOversizeResponse(res, body, requestId)
    assert.equal(bodyReads, 0)
    assert.equal(providerCalls, 0)
    assert.deepEqual(env.ATTEST_KV.calls, { get: 0, put: 0, delete: 0 })

    const monitoring = captured.lines
      .filter((line) => typeof line === 'string' && line.startsWith('[OCR_MONITORING] '))
      .map((line) => JSON.parse(line.replace('[OCR_MONITORING] ', '')))
    assert.equal(monitoring.length, 1, 'one rejected request emits exactly one structured signal')
    assert.equal(monitoring[0].signal, 'ocr_ingress_rejected')
    assert.equal(monitoring[0].route, route)
    assert.equal(monitoring[0].client_version, '2.2.0-test')
    assert.equal(monitoring[0].size_source, 'declared')
    assert.equal(monitoring[0].declared_or_actual_size, DEFAULT_MAX_BYTES + 1)
    assert.equal(monitoring[0].max, DEFAULT_MAX_BYTES)
    for (const forbidden of ['image', 'body', 'device', 'device_id', 'ip', 'cf_connecting_ip']) {
      assert.equal(forbidden in monitoring[0], false, `monitoring must not include ${forbidden}`)
    }
  })

  test(`POST ${path} rejects actual bytes above a configured cap with missing or spoofed length`, async () => {
    const env = makeEnv({ OCR_MAX_INGRESS_BYTES: String(CONFIGURED_MAX_BYTES) })
    const requestId = `trace-actual-${route}`
    const req = scanRequest(path, new Uint8Array(CONFIGURED_MAX_BYTES + 1), {
      ...(route === 'analyze' ? {} : { 'content-length': String(CONFIGURED_MAX_BYTES) }),
      'x-resplit-trace-id': requestId,
    })
    const captured = captureWarnings()
    let res
    try {
      res = await handleOcr(req, env)
    } finally {
      captured.restore()
    }
    const body = await res.json()

    assert.equal(res.status, 413)
    assert.equal(body.error, 'OCR_PAYLOAD_TOO_LARGE')
    assert.equal(body.message, `OCR image exceeds the ${CONFIGURED_MAX_BYTES} byte limit`)
    assert.equal(body.requestId, requestId)
    assert.equal(providerCalls, 0)
    assert.deepEqual(env.ATTEST_KV.calls, { get: 0, put: 0, delete: 0 })

    const monitoring = captured.lines
      .filter((line) => typeof line === 'string' && line.startsWith('[OCR_MONITORING] '))
      .map((line) => JSON.parse(line.replace('[OCR_MONITORING] ', '')))
    assert.equal(monitoring.length, 1)
    assert.equal(monitoring[0].route, route)
    assert.equal(monitoring[0].size_source, 'actual')
    assert.equal(monitoring[0].declared_or_actual_size, CONFIGURED_MAX_BYTES + 1)
    assert.equal(monitoring[0].max, CONFIGURED_MAX_BYTES)
  })
}

test('chunked ingress cancels immediately on overflow without buffering later chunks', async () => {
  const env = makeEnv({ OCR_MAX_INGRESS_BYTES: String(CONFIGURED_MAX_BYTES) })
  const firstChunkBytes = CONFIGURED_MAX_BYTES - 1024
  const secondChunkBytes = 2048
  let pulls = 0
  let cancelReason = null
  const stream = new ReadableStream({
    pull(controller) {
      pulls++
      if (pulls === 1) {
        controller.enqueue(new Uint8Array(firstChunkBytes))
        return
      }
      if (pulls === 2) {
        controller.enqueue(new Uint8Array(secondChunkBytes))
        return
      }
      throw new Error('ingress reader consumed bytes after the limit was crossed')
    },
    cancel(reason) {
      cancelReason = reason
    },
  }, { highWaterMark: 0 })
  const req = new Request('https://fx.resplit.app/ocr/analyze', {
    method: 'POST',
    headers: {
      'content-type': 'image/jpeg',
      'x-resplit-attest-soft-fail': 'true',
      'x-resplit-client-version': '2.2.0-stream-test',
      'x-resplit-trace-id': 'trace-stream-overflow',
    },
    body: stream,
    duplex: 'half',
  })
  assert.equal(req.headers.get('content-length'), null, 'streamed request must exercise the no-length path')
  let arrayBufferReads = 0
  Object.defineProperty(req, 'arrayBuffer', {
    value: async () => {
      arrayBufferReads++
      throw new Error('streaming ingress must not fall back to arrayBuffer')
    },
  })

  const captured = captureWarnings()
  let res
  try {
    res = await handleOcr(req, env)
  } finally {
    captured.restore()
  }
  const body = await res.json()

  assert.equal(res.status, 413)
  assert.equal(body.error, 'OCR_PAYLOAD_TOO_LARGE')
  assert.equal(body.requestId, 'trace-stream-overflow')
  assert.equal(arrayBufferReads, 0)
  assert.equal(pulls, 2, 'the third chunk must never be pulled')
  assert.equal(cancelReason, 'ocr_ingress_limit_exceeded')
  assert.equal(providerCalls, 0)
  assert.deepEqual(env.ATTEST_KV.calls, { get: 0, put: 0, delete: 0 })

  const monitoring = captured.lines
    .filter((line) => typeof line === 'string' && line.startsWith('[OCR_MONITORING] '))
    .map((line) => JSON.parse(line.replace('[OCR_MONITORING] ', '')))
  assert.equal(monitoring.length, 1)
  assert.equal(monitoring[0].route, 'analyze')
  assert.equal(monitoring[0].client_version, '2.2.0-stream-test')
  assert.equal(monitoring[0].size_source, 'actual')
  assert.equal(monitoring[0].declared_or_actual_size, firstChunkBytes + secondChunkBytes)
  assert.equal(monitoring[0].max, CONFIGURED_MAX_BYTES)
})

test('missing, invalid, and unsafe max configuration fail closed to 10 MiB', async () => {
  const unsafeValues = [
    undefined,
    '',
    'not-a-number',
    '0',
    '-1',
    '1.5',
    '3',
    String((2_000 * 1024) - 1),
    String(DEFAULT_MAX_BYTES + 1),
  ]

  for (const configured of unsafeValues) {
    const env = makeEnv(configured === undefined ? {} : { OCR_MAX_INGRESS_BYTES: configured })
    const req = scanRequest('/ocr/scan', new Uint8Array([1]), {
      'content-length': String(DEFAULT_MAX_BYTES + 1),
      'x-resplit-trace-id': `trace-config-${String(configured)}`,
    })
    let bodyReads = 0
    Object.defineProperty(req, 'arrayBuffer', {
      value: async () => {
        bodyReads++
        throw new Error('default cap must reject before reading')
      },
    })

    const captured = captureWarnings()
    let res
    try {
      res = await handleOcr(req, env)
    } finally {
      captured.restore()
    }
    const body = await res.json()
    assert.equal(res.status, 413, `configured=${String(configured)}`)
    assert.equal(body.error, 'OCR_PAYLOAD_TOO_LARGE')
    assert.equal(bodyReads, 0)
    const monitoring = captured.lines
      .filter((line) => typeof line === 'string' && line.startsWith('[OCR_MONITORING] '))
      .map((line) => JSON.parse(line.replace('[OCR_MONITORING] ', '')))
    assert.equal(monitoring.length, 1)
    assert.equal(monitoring[0].max, DEFAULT_MAX_BYTES)
  }
})
