// OCR proxy structured logging → Cloudflare Workers Observability → Grafana
// (Loki `grafana-logs-prod`). Mirrors the proven `logFxMonitoringEvent` shape in
// ../monitoring.mjs so the OCR path shows up on the same Grafana datasource the
// FX path already uses. Every line is a single `[OCR_MONITORING] {json}` record,
// queryable in Loki by field (outcome / latency_ms / azure_status / device_id),
// which is what renders the "online charts" (scan volume, p95, error rate,
// per-device abuse) without any new monitoring stack.

const SURFACE = 'resplit-currency-api'
const DOMAIN = 'ocr'

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
