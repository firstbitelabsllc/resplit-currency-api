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
  'FirstBite Operating Readout Scope Contract',
  'Loaded MCP Host Probe',
  'Loaded MCP Live Capture Contract',
  'Loaded MCP Proof Source',
  'Loaded MCP Catalog Delta',
  'Cloudflare OTEL Destinations',
  'Grafana OTEL Smoke',
  'Observability Proof Chain Contract',
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
  if (cockpit.localCi?.loadedMcpProbe?.status && !cockpit.localCi?.loadedMcpCaptureContract?.status) {
    failures.push('loaded MCP probe exists but live capture contract is missing')
  }
  const loadedMcpProbe = cockpit.localCi?.loadedMcpProbe
  if (loadedMcpProbe?.status && loadedMcpProbe.status !== 'missing') {
    if (!loadedMcpProbe.expectedRepoPath) {
      failures.push('loaded MCP probe does not record expected repo path')
    }
    if (loadedMcpProbe.repoPresent && !loadedMcpProbe.actualRepoPath) {
      failures.push('loaded MCP probe does not record actual repo path')
    }
    if (!Object.prototype.hasOwnProperty.call(loadedMcpProbe, 'repoPathMatchesExpected')) {
      failures.push('loaded MCP probe does not record repo path match status')
    }
    const delta = cockpit.localCi?.mcpCatalogDelta
    if (delta?.status && !Object.prototype.hasOwnProperty.call(delta, 'loadedRepoPathMatchesExpected')) {
      failures.push('loaded MCP catalog delta does not record repo path match status')
    }
    const captureContract = cockpit.localCi?.loadedMcpCaptureContract
    if (captureContract?.status && !Object.prototype.hasOwnProperty.call(captureContract, 'currentRepoPathMatch')) {
      failures.push('loaded MCP live capture contract does not record repo path match status')
    }
  }
  if (cockpit.localCi?.operatingReadout?.status && !cockpit.localCi?.operatingReadoutScopeContract?.status) {
    failures.push('FirstBite operating readout exists but scope contract is missing')
  }
  const findingTaxonomy = cockpit.localCi?.findingTaxonomy
  if (!findingTaxonomy?.status) {
    failures.push('local CI finding taxonomy is missing')
  } else {
    const categoryIds = new Set((findingTaxonomy.categories || []).map(category => category.id))
    for (const id of ['product-failure', 'proof-gap', 'stale-control-plane', 'peer-boundary']) {
      if (!categoryIds.has(id)) {
        failures.push(`local CI finding taxonomy missing category: ${id}`)
      }
    }
    const product = (findingTaxonomy.categories || []).find(category => category.id === 'product-failure')
    const proof = (findingTaxonomy.categories || []).find(category => category.id === 'proof-gap')
    if (product && proof && /resplit_currency_api_trust_preflight/.test(JSON.stringify(product))) {
      failures.push('local CI finding taxonomy misclassifies trust_preflight as a product failure')
    }
    if (proof && !/trust_preflight|Cloudflare|Grafana|proof/i.test(JSON.stringify(proof))) {
      failures.push('local CI finding taxonomy proof-gap row does not name launch proof evidence')
    }
  }
  const operatingReadoutScopeContract = cockpit.localCi?.operatingReadoutScopeContract
  if (operatingReadoutScopeContract) {
    const rowIds = new Set((operatingReadoutScopeContract.rows || []).map(row => row.id))
    for (const id of ['readout-report', 'repo-key', 'repo-path', 'repo-head', 'lane-set', 'proof-only-lanes']) {
      if (!rowIds.has(id)) {
        failures.push(`operating readout scope contract missing row: ${id}`)
      }
    }
    const accepted = (operatingReadoutScopeContract.acceptedProof || []).join(' ')
    const rejected = (operatingReadoutScopeContract.rejectedProof || []).join(' ')
    const acceptedPatterns = [/current repo path/i, /current repo HEAD/i, /lane_keys/i, /current manifest lane/i, /proof-only/i]
    const rejectedPatterns = [/primary-checkout/i, /PR worktree/i, /stale or headless/i, /checkout HEAD/i, /missing current manifest lanes/i, /proof-only/i, /support-only/i]
    if (!acceptedPatterns.every(pattern => pattern.test(accepted))) {
      failures.push('operating readout scope contract does not name current repo path, current repo HEAD, lane set, and proof-only separation')
    }
    if (!rejectedPatterns.every(pattern => pattern.test(rejected))) {
      failures.push('operating readout scope contract does not reject primary-checkout, missing-lane, proof-only, and support-only evidence')
    }
  }

  if (cockpit.telemetry?.grafana && !cockpit.telemetry?.cloudflare?.destinations) {
    failures.push('Grafana evidence exists but Cloudflare destination boundary is missing')
  }
  if (cockpit.telemetry?.grafana && !cockpit.telemetry?.observabilityProofChain?.status) {
    failures.push('Grafana evidence exists but observability proof chain is missing')
  }
  const observabilityProofChain = cockpit.telemetry?.observabilityProofChain
  if (observabilityProofChain) {
    const chainIds = new Set((observabilityProofChain.required || []).map(row => row.id))
    for (const id of ['cloudflare-destinations', 'worker-trigger', 'grafana-read-config', 'tempo-query', 'loki-query', 'freshness']) {
      if (!chainIds.has(id)) {
        failures.push(`observability proof chain missing row: ${id}`)
      }
    }
    const accepted = (observabilityProofChain.acceptedProof || []).join(' ')
    const rejected = (observabilityProofChain.rejectedProof || []).join(' ')
    if (!/Cloudflare|worker-trigger|grafana-read-config|tempo-query|loki-query|fresh/i.test(accepted)) {
      failures.push('observability proof chain does not name the full accepted Cloudflare/Grafana proof chain')
    }
    if (!/wrangler|skip-trigger|Tempo-only|Loki-only|stale|nurse-log/i.test(rejected)) {
      failures.push('observability proof chain does not reject config-only, skipped, partial, stale, and note-only proof')
    }
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
      const nextValidProof = loaded?.nextValidProof || ''
      if (!/mcp__firstbite_local_ci\.list_lanes/i.test(nextValidProof)
        || !/codex-mcp-tool|cursor-mcp-tool/i.test(nextValidProof)
        || !/repo-manifest-v2/i.test(nextValidProof)) {
        failures.push('loaded MCP proof row does not name live loaded-client list_lanes source and repo-manifest proof')
      }
    }

    const grafana = proofById.get('otel-grafana-proof')
    if (grafana && !/Cloudflare|Worker trigger|Tempo|Loki|Grafana|OTEL|fresh/i.test(`${grafana.acceptedProof || ''} ${grafana.rejectedProof || ''} ${grafana.nextValidProof || ''}`)) {
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
    const captureContract = cockpit.localCi.loadedMcpCaptureContract
    if (!captureContract) {
      failures.push('HTML/JSON missing loaded MCP live capture contract while loaded host probe is red')
    } else {
      const acceptedSources = (captureContract.acceptedSources || []).join(' ')
      const rejectedSources = (captureContract.rejectedSources || []).join(' ')
      if (!/mcp__firstbite_local_ci\.list_lanes/.test(acceptedSources)) {
        failures.push('loaded MCP live capture contract does not name the live MCP list_lanes source')
      }
      if (!/repo-backed|previous-loaded-mcp-artifact|--reuse-existing/i.test(rejectedSources)) {
        failures.push('loaded MCP live capture contract does not reject repo-backed or reused artifact sources')
      }
      if (captureContract.currentInvalidReason && !html.includes(escapeForHtmlText(captureContract.currentInvalidReason))) {
        failures.push('HTML missing loaded MCP live capture invalid reason')
      }
      for (const value of [
        cockpit.localCi.loadedMcpProbe.actualRepoPath,
        cockpit.localCi.loadedMcpProbe.expectedRepoPath,
        captureContract.currentRepoPath,
        captureContract.expectedRepoPath,
      ].filter(Boolean)) {
        if (!html.includes(escapeForHtmlText(value))) {
          failures.push(`HTML missing loaded MCP repo path: ${value}`)
        }
      }
      if (!html.includes('Loaded MCP Live Capture Contract')) {
        failures.push('HTML missing loaded MCP live capture section')
      }
      for (const source of captureContract.acceptedSources || []) {
        if (!html.includes(escapeForHtmlText(source))) {
          failures.push(`HTML missing loaded MCP accepted source: ${source}`)
        }
      }
    }
    const missingExpected = cockpit.localCi.loadedMcpProbe.missingLaneIds || []
    if (missingExpected.length > 0 && !missingExpected.every(laneId => html.includes(escapeForHtmlText(laneId)))) {
      failures.push('HTML missing one or more loaded MCP missing-lane IDs')
    }
    const sourceSummary = cockpit.localCi.loadedMcpProbe.sourceSummary
    if (sourceSummary && !html.includes(escapeForHtmlText(sourceSummary))) {
      failures.push('HTML missing loaded MCP proof source summary')
    }
  }

  const observabilityProofChain = cockpit.telemetry?.observabilityProofChain
  if (observabilityProofChain) {
    if (observabilityProofChain.currentInvalidReason && !html.includes(escapeForHtmlText(observabilityProofChain.currentInvalidReason))) {
      failures.push('HTML missing observability proof-chain invalid reason')
    }
    for (const proof of observabilityProofChain.acceptedProof || []) {
      if (!html.includes(escapeForHtmlText(proof))) {
        failures.push(`HTML missing observability accepted proof: ${proof}`)
      }
    }
    for (const proof of observabilityProofChain.rejectedProof || []) {
      if (!html.includes(escapeForHtmlText(proof))) {
        failures.push(`HTML missing observability rejected proof: ${proof}`)
      }
    }
  }

  const operatingReadoutScopeContract = cockpit.localCi?.operatingReadoutScopeContract
  if (operatingReadoutScopeContract) {
    if (operatingReadoutScopeContract.currentInvalidReason && !html.includes(escapeForHtmlText(operatingReadoutScopeContract.currentInvalidReason))) {
      failures.push('HTML missing operating readout scope invalid reason')
    }
    for (const proof of operatingReadoutScopeContract.acceptedProof || []) {
      if (!html.includes(escapeForHtmlText(proof))) {
        failures.push(`HTML missing operating readout accepted proof: ${proof}`)
      }
    }
    for (const proof of operatingReadoutScopeContract.rejectedProof || []) {
      if (!html.includes(escapeForHtmlText(proof))) {
        failures.push(`HTML missing operating readout rejected proof: ${proof}`)
      }
    }
  }

  const findingTaxonomy = cockpit.localCi?.findingTaxonomy
  if (findingTaxonomy) {
    if (!html.includes('Local CI Finding Taxonomy')) {
      failures.push('HTML missing local CI finding taxonomy section')
    }
    for (const category of findingTaxonomy.categories || []) {
      if (category.id && !html.includes(escapeForHtmlText(category.id))) {
        failures.push(`HTML missing local CI finding taxonomy category: ${category.id}`)
      }
      if (category.summary && !html.includes(escapeForHtmlText(category.summary))) {
        failures.push(`HTML missing local CI finding taxonomy summary: ${category.id}`)
      }
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
