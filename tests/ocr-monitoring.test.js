import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  logOcrMonitoringEvent,
  captureOcrProviderFailure,
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
        level: null, tags: {}, contexts: {},
        setLevel(l) { this.level = l },
        setTag(k, v) { this.tags[k] = v },
        setContext(k, v) { this.contexts[k] = v },
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
