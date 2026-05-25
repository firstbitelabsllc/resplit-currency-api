const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  EXPECTED_LAUNCH_AUDIT_IDS,
  auditCockpitCompletion,
  buildCompletionAudit,
  parseArgs,
} = require('../scripts/reliability-completion-audit.js')

test('parseArgs reads the generated reliability cockpit by default', () => {
  const options = parseArgs([])

  assert.equal(options.json, path.join('reports', 'resplit-fx-reliability-cockpit.json'))
  assert.equal(options.printJson, false)
})

test('buildCompletionAudit passes only when every launch boundary and trust contract is green', () => {
  const report = buildCompletionAudit({
    checkedAt: '2026-05-25T15:00:00.000Z',
    cockpitPath: '/tmp/reports/resplit-fx-reliability-cockpit.json',
    cockpit: buildCockpit(),
  })

  assert.equal(report.status, 'green')
  assert.match(report.summary, /Launch completion audit is green/)
  assert.equal(report.blockers.length, 0)
  assert.equal(report.nonGreenContracts.length, 0)
})

test('buildCompletionAudit blocks launch trust when loaded host and Grafana proof are not green', () => {
  const cockpit = buildCockpit()
  cockpit.verdict = { status: 'red', label: 'RED - missing required trust contract' }
  setAuditRow(cockpit, 'loaded-agent-mcp', {
    status: 'red',
    claimAllowed: false,
    gap: 'Loaded MCP host is missing FX lanes.',
    nextAction: 'Restart host and capture list_lanes.',
  })
  setAuditRow(cockpit, 'otel-grafana-proof', {
    status: 'yellow',
    claimAllowed: false,
    gap: 'Tempo/Loki evidence is missing.',
    nextAction: 'Run npm run observability:otel-smoke.',
  })
  cockpit.trustModel.contracts.find(contract => contract.gate === 'Loaded MCP host catalog').status = 'red'
  cockpit.trustModel.contracts.find(contract => contract.gate === 'OTEL/Grafana evidence').status = 'yellow'
  cockpit.trustModel.launchTrustAudit.status = 'red'

  const report = buildCompletionAudit({
    checkedAt: '2026-05-25T15:00:00.000Z',
    cockpitPath: '/tmp/reports/resplit-fx-reliability-cockpit.json',
    cockpit,
  })

  assert.equal(report.status, 'red')
  assert.match(report.summary, /Launch completion blocked/)
  assert.deepEqual(report.blockers.map(blocker => blocker.id), ['loaded-agent-mcp', 'otel-grafana-proof'])
  assert.deepEqual(report.nonGreenContracts.map(contract => contract.gate), ['Loaded MCP host catalog', 'OTEL/Grafana evidence'])
})

test('auditCockpitCompletion reads the report from disk', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-completion-audit-'))
  fs.mkdirSync(path.join(repoDir, 'reports'), { recursive: true })
  fs.writeFileSync(
    path.join(repoDir, 'reports', 'resplit-fx-reliability-cockpit.json'),
    `${JSON.stringify(buildCockpit(), null, 2)}\n`,
  )

  const result = auditCockpitCompletion(['--repo', repoDir], {
    now: () => '2026-05-25T15:00:00.000Z',
  })

  assert.equal(result.report.status, 'green')
  assert.equal(result.report.checkedAt, '2026-05-25T15:00:00.000Z')
})

test('buildCompletionAudit treats missing launch audit rows as launch-blocking', () => {
  const cockpit = buildCockpit()
  cockpit.trustModel.launchTrustAudit.rows = cockpit.trustModel.launchTrustAudit.rows
    .filter(row => row.id !== 'peer-execution')
  cockpit.trustModel.launchTrustAudit.status = 'red'

  const report = buildCompletionAudit({
    checkedAt: '2026-05-25T15:00:00.000Z',
    cockpitPath: '/tmp/reports/resplit-fx-reliability-cockpit.json',
    cockpit,
  })

  assert.equal(report.status, 'red')
  assert.deepEqual(report.launchTrustAudit.missingRows, ['peer-execution'])
  assert.match(report.failures.join('\n'), /missing launch audit row: peer-execution/)
})

function buildCockpit() {
  return {
    verdict: {
      status: 'green',
      label: 'GREEN - current local trust gates are declared and proven',
    },
    trustModel: {
      launchTrustAudit: {
        status: 'green',
        summary: 'All launch-trust boundaries are claim-allowed.',
        rows: EXPECTED_LAUNCH_AUDIT_IDS.map(id => ({
          id,
          surface: id.replace(/-/g, ' '),
          boundary: 'test',
          owner: 'test owner',
          status: 'green',
          claimAllowed: true,
          evidence: `/tmp/${id}.json`,
          gap: 'No gap.',
          nextAction: 'Keep proof fresh.',
        })),
      },
      contracts: [
        'Primary checkout',
        'Tracked local-CI contract',
        'Clean proof targetability',
        'Source promotion bundle',
        'FirstBite operating readout',
        'FirstBite runner durability',
        'Review-scout producer durability',
        'M4 peer execution boundary',
        'Selected local-CI proof',
        'Loaded MCP host catalog',
        'Repo-backed MCP package',
        'Cloudflare OTEL destinations',
        'OTEL/Grafana evidence',
        'Release-history strict coverage',
        'Agent ledger health',
        'Coding-agent review scout',
      ].map(gate => ({
        gate,
        status: 'green',
        current: 'green',
        proof: `/tmp/${gate}.json`,
        nextAction: 'Keep proof fresh.',
      })),
    },
  }
}

function setAuditRow(cockpit, id, patch) {
  const row = cockpit.trustModel.launchTrustAudit.rows.find(candidate => candidate.id === id)
  Object.assign(row, patch)
}
