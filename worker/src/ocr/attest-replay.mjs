import { AttestReplayStoreError } from './attest.mjs'

const GLOBAL_OCR_STATE_OBJECT = 'ocr-accounting-global-v1'

/**
 * Atomically advances an App Attest signCount before cache or paid provider
 * work. The raw key ID stays outside the Durable Object; its SHA-256 token is
 * only a stable routing-independent database key, never a reversible identity.
 */
export async function advanceAppAttestSignCount({
  env,
  keyId,
  previousSignCount,
  signCount,
}) {
  const stub = replayStub(env)
  const keyToken = await sha256Hex(new TextEncoder().encode(keyId))
  let decision
  try {
    decision = await stub.advanceAppAttestSignCount({
      keyToken,
      previousSignCount,
      signCount,
    })
  } catch {
    throw new AttestReplayStoreError('rpc_unavailable')
  }

  if (
    decision?.ok === true &&
    decision.signCount === signCount
  ) {
    return true
  }
  if (
    decision?.ok === false &&
    decision.error === 'REPLAY' &&
    Number.isSafeInteger(decision.signCount) &&
    decision.signCount >= previousSignCount
  ) {
    return false
  }
  throw new AttestReplayStoreError('invalid_decision')
}

function replayStub(env) {
  const namespace = env?.OCR_ACCOUNTING
  if (!namespace || typeof namespace.idFromName !== 'function' || typeof namespace.get !== 'function') {
    throw new AttestReplayStoreError('binding_unavailable')
  }
  const stub = namespace.get(namespace.idFromName(GLOBAL_OCR_STATE_OBJECT))
  if (!stub || typeof stub.advanceAppAttestSignCount !== 'function') {
    throw new AttestReplayStoreError('stub_unavailable')
  }
  return stub
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
