import { errorResponse } from '../http.mjs'
import { logOcrMonitoringEvent } from './monitoring.mjs'

export const DEFAULT_OCR_MAX_INGRESS_BYTES = 10 * 1024 * 1024
const MIN_COMPATIBLE_OCR_MAX_INGRESS_BYTES = 2_000 * 1024

/**
 * Read an OCR image without allowing a request to exceed the Worker's safe
 * ingress budget. The declared length is an early-rejection hint only; actual
 * bytes remain authoritative because clients and intermediaries can omit or
 * misstate Content-Length.
 *
 * @param {Request} request
 * @param {Record<string, any>} env
 * @param {{ route: string, requestId: string, clientVersion: string, responseHeaders: HeadersInit }} context
 * @returns {Promise<{ ok: true, imageBytes: Uint8Array } | { ok: false, response: Response }>}
 */
export async function readOcrImageWithinBudget(request, env, context) {
  const max = resolveOcrMaxIngressBytes(env?.OCR_MAX_INGRESS_BYTES)
  const declared = parseDeclaredLength(request.headers.get('content-length'))

  if (declared && declared.value > BigInt(max)) {
    return rejectOversizedImage(env, context, {
      sizeSource: 'declared',
      size: declared.telemetryValue,
      max,
    })
  }

  const imageBytes = new Uint8Array(await request.arrayBuffer())
  if (imageBytes.byteLength > max) {
    return rejectOversizedImage(env, context, {
      sizeSource: 'actual',
      size: imageBytes.byteLength,
      max,
    })
  }

  return { ok: true, imageBytes }
}

/**
 * An operator may lower the cap, but cannot go below the installed iOS clients'
 * 2,000 KiB preprocessing budget or above the server-safe 10 MiB ceiling.
 * Missing, malformed, fractional, or out-of-range values fail closed to the
 * ceiling instead of disabling the guard or bricking past builds.
 *
 * @param {unknown} configured
 * @returns {number}
 */
export function resolveOcrMaxIngressBytes(configured) {
  if (configured == null) return DEFAULT_OCR_MAX_INGRESS_BYTES
  const raw = String(configured).trim()
  if (!/^[1-9]\d*$/.test(raw)) return DEFAULT_OCR_MAX_INGRESS_BYTES
  const parsed = Number(raw)
  if (
    !Number.isSafeInteger(parsed)
    || parsed < MIN_COMPATIBLE_OCR_MAX_INGRESS_BYTES
    || parsed > DEFAULT_OCR_MAX_INGRESS_BYTES
  ) {
    return DEFAULT_OCR_MAX_INGRESS_BYTES
  }
  return parsed
}

function parseDeclaredLength(rawValue) {
  const raw = rawValue?.trim()
  if (!raw || !/^\d+$/.test(raw)) return null
  const value = BigInt(raw)
  return {
    value,
    telemetryValue: value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : raw,
  }
}

function rejectOversizedImage(env, context, { sizeSource, size, max }) {
  logOcrMonitoringEvent('warn', {
    signal: 'ocr_ingress_rejected',
    route: context.route,
    phase: 'ingress',
    status: 'payload_too_large',
    client_version: context.clientVersion,
    size_source: sizeSource,
    declared_or_actual_size: size,
    max,
    requestId: context.requestId,
  }, env)

  return {
    ok: false,
    response: errorResponse(
      'OCR_PAYLOAD_TOO_LARGE',
      `OCR image exceeds the ${max} byte limit`,
      413,
      context.requestId,
      context.responseHeaders,
    ),
  }
}
