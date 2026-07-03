#!/usr/bin/env node

/**
 * Provision the Resplit FX dashboard + alert rules into Grafana (Phase 4).
 *
 * Idempotent: dashboards upsert by uid via overwrite; alert rules upsert by uid
 * via the provisioning API (PUT). Safe to run repeatedly.
 *
 * Credential model:
 *   --dry-run            validate the spec + print the plan, NO network (works
 *                        with no creds; used by CI/tests as a proof gate).
 *   live (no --dry-run)  requires GRAFANA_BASE_URL + GRAFANA_API_TOKEN (+ a
 *                        Prometheus datasource uid); a hard no-op (exit 0) when
 *                        those are absent so it never fails CI pre-credentials.
 *
 * The Grafana alert-rule provisioning payload has NOT been validated against a
 * live instance yet (that is the credential-gated step); the pure builders below
 * are unit-tested for shape, and the first live `--dry-run` + provision is the
 * acceptance gate.
 */

const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_DASHBOARD = path.join('grafana', 'dashboards', 'resplit-fx.json')
const DEFAULT_ALERTS = path.join('grafana', 'alerts', 'fx-alerts.json')
const DEFAULT_TIMEOUT_MS = 15000

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`provision-grafana: FAILED\n${error.stack || error.message}`)
    process.exitCode = 1
  })
}

async function main(argv, deps = {}) {
  const env = deps.env || process.env
  const fetchImpl = deps.fetch || global.fetch
  const options = parseArgs(argv, env)

  const spec = loadAlertSpec(options.alertsPath)
  validateAlertSpec(spec)
  const dashboard = loadJson(options.dashboardPath)

  const config = resolveConfig(env, spec)
  const plan = buildPlan({ dashboard, spec, config })

  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
    console.log(`provision-grafana: dry-run OK — ${plan.dashboards.length} dashboard(s), ${plan.alertRules.length} alert rule(s) validated.`)
    return
  }

  if (!config.baseUrl || !config.token) {
    console.log('provision-grafana: skipped — GRAFANA_BASE_URL / GRAFANA_API_TOKEN not set. No-op (use --dry-run to validate).')
    return
  }
  if (!config.promDatasourceUid) {
    console.log('provision-grafana: skipped — GRAFANA_PROM_DATASOURCE_UID not set (alert rules need a datasource). No-op.')
    return
  }
  if (typeof fetchImpl !== 'function') {
    console.warn('provision-grafana: fetch unavailable in this runtime; skipping.')
    return
  }

  const results = await applyPlan(fetchImpl, config, plan, options.timeoutMs)
  const failed = results.filter((r) => !r.ok)
  for (const r of results) {
    console.log(`provision-grafana: ${r.ok ? 'OK' : 'FAIL'} ${r.kind} ${r.name}${r.ok ? '' : ` — ${r.error}`}`)
  }
  if (failed.length > 0) {
    throw new Error(`${failed.length} provisioning request(s) failed`)
  }
  console.log(`provision-grafana: applied ${results.length} object(s) to ${config.baseUrl}`)
}

function parseArgs(argv, env = process.env) {
  const options = {
    dryRun: false,
    dashboardPath: env.FX_DASHBOARD_PATH || DEFAULT_DASHBOARD,
    alertsPath: env.FX_ALERTS_PATH || DEFAULT_ALERTS,
    timeoutMs: Number(env.GRAFANA_PROVISION_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--dashboard') options.dashboardPath = argv[++i]
    else if (arg === '--alerts') options.alertsPath = argv[++i]
  }
  return options
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function loadAlertSpec(filePath) {
  return loadJson(filePath)
}

function validateAlertSpec(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('alert spec is not an object')
  if (!Array.isArray(spec.rules) || spec.rules.length === 0) throw new Error('alert spec has no rules')
  const seen = new Set()
  for (const rule of spec.rules) {
    for (const field of ['uid', 'title', 'expr', 'for', 'severity']) {
      if (!rule[field]) throw new Error(`alert rule ${rule.uid || rule.title || '(unknown)'} missing "${field}"`)
    }
    if (seen.has(rule.uid)) throw new Error(`duplicate alert rule uid "${rule.uid}"`)
    seen.add(rule.uid)
    if (!/^\d+[smh]$/.test(rule.for)) throw new Error(`alert rule ${rule.uid} has invalid "for": ${rule.for}`)
    if (!['page', 'warn', 'info'].includes(rule.severity)) throw new Error(`alert rule ${rule.uid} has invalid severity: ${rule.severity}`)
  }
  return true
}

function resolveConfig(env = process.env, spec = {}) {
  return {
    baseUrl: normalizeBaseUrl(firstEnv(env, ['GRAFANA_BASE_URL', 'GRAFANA_URL', 'GRAFANA_CLOUD_URL'])),
    token: firstEnv(env, ['GRAFANA_API_TOKEN', 'GRAFANA_SERVICE_ACCOUNT_TOKEN', 'GRAFANA_TOKEN']),
    promDatasourceUid: firstEnv(env, ['GRAFANA_PROM_DATASOURCE_UID', 'GRAFANA_PROMETHEUS_UID', 'PROM_DATASOURCE_UID']),
    folderUid: firstEnv(env, ['GRAFANA_FX_FOLDER_UID']) || 'resplit-fx',
    folderTitle: spec.folder || 'Resplit FX',
    ruleGroup: spec.ruleGroup || 'resplit-fx',
    intervalSeconds: spec.intervalSeconds || 60
  }
}

function buildPlan({ dashboard, spec, config }) {
  return {
    folder: { uid: config.folderUid, title: config.folderTitle },
    dashboards: [buildDashboardUpsert(dashboard, config.folderUid)],
    alertRules: spec.rules.map((rule) => buildAlertRulePayload(rule, config))
  }
}

function buildDashboardUpsert(dashboard, folderUid) {
  // Grafana import shape: __inputs is stripped and the datasource template var
  // resolves at import; overwrite:true + a stable uid make this idempotent.
  const clean = { ...dashboard }
  delete clean.__inputs
  delete clean.__requires
  clean.id = null
  return { folderUid, overwrite: true, dashboard: clean }
}

/**
 * Translate a clean spec rule into a Grafana provisioning alert-rule payload.
 * Query A runs the instant PromQL (which already embeds the firing comparison,
 * so it yields a value only when breaching); threshold expression C fires when A
 * is present ( > 0 ). Pure + deterministic for unit testing.
 */
function buildAlertRulePayload(rule, config) {
  return {
    uid: rule.uid,
    title: rule.title,
    folderUID: config.folderUid,
    ruleGroup: config.ruleGroup,
    condition: 'C',
    for: rule.for,
    noDataState: rule.noDataState || 'OK',
    execErrState: 'Error',
    labels: { severity: rule.severity, service: 'resplit-fx' },
    annotations: { summary: rule.summary || rule.title, __expr__: rule.expr },
    data: [
      {
        refId: 'A',
        relativeTimeRange: { from: 3600, to: 0 },
        datasourceUid: config.promDatasourceUid,
        model: { refId: 'A', expr: rule.expr, instant: true, intervalMs: 1000, maxDataPoints: 43200 }
      },
      {
        refId: 'C',
        datasourceUid: '__expr__',
        model: {
          refId: 'C',
          type: 'threshold',
          expression: 'A',
          conditions: [{ evaluator: { type: 'gt', params: [0] } }]
        }
      }
    ]
  }
}

async function applyPlan(fetchImpl, config, plan, timeoutMs) {
  const results = []
  for (const dash of plan.dashboards) {
    results.push(
      await request(fetchImpl, config, 'POST', '/api/dashboards/db', dash, timeoutMs, {
        kind: 'dashboard',
        name: dash.dashboard.uid || dash.dashboard.title
      })
    )
  }
  for (const rule of plan.alertRules) {
    // PUT by uid is the idempotent upsert for provisioned alert rules.
    results.push(
      await request(fetchImpl, config, 'PUT', `/api/v1/provisioning/alert-rules/${encodeURIComponent(rule.uid)}`, rule, timeoutMs, {
        kind: 'alert-rule',
        name: rule.title,
        headers: { 'X-Disable-Provenance': 'true' }
      })
    )
  }
  return results
}

async function request(fetchImpl, config, method, apiPath, body, timeoutMs, meta) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT_MS)
  try {
    const response = await fetchImpl(`${config.baseUrl}${apiPath}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.token}`,
        ...(meta.headers || {})
      },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    if (!response.ok) {
      const text = await safeText(response)
      return { ok: false, kind: meta.kind, name: meta.name, status: response.status, error: text || `HTTP ${response.status}` }
    }
    return { ok: true, kind: meta.kind, name: meta.name, status: response.status }
  } catch (error) {
    return { ok: false, kind: meta.kind, name: meta.name, status: null, error: error.message }
  } finally {
    clearTimeout(timer)
  }
}

async function safeText(response) {
  try {
    return (await response.text()).slice(0, 300)
  } catch {
    return null
  }
}

function firstEnv(env, names) {
  for (const name of names) {
    if (env[name]) return env[name]
  }
  return null
}

function normalizeBaseUrl(value) {
  return value ? String(value).replace(/\/+$/, '') : null
}

module.exports = {
  parseArgs,
  validateAlertSpec,
  resolveConfig,
  buildPlan,
  buildDashboardUpsert,
  buildAlertRulePayload
}
