const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  REQUIRED_CONTRACT_GATES,
  REQUIRED_HTML_LABELS,
  REQUIRED_OPERATOR_ACTIONS,
  parseArgs,
  verifyCockpitReport,
} = require('../scripts/verify-reliability-cockpit-report.js')

const CURRENT_REPO_STATE = {
  head: 'de99b14671dd',
  branch: 'codex/fx-otel-grafana-config-20260525',
}

test('parseArgs points at the generated reliability cockpit artifacts', () => {
  const options = parseArgs([])

  assert.equal(options.json, path.join('reports', 'resplit-fx-reliability-cockpit.json'))
  assert.equal(options.html, path.join('reports', 'resplit-fx-reliability-cockpit.html'))
  assert.equal(options.printJson, false)
})

test('verifyCockpitReport accepts a report with every operator trust surface visible', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-cockpit-report-'))
  writeReport(repoDir, buildReport())

  const result = verifyCockpitReport(['--repo', repoDir], {
    now: () => '2026-05-25T14:15:00.000Z',
    repoState: CURRENT_REPO_STATE,
  })

  assert.equal(result.report.status, 'green')
  assert.match(result.report.summary, /Cockpit report contract is intact/)
  assert.equal(result.report.reportFreshness.status, 'green')
})

test('verifyCockpitReport fails when generated HTML drops a critical section', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-cockpit-report-missing-section-'))
  const report = buildReport()
  const html = buildHtml(report).replace('Loaded MCP Host Probe', 'Loaded Host')
  writeReport(repoDir, report, html)

  const result = verifyCockpitReport(['--repo', repoDir], {
    now: () => '2026-05-25T14:15:00.000Z',
    repoState: CURRENT_REPO_STATE,
  })

  assert.equal(result.report.status, 'red')
  assert.match(result.report.failures.join('\n'), /HTML missing section label: Loaded MCP Host Probe/)
})

test('verifyCockpitReport fails when JSON loses the Grafana operator action', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-cockpit-report-missing-action-'))
  const report = buildReport()
  report.trustModel.operatorActions = report.trustModel.operatorActions
    .filter(action => action.id !== 'grafana-otel-proof')
  writeReport(repoDir, report)

  const result = verifyCockpitReport(['--repo', repoDir], {
    now: () => '2026-05-25T14:15:00.000Z',
    repoState: CURRENT_REPO_STATE,
  })

  assert.equal(result.report.status, 'red')
  assert.match(result.report.failures.join('\n'), /missing operator action: grafana-otel-proof/)
})

test('verifyCockpitReport fails when JSON loses the proof acceptance matrix', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-cockpit-report-missing-proof-matrix-'))
  const report = buildReport()
  delete report.trustModel.proofAcceptanceMatrix
  writeReport(repoDir, report)

  const result = verifyCockpitReport(['--repo', repoDir], {
    now: () => '2026-05-25T14:15:00.000Z',
    repoState: CURRENT_REPO_STATE,
  })

  assert.equal(result.report.status, 'red')
  assert.match(result.report.failures.join('\n'), /proof acceptance matrix rows are missing/)
})

test('verifyCockpitReport fails when JSON loses a recovery boundary claim', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-cockpit-report-missing-boundary-claim-'))
  const report = buildReport()
  report.trustModel.operatorRecoveryFlow.boundaryClaims = report.trustModel.operatorRecoveryFlow.boundaryClaims
    .filter(claim => claim.boundary !== 'local-agent-host')
  writeReport(repoDir, report)

  const result = verifyCockpitReport(['--repo', repoDir], {
    now: () => '2026-05-25T14:15:00.000Z',
    repoState: CURRENT_REPO_STATE,
  })

  assert.equal(result.report.status, 'red')
  assert.match(result.report.failures.join('\n'), /missing recovery boundary claim: local-agent-host/)
})

test('verifyCockpitReport fails when the generated report head is stale', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-cockpit-report-stale-head-'))
  const report = buildReport()
  report.repo.git.head = '111111111111'
  writeReport(repoDir, report)

  const result = verifyCockpitReport(['--repo', repoDir], {
    now: () => '2026-05-25T14:15:00.000Z',
    repoState: CURRENT_REPO_STATE,
  })

  assert.equal(result.report.status, 'red')
  assert.equal(result.report.reportFreshness.status, 'red')
  assert.match(result.report.failures.join('\n'), /Cockpit report is stale: report HEAD 111111111111/)
})

test('verifyCockpitReport fails when current git state cannot be read', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-cockpit-report-missing-git-'))
  writeReport(repoDir, buildReport())

  const result = verifyCockpitReport(['--repo', repoDir], {
    now: () => '2026-05-25T14:15:00.000Z',
    repoState: { head: null, branch: null },
  })

  assert.equal(result.report.status, 'red')
  assert.equal(result.report.reportFreshness.status, 'red')
  assert.match(result.report.failures.join('\n'), /Cockpit report head is not comparable/)
})

function buildReport() {
  return {
    generatedAt: '2026-05-25T14:10:00.000Z',
    repo: {
      git: { ...CURRENT_REPO_STATE },
    },
    verdict: {
      status: 'red',
      label: 'RED - missing required trust contract',
    },
    localCi: {
      loadedMcpProbe: {
        status: 'red',
        source: 'repo-backed-cli:list_lanes-current-primary-checkouts',
        sourceStatus: 'red',
        sourceSummary: 'Loaded MCP probe source is diagnostic repo-backed evidence.',
        missingLaneIds: [
          'resplit_currency_api_unit',
          'resplit_currency_api_integration',
          'resplit_currency_api_trust_preflight',
          'resplit_currency_api_ui',
        ],
      },
      mcpCatalogDelta: {
        status: 'red',
      },
      loadedMcpCaptureContract: {
        status: 'red',
        acceptedSources: [
          'codex-mcp-tool:mcp__firstbite_local_ci.list_lanes',
          'cursor-mcp-tool:mcp__firstbite_local_ci.list_lanes',
        ],
        rejectedSources: [
          'repo-backed package:list_lanes',
          'previous-loaded-mcp-artifact:<path>',
          '--reuse-existing',
        ],
        currentInvalidReason: 'Loaded MCP probe source is diagnostic repo-backed evidence.',
      },
    },
    telemetry: {
      grafana: {
        evidence: { status: 'yellow' },
      },
      cloudflare: {
        destinations: {
          status: 'yellow',
        },
      },
    },
    trustModel: {
      contracts: REQUIRED_CONTRACT_GATES.map(gate => ({ gate, status: 'yellow' })),
      operatorActions: REQUIRED_OPERATOR_ACTIONS.map(id => ({ id, status: 'yellow' })),
      operatorRecoveryFlow: {
        status: 'red',
        summary: '1 runnable action(s) now; 2 action(s) waiting on local or external dependencies.',
        nextLocalAction: {
          id: 'loaded-mcp-recapture',
          priority: 3,
          status: 'yellow',
          owner: 'Codex/Cursor MCP host',
          boundary: 'local-agent-host-evidence',
          command: 'npm run mcp:loaded-probe -- --input /tmp/firstbite-loaded-mcp.json',
          proof: 'reports/firstbite-loaded-mcp-lanes.json',
          blocker: 'Loaded MCP probe artifact is stale.',
          unblocks: 'Loaded MCP evidence freshness',
        },
        firstBlockedAction: {
          id: 'clean-firstbite-proof',
          blocker: 'Source promotion bundle must land first.',
        },
        runnableNow: [],
        waitingOnDependency: [],
        boundaries: [],
        boundaryClaims: [
          {
            boundary: 'local-ci',
            label: 'Clean FirstBite local CI',
            status: 'red',
            claimAllowed: false,
            actionIds: ['clean-firstbite-proof'],
            forbiddenClaim: 'Do not claim local CI validates launch until a clean worktree=true FirstBite execute report runs from landed source.',
            requiredProof: 'Fresh worktree=true execute report with all current resplit_currency_api lanes passing and commands matching .firstbite/local-ci.json.',
            currentBlocker: 'Source promotion bundle must land first.',
            nextAction: 'Run clean worktree local CI from the landed contract.',
          },
          {
            boundary: 'local-agent-host',
            label: 'Loaded Codex/Cursor MCP host',
            status: 'red',
            claimAllowed: false,
            actionIds: ['loaded-mcp-refresh'],
            forbiddenClaim: 'Do not claim the loaded Codex/Cursor MCP host can execute FX lanes from a repo-backed package catalog or stale loaded-host probe.',
            requiredProof: 'Fresh live loaded-client mcp__firstbite_local_ci.list_lanes after Codex/Cursor restart or reload, captured with source codex-mcp-tool:mcp__firstbite_local_ci.list_lanes, showing repo-manifest-v2 and all current resplit_currency_api lanes plus the resplit_currency_api_all group.',
            currentBlocker: 'Loaded MCP host catalog is missing current lanes.',
            nextAction: 'Save work and restart/reload Codex/Cursor.',
          },
          {
            boundary: 'external-observability',
            label: 'OTEL/Grafana telemetry',
            status: 'red',
            claimAllowed: false,
            actionIds: ['grafana-otel-proof'],
            forbiddenClaim: 'Do not claim telemetry is launch-trusted from wrangler config, Cloudflare destination names, or an old nurse-log note alone.',
            requiredProof: 'Fresh Grafana smoke artifact where Worker trigger, Grafana config, Tempo query, and Loki query are all green.',
            currentBlocker: 'Grafana proof missing.',
            nextAction: 'Run the live Grafana smoke after destinations and read credentials exist.',
          },
        ],
      },
      proofAcceptanceMatrix: {
        status: 'red',
        summary: '0 accepted, 3 blocked proof boundary(s).',
        rows: [
          {
            id: 'clean-firstbite-local-ci',
            surface: 'Clean FirstBite local-CI execution',
            boundary: 'local-ci',
            status: 'red',
            claimAllowed: false,
            acceptedProof: 'No launch claim accepted; diagnostic evidence only: FirstBite execute report missing.',
            rejectedProof: 'Do not claim local CI validates the current launch source.',
            currentEvidence: 'FirstBite execute report missing.',
            currentGap: 'clean proof missing',
            nextValidProof: 'A fresh worktree=true execute report with all resplit_currency_api lanes passing and commands matching .firstbite/local-ci.json.',
            actionId: 'clean-firstbite-proof',
          },
          {
            id: 'loaded-agent-mcp',
            surface: 'Loaded Codex/Cursor MCP host',
            boundary: 'local-agent-host',
            status: 'red',
            claimAllowed: false,
            acceptedProof: 'No launch claim accepted; diagnostic evidence only: reports/firstbite-loaded-mcp-lanes.json',
            rejectedProof: 'Do not claim Codex/Cursor loaded MCP can execute or even see FX lanes from the current host process.',
            currentEvidence: 'reports/firstbite-loaded-mcp-lanes.json',
            currentGap: 'missing current FX lanes',
            nextValidProof: 'Fresh live loaded-client mcp__firstbite_local_ci.list_lanes artifact with source codex-mcp-tool:mcp__firstbite_local_ci.list_lanes, repo-manifest-v2, all current resplit_currency_api lanes present, and resplit_currency_api_all containing every expected lane.',
            actionId: 'loaded-mcp-refresh',
          },
          {
            id: 'otel-grafana-proof',
            surface: 'OTEL/Grafana observability',
            boundary: 'external-observability',
            status: 'red',
            claimAllowed: false,
            acceptedProof: 'No launch claim accepted; diagnostic evidence only: reports/grafana-otel-smoke.json',
            rejectedProof: 'Do not claim telemetry is launch-trusted from config alone or an old nurse-log note.',
            currentEvidence: 'reports/grafana-otel-smoke.json',
            currentGap: 'Grafana proof missing.',
            nextValidProof: 'A fresh smoke artifact where Worker trigger, Grafana config, Tempo query, and Loki query are all green.',
            actionId: 'grafana-otel-proof',
          },
        ],
      },
    },
  }
}

function buildHtml(report) {
  return [
    report.verdict.label,
    ...REQUIRED_HTML_LABELS,
    ...REQUIRED_CONTRACT_GATES,
    ...report.trustModel.operatorRecoveryFlow.boundaryClaims.map(claim => claim.boundary),
    ...report.localCi.loadedMcpProbe.missingLaneIds,
    report.localCi.loadedMcpProbe.sourceSummary,
    report.localCi.loadedMcpCaptureContract.currentInvalidReason,
    ...report.localCi.loadedMcpCaptureContract.acceptedSources,
    ...report.localCi.loadedMcpCaptureContract.rejectedSources,
  ].join('\n')
}

function writeReport(repoDir, report, html = buildHtml(report)) {
  const reportsDir = path.join(repoDir, 'reports')
  fs.mkdirSync(reportsDir, { recursive: true })
  fs.writeFileSync(path.join(reportsDir, 'resplit-fx-reliability-cockpit.json'), `${JSON.stringify(report, null, 2)}\n`)
  fs.writeFileSync(path.join(reportsDir, 'resplit-fx-reliability-cockpit.html'), html)
}
