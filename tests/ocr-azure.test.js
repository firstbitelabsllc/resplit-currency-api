import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getReceiptAnalyzeResult,
  submitReceiptAnalyze,
} from '../worker/src/ocr/azure.mjs'

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
