#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const {
  REPORT_BASENAME,
} = require('./reliability-cockpit.js')
const {
  buildReportFreshness,
  getCurrentRepoState,
} = require('./reliability-completion-audit.js')

const DEFAULT_OUTPUT_DIR = 'reports'
const REQUIRED_CONTRACT_GATES = [
  'Primary checkout',
  'Tracked local-CI contract',
  'Clean proof targetability',
  'Source promotion bundle',
  'Selected local-CI proof',
  'Loaded MCP host catalog',
  'Repo-backed MCP package',
  'Cloudflare OTEL destinations',
  'OTEL/Grafana evidence',
  'Agent ledger health',
  'Coding-agent review scout',
]
const REQUIRED_OPERATOR_ACTIONS = [
  'source-promotion-review',
  'clean-firstbite-proof',
  'loaded-mcp-refresh',
  'cloudflare-otel-destinations',
  'grafana-otel-proof',
]
const REQUIRED_HTML_LABELS = [
  'Operator Action Queue',
  'Operator Recovery Flow',
  'Recovery Boundary Claims',
  'Trust Contracts',
  'Launch Trust Audit',
  'Proof Acceptance Matrix',
  'Evidence Freshness Ledger',
  'FirstBite Local CI',
  'Loaded MCP Host Probe',
  'Loaded MCP Catalog Delta',
  'Cloudflare OTEL Destinations',
  'Grafana OTEL Smoke',
]

if (require.main === module) {
  try {
    const result = verifyCockpitReport(process.argv.slice(2))
    if (result.help) {
      process.stdout.write(helpText())
    } else if (result.options.printJson) {
      process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`)
    } else {
      process.stdout.write(`cockpit-report-verify: ${result.report.status} ${result.report.summary}\n`)
      process.stdout.write(`cockpit-report-verify: json ${result.report.jsonPath}\n`)
      process.stdout.write(`cockpit-report-verify: html ${result.report.htmlPath}\n`)
      if (result.report.failures.length > 0) {
        process.stdout.write(`${result.report.failures.map(failure => `- ${failure}`).join('\n')}\n`)
      }
    }
    if (!result.help) {
      process.exitCode = result.report.status === 'green' ? 0 : 2
    }
  } catch (error) {
    console.error(`cockpit-report-verify: FAILED\n${error.stack || error.message}`)
    process.exitCode = 1
  }
}

function verifyCockpitReport(argv, deps = {}) {
  const options = parseArgs(argv)
  if (options.help) {
    return { options, help: true }
  }

  const repoDir = path.resolve(options.repoDir || process.cwd())
  const jsonPath = path.resolve(repoDir, options.json)
  const htmlPath = path.resolve(repoDir, options.html)
  const readFile = deps.readFile || fs.readFileSync
  const jsonText = readRequiredText(jsonPath, readFile)
  const html = readRequiredText(htmlPath, readFile)
  const cockpit = JSON.parse(jsonText)
  const reportFreshness = buildReportFreshness(cockpit, deps.repoState || getCurrentRepoState(repoDir))
  const failures = [
    ...verifyReportFreshness(reportFreshness),
    ...verifyJsonContract(cockpit),
    ...verifyRecoveryFlowContract(cockpit),
    ...verifyHtmlContract({ cockpit, html }),
  ]
  const status = failures.length === 0 ? 'green' : 'red'
  const report = {
    checkedAt: deps.now ? deps.now() : new Date().toISOString(),
    status,
    summary: status === 'green'
      ? `Cockpit report contract is intact: ${REQUIRED_CONTRACT_GATES.length} gate(s), ${REQUIRED_OPERATOR_ACTIONS.length} action(s), generated HTML sections are present, and report HEAD matches the current checkout.`
      : `Cockpit report contract failed with ${failures.length} issue(s).`,
    jsonPath,
    htmlPath,
    verdict: cockpit.verdict || null,
    reportFreshness,
    failures,
  }

  return { options, report }
}

function parseArgs(argv) {
  const options = {
    repoDir: null,
    json: path.join(DEFAULT_OUTPUT_DIR, `${REPORT_BASENAME}.json`),
    html: path.join(DEFAULT_OUTPUT_DIR, `${REPORT_BASENAME}.html`),
    printJson: false,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
    case '--help':
    case '-h':
      options.help = true
      break
    case '--repo':
      options.repoDir = requireValue(argv, index, arg)
      index += 1
      break
    case '--json-file':
      options.json = requireValue(argv, index, arg)
      index += 1
      break
    case '--html-file':
      options.html = requireValue(argv, index, arg)
      index += 1
      break
    case '--json':
      options.printJson = true
      break
    default:
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return options
}

function verifyJsonContract(cockpit) {
  const failures = []
  if (!cockpit || typeof cockpit !== 'object') {
    return ['cockpit JSON is not an object']
  }

  if (!cockpit.verdict?.status || !cockpit.verdict?.label) {
    failures.push('cockpit verdict is missing status or label')
  }

  const contractGates = new Set((cockpit.trustModel?.contracts || []).map(contract => contract.gate))
  for (const gate of REQUIRED_CONTRACT_GATES) {
    if (!contractGates.has(gate)) {
      failures.push(`missing trust contract gate: ${gate}`)
    }
  }

  const actionIds = new Set((cockpit.trustModel?.operatorActions || []).map(action => action.id))
  for (const actionId of REQUIRED_OPERATOR_ACTIONS) {
    if (!actionIds.has(actionId)) {
      failures.push(`missing operator action: ${actionId}`)
    }
  }

  if (cockpit.localCi?.loadedMcpProbe?.status && !cockpit.localCi?.mcpCatalogDelta?.status) {
    failures.push('loaded MCP probe exists but MCP catalog delta is missing')
  }

  if (cockpit.telemetry?.grafana && !cockpit.telemetry?.cloudflare?.destinations) {
    failures.push('Grafana evidence exists but Cloudflare destination boundary is missing')
  }

  const proofRows = cockpit.trustModel?.proofAcceptanceMatrix?.rows
  if (!Array.isArray(proofRows) || proofRows.length === 0) {
    failures.push('proof acceptance matrix rows are missing')
  } else {
    const proofById = new Map(proofRows.map(row => [row.id, row]))
    for (const rowId of ['clean-firstbite-local-ci', 'loaded-agent-mcp', 'otel-grafana-proof']) {
      if (!proofById.has(rowId)) {
        failures.push(`missing proof acceptance row: ${rowId}`)
      }
    }

    const loaded = proofById.get('loaded-agent-mcp')
    if (cockpit.localCi?.loadedMcpProbe?.status === 'red') {
      if (loaded?.claimAllowed !== false) {
        failures.push('loaded MCP proof row must reject launch claims while loaded host probe is red')
      }
      if (!/Fresh loaded-host list_lanes|Restart|reload/i.test(loaded?.nextValidProof || '')) {
        failures.push('loaded MCP proof row does not name fresh loaded-host list_lanes or host reload proof')
      }
    }

    const grafana = proofById.get('otel-grafana-proof')
    if (grafana && !/Tempo|Loki|Grafana|OTEL/i.test(`${grafana.acceptedProof || ''} ${grafana.rejectedProof || ''} ${grafana.nextValidProof || ''}`)) {
      failures.push('Grafana proof row does not describe Tempo/Loki/Grafana proof requirements')
    }
  }

  return failures
}

function verifyRecoveryFlowContract(cockpit) {
  const failures = []
  const flow = cockpit.trustModel?.operatorRecoveryFlow
  if (!flow || typeof flow !== 'object') {
    return ['operator recovery flow is missing']
  }

  const boundaryClaims = Array.isArray(flow.boundaryClaims) ? flow.boundaryClaims : null
  if (!boundaryClaims) {
    return ['operator recovery flow boundary claims are missing']
  }

  const actionIds = new Set((cockpit.trustModel?.operatorActions || []).map(action => action.id))
  const claimsByBoundary = new Map(boundaryClaims.map(claim => [claim.boundary, claim]))

  if (actionIds.has('clean-firstbite-proof')) {
    requireBoundaryClaim({
      failures,
      claimsByBoundary,
      boundary: 'local-ci',
      requiredProofPattern: /worktree=true|resplit_currency_api/i,
      forbiddenClaimPattern: /Do not claim.*local CI|FirstBite/i,
    })
  }

  if (actionIds.has('loaded-mcp-refresh') || cockpit.localCi?.loadedMcpProbe?.status === 'red') {
    requireBoundaryClaim({
      failures,
      claimsByBoundary,
      boundary: 'local-agent-host',
      requiredProofPattern: /list_lanes|repo-manifest-v2|restart|reload/i,
      forbiddenClaimPattern: /Do not claim.*Codex|Do not claim.*Cursor|loaded.*MCP/i,
    })
  }

  if (actionIds.has('grafana-otel-proof')) {
    requireBoundaryClaim({
      failures,
      claimsByBoundary,
      boundary: 'external-observability',
      requiredProofPattern: /Tempo|Loki|Grafana|OTEL/i,
      forbiddenClaimPattern: /Do not claim.*telemetry|config alone|nurse-log/i,
    })
  }

  return failures
}

function requireBoundaryClaim({ failures, claimsByBoundary, boundary, requiredProofPattern, forbiddenClaimPattern }) {
  const claim = claimsByBoundary.get(boundary)
  if (!claim) {
    failures.push(`missing recovery boundary claim: ${boundary}`)
    return
  }

  if (claim.claimAllowed !== false) {
    failures.push(`recovery boundary claim must block launch claims: ${boundary}`)
  }
  if (!requiredProofPattern.test(claim.requiredProof || '')) {
    failures.push(`recovery boundary claim does not name required proof: ${boundary}`)
  }
  if (!forbiddenClaimPattern.test(claim.forbiddenClaim || '')) {
    failures.push(`recovery boundary claim does not name forbidden claim: ${boundary}`)
  }
}

function verifyHtmlContract({ cockpit, html }) {
  const failures = []
  for (const label of REQUIRED_HTML_LABELS) {
    if (!html.includes(label)) {
      failures.push(`HTML missing section label: ${label}`)
    }
  }

  for (const gate of REQUIRED_CONTRACT_GATES) {
    if (!html.includes(escapeForHtmlText(gate))) {
      failures.push(`HTML missing trust contract gate: ${gate}`)
    }
  }

  const verdictLabel = cockpit.verdict?.label
  if (verdictLabel && !html.includes(escapeForHtmlText(verdictLabel))) {
    failures.push(`HTML missing verdict label: ${verdictLabel}`)
  }

  if (cockpit.localCi?.loadedMcpProbe?.status === 'red') {
    const missingExpected = cockpit.localCi.loadedMcpProbe.missingLaneIds || []
    if (missingExpected.length > 0 && !missingExpected.every(laneId => html.includes(escapeForHtmlText(laneId)))) {
      failures.push('HTML missing one or more loaded MCP missing-lane IDs')
    }
  }

  return failures
}

function verifyReportFreshness(reportFreshness) {
  if (reportFreshness.status === 'green') {
    return []
  }

  return [`report freshness failed: ${reportFreshness.summary}`]
}

function readRequiredText(filePath, readFile) {
  try {
    return readFile(filePath, 'utf8')
  } catch (error) {
    throw new Error(`Unable to read ${filePath}: ${error.message}`)
  }
}

function requireValue(argv, index, arg) {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${arg} requires a value`)
  }
  return value
}

function escapeForHtmlText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function helpText() {
  return [
    'Usage: node scripts/verify-reliability-cockpit-report.js [--repo <dir>] [--json]',
    '',
    'Verifies the generated reliability cockpit JSON and HTML still expose the launch-trust contract and match the current checkout.',
    'Run npm run reliability:cockpit before this verifier to refresh reports/resplit-fx-reliability-cockpit.{json,html}.',
    '',
  ].join('\n')
}

module.exports = {
  REQUIRED_CONTRACT_GATES,
  REQUIRED_HTML_LABELS,
  REQUIRED_OPERATOR_ACTIONS,
  parseArgs,
  verifyCockpitReport,
  verifyHtmlContract,
  verifyJsonContract,
  verifyRecoveryFlowContract,
  verifyReportFreshness,
}
