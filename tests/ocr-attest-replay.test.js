import test from 'node:test'
import assert from 'node:assert/strict'
import {
  advanceAppAttestSignCount,
} from '../worker/src/ocr/attest-replay.mjs'
import { AttestReplayStoreError } from '../worker/src/ocr/attest.mjs'

function binding(handler) {
  const calls = { names: [], inputs: [] }
  return {
    calls,
    idFromName(name) {
      calls.names.push(name)
      return name
    },
    get() {
      return {
        async advanceAppAttestSignCount(input) {
          calls.inputs.push(structuredClone(input))
          return handler(input)
        },
      }
    },
  }
}

test('App Attest replay RPC sends only a SHA-256 key token and exact counter floor', async () => {
  const namespace = binding(({ signCount }) => ({ ok: true, signCount }))
  const accepted = await advanceAppAttestSignCount({
    env: { OCR_ACCOUNTING: namespace },
    keyId: 'raw-key-id-must-not-cross',
    previousSignCount: 7,
    signCount: 8,
  })

  assert.equal(accepted, true)
  assert.deepEqual(namespace.calls.names, ['ocr-accounting-global-v1'])
  assert.equal(namespace.calls.inputs.length, 1)
  assert.deepEqual(Object.keys(namespace.calls.inputs[0]).sort(), [
    'keyToken',
    'previousSignCount',
    'signCount',
  ])
  assert.match(namespace.calls.inputs[0].keyToken, /^[0-9a-f]{64}$/)
  assert.equal(JSON.stringify(namespace.calls.inputs).includes('raw-key-id-must-not-cross'), false)
  assert.equal(namespace.calls.inputs[0].previousSignCount, 7)
  assert.equal(namespace.calls.inputs[0].signCount, 8)
})

test('App Attest replay RPC preserves a typed replay decision', async () => {
  const namespace = binding(() => ({ ok: false, error: 'REPLAY', signCount: 9 }))
  assert.equal(await advanceAppAttestSignCount({
    env: { OCR_ACCOUNTING: namespace },
    keyId: 'device',
    previousSignCount: 8,
    signCount: 9,
  }), false)
})

test('App Attest replay RPC fails closed on missing binding, outage, or malformed response', async () => {
  const cases = [
    {},
    { OCR_ACCOUNTING: binding(() => { throw new Error('offline') }) },
    { OCR_ACCOUNTING: binding(() => ({ ok: true, signCount: 999 })) },
    { OCR_ACCOUNTING: binding(() => ({ ok: false, error: 'UNKNOWN' })) },
  ]
  for (const env of cases) {
    await assert.rejects(
      () => advanceAppAttestSignCount({
        env,
        keyId: 'device',
        previousSignCount: 0,
        signCount: 1,
      }),
      (error) => error instanceof AttestReplayStoreError
    )
  }
})
