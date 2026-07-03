const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  validateAlertSpec,
  resolveConfig,
  buildPlan,
  buildDashboardUpsert,
  buildAlertRulePayload
} = require('../scripts/provision-grafana')

const SPEC_PATH = path.join(__dirname, '..', 'grafana', 'alerts', 'fx-alerts.json')
const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'))
const dashboard = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'grafana', 'dashboards', 'resplit-fx.json'), 'utf8'))

test('shipped fx-alerts spec is valid and carries exactly the 3 plan alerts', () => {
  assert.equal(validateAlertSpec(spec), true)
  const uids = spec.rules.map((r) => r.uid).sort()
  assert.deepEqual(uids, ['fx-fallback-share', 'fx-read-slo-fast-burn', 'fx-snapshot-stale'])
})

test('validateAlertSpec rejects duplicate uids, bad "for", and unknown severity', () => {
  assert.throws(() => validateAlertSpec({ rules: [] }), /no rules/)
  assert.throws(
    () => validateAlertSpec({ rules: [{ uid: 'a', title: 'A', expr: 'x', for: '10m', severity: 'page' }, { uid: 'a', title: 'B', expr: 'y', for: '5m', severity: 'page' }] }),
    /duplicate/
  )
  assert.throws(
    () => validateAlertSpec({ rules: [{ uid: 'a', title: 'A', expr: 'x', for: 'ten', severity: 'page' }] }),
    /invalid "for"/
  )
  assert.throws(
    () => validateAlertSpec({ rules: [{ uid: 'a', title: 'A', expr: 'x', for: '10m', severity: 'critical' }] }),
    /invalid severity/
  )
})

test('resolveConfig no-ops cleanly with no env and reads spec folder/group defaults', () => {
  const config = resolveConfig({}, spec)
  assert.equal(config.baseUrl, null)
  assert.equal(config.token, null)
  assert.equal(config.promDatasourceUid, null)
  assert.equal(config.folderTitle, 'Resplit FX')
  assert.equal(config.ruleGroup, 'resplit-fx')
})

test('buildDashboardUpsert is an idempotent overwrite that strips import inputs', () => {
  const upsert = buildDashboardUpsert(dashboard, 'resplit-fx')
  assert.equal(upsert.overwrite, true)
  assert.equal(upsert.folderUid, 'resplit-fx')
  assert.equal(upsert.dashboard.__inputs, undefined)
  assert.equal(upsert.dashboard.id, null)
  assert.equal(upsert.dashboard.uid, 'resplit-fx')
})

test('buildAlertRulePayload produces a Grafana-shaped rule with threshold condition C', () => {
  const config = resolveConfig({ GRAFANA_PROM_DATASOURCE_UID: 'prom-uid' }, spec)
  const stale = spec.rules.find((r) => r.uid === 'fx-snapshot-stale')
  const payload = buildAlertRulePayload(stale, config)

  assert.equal(payload.uid, 'fx-snapshot-stale')
  assert.equal(payload.title, 'FXSnapshotStale')
  assert.equal(payload.for, '10m')
  assert.equal(payload.condition, 'C')
  assert.equal(payload.noDataState, 'Alerting') // dead-man: missing metric must page
  assert.equal(payload.labels.severity, 'page')

  const queryA = payload.data.find((d) => d.refId === 'A')
  assert.equal(queryA.datasourceUid, 'prom-uid')
  assert.equal(queryA.model.expr, stale.expr)
  assert.equal(queryA.model.instant, true)

  const condC = payload.data.find((d) => d.refId === 'C')
  assert.equal(condC.datasourceUid, '__expr__')
  assert.equal(condC.model.conditions[0].evaluator.type, 'gt')
})

test('fast-burn rule defaults noDataState to OK (no traffic is not an error)', () => {
  const config = resolveConfig({ GRAFANA_PROM_DATASOURCE_UID: 'prom-uid' }, spec)
  const burn = spec.rules.find((r) => r.uid === 'fx-read-slo-fast-burn')
  const payload = buildAlertRulePayload(burn, config)
  assert.equal(payload.noDataState, 'OK')
  // multi-window: expr references both 5m and 1h ranges.
  assert.match(burn.expr, /\[5m\]/)
  assert.match(burn.expr, /\[1h\]/)
})

test('buildPlan bundles the dashboard + one payload per alert rule', () => {
  const config = resolveConfig({ GRAFANA_PROM_DATASOURCE_UID: 'prom-uid' }, spec)
  const plan = buildPlan({ dashboard, spec, config })
  assert.equal(plan.dashboards.length, 1)
  assert.equal(plan.alertRules.length, spec.rules.length)
  assert.equal(plan.folder.title, 'Resplit FX')
})

test('alert exprs reference only metrics the dashboard/emitters produce', () => {
  const dashRaw = fs.readFileSync(path.join(__dirname, '..', 'grafana', 'dashboards', 'resplit-fx.json'), 'utf8')
  const allowed = new Set([...dashRaw.matchAll(/\b(fx_[a-z_]+|http_[a-z_]+)\b/g)].map((m) => m[1]))
  for (const rule of spec.rules) {
    const used = new Set([...rule.expr.matchAll(/\b(fx_[a-z_]+|http_[a-z_]+)\b/g)].map((m) => m[1]))
    for (const metric of used) {
      assert.ok(allowed.has(metric), `alert ${rule.uid} uses metric ${metric} not present on the dashboard/emitter contract`)
    }
  }
})
