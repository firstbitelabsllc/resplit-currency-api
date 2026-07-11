import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getReceiptAnalyzeResult,
  submitReceiptAnalyze,
} from '../worker/src/ocr/azure.mjs'
import { handleOcr } from '../worker/src/ocr/router.mjs'

const BASE_ENV = Object.freeze({
  AZURE_OCR_ENDPOINT: 'https://test.cognitiveservices.azure.com',
  AZURE_OCR_KEY: 'test-key',
})

function installFetch(t, implementation) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = implementation
  t.after(() => { globalThis.fetch = originalFetch })
}

function installTrackedTimers(t) {
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const active = new Set()
  const delays = []

  globalThis.setTimeout = (callback, delay, ...args) => {
    delays.push(delay)
    const handle = originalSetTimeout(callback, delay, ...args)
    active.add(handle)
    return handle
  }
  globalThis.clearTimeout = (handle) => {
    active.delete(handle)
    return originalClearTimeout(handle)
  }
  t.after(() => {
    for (const handle of active) originalClearTimeout(handle)
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  })

  return { active, delays }
}

function rejectWhenAborted(signal, onAbort) {
  return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {
      onAbort()
      reject(new DOMException('request aborted', 'AbortError'))
    }, { once: true })
  })
}

function makeKV() {
  const store = new Map()
  return {
    async get(key) { return store.has(key) ? store.get(key) : null },
    async put(key, value) { store.set(key, value) },
    async delete(key) { store.delete(key) },
  }
}

function scanRequest(path, imageByte) {
  return new Request(`https://fx.resplit.app${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'image/jpeg',
      'x-resplit-attest-soft-fail': 'true',
    },
    body: new Uint8Array([imageByte]),
  })
}

test('Azure submit timeout aborts fetch and returns the legacy-safe provider shape', { concurrency: false, timeout: 250 }, async (t) => {
  const timers = installTrackedTimers(t)
  let sawSignal = false
  let sawAbort = false
  installFetch(t, async (_url, init) => {
    assert.ok(init.signal instanceof AbortSignal)
    sawSignal = true
    return rejectWhenAborted(init.signal, () => { sawAbort = true })
  })

  const result = await submitReceiptAnalyze(
    new Uint8Array([1, 2, 3]),
    'image/jpeg',
    { ...BASE_ENV, AZURE_OCR_FETCH_TIMEOUT_MS: '1' },
  )

  assert.equal(sawSignal, true)
  assert.equal(sawAbort, true)
  assert.deepEqual(result, {
    ok: false,
    httpStatus: 504,
    operationId: null,
    errorBody: 'azure_timeout',
  })
  assert.deepEqual(timers.delays, [1])
  assert.equal(timers.active.size, 0, 'timeout handle must be cleared after the aborted fetch settles')
})

test('Azure poll timeout aborts fetch and returns the legacy-safe provider shape', { concurrency: false, timeout: 250 }, async (t) => {
  const timers = installTrackedTimers(t)
  let sawAbort = false
  installFetch(t, async (_url, init) => {
    assert.ok(init.signal instanceof AbortSignal)
    return rejectWhenAborted(init.signal, () => { sawAbort = true })
  })

  const result = await getReceiptAnalyzeResult(
    'operation-1',
    { ...BASE_ENV, AZURE_OCR_FETCH_TIMEOUT_MS: '1' },
  )

  assert.equal(sawAbort, true)
  assert.deepEqual(result, {
    ok: false,
    httpStatus: 504,
    status: null,
    body: null,
    errorBody: 'azure_timeout',
  })
  assert.deepEqual(timers.delays, [1])
  assert.equal(timers.active.size, 0, 'timeout handle must be cleared after the aborted fetch settles')
})

test('Azure transport failure stays data-shaped instead of escaping the OCR route', { concurrency: false }, async (t) => {
  const timers = installTrackedTimers(t)
  installFetch(t, async () => { throw new TypeError('socket details must not escape') })

  const result = await submitReceiptAnalyze(
    new Uint8Array([1]),
    'image/jpeg',
    { ...BASE_ENV, AZURE_OCR_FETCH_TIMEOUT_MS: '25' },
  )

  assert.deepEqual(result, {
    ok: false,
    httpStatus: 502,
    operationId: null,
    errorBody: 'azure_transport_error',
  })
  assert.equal(timers.active.size, 0, 'transport failures must clear their pending timeout')
})

test('invalid Azure timeout config falls back to the conservative default and clears it', { concurrency: false }, async (t) => {
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const handle = { kind: 'fake-timeout' }
  let configuredDelay = null
  let clearedHandle = null
  globalThis.setTimeout = (_callback, delay) => {
    configuredDelay = delay
    return handle
  }
  globalThis.clearTimeout = (value) => { clearedHandle = value }
  t.after(() => {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  })
  installFetch(t, async () => new Response('', {
    status: 202,
    headers: { 'operation-location': 'https://test.cognitiveservices.azure.com/analyzeResults/op-1' },
  }))

  const result = await submitReceiptAnalyze(
    new Uint8Array([1]),
    'image/jpeg',
    { ...BASE_ENV, AZURE_OCR_FETCH_TIMEOUT_MS: '15seconds' },
  )

  assert.equal(result.ok, true)
  assert.equal(configuredDelay, 15_000)
  assert.equal(clearedHandle, handle)
})

test('Azure timeout preserves the legacy v1 and v2 provider_error/502 route contracts', { concurrency: false, timeout: 500 }, async (t) => {
  const timers = installTrackedTimers(t)
  installFetch(t, async (_url, init) => rejectWhenAborted(init.signal, () => {}))
  const env = {
    ...BASE_ENV,
    ATTEST_KV: makeKV(),
    AZURE_OCR_FETCH_TIMEOUT_MS: '1',
    SENTRY_ENVIRONMENT: 'test',
  }

  const v1Response = await handleOcr(scanRequest('/ocr/dual-scan', 7), env)
  const v1 = await v1Response.json()
  assert.equal(v1Response.status, 502)
  assert.equal(v1.v, 1)
  assert.equal(v1.status, 'provider_error')
  assert.equal(v1.azure.status, 'provider_error')

  const v2Response = await handleOcr(scanRequest('/ocr/analyze', 8), env)
  const v2 = await v2Response.json()
  assert.equal(v2Response.status, 502)
  assert.equal(v2.v, 2)
  assert.equal(v2.status, 'provider_error')
  const v2Azure = v2.engines.find((engine) => engine.id === 'azure')
  assert.equal(v2Azure.status, 'provider_error')

  assert.deepEqual(timers.delays, [1, 1])
  assert.equal(timers.active.size, 0)
})

test('dark accounting preserves the legacy settled fallback for an unexpected Azure exception', { concurrency: false }, async () => {
  const env = {
    ATTEST_KV: makeKV(),
    SENTRY_ENVIRONMENT: 'test',
  }
  Object.defineProperty(env, 'AZURE_OCR_ENDPOINT', {
    get() { throw new Error('synthetic unexpected provider configuration failure') },
  })

  const response = await handleOcr(scanRequest('/ocr/analyze', 9), env)
  const body = await response.json()
  const azure = body.engines.find((engine) => engine.id === 'azure')

  assert.equal(response.status, 502)
  assert.equal(azure.status, 'provider_error')
  assert.equal(
    azure.latencyMs,
    null,
    'default-off accounting must not replace the installed rejected-leg sentinel',
  )
})
