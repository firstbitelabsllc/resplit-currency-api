import { logOcrMonitoringEvent } from './monitoring.mjs'

const SHADOW_MODE = 'shadow'
const MIN_HMAC_KEY_BYTES = 32
const DEFAULT_AZURE_GLOBAL_DAILY_CAP = 6_000
const DEFAULT_ANTHROPIC_GLOBAL_DAILY_CAP = 3_000
const SUBJECT_KINDS = new Set(['attested', 'soft_fail'])

class ShadowConfigurationError extends Error {
  constructor(reason) {
    super(reason)
    this.reason = reason
  }
}

/**
 * Schedule a non-enforcing OCR accounting observation after a cache miss.
 *
 * The helper is deliberately inert unless OCR_ACCOUNTING_MODE is exactly
 * "shadow". Every failure is converted to a bounded, identity-free warning;
 * neither the response nor provider execution can depend on this path.
 *
 * @param {{
 *   env: Record<string, any>,
 *   ctx?: ExecutionContext,
 *   route: 'scan' | 'dual-scan' | 'analyze',
 *   requestId?: string,
 *   scanId: string,
 *   principalKind: 'attested' | 'soft_fail',
 *   principal: string,
 *   azureUnits: number,
 *   anthropicUnits: number,
 *   azureSubjectCap: number,
 *   anthropicSubjectCap: number,
 * }} input
 * @returns {boolean} true when a shadow task was handed to ExecutionContext
 */
export function scheduleOcrAccountingShadow(input) {
  if (String(input?.env?.OCR_ACCOUNTING_MODE || '').trim().toLowerCase() !== SHADOW_MODE) {
    return false
  }

  if (!input?.ctx || typeof input.ctx.waitUntil !== 'function') {
    logShadowFailure(input, 'execution_context_unavailable')
    return false
  }

  const task = recordShadowReservation(input).catch((error) => {
    const reason = error instanceof ShadowConfigurationError ? error.reason : 'reservation_failed'
    logShadowFailure(input, reason)
  })

  try {
    input.ctx.waitUntil(task)
    return true
  } catch {
    logShadowFailure(input, 'wait_until_failed')
    return false
  }
}

async function recordShadowReservation(input) {
  validateInput(input)

  const day = new Date().toISOString().slice(0, 10)
  const subjectToken = await hmacSubjectToken({
    secret: input.env.OCR_ACCOUNTING_HMAC_KEY,
    day,
    principalKind: input.principalKind,
    principal: input.principal,
  })
  const namespace = input.env.OCR_ACCOUNTING
  if (!namespace || typeof namespace.idFromName !== 'function' || typeof namespace.get !== 'function') {
    throw new ShadowConfigurationError('binding_unavailable')
  }

  // A single server-owned rendezvous point keeps the global cap atomic. UTC day
  // is reservation data, never part of the object identity or client input.
  const id = namespace.idFromName('ocr-accounting-global-v1')
  const stub = namespace.get(id)
  if (!stub || typeof stub.reserve !== 'function') {
    throw new ShadowConfigurationError('stub_unavailable')
  }

  const decision = await stub.reserve({
    day,
    reservationId: input.scanId,
    subjectToken,
    azureUnits: input.azureUnits,
    anthropicUnits: input.anthropicUnits,
    caps: {
      azure: {
        globalDaily: resolveCap(input.env.OCR_AZURE_GLOBAL_DAILY_CAP, DEFAULT_AZURE_GLOBAL_DAILY_CAP),
        subjectDaily: input.azureSubjectCap,
      },
      anthropic: {
        globalDaily: resolveCap(
          input.env.OCR_ANTHROPIC_GLOBAL_DAILY_CAP ?? input.env.LLM_SCAN_DAILY_CAP,
          DEFAULT_ANTHROPIC_GLOBAL_DAILY_CAP
        ),
        subjectDaily: input.anthropicSubjectCap,
      },
    },
  })

  if (!decision?.ok) {
    throw new ShadowConfigurationError('reservation_rejected')
  }

  const status = shadowStatus(decision, input)
  logOcrMonitoringEvent(status === 'would_allow' ? 'info' : 'warn', {
    signal: 'ocr_accounting_shadow',
    phase: 'accounting',
    route: input.route,
    status,
    enforced: false,
    day,
    azure_units_requested: input.azureUnits,
    anthropic_units_requested: input.anthropicUnits,
    azure_allowed: decision.azure?.allowed === true,
    anthropic_allowed: decision.anthropic?.allowed === true,
    global_azure_units: safeUsage(decision.usage?.global?.azureUnits),
    global_anthropic_units: safeUsage(decision.usage?.global?.anthropicUnits),
    subject_azure_units: safeUsage(decision.usage?.subject?.azureUnits),
    subject_anthropic_units: safeUsage(decision.usage?.subject?.anthropicUnits),
    scanId: input.scanId,
    requestId: input.requestId,
  }, input.env)
}

function validateInput(input) {
  if (!input || !SUBJECT_KINDS.has(input.principalKind)) {
    throw new ShadowConfigurationError('invalid_subject_kind')
  }
  if (typeof input.principal !== 'string' || input.principal.length === 0) {
    throw new ShadowConfigurationError('principal_unavailable')
  }
  if (typeof input.scanId !== 'string' || input.scanId.length === 0) {
    throw new ShadowConfigurationError('scan_id_unavailable')
  }
  for (const value of [input.azureUnits, input.anthropicUnits, input.azureSubjectCap, input.anthropicSubjectCap]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ShadowConfigurationError('invalid_units_or_cap')
    }
  }
}

async function hmacSubjectToken({ secret, day, principalKind, principal }) {
  const secretBytes = new TextEncoder().encode(String(secret || ''))
  if (secretBytes.length < MIN_HMAC_KEY_BYTES) {
    throw new ShadowConfigurationError('hmac_key_unavailable')
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

function shadowStatus(decision, input) {
  const azureAllowed = input.azureUnits === 0 || decision.azure?.allowed === true
  const anthropicAllowed = input.anthropicUnits === 0 || decision.anthropic?.allowed === true
  if (azureAllowed && anthropicAllowed) return 'would_allow'
  if (azureAllowed || anthropicAllowed) return 'would_partially_allow'
  return 'would_block'
}

function resolveCap(value, fallback) {
  const normalized = String(value ?? '').trim()
  if (!/^\d+$/.test(normalized)) return fallback
  const parsed = Number(normalized)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback
}

function safeUsage(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function logShadowFailure(input, reason) {
  try {
    logOcrMonitoringEvent('warn', {
      signal: 'ocr_accounting_shadow_failure',
      phase: 'accounting',
      route: input?.route || 'unknown',
      status: 'degraded',
      reason,
      enforced: false,
    }, input?.env || {})
  } catch {
    // Accounting is observational in shadow mode. A broken telemetry sink must
    // never change the OCR response or provider path.
  }
}
