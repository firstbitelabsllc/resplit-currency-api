import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  logOcrMonitoringEvent,
  captureOcrCacheWriteFailure,
  captureOcrLlmFailure,
  captureOcrProviderFailure,
  captureOcrTotalsDivergence,
  setOcrSentrySdkForTests,
  resetOcrSentrySdkForTests,
} from '../worker/src/ocr/monitoring.mjs'

function makeSentryMock() {
  const calls = { captureMessage: [], flush: [], scopes: [] }
  const sdk = {
    captureMessage(message) { calls.captureMessage.push(message) },
    flush(timeout) { calls.flush.push(timeout); return Promise.resolve(true) },
    withScope(cb) {
      const scope = {
        level: null, tags: {}, contexts: {}, fingerprint: null,
        setLevel(l) { this.level = l },
        setTag(k, v) { this.tags[k] = v },
        setContext(k, v) { this.contexts[k] = v },
        setFingerprint(value) { this.fingerprint = value },
      }
      calls.scopes.push(scope)
      cb(scope)
    },
  }
  return { calls, sdk }
}

function captureConsole(level, fn) {
  const orig = console[level]
  const lines = []
  console[level] = (line) => lines.push(line)
  try { fn() } finally { console[level] = orig }
  return lines
}

test('logOcrMonitoringEvent emits a [OCR_MONITORING] line with the dashboard fields', () => {
  const lines = captureConsole('log', () => {
    logOcrMonitoringEvent('info', {
      signal: 'scan', phase: 'scan', status: 'ok', attest: 'pass', cache: 'miss',
      latency_ms: 1234, azure_status: 200, scanId: 'abc', client_version: '2.0.0',
    }, { SENTRY_ENVIRONMENT: 'production' })
  })
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^\[OCR_MONITORING\] /)
  const json = JSON.parse(lines[0].replace('[OCR_MONITORING] ', ''))
  assert.equal(json.domain, 'ocr')
  assert.equal(json.surface, 'resplit-currency-api')
  assert.equal(json.status, 'ok')
  assert.equal(json.attest, 'pass')
  assert.equal(json.cache, 'miss')
  assert.equal(json.azure_status, 200)
  assert.equal(json.client_version, '2.0.0')
  assert.equal(json.environment, 'production')
  assert.ok(json.timestamp)
})

test('logOcrMonitoringEvent routes level to the right console method', () => {
  const warn = captureConsole('warn', () => logOcrMonitoringEvent('warn', { signal: 'x' }, {}))
  const err = captureConsole('error', () => logOcrMonitoringEvent('error', { signal: 'y' }, {}))
  assert.equal(warn.length, 1)
  assert.equal(err.length, 1)
  assert.match(warn[0], /OCR_MONITORING/)
  assert.match(err[0], /OCR_MONITORING/)
})

test('logOcrMonitoringEvent never throws when the structured-log sink is unavailable', () => {
  const originalLog = console.log
  console.log = () => { throw new Error('log sink unavailable') }
  try {
    assert.doesNotThrow(() => logOcrMonitoringEvent('info', { signal: 'scan' }, {}))
  } finally {
    console.log = originalLog
  }
})

test('captureOcrProviderFailure reports a DSN-enabled scan failure to Sentry with OCR tags', async () => {
  const { calls, sdk } = makeSentryMock()
  setOcrSentrySdkForTests(sdk)
  try {
    const result = await captureOcrProviderFailure({
      scanId: 'scan-1', requestId: 'req-1', azureStatus: 500,
      attest: 'pass', clientVersion: '2.0.0', kvExtras: 'off', totalMs: 1200,
    }, { SENTRY_DSN: 'https://ocr@example.ingest.sentry.io/1' })

    assert.equal(result, true)
    assert.deepEqual(calls.captureMessage, ['OCR scan provider_error (azure_status=500)'])
    assert.deepEqual(calls.flush, [2_000])
    assert.equal(calls.scopes.length, 1)
    const scope = calls.scopes[0]
    assert.equal(scope.level, 'error')
    assert.equal(scope.tags.surface, 'resplit-currency-api')
    assert.equal(scope.tags.runtime, 'worker')
    assert.equal(scope.tags['monitoring.domain'], 'ocr')
    assert.equal(scope.tags['monitoring.signal'], 'ocr_provider_error')
    assert.equal(scope.tags['request.id'], 'req-1')
    assert.equal(scope.tags['ocr.azure_status'], '500')
    assert.equal(scope.tags['ocr.client_version'], '2.0.0')
    assert.deepEqual(scope.contexts.ocrScan, {
      scanId: 'scan-1', requestId: 'req-1', azureStatus: 500,
      attest: 'pass', kvExtras: 'off', totalMs: 1200,
    })
  } finally {
    resetOcrSentrySdkForTests()
  }
})

test('captureOcrProviderFailure is a no-op (no Sentry) when no DSN is configured', async () => {
  const { calls, sdk } = makeSentryMock()
  setOcrSentrySdkForTests(sdk)
  try {
    const result = await captureOcrProviderFailure({ scanId: 'scan-2', azureStatus: null }, {})
    assert.equal(result, false)
    assert.equal(calls.captureMessage.length, 0)
    assert.equal(calls.flush.length, 0)
    assert.equal(calls.scopes.length, 0)
  } finally {
    resetOcrSentrySdkForTests()
  }
})

test('captureOcrCacheWriteFailure emits one grouped PII-free warning with server correlation only', async () => {
  const { calls, sdk } = makeSentryMock()
  setOcrSentrySdkForTests(sdk)
  try {
    const result = await captureOcrCacheWriteFailure({
      scanId: 'scan-server-generated',
      route: 'analyze',
      requestId: 'CLIENT_REQUEST_ID_MUST_NOT_LEAK',
      clientVersion: 'CLIENT_VERSION_MUST_NOT_LEAK',
      cacheKey: 'CACHE_KEY_MUST_NOT_LEAK',
      error: new Error('RAW_CACHE_ERROR_MUST_NOT_LEAK'),
    }, {
      SENTRY_DSN: 'https://ocr@example.ingest.sentry.io/1',
      SENTRY_RELEASE: 'release-cache-test',
    })

    assert.equal(result, true)
    assert.deepEqual(calls.captureMessage, ['OCR cache write failed'])
    assert.deepEqual(calls.flush, [2_000])
    assert.equal(calls.scopes.length, 1)
    const scope = calls.scopes[0]
    assert.equal(scope.level, 'warning')
    assert.equal(scope.tags['monitoring.signal'], 'ocr_cache_write_failed')
    assert.equal(scope.tags['ocr.route'], 'analyze')
    assert.deepEqual(scope.fingerprint, ['ocr_cache_write_failed'])
    assert.deepEqual(scope.contexts.ocrCacheWrite, {
      scanId: 'scan-server-generated',
      route: 'analyze',
      release: 'release-cache-test',
    })
    assert.doesNotMatch(
      JSON.stringify(calls),
      /CLIENT_REQUEST_ID_MUST_NOT_LEAK|CLIENT_VERSION_MUST_NOT_LEAK|CACHE_KEY_MUST_NOT_LEAK|RAW_CACHE_ERROR_MUST_NOT_LEAK/
    )
  } finally {
    resetOcrSentrySdkForTests()
  }
})

test('captureOcrCacheWriteFailure swallows Sentry scope, capture, and flush failures', async () => {
  const env = { SENTRY_DSN: 'https://ocr@example.ingest.sentry.io/1' }
  const context = { scanId: 'scan-safe', route: 'scan' }
  const failures = [
    {
      withScope() { throw new Error('scope unavailable') },
      captureMessage() {},
      flush() { return Promise.resolve(true) },
    },
    {
      withScope(cb) {
        cb({ setLevel() {}, setTag() {}, setContext() {}, setFingerprint() {} })
      },
      captureMessage() { throw new Error('capture unavailable') },
      flush() { return Promise.resolve(true) },
    },
    {
      withScope(cb) {
        cb({ setLevel() {}, setTag() {}, setContext() {}, setFingerprint() {} })
      },
      captureMessage() {},
      flush() { return Promise.reject(new Error('flush unavailable')) },
    },
  ]

  try {
    for (const sdk of failures) {
      setOcrSentrySdkForTests(sdk)
      assert.equal(await captureOcrCacheWriteFailure(context, env), false)
    }
  } finally {
    resetOcrSentrySdkForTests()
  }
})

test('OCR outcome telemetry swallows Sentry scope, capture, and flush failures', async () => {
  const env = { SENTRY_DSN: 'https://ocr@example.ingest.sentry.io/1' }
  const captures = [
    {
      name: 'provider failure',
      run: () => captureOcrProviderFailure({ scanId: 'scan-provider', azureStatus: 500 }, env),
    },
    {
      name: 'LLM failure',
      run: () => captureOcrLlmFailure({ scanId: 'scan-llm', httpStatus: 500, reason: 'provider_error' }, env),
    },
    {
      name: 'totals divergence',
      run: () => captureOcrTotalsDivergence({ scanId: 'scan-divergence', azureTotal: 12, llmTotal: 14 }, env),
    },
  ]
  const failures = [
    {
      name: 'scope',
      sdk: {
        withScope() { throw new Error('scope unavailable') },
        captureMessage() {},
        flush() { return Promise.resolve(true) },
      },
    },
    {
      name: 'capture',
      sdk: {
        withScope(cb) { cb({ setLevel() {}, setTag() {}, setContext() {} }) },
        captureMessage() { throw new Error('capture unavailable') },
        flush() { return Promise.resolve(true) },
      },
    },
    {
      name: 'flush',
      sdk: {
        withScope(cb) { cb({ setLevel() {}, setTag() {}, setContext() {} }) },
        captureMessage() {},
        flush() { return Promise.reject(new Error('flush unavailable')) },
      },
    },
  ]

  try {
    for (const capture of captures) {
      for (const failure of failures) {
        setOcrSentrySdkForTests(failure.sdk)
        assert.equal(
          await capture.run(),
          false,
          `${capture.name} must fail open when Sentry ${failure.name} fails`,
        )
      }
    }
  } finally {
    resetOcrSentrySdkForTests()
  }
})
