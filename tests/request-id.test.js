import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CORRELATION_EXPOSE_HEADERS,
  RESPLIT_TRACE_ID_HEADER,
  REQUEST_ID_HEADER,
  requestCorrelationHeaders,
  resolveRequestId,
} from '../worker/src/request-id.mjs'

test('resolveRequestId prefers x-resplit-trace-id over x-request-id', () => {
  const request = new Request('https://fx.resplit.app/health', {
    headers: {
      [REQUEST_ID_HEADER]: 'legacy-request-id',
      [RESPLIT_TRACE_ID_HEADER]: 'trace-id-from-client',
    },
  })

  assert.equal(resolveRequestId(request), 'trace-id-from-client')
})

test('requestCorrelationHeaders emits both correlation headers', () => {
  assert.deepEqual(requestCorrelationHeaders('trace-join-1'), {
    [REQUEST_ID_HEADER]: 'trace-join-1',
    [RESPLIT_TRACE_ID_HEADER]: 'trace-join-1',
    'Access-Control-Expose-Headers': CORRELATION_EXPOSE_HEADERS,
  })
})
