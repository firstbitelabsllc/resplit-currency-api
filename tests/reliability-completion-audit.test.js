const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  EXPECTED_LAUNCH_AUDIT_IDS,
  EXPECTED_PROOF_ACCEPTANCE_IDS,
  auditCockpitCompletion,
  buildCompletionAudit,
  buildReportFreshness,
  parseArgs,
} = require('../scripts/reliability-completion-audit.js')

test('parseArgs reads the generated reliability cockpit by default', () => {
  const options = parseArgs([])

  assert.equal(options.json, path.join('reports', 'resplit-fx-reliability-cockpit.json'))
  assert.equal(options.printJson, false)
})

test('buildCompletionAudit passes only when every launch boundary, proof boundary, and trust contract is green', () => {
  const report = buildCompletionAudit({
    checkedAt: '2026-05-25T15:00:00.000Z',
    cockpitPath: '/tmp/reports/resplit-fx-reliability-cockpit.json',
    currentRepoState: matchingRepoState(),
    cockpit: buildCockpit(),
  })

  assert.equal(report.status, 'green')
  assert.match(report.summary, /Launch completion audit is green/)
  assert.equal(report.reportFreshness.status, 'green')
  assert.equal(report.blockers.length, 0)
  assert.equal(report.proofBlockers.length, 0)
  assert.equal(report.nonGreenContracts.length, 0)
})

test('buildCompletionAudit blocks stale generated cockpit reports', () => {
  const cockpit = buildCockpit()
  cockpit.repo.git.head = '111111111111'

  const report = buildCompletionAudit({
    checkedAt: '2026-05-25T15:00:00.000Z',
    cockpitPath: '/tmp/reports/resplit-fx-reliability-cockpit.json',
    currentRepoState: { head: '222222222222', branch: 'codex/fx-otel-grafana-config-20260525' },
    cockpit,
  })

  assert.equal(report.status, 'red')
  assert.equal(report.reportFreshness.status, 'red')
  assert.match(report.reportFreshness.summary, /Cockpit report is stale/)
  assert.match(report.failures.join('\n'), /cockpit report freshness/)
  assert.match(report.summary, /1 stale\/missing cockpit report/)
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
  setProofRow(cockpit, 'loaded-agent-mcp', {
    status: 'red',
    claimAllowed: false,
    currentGap: 'Loaded MCP host is missing FX lanes.',
    nextValidProof: 'Restart host and capture list_lanes.',
  })
  setProofRow(cockpit, 'otel-grafana-proof', {
    status: 'yellow',
    claimAllowed: false,
    currentGap: 'Tempo/Loki evidence is missing.',
    nextValidProof: 'Run npm run observability:otel-smoke.',
  })
  cockpit.trustModel.contracts.find(contract => contract.gate === 'Loaded MCP host catalog').status = 'red'
  cockpit.trustModel.contracts.find(contract => contract.gate === 'OTEL/Grafana evidence').status = 'yellow'
  cockpit.trustModel.launchTrustAudit.status = 'red'
  cockpit.trustModel.proofAcceptanceMatrix.status = 'red'

  const report = buildCompletionAudit({
    checkedAt: '2026-05-25T15:00:00.000Z',
    cockpitPath: '/tmp/reports/resplit-fx-reliability-cockpit.json',
    currentRepoState: matchingRepoState(),
    cockpit,
  })

  assert.equal(report.status, 'red')
  assert.match(report.summary, /Launch completion blocked/)
  assert.deepEqual(report.blockers.map(blocker => blocker.id), ['loaded-agent-mcp', 'otel-grafana-proof'])
  assert.deepEqual(report.proofBlockers.map(blocker => blocker.id), ['loaded-agent-mcp', 'otel-grafana-proof'])
  assert.deepEqual(report.nonGreenContracts.map(contract => contract.gate), ['Loaded MCP host catalog', 'OTEL/Grafana evidence'])
  assert.match(report.failures.join('\n'), /loaded-agent-mcp: proof red/)
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
    repoState: { head: '23cae94d3d40', branch: 'codex/fx-otel-grafana-config-20260525' },
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
    currentRepoState: matchingRepoState(),
    cockpit,
  })

  assert.equal(report.status, 'red')
  assert.deepEqual(report.launchTrustAudit.missingRows, ['peer-execution'])
  assert.match(report.failures.join('\n'), /missing launch audit row: peer-execution/)
})

test('buildCompletionAudit treats missing proof acceptance rows as launch-blocking', () => {
  const cockpit = buildCockpit()
  cockpit.trustModel.proofAcceptanceMatrix.rows = cockpit.trustModel.proofAcceptanceMatrix.rows
    .filter(row => row.id !== 'loaded-agent-mcp')
  cockpit.trustModel.proofAcceptanceMatrix.status = 'red'

  const report = buildCompletionAudit({
    checkedAt: '2026-05-25T15:00:00.000Z',
    cockpitPath: '/tmp/reports/resplit-fx-reliability-cockpit.json',
    currentRepoState: matchingRepoState(),
    cockpit,
  })

  assert.equal(report.status, 'red')
  assert.deepEqual(report.proofAcceptanceMatrix.missingRows, ['loaded-agent-mcp'])
  assert.match(report.failures.join('\n'), /missing proof acceptance row: loaded-agent-mcp/)
})

test('buildCompletionAudit blocks completion when only the proof matrix is red', () => {
  const cockpit = buildCockpit()
  setProofRow(cockpit, 'repo-backed-mcp-source', {
    status: 'red',
    claimAllowed: false,
    acceptedProof: 'No launch claim accepted; diagnostic evidence only: stale catalog.',
    rejectedProof: 'Do not promote a remembered catalog into a current loaded-host claim.',
    currentGap: 'Proof matrix found stale or adjacent evidence.',
    nextValidProof: 'Capture fresh repo-backed catalog proof.',
  })
  cockpit.trustModel.proofAcceptanceMatrix.status = 'red'

  const report = buildCompletionAudit({
    checkedAt: '2026-05-25T15:00:00.000Z',
    cockpitPath: '/tmp/reports/resplit-fx-reliability-cockpit.json',
    currentRepoState: matchingRepoState(),
    cockpit,
  })

  assert.equal(report.status, 'red')
  assert.equal(report.blockers.length, 0)
  assert.equal(report.nonGreenContracts.length, 0)
  assert.deepEqual(report.proofBlockers.map(blocker => blocker.id), ['repo-backed-mcp-source'])
  assert.match(report.summary, /1 non-green\/missing proof boundary/)
})

test('buildReportFreshness accepts matching short or full checkout SHAs', () => {
  const reportFreshness = buildReportFreshness(buildCockpit(), {
    head: '23cae94d3d405135a24d891dc9ed28ffa270ef51',
    branch: 'codex/fx-otel-grafana-config-20260525',
  })

  assert.equal(reportFreshness.status, 'green')
  assert.equal(reportFreshness.reportHead, '23cae94d3d40')
  assert.equal(reportFreshness.currentHead, '23cae94d3d40')
})

test('buildReportFreshness rejects missing git state', () => {
  const reportFreshness = buildReportFreshness(buildCockpit(), {
    head: null,
    branch: null,
  })

  assert.equal(reportFreshness.status, 'red')
  assert.match(reportFreshness.summary, /not comparable/)
})

function buildCockpit() {
  return {
    generatedAt: '2026-05-25T15:00:00.000Z',
    repo: {
      git: {
        head: '23cae94d3d40',
        branch: 'codex/fx-otel-grafana-config-20260525',
      },
    },
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
      proofAcceptanceMatrix: {
        status: 'green',
        summary: 'All proof boundaries are claim-allowed.',
        rows: EXPECTED_PROOF_ACCEPTANCE_IDS.map(id => ({
          id,
          surface: id.replace(/-/g, ' '),
          boundary: 'test',
          owner: 'test owner',
          status: 'green',
          claimAllowed: true,
          acceptedProof: 'Current matching proof accepted.',
          rejectedProof: 'No rejected proof while green.',
          currentEvidence: `/tmp/${id}.json`,
          currentGap: 'No gap.',
          nextValidProof: 'Keep proof fresh.',
          actionId: `action-${id}`,
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

function setProofRow(cockpit, id, patch) {
  const row = cockpit.trustModel.proofAcceptanceMatrix.rows.find(candidate => candidate.id === id)
  Object.assign(row, patch)
}

function matchingRepoState() {
  return {
    head: '23cae94d3d40',
    branch: 'codex/fx-otel-grafana-config-20260525',
  }
}
