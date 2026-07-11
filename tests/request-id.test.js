import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CORRELATION_EXPOSE_HEADERS,
  RESPLIT_TRACE_ID_HEADER,
  REQUEST_ID_HEADER,
  requestCorrelationHeaders,
  resolveRequestId,
} from '../worker/src/request-id.mjs'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

test('resolveRequestId prefers x-resplit-trace-id over x-request-id', () => {
  const request = new Request('https://fx.resplit.app/health', {
    headers: {
      [REQUEST_ID_HEADER]: 'legacy-request-id',
      [RESPLIT_TRACE_ID_HEADER]: 'trace-id-from-client',
    },
  })

  assert.equal(resolveRequestId(request), 'trace-id-from-client')
})

test('resolveRequestId accepts and trims the supported ASCII correlation-id grammar', () => {
  const request = new Request('https://fx.resplit.app/health', {
    headers: {
      [RESPLIT_TRACE_ID_HEADER]: '  trace.Root_01:span-02  ',
    },
  })

  assert.equal(resolveRequestId(request), 'trace.Root_01:span-02')
})

test('resolveRequestId accepts 96 characters and rejects 97', () => {
  const accepted = 'a'.repeat(96)
  const rejected = 'b'.repeat(97)

  assert.equal(resolveRequestId(new Request('https://fx.resplit.app/health', {
    headers: { [RESPLIT_TRACE_ID_HEADER]: accepted },
  })), accepted)

  const generated = resolveRequestId(new Request('https://fx.resplit.app/health', {
    headers: { [RESPLIT_TRACE_ID_HEADER]: rejected },
  }))
  assert.match(generated, UUID_PATTERN)
  assert.notEqual(generated, rejected)
})

test('resolveRequestId rejects spaces, non-ASCII, and control-like input', () => {
  const rejectedValues = [
    'trace id with spaces',
    'trace-ümlaut',
    `trace-${String.fromCharCode(0x1f)}-unit-separator`,
  ]

  for (const rejected of rejectedValues) {
    const generated = resolveRequestId(new Request('https://fx.resplit.app/health', {
      headers: { [RESPLIT_TRACE_ID_HEADER]: rejected },
    }))
    assert.match(generated, UUID_PATTERN)
    assert.notEqual(generated, rejected)
  }
})

test('resolveRequestId falls back to a valid x-request-id when the trace id is invalid', () => {
  const request = new Request('https://fx.resplit.app/health', {
    headers: {
      [RESPLIT_TRACE_ID_HEADER]: 'invalid trace id',
      [REQUEST_ID_HEADER]: 'valid-request-id',
    },
  })

  assert.equal(resolveRequestId(request), 'valid-request-id')
})

test('resolveRequestId mints a UUID when both caller correlation ids are invalid', () => {
  const request = new Request('https://fx.resplit.app/health', {
    headers: {
      [RESPLIT_TRACE_ID_HEADER]: 'invalid trace id',
      [REQUEST_ID_HEADER]: 'invalid/request/id',
    },
  })

  const generated = resolveRequestId(request)
  assert.match(generated, UUID_PATTERN)
  assert.notEqual(generated, 'invalid trace id')
  assert.notEqual(generated, 'invalid/request/id')
})

test('requestCorrelationHeaders emits both correlation headers', () => {
  assert.deepEqual(requestCorrelationHeaders('trace-join-1'), {
    [REQUEST_ID_HEADER]: 'trace-join-1',
    [RESPLIT_TRACE_ID_HEADER]: 'trace-join-1',
    'Access-Control-Expose-Headers': CORRELATION_EXPOSE_HEADERS,
  })
})
