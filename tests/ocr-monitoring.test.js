import { test } from 'node:test'
import assert from 'node:assert/strict'
import { logOcrMonitoringEvent } from '../worker/src/ocr/monitoring.mjs'

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
