const ENFORCE_MODE = 'enforce'
const MIN_HMAC_KEY_BYTES = 32
const SUBJECT_KINDS = new Set(['attested', 'soft_fail'])

export class OcrAccountingError extends Error {
  constructor(reason) {
    super(reason)
    this.name = 'OcrAccountingError'
    this.reason = reason
  }
}

export function ocrAccountingEnforced(env) {
  return String(env?.OCR_ACCOUNTING_MODE || '').trim().toLowerCase() === ENFORCE_MODE
}

/**
 * Build and atomically reserve one server-owned OCR accounting request.
 * Raw principals are HMACed with a daily domain separator before crossing the
 * Durable Object boundary; the object sees no IP address or App Attest key ID.
 */
export async function reserveOcrAccounting(input) {
  validateInput(input)

  const day = new Date().toISOString().slice(0, 10)
  const subjectToken = await hmacSubjectToken({
    secret: input.env.OCR_ACCOUNTING_HMAC_KEY,
    day,
    principalKind: input.principalKind,
    principal: input.principal,
  })
  const stub = accountingStub(input.env)
  const decision = await stub.reserve({
    day,
    reservationId: input.scanId,
    subjectToken,
    azureUnits: input.azureUnits,
    anthropicUnits: input.anthropicUnits,
    caps: {
      azure: {
        globalDaily: requiredCap(input.env.OCR_AZURE_GLOBAL_DAILY_CAP),
        subjectDaily: input.azureSubjectCap,
      },
      anthropic: {
        globalDaily: requiredCap(input.env.OCR_ANTHROPIC_GLOBAL_DAILY_CAP),
        subjectDaily: input.anthropicSubjectCap,
      },
    },
  })

  if (!validReservationDecision(decision, { day, ...input })) {
    throw new OcrAccountingError('reservation_rejected')
  }
  return { day, reservationId: input.scanId, stub, decision }
}

export async function settleOcrAccounting(reservation, { azureUnits, anthropicUnits }) {
  if (!reservation) return null
  if (!isNonNegativeInteger(azureUnits) || !isNonNegativeInteger(anthropicUnits)) {
    throw new OcrAccountingError('invalid_settlement_units')
  }

  const result = azureUnits === 0 && anthropicUnits === 0
    ? await reservation.stub.refund({
      day: reservation.day,
      reservationId: reservation.reservationId,
    })
    : await reservation.stub.commit({
      day: reservation.day,
      reservationId: reservation.reservationId,
      azureUnits,
      anthropicUnits,
    })

  if (!result?.ok) throw new OcrAccountingError('settlement_rejected')
  return result
}

function validateInput(input) {
  if (!input || !SUBJECT_KINDS.has(input.principalKind)) {
    throw new OcrAccountingError('invalid_subject_kind')
  }
  if (typeof input.principal !== 'string' || input.principal.length === 0) {
    throw new OcrAccountingError('principal_unavailable')
  }
  if (typeof input.scanId !== 'string' || input.scanId.length === 0) {
    throw new OcrAccountingError('scan_id_unavailable')
  }
  for (const value of [
    input.azureUnits,
    input.anthropicUnits,
    input.azureSubjectCap,
    input.anthropicSubjectCap,
  ]) {
    if (!isNonNegativeInteger(value)) {
      throw new OcrAccountingError('invalid_units_or_cap')
    }
  }
}

function accountingStub(env) {
  const namespace = env.OCR_ACCOUNTING
  if (!namespace || typeof namespace.idFromName !== 'function' || typeof namespace.get !== 'function') {
    throw new OcrAccountingError('binding_unavailable')
  }

  // One server-owned rendezvous point makes global admission atomic. UTC day is
  // reservation data rather than object identity, preventing per-day split brain.
  const id = namespace.idFromName('ocr-accounting-global-v1')
  const stub = namespace.get(id)
  if (
    !stub ||
    typeof stub.reserve !== 'function' ||
    typeof stub.commit !== 'function' ||
    typeof stub.refund !== 'function'
  ) {
    throw new OcrAccountingError('stub_unavailable')
  }
  return stub
}

async function hmacSubjectToken({ secret, day, principalKind, principal }) {
  const secretBytes = new TextEncoder().encode(String(secret || ''))
  if (secretBytes.length < MIN_HMAC_KEY_BYTES) {
    throw new OcrAccountingError('hmac_key_unavailable')
  }

  const key = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const message = new TextEncoder().encode(
    `ocr-accounting:v1\0${day}\0${principalKind}\0${principal}`
  )
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, message))
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function requiredCap(value) {
  const normalized = String(value ?? '').trim()
  if (!/^\d+$/.test(normalized)) throw new OcrAccountingError('global_cap_unavailable')
  const parsed = Number(normalized)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new OcrAccountingError('global_cap_unavailable')
  }
  return parsed
}

function validReservationDecision(decision, request) {
  return Boolean(
    decision?.ok === true &&
    decision.day === request.day &&
    decision.reservationId === request.scanId &&
    decision.azure?.requestedUnits === request.azureUnits &&
    typeof decision.azure?.allowed === 'boolean' &&
    decision.anthropic?.requestedUnits === request.anthropicUnits &&
    typeof decision.anthropic?.allowed === 'boolean'
  )
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}
