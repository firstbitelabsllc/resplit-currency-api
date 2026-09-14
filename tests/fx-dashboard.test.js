const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const DASHBOARD_PATH = path.join(__dirname, '..', 'grafana', 'dashboards', 'resplit-fx.json')

function loadDashboard() {
  return JSON.parse(fs.readFileSync(DASHBOARD_PATH, 'utf8'))
}

// The FX dashboard is the Cloudflare/JS canonical stack (Phase 3 reconcile,
// 2026-07-03). The old GCP-era panels (Cloud Load Balancing / GCS CDN) can never
// receive data on this stack, so guard against them silently creeping back in.
test('fx dashboard is valid JSON with panels', () => {
  const dashboard = loadDashboard()
  assert.ok(Array.isArray(dashboard.panels) && dashboard.panels.length > 0)
  assert.equal(dashboard.uid, 'resplit-fx')
})

test('fx dashboard has no GCP-only metrics or datasource language', () => {
  const raw = fs.readFileSync(DASHBOARD_PATH, 'utf8')
  assert.equal(/googleapis/i.test(raw), false, 'GCP loadbalancing_googleapis_com metric must be gone')
  assert.equal(/Google Managed Prometheus|Cloud Monitoring/i.test(raw), false, 'GCP datasource description must be reconciled')
  // Legacy GCP label + route conventions that never match Cloudflare Worker series.
  assert.equal(/status_class/.test(raw), false, 'use the {status} label, not GCP {status_class}')
  assert.equal(/route=~\\?"\/fx\.\*\\?"/.test(raw), false, 'route must be the Worker pathname, not the GCP /fx.* path glob')
})

test('fx dashboard only queries the emitted metric contract', () => {
  const raw = fs.readFileSync(DASHBOARD_PATH, 'utf8')
  const used = new Set([...raw.matchAll(/\b(fx_[a-z_]+|http_[a-z_]+)\b/g)].map((m) => m[1]))
  // Contract emitted by the pipeline (OTLP push) + Worker (@microlabs/otel-cf-workers).
  const allowed = new Set([
    'fx_snapshot_age_seconds',
    'fx_source_available',
    'fx_currencies_count',
    'fx_publish_duration_seconds',
    'fx_fallback_served_total',
    'http_requests_total',
    'http_request_duration_seconds',
    'http_request_duration_seconds_bucket'
  ])
  for (const metric of used) {
    assert.ok(allowed.has(metric), `dashboard queries unknown metric "${metric}" — add an emitter or fix the panel`)
  }
  // The freshness dead-man + the fallback trust signal must always be present.
  assert.ok(used.has('fx_snapshot_age_seconds'))
  assert.ok(used.has('fx_fallback_served_total'))
})
