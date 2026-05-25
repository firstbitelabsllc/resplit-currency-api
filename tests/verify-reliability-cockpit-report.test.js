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

test('verifyCockpitReport fails when operating readout scope rules disappear', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-cockpit-report-missing-readout-scope-'))
  const report = buildReport()
  report.localCi.operatingReadoutScopeContract.acceptedProof = [
    'fresh firstbite-operating-readout report generated for the current repo path',
  ]
  report.localCi.operatingReadoutScopeContract.rejectedProof = [
    'primary-checkout readout when the current proof target is a PR worktree',
  ]
  writeReport(repoDir, report)

  const result = verifyCockpitReport(['--repo', repoDir], {
    now: () => '2026-05-25T14:15:00.000Z',
    repoState: CURRENT_REPO_STATE,
  })

  assert.equal(result.report.status, 'red')
  assert.match(result.report.failures.join('\n'), /operating readout scope contract does not name current repo path/)
  assert.match(result.report.failures.join('\n'), /operating readout scope contract does not reject primary-checkout/)
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
      operatingReadout: {
        status: 'red',
        reportPath: '/Users/leokwan/.agent-ledger/firstbite-operating-readout/fx-cockpit/report.json',
      },
      operatingReadoutScopeContract: {
        status: 'red',
        summary: 'FirstBite operating readout is diagnostic for this checkout.',
        rows: [
          { id: 'readout-report', label: 'Readout report', status: 'red', proof: '/Users/leokwan/.agent-ledger/firstbite-operating-readout/fx-cockpit/report.json', nextAction: 'Refresh the readout.' },
          { id: 'repo-key', label: 'Repo key', status: 'green', proof: 'resplit_currency_api present in readout catalog', nextAction: 'Keep repo key present.' },
          { id: 'repo-path', label: 'Repo path', status: 'red', proof: 'readout=/Users/leokwan/Development/resplit-currency-api current=/Users/leokwan/Development/resplit-currency-api-worktrees/post-pr9-main-20260525', nextAction: 'Regenerate from the current repo path.' },
          { id: 'lane-set', label: 'Lane set', status: 'red', proof: 'missing resplit_currency_api_trust_preflight', nextAction: 'Regenerate after current lanes exist.' },
          { id: 'proof-only-lanes', label: 'Proof-only lanes', status: 'yellow', proof: '4 non-current proof-only lane(s), 2 failed', nextAction: 'Keep proof-only failures separated.' },
        ],
        acceptedProof: [
          'fresh firstbite-operating-readout report generated for the current repo path',
          'catalog repo key matches the current .firstbite/local-ci.json repo',
          'catalog lane_keys include every current manifest lane',
          'proof-only lanes are separated from current repo-path proof',
        ],
        rejectedProof: [
          'primary-checkout readout when the current proof target is a PR worktree',
          'readout catalog missing current manifest lanes',
          'proof-only non-current lane failures promoted as current proof',
          'Moussey/M4 support-only status promoted as execution proof',
        ],
        currentInvalidReason: 'Repo path mismatch; Lane set missing resplit_currency_api_trust_preflight.',
      },
      findingTaxonomy: {
        status: 'red',
        summary: 'Local CI found 3 non-green finding class(es): proof-gap=red, stale-control-plane=red, peer-boundary=yellow.',
        productFailureCount: 0,
        proofGapCount: 3,
        staleControlPlaneCount: 1,
        peerBoundaryCount: 1,
        categories: [
          {
            id: 'product-failure',
            label: 'Product lane failure',
            status: 'green',
            summary: 'No current resplit_currency_api product lane failure is proven by local CI.',
            evidence: [],
            nextAction: 'Keep product-lane proof separate from proof/control-plane failures.',
            laneFindings: [],
            actionIds: [],
          },
          {
            id: 'proof-gap',
            label: 'Launch proof gap',
            status: 'red',
            summary: '1 proof lane failure(s): resplit_currency_api_trust_preflight; grafana-otel-proof: yellow',
            evidence: ['/tmp/firstbite/report.json', 'reports/grafana-otel-smoke.json'],
            nextAction: 'Run the proof commands for the non-green launch-trust gates.',
            laneFindings: [{
              lane: 'resplit_currency_api_trust_preflight',
              repo: 'resplit_currency_api',
              runId: 'trust-red',
              reportPath: '/tmp/firstbite/report.json',
              reason: 'command exited with code 2',
              kind: 'proof-gap',
            }],
            actionIds: ['grafana-otel-proof'],
          },
          {
            id: 'stale-control-plane',
            label: 'Stale agent/control-plane',
            status: 'red',
            summary: 'loaded-mcp-refresh: red',
            evidence: ['reports/firstbite-loaded-mcp-lanes.json'],
            nextAction: 'Save work and restart/reload Codex/Cursor.',
            laneFindings: [],
            actionIds: ['loaded-mcp-refresh'],
          },
          {
            id: 'peer-boundary',
            label: 'Peer execution boundary',
            status: 'yellow',
            summary: 'm4-peer-execute-proof: yellow',
            evidence: ['/Users/leokwan/.agent-ledger/firstbite-operating-readout/fx-cockpit/report.json'],
            nextAction: 'Run on M4.',
            laneFindings: [],
            actionIds: ['m4-peer-execute-proof'],
          },
        ],
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
      observabilityProofChain: {
        status: 'yellow',
        summary: 'Observability proof chain is incomplete.',
        required: [
          { id: 'cloudflare-destinations', label: 'Cloudflare destination read proof', status: 'yellow', proof: 'Cloudflare proof missing.' },
          { id: 'worker-trigger', label: 'Worker trigger', status: 'yellow', proof: 'Worker trigger missing.' },
          { id: 'grafana-read-config', label: 'Grafana read config', status: 'yellow', proof: 'Grafana config missing.' },
          { id: 'tempo-query', label: 'Tempo trace query', status: 'yellow', proof: 'Tempo missing.' },
          { id: 'loki-query', label: 'Loki log query', status: 'yellow', proof: 'Loki missing.' },
          { id: 'freshness', label: 'Freshness', status: 'yellow', proof: 'Freshness missing.' },
        ],
        acceptedProof: [
          'reports/cloudflare-otel-destinations.json:green',
          'reports/grafana-otel-smoke.json:worker-trigger green',
          'reports/grafana-otel-smoke.json:grafana-read-config green',
          'reports/grafana-otel-smoke.json:tempo-query green',
          'reports/grafana-otel-smoke.json:loki-query green',
          'fresh checkedAt within 24h',
        ],
        rejectedProof: [
          'wrangler.jsonc destination names without Cloudflare read proof',
          'reports/grafana-otel-smoke.json with --skip-trigger or worker-trigger skipped',
          'Tempo-only proof without Loki logs',
          'Loki-only proof without Tempo trace',
          'stale Grafana or Cloudflare report',
          'old nurse-log or INBOX note',
        ],
        currentInvalidReason: 'Worker trigger missing; Tempo missing; Loki missing.',
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
            rejectedProof: 'Do not claim telemetry is launch-trusted from wrangler config alone, skipped-trigger Grafana smoke, Tempo-only/Loki-only proof, stale reports, or an old nurse-log note.',
            currentEvidence: 'reports/grafana-otel-smoke.json',
            currentGap: 'Grafana proof missing.',
            nextValidProof: 'Fresh Cloudflare destination proof plus a non-skipped Grafana smoke artifact where Worker trigger, Grafana config, Tempo query, Loki query, and freshness are all green.',
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
    report.telemetry.observabilityProofChain.currentInvalidReason,
    ...report.telemetry.observabilityProofChain.acceptedProof,
    ...report.telemetry.observabilityProofChain.rejectedProof,
    report.localCi.operatingReadoutScopeContract.currentInvalidReason,
    ...report.localCi.operatingReadoutScopeContract.acceptedProof,
    ...report.localCi.operatingReadoutScopeContract.rejectedProof,
    'Local CI Finding Taxonomy',
    ...report.localCi.findingTaxonomy.categories.flatMap(category => [
      category.id,
      category.summary,
    ]),
  ].join('\n')
}

function writeReport(repoDir, report, html = buildHtml(report)) {
  const reportsDir = path.join(repoDir, 'reports')
  fs.mkdirSync(reportsDir, { recursive: true })
  fs.writeFileSync(path.join(reportsDir, 'resplit-fx-reliability-cockpit.json'), `${JSON.stringify(report, null, 2)}\n`)
  fs.writeFileSync(path.join(reportsDir, 'resplit-fx-reliability-cockpit.html'), html)
}
