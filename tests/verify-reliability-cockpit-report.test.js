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
  })

  assert.equal(result.report.status, 'green')
  assert.match(result.report.summary, /Cockpit report contract is intact/)
})

test('verifyCockpitReport fails when generated HTML drops a critical section', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-cockpit-report-missing-section-'))
  const report = buildReport()
  const html = buildHtml(report).replace('Loaded MCP Host Probe', 'Loaded Host')
  writeReport(repoDir, report, html)

  const result = verifyCockpitReport(['--repo', repoDir], {
    now: () => '2026-05-25T14:15:00.000Z',
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
  })

  assert.equal(result.report.status, 'red')
  assert.match(result.report.failures.join('\n'), /proof acceptance matrix rows are missing/)
})

function buildReport() {
  return {
    verdict: {
      status: 'red',
      label: 'RED - missing required trust contract',
    },
    localCi: {
      loadedMcpProbe: {
        status: 'red',
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
            nextValidProof: 'Fresh loaded-host list_lanes artifact with repo-manifest-v2 and all current resplit_currency_api lanes present.',
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
    ...report.localCi.loadedMcpProbe.missingLaneIds,
  ].join('\n')
}

function writeReport(repoDir, report, html = buildHtml(report)) {
  const reportsDir = path.join(repoDir, 'reports')
  fs.mkdirSync(reportsDir, { recursive: true })
  fs.writeFileSync(path.join(reportsDir, 'resplit-fx-reliability-cockpit.json'), `${JSON.stringify(report, null, 2)}\n`)
  fs.writeFileSync(path.join(reportsDir, 'resplit-fx-reliability-cockpit.html'), html)
}
