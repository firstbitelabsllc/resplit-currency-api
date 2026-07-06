// OCR proxy structured logging → Cloudflare Workers Observability → Grafana
// (Loki `grafana-logs-prod`). Mirrors the proven `logFxMonitoringEvent` shape in
// ../monitoring.mjs so the OCR path shows up on the same Grafana datasource the
// FX path already uses. Every line is a single `[OCR_MONITORING] {json}` record,
// queryable in Loki by field (outcome / latency_ms / azure_status / device_id),
// which is what renders the "online charts" (scan volume, p95, error rate,
// per-device abuse) without any new monitoring stack.
//
// Sentry leg: a scan that returns the `provider_error` 502 (Azure submit failed,
// polling exhausted, or Azure reported `failed`) is the user-facing "receipt scan
// failed" error-state — the money/scan path. The Loki log alone is not trendable,
// alertable, or release-correlated in Sentry the way the FX path's 502 already is
// (see `captureFxRouteFailure`). `captureOcrProviderFailure` closes that gap so a
// prod scan failure surfaces as a Sentry issue, never just a buried log line.

import * as Sentry from '@sentry/cloudflare'

const SURFACE = 'resplit-currency-api'
const DOMAIN = 'ocr'

let sentrySdk = Sentry

/** Test seam — mirrors monitoring.mjs's `setSentryWorkerSdkForTests`. */
export function setOcrSentrySdkForTests(mock) {
  sentrySdk = mock
}

export function resetOcrSentrySdkForTests() {
  sentrySdk = Sentry
}

/**
 * @param {{ SENTRY_DSN?: string }} env
 * @returns {boolean}
 */
function isOcrSentryEnabled(env) {
  return Boolean(env && env.SENTRY_DSN)
}

/**
 * @param {{ SENTRY_ENVIRONMENT?: string, SENTRY_RELEASE?: string }} env
 * @returns {{ surface: string, runtime: string, environment: string, release: string | null }}
 */
function runtimeMetadata(env) {
  return {
    surface: SURFACE,
    runtime: 'worker',
    environment: env.SENTRY_ENVIRONMENT || 'production',
    release: env.SENTRY_RELEASE || null,
  }
}

/**
 * Emit one structured OCR telemetry line. Fields land as Loki labels/fields and
 * drive the Grafana OCR dashboard. Never log image bytes or the Azure key.
 *
 * @param {'info' | 'warn' | 'error'} level
 * @param {Record<string, unknown>} event - e.g. { signal, scan_id, device_id, outcome, latency_ms, azure_status, attest }
 * @param {{ SENTRY_ENVIRONMENT?: string, SENTRY_RELEASE?: string }} env
 */
export function logOcrMonitoringEvent(level, event, env) {
  const meta = runtimeMetadata(env)
  const line = `[OCR_MONITORING] ${JSON.stringify({
    timestamp: new Date().toISOString(),
    surface: meta.surface,
    runtime: meta.runtime,
    environment: meta.environment,
    release: meta.release,
    domain: DOMAIN,
    ...event,
  })}`

  switch (level) {
  case 'info':
    console.log(line)
    break
  case 'warn':
    console.warn(line)
    break
  case 'error':
    console.error(line)
    break
  }
}

/**
 * Report a scan that ended in the `provider_error` 502 to Sentry (in addition to
 * the structured Loki line `finishScan` already emits). Uses `captureMessage`
 * (not `captureException`): a `provider_error` is a controlled degraded outcome,
 * not a thrown JS error — the same precedent the FX canary uses. PII-safe: never
 * carries image bytes, the Azure key, or device identifiers.
 *
 * @param {{
 *   scanId: string
 *   requestId?: string
 *   azureStatus?: number | null
 *   attest?: string
 *   clientVersion?: string
 *   kvExtras?: string
 *   totalMs?: number
 * }} context
 * @param {{ SENTRY_DSN?: string, SENTRY_ENVIRONMENT?: string, SENTRY_RELEASE?: string }} env
 * @returns {Promise<boolean>} true when the failure was reported to Sentry
 */
export async function captureOcrProviderFailure(context, env) {
  if (!isOcrSentryEnabled(env)) {
    return false
  }

  sentrySdk.withScope(scope => {
    scope.setLevel('error')
    scope.setTag('surface', SURFACE)
    scope.setTag('runtime', 'worker')
    scope.setTag('monitoring.domain', DOMAIN)
    scope.setTag('monitoring.signal', 'ocr_provider_error')
    if (context.requestId) {
      scope.setTag('request.id', context.requestId)
    }
    if (context.azureStatus != null) {
      scope.setTag('ocr.azure_status', String(context.azureStatus))
    }
    if (context.clientVersion) {
      scope.setTag('ocr.client_version', context.clientVersion)
    }
    scope.setContext('ocrScan', {
      scanId: context.scanId,
      requestId: context.requestId,
      azureStatus: context.azureStatus ?? null,
      attest: context.attest,
      kvExtras: context.kvExtras,
      totalMs: context.totalMs,
    })
    sentrySdk.captureMessage(
      `OCR scan provider_error (azure_status=${context.azureStatus ?? 'unknown'})`
    )
  })

  return sentrySdk.flush(2_000)
}

/**
 * Report a failed /ocr/dual-scan LLM (Anthropic) leg to Sentry — the paid leg's
 * error observability. Fires when the LLM leg ends in `provider_error`, which
 * covers an Anthropic API error, a truncated tool_use (`llm_truncated`), a
 * server-side schema violation (`llm_schema_violation:*`), or a timeout. The
 * `reason` carries that discriminator so the paid leg's failure modes are
 * trendable/alertable, not silent. PII-safe: no image bytes, no API key.
 *
 * @param {{
 *   scanId: string
 *   requestId?: string
 *   llmStatus?: string
 *   httpStatus?: number | null
 *   reason?: string | null
 *   model?: string
 *   attest?: string
 *   clientVersion?: string
 *   totalMs?: number
 * }} context
 * @param {{ SENTRY_DSN?: string, SENTRY_ENVIRONMENT?: string, SENTRY_RELEASE?: string }} env
 * @returns {Promise<boolean>} true when the failure was reported to Sentry
 */
export async function captureOcrLlmFailure(context, env) {
  if (!isOcrSentryEnabled(env)) {
    return false
  }

  sentrySdk.withScope(scope => {
    scope.setLevel('error')
    scope.setTag('surface', SURFACE)
    scope.setTag('runtime', 'worker')
    scope.setTag('monitoring.domain', DOMAIN)
    scope.setTag('monitoring.signal', 'ocr_llm_error')
    if (context.requestId) {
      scope.setTag('request.id', context.requestId)
    }
    if (context.httpStatus != null) {
      scope.setTag('ocr.llm_status', String(context.httpStatus))
    }
    if (context.model) {
      scope.setTag('ocr.llm_model', context.model)
    }
    if (context.reason) {
      scope.setTag('ocr.llm_reason', context.reason)
    }
    if (context.clientVersion) {
      scope.setTag('ocr.client_version', context.clientVersion)
    }
    scope.setContext('ocrLlmScan', {
      scanId: context.scanId,
      requestId: context.requestId,
      llmStatus: context.llmStatus ?? null,
      httpStatus: context.httpStatus ?? null,
      reason: context.reason ?? null,
      model: context.model ?? null,
      attest: context.attest,
      totalMs: context.totalMs,
    })
    sentrySdk.captureMessage(
      `OCR dual-scan llm_error (reason=${context.reason ?? 'unknown'}, http=${context.httpStatus ?? 'unknown'})`
    )
  })

  return sentrySdk.flush(2_000)
}
