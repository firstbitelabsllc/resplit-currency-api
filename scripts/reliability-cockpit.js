#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')

const DEFAULT_OUTPUT_DIR = 'reports'
const REPORT_BASENAME = 'resplit-fx-reliability-cockpit'
const LOADED_MCP_PROBE_BASENAME = 'firstbite-loaded-mcp-lanes.json'
const LOADED_MCP_PROBE_FRESHNESS_LIMIT_MINUTES = 60
const LOADED_MCP_REUSE_COMMAND = 'npm run mcp:loaded-probe -- --reuse-existing'
const TRUST_PREFLIGHT_BASENAME = 'resplit-fx-trust-preflight.json'
const SOURCE_PROMOTION_PACKET_BASENAME = 'resplit-fx-source-promotion-packet.json'
const SOURCE_PROMOTION_PACKET_MARKDOWN = 'resplit-fx-source-promotion-packet.md'
const CLOUDFLARE_OTEL_DESTINATIONS_BASENAME = 'cloudflare-otel-destinations.json'
const PROOF_FRESHNESS_LIMIT_MINUTES = 60
const DEFAULT_AI_LEO_REPO_DIR = path.join(os.homedir(), 'Development', 'ai-leo')
const DEFAULT_FIRSTBITE_LOCAL_CI_DIR = path.join(os.homedir(), 'Development', 'ai-leo', 'skills', 'resplit-watch', 'mcp', 'firstbite-local-ci')
const FIRSTBITE_RUNNER_SERVER_RELATIVE_PATH = 'skills/resplit-watch/mcp/firstbite-local-ci/src/server.mjs'
const FIRSTBITE_RUNNER_README_RELATIVE_PATH = 'skills/resplit-watch/mcp/firstbite-local-ci/README.md'
const FIRSTBITE_WARN_EXIT_BRANCH_REF = 'origin/codex/firstbite-mcp-warn-exits-20260525'
const FIRSTBITE_REVIEW_SCOUT_SCRIPT_RELATIVE_PATH = 'skills/resplit-watch/scripts/firstbite-cursor-review.sh'
const FIRSTBITE_REVIEW_SCOUT_PRODUCER_BRANCH_REF = 'origin/codex/local-ci-handoff-hardening-20260525'
const DEFAULT_FIRSTBITE_SOURCE_REF = 'refs/remotes/origin/main'
const DEFAULT_FIRSTBITE_OPERATING_READOUT_DIR = path.join(os.homedir(), '.agent-ledger', 'firstbite-operating-readout')
const DEFAULT_FIRSTBITE_MCP_REFRESH_PLAN_DIR = path.join(os.homedir(), '.agent-ledger', 'firstbite-mcp-refresh-plan')
const DEFAULT_FIRSTBITE_CURSOR_REVIEW_DIR = path.join(os.homedir(), '.agent-ledger', 'firstbite-cursor-review')
const RESPLIT_CURRENCY_API_REPO_ENV = 'RESPLIT_CURRENCY_API_REPO'
const FIRSTBITE_OPERATING_READOUT_FRESHNESS_LIMIT_MINUTES = 60
const FIRSTBITE_MCP_REFRESH_PLAN_FRESHNESS_LIMIT_MINUTES = 60
const FIRSTBITE_CURSOR_REVIEW_FRESHNESS_LIMIT_MINUTES = 60
const MAX_MCP_HISTORY = 8
const MAX_AGENT_ACTIVITY_ROWS = 8
const SOURCE_PROMOTION_REQUIRED_PATHS = [
  '.firstbite/local-ci.json',
  '.firstbite/source-promotion-decisions.json',
  'package.json',
  'currscript.js',
  'scripts/reliability-cockpit.js',
  'tests/reliability-cockpit.test.js',
  'scripts/source-promotion-packet.js',
  'tests/source-promotion-packet.test.js',
  'scripts/trust-preflight.js',
  'tests/trust-preflight.test.js',
  'scripts/capture-loaded-mcp-probe.js',
  'tests/capture-loaded-mcp-probe.test.js',
  'scripts/verify-cloudflare-otel-destinations.js',
  'tests/verify-cloudflare-otel-destinations.test.js',
  'scripts/verify-grafana-otel-smoke.js',
  'tests/verify-grafana-otel-smoke.test.js',
  'scripts/verify-reliability-cockpit-report.js',
  'tests/verify-reliability-cockpit-report.test.js',
  'scripts/reliability-completion-audit.js',
  'tests/reliability-completion-audit.test.js',
  'scripts/audit-history-backfill-sources.js',
  'tests/audit-history-backfill-sources.test.js',
  'scripts/smoke-check-deploy.js',
  'tests/smoke-check-deploy.test.js',
  'scripts/validate-package.js',
  'tests/validate-package.test.js',
]

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`reliability-cockpit: FAILED\n${error.stack || error.message}`)
    process.exitCode = 1
  })
}

async function main(argv, options = {}) {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(helpText())
    return
  }

  const repoDir = path.resolve(args.repoDir || options.repoDir || process.cwd())
  const outputDir = path.resolve(repoDir, args.outputDir || DEFAULT_OUTPUT_DIR)
  const generatedAt = options.generatedAt || new Date().toISOString()
  const repoBackedMcpProbe = args.skipRepoBackedMcp
    ? null
    : options.repoBackedMcpProbe || captureRepoBackedMcpCatalog({
      generatedAt,
      packageDir: options.repoBackedMcpPackageDir || DEFAULT_FIRSTBITE_LOCAL_CI_DIR,
      repoDir,
    })
  const report = buildReport({
    repoDir,
    generatedAt,
    gitState: options.gitState,
    mcpReportRoot: options.mcpReportRoot,
    repoBackedMcpProbe,
    repoBackedMcpPackageDir: options.repoBackedMcpPackageDir,
  })

  const json = `${JSON.stringify(report, null, 2)}\n`
  const html = renderHtml(report)

  if (!args.noWrite) {
    fs.mkdirSync(outputDir, { recursive: true })
    fs.writeFileSync(path.join(outputDir, `${REPORT_BASENAME}.json`), json)
    fs.writeFileSync(path.join(outputDir, `${REPORT_BASENAME}.html`), html)
  }

  if (args.printJson) {
    process.stdout.write(json)
  } else if (!args.noWrite) {
    process.stdout.write(`reliability-cockpit: wrote ${path.join(outputDir, `${REPORT_BASENAME}.html`)}\n`)
  }
}

function parseArgs(argv) {
  const args = {
    outputDir: DEFAULT_OUTPUT_DIR,
    printJson: false,
    noWrite: false,
    help: false,
    repoDir: null,
    skipRepoBackedMcp: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
    case '--help':
    case '-h':
      args.help = true
      break
    case '--json':
      args.printJson = true
      break
    case '--no-write':
      args.noWrite = true
      break
    case '--output-dir':
      args.outputDir = requireValue(argv, index, arg)
      index += 1
      break
    case '--repo':
      args.repoDir = requireValue(argv, index, arg)
      index += 1
      break
    case '--skip-repo-backed-mcp':
      args.skipRepoBackedMcp = true
      break
    default:
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return args
}

function requireValue(argv, index, arg) {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${arg} requires a value`)
  }
  return value
}

function helpText() {
  return [
    'Usage: node scripts/reliability-cockpit.js [--json] [--no-write] [--skip-repo-backed-mcp] [--output-dir reports]',
    '',
    'Generates a local Resplit FX reliability cockpit as JSON and HTML.',
    'The cockpit is read-only: it inspects repo files, local git state, nurse logs,',
    'local-CI declarations, and local-CI MCP report artifacts without calling live deploys.',
    'By default it also runs the repo-backed FirstBite MCP list_lanes probe so',
    'operator UI can distinguish a current package catalog from a stale loaded MCP host.',
    '',
  ].join('\n')
}

function buildReport({
  repoDir,
  generatedAt = new Date().toISOString(),
  gitState,
  mcpReportRoot,
  loadedMcpProbePath,
  repoBackedMcpProbe,
  repoBackedMcpPackageDir,
  firstBiteRunnerControlPlane,
  firstBiteReviewScoutProducerControlPlane,
  aiLeoRepoDir,
  operatingReadoutRoot,
  mcpRefreshPlanRoot,
  cursorReviewRoot,
  sharedLedgerPath,
} = {}) {
  const manifestPath = path.join(repoDir, '.firstbite', 'local-ci.json')
  const packagePath = path.join(repoDir, 'package.json')
  const wranglerPath = path.join(repoDir, 'wrangler.jsonc')
  const nurseLogPath = path.join(repoDir, '.cursor', 'plans', 'resplit-nurse.log.md')
  const inboxPath = path.join(repoDir, 'INBOX.md')
  const ledgerPath = path.join(repoDir, '.agent-ledger', 'activity.jsonl')
  const trustPreflightPath = path.join(repoDir, DEFAULT_OUTPUT_DIR, TRUST_PREFLIGHT_BASENAME)
  const sourcePromotionPacketPath = path.join(repoDir, DEFAULT_OUTPUT_DIR, SOURCE_PROMOTION_PACKET_BASENAME)

  const manifest = readJsonIfExists(manifestPath)
  const packageJson = readJsonIfExists(packagePath)
  const wrangler = readJsoncIfExists(wranglerPath)
  const nurseLog = parseNurseLog(readTextIfExists(nurseLogPath))
  const inbox = parseInbox(readTextIfExists(inboxPath))
  const ledger = inspectLedger({
    repoLedgerPath: ledgerPath,
    sharedLedgerPath: sharedLedgerPath || path.join(os.homedir(), '.agent-ledger', 'activity.jsonl'),
    repoName: packageJson?.name || path.basename(repoDir),
    generatedAt,
  })
  const git = gitState || getGitState(repoDir)
  const mcpProof = findLatestMcpProofForRepo({
    repoDir,
    repoKey: manifest?.repo,
    expectedLaneIds: Object.keys(manifest?.localCi?.lanes || {}),
    reportRoot: mcpReportRoot || path.join(os.homedir(), '.agent-ledger', 'firstbite-local-ci-mcp'),
  })
  const trackedSource = inspectTrackedSourceContract({
    repoDir,
    manifest,
    packageJson,
    manifestPath,
  })
  const loadedMcpProbe = inspectLoadedMcpProbe({
    probePath: loadedMcpProbePath || path.join(repoDir, DEFAULT_OUTPUT_DIR, LOADED_MCP_PROBE_BASENAME),
    expectedRepo: manifest?.repo,
    expectedLaneIds: Object.keys(manifest?.localCi?.lanes || {}),
    generatedAt,
  })
  const repoBackedMcpCatalog = inspectRepoBackedMcpCatalog({
    artifact: repoBackedMcpProbe,
    packageDir: repoBackedMcpPackageDir || DEFAULT_FIRSTBITE_LOCAL_CI_DIR,
    expectedRepo: manifest?.repo,
    expectedRepoPath: repoDir,
    expectedLaneIds: Object.keys(manifest?.localCi?.lanes || {}),
    generatedAt,
  })
  const operatingReadout = inspectFirstBiteOperatingReadout({
    reportRoot: operatingReadoutRoot || DEFAULT_FIRSTBITE_OPERATING_READOUT_DIR,
    expectedRepo: manifest?.repo,
    generatedAt,
  })
  const mcpRefreshPlan = inspectFirstBiteMcpRefreshPlan({
    reportRoot: mcpRefreshPlanRoot || DEFAULT_FIRSTBITE_MCP_REFRESH_PLAN_DIR,
    expectedRepo: manifest?.repo,
    expectedLaneIds: Object.keys(manifest?.localCi?.lanes || {}),
    repoDir,
    generatedAt,
  })
  const runnerControlPlane = firstBiteRunnerControlPlane || inspectFirstBiteRunnerControlPlane({
    aiLeoRepoDir: aiLeoRepoDir || DEFAULT_AI_LEO_REPO_DIR,
    packageDir: repoBackedMcpPackageDir || DEFAULT_FIRSTBITE_LOCAL_CI_DIR,
  })
  const reviewScoutProducerControlPlane = firstBiteReviewScoutProducerControlPlane || inspectFirstBiteReviewScoutProducerControlPlane({
    aiLeoRepoDir: aiLeoRepoDir || DEFAULT_AI_LEO_REPO_DIR,
  })
  const reviewScout = inspectFirstBiteCursorReviewScout({
    reportRoot: cursorReviewRoot || DEFAULT_FIRSTBITE_CURSOR_REVIEW_DIR,
    expectedRepo: manifest?.repo,
    repoName: packageJson?.name || path.basename(repoDir),
    repoDir,
    git,
    generatedAt,
  })

  const localCi = inspectLocalCiManifest(manifest, manifestPath, mcpProof, generatedAt, loadedMcpProbe, trackedSource, repoBackedMcpCatalog, git)
  localCi.operatingReadout = operatingReadout
  localCi.mcpRefreshPlan = mcpRefreshPlan
  localCi.runnerControlPlane = runnerControlPlane
  localCi.reviewScoutProducerControlPlane = reviewScoutProducerControlPlane
  localCi.sourcePromotionBundle = buildSourcePromotionBundle({
    repoDir,
    trackedSource: localCi.trackedSource,
    cleanProofReadiness: localCi.cleanProofReadiness,
  })
  localCi.sourcePromotionPacket = inspectSourcePromotionPacket({
    artifact: readJsonIfExists(sourcePromotionPacketPath),
    artifactPath: sourcePromotionPacketPath,
    markdownPath: path.join(repoDir, DEFAULT_OUTPUT_DIR, SOURCE_PROMOTION_PACKET_MARKDOWN),
    generatedAt,
  })
  const telemetry = inspectTelemetry(wrangler, wranglerPath, packageJson, repoDir, { generatedAt })
  const gates = inspectGates(packageJson)
  const preflight = inspectTrustPreflight(readJsonIfExists(trustPreflightPath), trustPreflightPath, generatedAt)
  const risks = computeRisks({
    git,
    localCi,
    telemetry,
    nurseLog,
    inbox,
    ledger,
    reviewScout,
  })
  const contracts = buildTrustContracts({
    git,
    localCi,
    telemetry,
    nurseLog,
    ledger,
    reviewScout,
  })
  const operatorActions = buildOperatorActionQueue({
    localCi,
    telemetry,
    nurseLog,
    inbox,
    ledger,
    reviewScout,
    contracts,
  })
  const operatorRecoveryFlow = buildOperatorRecoveryFlow(operatorActions)
  const evidenceFreshness = buildEvidenceFreshnessLedger({
    repoDir,
    generatedAt,
    localCi,
    telemetry,
    preflight,
    reviewScout,
  })
  const launchTrustAudit = buildLaunchTrustAudit({
    contracts,
    localCi,
    telemetry,
    nurseLog,
    ledger,
    reviewScout,
  })

  return {
    generatedAt,
    title: 'Resplit FX Reliability Cockpit',
    repo: {
      name: packageJson?.name || path.basename(repoDir),
      path: repoDir,
      git,
    },
    verdict: summarizeVerdict(risks),
    localCi,
    gates,
    telemetry,
    agentState: {
      nurseLog,
      inbox,
      ledger,
      reviewScout,
    },
    trustModel: {
      principles: [
        'Repo-owned .firstbite/local-ci.json is the lane contract; dashboards and agents display or execute it.',
        'A green lane is only trusted when it has source state, report/log artifacts, and the tested head is named.',
        'FX launch readiness keeps freshness, release-history coverage, local CI, and OTEL/Grafana proof separate.',
        'Grafana/OTEL readiness is configuration proof plus Tempo/Loki evidence, not an old nurse-log claim.',
      ],
      preflight,
      launchTrustAudit,
      evidenceFreshness,
      operatorActions,
      operatorRecoveryFlow,
      contracts,
      risks,
    },
  }
}

function inspectTrustPreflight(artifact, artifactPath, generatedAt = new Date().toISOString()) {
  if (!artifact) {
    return {
      status: 'missing',
      summary: 'No local trust preflight artifact has been generated yet.',
      path: artifactPath,
      generatedAt: null,
      ageMinutes: null,
      mode: null,
      commands: [],
    }
  }

  const ageMinutes = artifact.generatedAt
    ? Math.max(0, Math.round((new Date(generatedAt).getTime() - new Date(artifact.generatedAt).getTime()) / 60000))
    : null
  const commands = Array.isArray(artifact.commands) ? artifact.commands : []
  const counts = commands.reduce((acc, command) => {
    const status = command.status || 'unknown'
    acc[status] = (acc[status] || 0) + 1
    return acc
  }, {})
  const status = ['green', 'yellow', 'red'].includes(artifact.status) ? artifact.status : 'yellow'
  const summary = artifact.summary?.headline
    || `${commands.length} command(s): ${counts.green || 0} green, ${counts.yellow || 0} yellow, ${counts.red || 0} red.`

  return {
    status,
    summary,
    path: artifactPath,
    generatedAt: artifact.generatedAt || null,
    ageMinutes,
    mode: artifact.mode || null,
    cockpitVerdict: artifact.cockpit?.verdict || null,
    markdownPath: artifact.markdownPath || null,
    commands: commands.map(command => ({
      id: command.id || 'unknown',
      label: command.label || command.id || 'unknown',
      command: command.command || '',
      status: command.status || 'unknown',
      rc: command.rc,
      durationMs: command.durationMs,
      expectedExitCodes: command.expectedExitCodes || [],
      yellowExitCodes: command.yellowExitCodes || [],
    })),
  }
}

function inspectSourcePromotionPacket({
  artifact,
  artifactPath,
  markdownPath,
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!artifact) {
    return {
      status: 'missing',
      summary: 'Source promotion packet proof is missing.',
      artifactPath,
      markdownPath,
      generatedAt: null,
      ageMinutes: null,
      promotionReview: null,
      counts: {},
      commands: { writePacket: 'npm run source:promotion-packet' },
    }
  }

  const checkedAt = artifact.generatedAt || artifact.checkedAt || null
  const promotionReview = artifact.promotionReview || null
  const reconciliation = promotionReview
    ? `; reconciliation ${promotionReview.status || 'unknown'} (${promotionReview.summary || 'no summary'})`
    : ''

  return {
    status: artifact.status || promotionReview?.status || 'yellow',
    summary: `${summarizeSourcePromotionPacket(artifact, null)}${reconciliation}`,
    artifactPath,
    markdownPath: artifact.markdownPath || markdownPath,
    generatedAt: checkedAt,
    ageMinutes: ageMinutesBetween(checkedAt, generatedAt),
    promotionReview,
    stagingGate: artifact.stagingGate || null,
    stagedBundle: artifact.stagedBundle || null,
    counts: artifact.summary?.counts || {},
    commands: artifact.commands || { writePacket: 'npm run source:promotion-packet' },
  }
}

function inspectLocalCiManifest(manifest, manifestPath, mcpProof, generatedAt = new Date().toISOString(), loadedMcpProbe = null, trackedSource = null, repoBackedMcpProbe = null, git = null) {
  if (!manifest) {
    return {
      status: 'red',
      manifestPath,
      manifestPresent: false,
      lanes: [],
      mcpProof,
      loadedMcpProbe,
      repoBackedMcpProbe,
      trackedSource,
      cleanProofReadiness: assessCleanProofReadiness({
        trackedSource,
        repoBackedMcpProbe,
        git,
      }),
      proofFreshness: evaluateMcpProofFreshness(null, generatedAt),
      mcpCatalogDelta: buildMcpCatalogDelta({
        loadedMcpProbe,
        repoBackedMcpProbe,
        expectedRepo: null,
        expectedLaneIds: [],
      }),
      summary: 'No repo-owned local-CI manifest is present.',
    }
  }

  const lanes = Object.entries(manifest.localCi?.lanes || {}).map(([id, lane]) => ({
    id,
    kind: lane.kind,
    command: lane.command,
    timeoutMs: lane.timeoutMs,
    expectedExitCodes: lane.expectedExitCodes || [],
    yellowExitCodes: lane.yellowExitCodes || [],
    note: lane.note || null,
  }))

  const missingKinds = ['unit', 'integration', 'ui'].filter(kind => !lanes.some(lane => lane.kind === kind))
  const proofStatus = mcpProof.latest?.status || null
  const proofFreshness = evaluateMcpProofFreshness(mcpProof.latest, generatedAt)
  const diagnosticStatus = summarizeLaneDiagnostics(mcpProof.latest?.lanes || [])
  const diagnosticSummary = summarizeLaneDiagnosticMessages(mcpProof.latest?.lanes || [])
  const proofManifestMatch = evaluateProofManifestMatch(lanes, mcpProof.latest)
  const currentManifestProof = summarizeCurrentManifestProof({
    proof: mcpProof.latestComplete,
    selectedProof: mcpProof.latest,
    lanes,
    generatedAt,
  })
  const cleanProofReadiness = assessCleanProofReadiness({
    lanes,
    proof: mcpProof.latest,
    proofFreshness,
    proofManifestMatch,
    diagnosticStatus,
    diagnosticSummary,
    currentManifestProof,
    trackedSource,
    repoBackedMcpProbe,
    git,
  })
  const status = missingKinds.length > 0
    ? 'yellow'
    : proofStatus === 'pass'
      && proofFreshness.status === 'green'
      && diagnosticStatus === 'green'
      && proofManifestMatch.status === 'green'
      ? 'green'
      : isRedProofStatus(proofStatus)
        ? 'red'
        : proofManifestMatch.status === 'red'
          ? 'red'
        : diagnosticStatus === 'red'
          ? 'red'
        : 'yellow'
  const baseSummary = mcpProof.latest
    ? (proofFreshness.status === 'green' && diagnosticStatus === 'green' && proofManifestMatch.status === 'green'
      ? `Manifest has ${lanes.length} lane(s); latest MCP proof is ${mcpProof.latest.status}.`
      : `Manifest has ${lanes.length} lane(s); latest MCP proof is ${mcpProof.latest.status}, but ${diagnosticSummary || proofManifestMatch.summary || proofFreshness.summary}`)
    : `Manifest has ${lanes.length} lane(s), but no MCP execute proof for ${manifest.repo} was found locally.`
  const summary = currentManifestProof && currentManifestProof.runId !== mcpProof.latest?.runId
    ? `${baseSummary} Newer current-manifest proof ${currentManifestProof.runId} passed from ${currentManifestProof.sourceSummary}; clean tracked proof is still required.`
    : baseSummary

  return {
    status,
    manifestPath,
    manifestPresent: true,
    repoKey: manifest.repo,
    display: manifest.display,
    lanes,
    missingKinds,
    proofFreshness,
    proofManifestMatch,
    currentManifestProof,
    diagnosticStatus,
    diagnosticSummary,
    mcpProof,
    loadedMcpProbe,
    repoBackedMcpProbe,
    mcpCatalogDelta: buildMcpCatalogDelta({
      loadedMcpProbe,
      repoBackedMcpProbe,
      expectedRepo: manifest.repo,
      expectedLaneIds: lanes.map(lane => lane.id),
    }),
    trackedSource,
    cleanProofReadiness,
    summary,
  }
}

function evaluateProofManifestMatch(lanes, proof) {
  if (!proof) {
    return {
      status: 'yellow',
      missingLaneIds: lanes.map(lane => lane.id),
      mismatches: [],
      unknownLaneIds: [],
      summary: 'No MCP proof exists to compare against the manifest commands.',
    }
  }

  const proofByLane = new Map((proof.lanes || []).map(lane => [lane.lane, lane]))
  const missingLaneIds = []
  const unknownLaneIds = []
  const mismatches = []
  for (const lane of lanes) {
    const proofLane = proofByLane.get(lane.id)
    if (!proofLane) {
      missingLaneIds.push(lane.id)
      continue
    }
    const expectedCommand = normalizeCommand(lane.command)
    const actualCommand = normalizeCommand(proofLane.command)
    if (!actualCommand) {
      unknownLaneIds.push(lane.id)
      continue
    }
    if (expectedCommand !== actualCommand) {
      mismatches.push({
        lane: lane.id,
        expected: lane.command || '',
        actual: proofLane.command || '',
      })
    }
  }

  if (mismatches.length > 0) {
    return {
      status: 'red',
      missingLaneIds,
      unknownLaneIds,
      mismatches,
      summary: `Latest MCP proof command drift: ${mismatches.map(item => `${item.lane} expected "${item.expected}", ran "${item.actual}"`).join('; ')}`,
    }
  }
  if (missingLaneIds.length > 0 || unknownLaneIds.length > 0) {
    return {
      status: 'yellow',
      missingLaneIds,
      unknownLaneIds,
      mismatches,
      summary: `Latest MCP proof command match is incomplete: missing ${missingLaneIds.length} lane(s), unknown command for ${unknownLaneIds.length} lane(s).`,
    }
  }

  return {
    status: 'green',
    missingLaneIds: [],
    unknownLaneIds: [],
    mismatches: [],
    summary: 'Latest MCP proof commands match the current manifest.',
  }
}

function summarizeCurrentManifestProof({
  proof,
  selectedProof,
  lanes,
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!proof) {
    return null
  }

  const manifestMatch = evaluateProofManifestMatch(lanes, proof)
  const freshness = evaluateMcpProofFreshness(proof, generatedAt)
  const diagnosticStatus = summarizeLaneDiagnostics(proof.lanes || [])
  const diagnosticSummary = summarizeLaneDiagnosticMessages(proof.lanes || [])
  const sourceState = proof.executionSourceState || proof.sourceState
  const sourceTrustStatus = sourceStateTrustStatus(sourceState)
  const sourceSummary = sourceState
    ? `${sourceState.syncStatus || 'unknown'} source, dirty ${sourceState.dirtyCount ?? 'unknown'}, ahead ${sourceState.aheadOriginMain ?? 'unknown'}, behind ${sourceState.behindOriginMain ?? 'unknown'}`
    : 'missing source_state'
  const status = proof.status === 'pass'
    && freshness.status === 'green'
    && manifestMatch.status === 'green'
    && diagnosticStatus === 'green'
    ? (sourceTrustStatus === 'green' ? 'green' : 'yellow')
    : isRedProofStatus(proof.status) || manifestMatch.status === 'red' || diagnosticStatus === 'red'
      ? 'red'
      : 'yellow'

  return {
    status,
    runId: proof.runId,
    selectedRunId: selectedProof?.runId || null,
    selected: Boolean(selectedProof?.runId && selectedProof.runId === proof.runId),
    proofStatus: proof.status,
    createdAt: proof.createdAt,
    reportPath: proof.reportPath,
    manifestMatch,
    freshness,
    diagnosticStatus,
    diagnosticSummary,
    sourceTrustStatus,
    sourceSummary,
  }
}

function assessCleanProofReadiness({
  lanes = [],
  proof = null,
  proofFreshness = null,
  proofManifestMatch = null,
  diagnosticStatus = 'yellow',
  diagnosticSummary = '',
  currentManifestProof = null,
  trackedSource = null,
  repoBackedMcpProbe = null,
  git = null,
} = {}) {
  const reasons = []
  const runnerContract = 'FirstBite run_lanes with worktree=true creates disposable detached worktrees from source_ref; launch proof must pass source_ref=refs/remotes/origin/main so a dirty registered checkout cannot leak into execution. worktree=false runs the active checkout and is supporting evidence only.'
  const cleanCommand = `cd ${DEFAULT_FIRSTBITE_LOCAL_CI_DIR} && npm run --silent call -- run_lanes '{"mode":"execute","group":"resplit_currency_api_all","worktree":true,"source_ref":"${DEFAULT_FIRSTBITE_SOURCE_REF}","run_id":"verify-resplit-fx-clean-origin-main-YYYYMMDD"}'`
  const dirtyCommand = `cd ${DEFAULT_FIRSTBITE_LOCAL_CI_DIR} && npm run --silent call -- run_lanes '{"mode":"execute","group":"resplit_currency_api_all","worktree":false,"run_id":"verify-resplit-fx-current-manifest-YYYYMMDD"}'`
  const proofUsesPinnedOriginMain = usesPinnedOriginMainSourceRef(proof)

  if (trackedSource?.status && trackedSource.status !== 'green') {
    reasons.push({
      status: trackedSource.status,
      area: 'tracked contract',
      detail: trackedSource.summary,
    })
  } else if (!trackedSource) {
    reasons.push({
      status: 'yellow',
      area: 'tracked contract',
      detail: 'Tracked source contract was not inspected.',
    })
  }

  if (!proof) {
    reasons.push({
      status: 'yellow',
      area: 'selected proof',
      detail: 'No selected MCP execute proof exists for a clean worktree run.',
    })
  } else {
    if (proof.status !== 'pass') {
      reasons.push({
        status: isRedProofStatus(proof.status) ? 'red' : 'yellow',
        area: 'selected proof',
        detail: `Selected MCP proof ${proof.runId || 'unknown'} is ${proof.status || 'unknown'}.`,
      })
    }
    if (proofFreshness?.status && proofFreshness.status !== 'green') {
      reasons.push({
        status: proofFreshness.status,
        area: 'freshness',
        detail: proofFreshness.summary || 'Selected MCP proof is not fresh.',
      })
    }
    if (proofManifestMatch?.status && proofManifestMatch.status !== 'green') {
      reasons.push({
        status: proofManifestMatch.status,
        area: 'manifest commands',
        detail: proofManifestMatch.summary || 'Selected MCP proof commands do not match the current manifest.',
      })
    }
    if (diagnosticStatus !== 'green') {
      reasons.push({
        status: diagnosticStatus === 'red' ? 'red' : 'yellow',
        area: 'lane diagnostics',
        detail: diagnosticSummary || 'Selected MCP proof has non-green lane diagnostics.',
      })
    }

    const proofSource = proof.executionSourceState || proof.sourceState
    if (!isTrustworthyCleanExecutionSource(proofSource)) {
      reasons.push({
        status: (proofSource?.dirtyCount || 0) > 0 ? 'red' : 'yellow',
        area: 'execution source',
        detail: proofSource
          ? `Selected proof execution source is ${sourceStateSummary(proofSource)}.`
          : 'Selected proof is missing execution source_state.',
      })
    }
  }

  if (currentManifestProof && !currentManifestProof.selected && currentManifestProof.status !== 'green') {
    reasons.push({
      status: currentManifestProof.status === 'red' ? 'red' : 'yellow',
      area: 'current manifest proof',
      detail: `Newer current-manifest proof ${currentManifestProof.runId || 'unknown'} is ${currentManifestProof.status}; it came from ${currentManifestProof.sourceSummary || 'unknown source'}.`,
    })
  }

  if (!proofUsesPinnedOriginMain && git && ((git.dirtyCount || 0) > 0 || (git.behindOriginMain || 0) > 0)) {
    reasons.push({
      status: 'yellow',
      area: 'primary checkout',
      detail: `Primary checkout is dirty ${git.dirtyCount ?? 'unknown'} and behind ${git.behindOriginMain ?? 'unknown'} on ${git.branch || 'unknown'}.`,
    })
  }

  const portability = repoBackedMcpProbe?.manifestPortability
  if (portability) {
    if (portability.fresh_clone_ready === false) {
      reasons.push({
        status: 'red',
        area: 'manifest portability',
        detail: 'Repo-backed MCP catalog says fresh_clone_ready=false; another Mac cannot pull the full manifest contract from origin/main.',
      })
    } else if (portability.ready === false && !proofUsesPinnedOriginMain) {
      reasons.push({
        status: 'yellow',
        area: 'active checkout portability',
        detail: 'Repo-backed MCP catalog says active checkout ready=false; at least one primary repo path still has an untracked or dirty manifest.',
      })
    }
  }

  const hasRed = reasons.some(reason => reason.status === 'red')
  const hasYellow = reasons.some(reason => reason.status === 'yellow')
  const selectedProofClean = proof?.status === 'pass'
    && proofFreshness?.status === 'green'
    && proofManifestMatch?.status === 'green'
    && diagnosticStatus === 'green'
    && isTrustworthyCleanExecutionSource(proof.executionSourceState || proof.sourceState)
  const trackedGreen = trackedSource?.status === 'green'
  const status = hasRed
    ? 'red'
    : selectedProofClean && trackedGreen && !hasYellow
      ? 'green'
      : 'yellow'
  const summary = status === 'green'
    ? `Clean worktree proof ${proof.runId} matches the current tracked manifest contract.`
    : `${reasons.length} clean-proof readiness issue(s); current lane count ${lanes.length}.`
  const nextAction = status === 'green'
    ? 'Keep this proof fresh before launch claims.'
    : trackedSource?.status === 'green'
      ? 'Rerun the clean worktree command and keep the report attached to this cockpit.'
      : 'Land or sync the current manifest, package scripts, and cockpit scripts to tracked source, then rerun the clean worktree command.'

  return {
    status,
    summary,
    runnerContract,
    reasons,
    selectedProof: proof ? {
      runId: proof.runId || null,
      status: proof.status || null,
      source: sourceStateSummary(proof.executionSourceState || proof.sourceState),
      sourceRef: proof.requestedSourceRef || null,
      resolvedSourceRef: proof.resolvedSourceRef || null,
    } : null,
    currentManifestProof: currentManifestProof ? {
      runId: currentManifestProof.runId || null,
      status: currentManifestProof.status || null,
      source: currentManifestProof.sourceSummary || null,
    } : null,
    commands: {
      cleanWorktree: cleanCommand,
      dirtySupporting: dirtyCommand,
    },
    nextAction,
  }
}

function usesPinnedOriginMainSourceRef(proof) {
  if (!proof) {
    return false
  }
  return isOriginMainSourceRef(proof.requestedSourceRef)
    || (proof.lanes || []).some(lane => isOriginMainSourceRef(lane.requestedSourceRef))
}

function isOriginMainSourceRef(sourceRef) {
  return sourceRef === DEFAULT_FIRSTBITE_SOURCE_REF || sourceRef === 'origin/main'
}

function isTrustworthyCleanExecutionSource(sourceState) {
  if (!sourceState) {
    return false
  }
  if (sourceState.dirtyCount !== 0) {
    return false
  }
  return sourceState.syncStatus === 'origin_main'
    || sourceState.syncStatus === 'not_origin_main'
    || sourceState.syncStatus === 'clean'
}

function sourceStateSummary(sourceState) {
  if (!sourceState) {
    return 'missing source_state'
  }
  return `${sourceState.syncStatus || 'unknown'} source, dirty ${sourceState.dirtyCount ?? 'unknown'}, ahead ${sourceState.aheadOriginMain ?? 'unknown'}, behind ${sourceState.behindOriginMain ?? 'unknown'}`
}

function normalizeCommand(command) {
  return String(command || '').trim().replace(/\s+/g, ' ')
}

function inspectTrackedSourceContract({ repoDir, manifest, packageJson, manifestPath }) {
  const currentScripts = packageJson?.scripts || {}
  const headPackage = readPackageJsonAtRef(repoDir, 'HEAD')
  const originPackage = readPackageJsonAtRef(repoDir, 'origin/main')
  const headScripts = headPackage?.scripts || {}
  const originScripts = originPackage?.scripts || {}
  const manifestRelPath = manifestPath ? path.relative(repoDir, manifestPath).split(path.sep).join('/') : '.firstbite/local-ci.json'
  const headManifest = readJsonAtRef(repoDir, 'HEAD', manifestRelPath)
  const originManifest = readJsonAtRef(repoDir, 'origin/main', manifestRelPath)
  const laneCommands = Object.values(manifest?.localCi?.lanes || {})
    .map(lane => lane?.command)
    .filter(Boolean)
  const manifestLaneRows = inspectManifestLaneCommands(manifest, headManifest, originManifest)
  const laneScriptSeeds = unique(laneCommands.flatMap(extractNpmRunScriptNames))
  const requiredScriptSeeds = unique([
    ...laneScriptSeeds,
    'reliability:cockpit',
    'reliability:cockpit:verify',
    'source:promotion-packet',
  ]).filter(name => currentScripts[name] || headScripts[name] || originScripts[name])
  const requiredScripts = collectPackageScriptClosure(currentScripts, requiredScriptSeeds)
  const scriptRows = requiredScripts.map(name => {
    const currentCommand = currentScripts[name] || null
    const headCommand = headScripts[name] || null
    const originCommand = originScripts[name] || null
    const status = scriptContractStatus({ currentCommand, headCommand, originCommand })
    return {
      name,
      status,
      currentCommand,
      headCommand,
      originCommand,
      currentPresent: Boolean(currentCommand),
      headPresent: Boolean(headCommand),
      originPresent: Boolean(originCommand),
    }
  })
  const scriptFilePaths = unique(
    requiredScripts.flatMap(name => extractCommandFilePaths(currentScripts[name] || ''))
  )
  const fileRows = unique([
    manifestRelPath,
    'package.json',
    ...scriptFilePaths,
  ])
    .filter(Boolean)
    .map(relPath => inspectTrackedPath(repoDir, relPath))
  const missingHeadFiles = fileRows.filter(row => !row.headExists)
  const missingOriginFiles = fileRows.filter(row => !row.originExists)
  const changedCurrentFiles = fileRows.filter(row => row.gitStatus && !row.gitStatus.startsWith('??'))
  const untrackedFiles = fileRows.filter(row => row.gitStatus?.startsWith('??') || (!row.headExists && row.currentExists))
  const scriptProblems = scriptRows.filter(row => row.status !== 'green')
  const manifestProblems = manifestLaneRows.filter(row => row.status !== 'green')
  const status = missingHeadFiles.length > 0
    || missingOriginFiles.length > 0
    || scriptProblems.some(row => row.status === 'red')
    || manifestProblems.some(row => row.status === 'red')
    ? 'red'
    : changedCurrentFiles.length > 0 || untrackedFiles.length > 0 || scriptProblems.length > 0 || manifestProblems.length > 0
      ? 'yellow'
      : 'green'
  const summary = status === 'green'
    ? 'Local-CI contract files and package scripts match tracked HEAD and origin/main.'
    : [
      `${missingHeadFiles.length} file(s) missing from HEAD`,
      `${missingOriginFiles.length} file(s) missing from origin/main`,
      `${manifestProblems.length} manifest lane command drift(s)`,
      `${scriptProblems.length} script contract issue(s)`,
      `${untrackedFiles.length} untracked/current-only contract file(s)`,
    ].join('; ')

  return {
    status,
    summary,
    refs: {
      head: 'HEAD',
      origin: 'origin/main',
      originAvailable: Boolean(originPackage),
    },
    manifestLaneCommands: manifestLaneRows,
    requiredScripts: scriptRows,
    files: fileRows,
  }
}

function buildSourcePromotionBundle({ repoDir, trackedSource = null, cleanProofReadiness = null } = {}) {
  const trackedPaths = (trackedSource?.files || []).map(row => row.path)
  const paths = unique([
    ...trackedPaths,
    ...SOURCE_PROMOTION_REQUIRED_PATHS,
  ]).filter(Boolean)

  const files = paths
    .map(relPath => inspectTrackedPath(repoDir, relPath))
    .map(row => ({
      ...row,
      role: sourcePromotionPathRole(row.path, trackedPaths),
      action: sourcePromotionPathAction(row),
    }))

  const currentOnlyFiles = files.filter(row => row.currentExists && (!row.headExists || row.gitStatus?.startsWith('??')))
  const missingHeadFiles = files.filter(row => row.currentExists && !row.headExists)
  const missingOriginFiles = files.filter(row => row.currentExists && !row.originExists)
  const modifiedFiles = files.filter(row => row.gitStatus && !row.gitStatus.startsWith('??'))
  const missingCurrentFiles = files.filter(row => !row.currentExists)
  const commandDrift = [
    ...(trackedSource?.manifestLaneCommands || []).filter(row => row.status !== 'green').map(row => ({
      kind: 'manifest lane',
      name: row.lane,
      status: row.status,
      current: row.currentCommand,
      head: row.headCommand,
      origin: row.originCommand,
    })),
    ...(trackedSource?.requiredScripts || []).filter(row => row.status !== 'green').map(row => ({
      kind: 'package script',
      name: row.name,
      status: row.status,
      current: row.currentCommand,
      head: row.headCommand,
      origin: row.originCommand,
    })),
  ]
  const dirtyBundleFiles = [...currentOnlyFiles, ...modifiedFiles]
  const red = missingCurrentFiles.length > 0
    || currentOnlyFiles.length > 0
    || modifiedFiles.length > 0
    || missingOriginFiles.length > 0
    || commandDrift.some(row => row.status === 'red')
    || trackedSource?.status === 'red'
  const yellow = commandDrift.length > 0
    || trackedSource?.status === 'yellow'
  const status = red ? 'red' : yellow ? 'yellow' : 'green'
  const summary = status === 'green'
    ? 'Source promotion bundle is tracked; clean worktree proof can target the current cockpit and local-CI contract.'
    : [
      `${currentOnlyFiles.length} current-only file(s)`,
      `${modifiedFiles.length} modified tracked file(s)`,
      `${missingCurrentFiles.length} missing current file(s)`,
      `${missingHeadFiles.length} file(s) absent from HEAD`,
      `${missingOriginFiles.length} file(s) absent from origin/main`,
      `${commandDrift.length} command drift row(s)`,
    ].join('; ')
  const pathArgs = shellQuotePaths(paths)

  return {
    status,
    summary,
    files,
    commandDrift,
    counts: {
      currentOnlyFiles: currentOnlyFiles.length,
      modifiedFiles: modifiedFiles.length,
      missingCurrentFiles: missingCurrentFiles.length,
      missingHeadFiles: missingHeadFiles.length,
      missingOriginFiles: missingOriginFiles.length,
      commandDrift: commandDrift.length,
    },
    recommendedPaths: dirtyBundleFiles.map(row => row.path),
    commands: {
      inspectStatus: pathArgs ? `git status --short -- ${pathArgs}` : 'git status --short',
      inspectDiff: pathArgs ? `git diff -- ${pathArgs}` : 'git diff',
      inspectUntracked: pathArgs ? `git ls-files --others --exclude-standard -- ${pathArgs}` : 'git ls-files --others --exclude-standard',
      writePacket: 'npm run source:promotion-packet',
      reviewPacket: path.join(DEFAULT_OUTPUT_DIR, 'resplit-fx-source-promotion-packet.md'),
      cleanProofAfterPromotion: cleanProofReadiness?.commands?.cleanWorktree || '',
    },
    nextAction: status === 'green'
      ? 'Run the clean worktree FirstBite command and attach the new report.'
      : 'Review this bundle, land the listed current-only and modified control-plane paths onto tracked source, then rerun clean worktree FirstBite proof.',
  }
}

function inspectFirstBiteOperatingReadout({
  reportRoot = DEFAULT_FIRSTBITE_OPERATING_READOUT_DIR,
  expectedRepo = 'resplit_currency_api',
  generatedAt = new Date().toISOString(),
} = {}) {
  const missing = {
    status: 'missing',
    reportRoot,
    reportPath: null,
    summaryPath: null,
    runId: null,
    createdAt: null,
    ageMinutes: null,
    searchedReports: 0,
    localCi: null,
    catalog: null,
    manifestPortability: null,
    failedLanes: [],
    expectedRepoFailures: [],
    mousseyLocal: null,
    m4PeerProbe: null,
    m4FreshClonePacket: null,
    peerExecutionBoundary: null,
    summary: 'No FirstBite operating readout report was found.',
    nextAction: 'Run the FirstBite operating readout before making cross-agent or cross-repo local-CI trust claims.',
  }
  if (!fs.existsSync(reportRoot)) {
    return missing
  }

  const reports = fs.readdirSync(reportRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const reportPath = path.join(reportRoot, entry.name, 'report.json')
      if (!fs.existsSync(reportPath)) {
        return null
      }
      const stat = fs.statSync(reportPath)
      return {
        runId: entry.name,
        reportPath,
        summaryPath: path.join(reportRoot, entry.name, 'summary.md'),
        mtimeMs: stat.mtimeMs,
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)

  if (reports.length === 0) {
    return missing
  }

  const latest = reports[0]
  const data = readJsonIfExists(latest.reportPath)
  if (!data) {
    return {
      ...missing,
      status: 'yellow',
      reportPath: latest.reportPath,
      summaryPath: latest.summaryPath,
      runId: latest.runId,
      searchedReports: reports.length,
      summary: `Latest FirstBite operating readout could not be parsed: ${latest.reportPath}.`,
    }
  }

  const localCi = data.local_ci || {}
  const catalog = localCi.catalog || null
  const latestLaneProof = Array.isArray(localCi.latest_lane_proof) ? localCi.latest_lane_proof : []
  const failedLanes = latestLaneProof
    .filter(lane => lane.status && lane.status !== 'pass')
    .map(summarizeOperatingReadoutLane)
  const expectedRepoFailures = failedLanes.filter(lane => lane.repo === expectedRepo)
  const manifestPortability = catalog?.manifest_portability || null
  const expectedManifestState = (catalog?.manifest_states || []).find(row => row.repo === expectedRepo) || null
  const ageMinutes = ageMinutesBetween(data.created_at, generatedAt)
  const laneCount = numberOrNull(localCi.latest_lane_count) ?? latestLaneProof.length
  const passCount = numberOrNull(localCi.latest_lane_pass_count) ?? latestLaneProof.filter(lane => lane.status === 'pass').length
  const failCount = numberOrNull(localCi.latest_lane_fail_count) ?? failedLanes.length
  const declaredCount = numberOrNull(catalog?.declared_count)
  const catalogLaneCount = numberOrNull(catalog?.lane_count)
  const repoPresent = Array.isArray(catalog?.repo_keys) ? catalog.repo_keys.includes(expectedRepo) : Boolean(expectedManifestState)
  const stale = ageMinutes === null || ageMinutes > FIRSTBITE_OPERATING_READOUT_FRESHNESS_LIMIT_MINUTES
  const catalogIncomplete = !catalog || declaredCount === null || catalogLaneCount === null || declaredCount !== catalogLaneCount || !repoPresent
  const mousseyVerdict = data.moussey_local?.verdict || null
  const mousseyNotReady = mousseyVerdict && mousseyVerdict !== 'ready'
  const m4PeerProbe = normalizeM4PeerProbe(data.m4_peer_probe)
  const m4FreshClonePacket = normalizeM4FreshClonePacket(data.m4_fresh_clone_packet)
  const peerExecutionBoundary = buildPeerExecutionBoundary(m4PeerProbe, m4FreshClonePacket)
  const peerBoundaryWarning = peerExecutionBoundary && peerExecutionBoundary.status !== 'green' && peerExecutionBoundary.status !== 'missing'
  const status = catalogIncomplete || expectedRepoFailures.length > 0
    ? 'red'
    : stale || failCount > 0 || manifestPortability?.ready === false || mousseyNotReady || peerBoundaryWarning
      ? 'yellow'
      : 'green'
  const failSummary = failedLanes.length > 0
    ? `; failed lane(s): ${failedLanes.map(lane => lane.lane).join(', ')}`
    : ''
  const readinessSummary = manifestPortability
    ? `; fresh_clone_ready=${String(manifestPortability.fresh_clone_ready)}, active_ready=${String(manifestPortability.ready)}`
    : ''
  const peerSummary = peerExecutionBoundary && peerExecutionBoundary.status !== 'missing'
    ? `; M4 peer ${peerExecutionBoundary.executionReady ? 'execution-ready' : 'support-only'}`
    : ''
  const summary = status === 'green'
    ? `FirstBite operating readout is fresh: ${passCount}/${laneCount} lane proof(s) pass, catalog ${catalog.catalog_version || 'unknown'} has ${declaredCount ?? 'unknown'}/${catalogLaneCount ?? 'unknown'} declared lane(s), Moussey ${mousseyVerdict || 'unknown'}.`
    : `FirstBite operating readout: ${passCount}/${laneCount} lane proof(s) pass, catalog ${catalog?.catalog_version || 'missing'} has ${declaredCount ?? 'unknown'}/${catalogLaneCount ?? 'unknown'} declared lane(s), Moussey ${mousseyVerdict || 'unknown'}${readinessSummary}${peerSummary}${failSummary}.`

  return {
    status,
    reportRoot,
    reportPath: latest.reportPath,
    summaryPath: latest.summaryPath,
    runId: data.run_id || latest.runId,
    createdAt: data.created_at || null,
    ageMinutes,
    searchedReports: reports.length,
    localCi: {
      latestLaneCount: laneCount,
      latestLanePassCount: passCount,
      latestLaneFailCount: failCount,
      runRoot: localCi.run_root || null,
      xcodeLock: localCi.xcode_lock || null,
    },
    catalog: catalog ? {
      version: catalog.catalog_version || null,
      laneCount: catalogLaneCount,
      declaredCount,
      repoCount: numberOrNull(catalog.repo_count),
      serverPid: catalog.server_pid || null,
      loadedAt: catalog.loaded_at || null,
      repoPresent,
      restartHint: catalog.restart_hint || null,
    } : null,
    manifestPortability,
    expectedManifestState,
    failedLanes,
    expectedRepoFailures,
    mousseyLocal: data.moussey_local ? {
      verdict: data.moussey_local.verdict || null,
      proofRule: data.moussey_local.proof_rule || null,
      localCiApi: data.moussey_local.local_ci_api || null,
      lanStatus: data.moussey_local.lan_status || null,
    } : null,
    m4PeerProbe,
    m4FreshClonePacket,
    peerExecutionBoundary,
    summary,
    nextAction: status === 'green'
      ? 'Keep the operating readout fresh before cross-agent local-CI claims.'
      : expectedRepoFailures.length > 0
        ? 'Fix the failing resplit_currency_api lane before treating this repo as locally proven.'
        : peerBoundaryWarning && failCount === 0 && manifestPortability?.ready !== false && !mousseyNotReady
          ? peerExecutionBoundary.nextAction
          : 'Treat this as a fleet warning: inspect the failed lane(s), active manifest readiness, peer execution boundary, and Moussey status before broad launch claims.',
  }
}

function inspectFirstBiteMcpRefreshPlan({
  reportRoot = DEFAULT_FIRSTBITE_MCP_REFRESH_PLAN_DIR,
  expectedRepo = null,
  expectedLaneIds = [],
  repoDir = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  const missing = {
    status: 'missing',
    reportRoot,
    reportPath: null,
    summaryPath: null,
    runId: null,
    createdAt: null,
    ageMinutes: null,
    searchedReports: 0,
    verdict: 'missing',
    processAudit: null,
    repoBackedCatalog: null,
    staleProcessCount: null,
    processCount: null,
    repoBackedCatalogCurrent: false,
    repoPresent: false,
    missingExpectedLaneIds: expectedLaneIds,
    summary: 'No FirstBite MCP refresh plan report was found.',
    nextAction: 'Run the read-only FirstBite MCP refresh plan before claiming loaded Codex/Cursor MCP clients are current.',
    continuationCommands: [],
  }
  if (!fs.existsSync(reportRoot)) {
    return missing
  }

  const reports = fs.readdirSync(reportRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const reportPath = path.join(reportRoot, entry.name, 'report.json')
      if (!fs.existsSync(reportPath)) {
        return null
      }
      const stat = fs.statSync(reportPath)
      return {
        runId: entry.name,
        reportPath,
        summaryPath: path.join(reportRoot, entry.name, 'summary.md'),
        mtimeMs: stat.mtimeMs,
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)

  if (reports.length === 0) {
    return missing
  }

  const latest = reports[0]
  const data = readJsonIfExists(latest.reportPath)
  if (!data) {
    return {
      ...missing,
      status: 'yellow',
      reportPath: latest.reportPath,
      summaryPath: latest.summaryPath,
      runId: latest.runId,
      searchedReports: reports.length,
      summary: `Latest FirstBite MCP refresh plan could not be parsed: ${latest.reportPath}.`,
    }
  }

  const processAudit = data.processAudit || null
  const repoBackedCatalog = data.repoBackedCatalog || null
  const createdAt = data.createdAt || data.created_at || null
  const ageMinutes = ageMinutesBetween(createdAt, generatedAt)
  const stale = ageMinutes === null || ageMinutes > FIRSTBITE_MCP_REFRESH_PLAN_FRESHNESS_LIMIT_MINUTES
  const staleProcessCount = numberOrNull(processAudit?.stale_process_count)
  const processCount = numberOrNull(processAudit?.process_count)
  const repoKeys = Array.isArray(repoBackedCatalog?.repo_keys) ? repoBackedCatalog.repo_keys : []
  const laneKeys = Array.isArray(repoBackedCatalog?.lane_keys) ? repoBackedCatalog.lane_keys : []
  const repoPresent = expectedRepo
    ? repoKeys.includes(expectedRepo) || laneKeys.some(lane => lane.startsWith(`${expectedRepo}_`))
    : repoKeys.length > 0 || laneKeys.length > 0
  const missingExpectedLaneIds = expectedLaneIds.filter(laneId => !laneKeys.includes(laneId))
  const catalogHasExpectedManifest = (expectedLaneIds.length === 0 || missingExpectedLaneIds.length === 0)
    && (!expectedRepo || repoPresent)
  const catalogLaneCount = numberOrNull(repoBackedCatalog?.lane_count)
  const catalogDeclaredCount = numberOrNull(repoBackedCatalog?.declared_count)
  const catalogCountsAreSelfConsistent = catalogLaneCount !== null
    && catalogDeclaredCount !== null
    && catalogLaneCount === catalogDeclaredCount
  const catalogMeetsExpectedLaneFloor = expectedLaneIds.length === 0
    || catalogLaneCount >= expectedLaneIds.length
  const catalogLooksRepoManifestV2 = repoBackedCatalog?.catalog_version === 'repo-manifest-v2'
    && catalogCountsAreSelfConsistent
    && catalogMeetsExpectedLaneFloor
  const repoBackedCatalogCurrent = catalogHasExpectedManifest
    && (Boolean(data.authority?.repoBackedCatalogCurrent) || catalogLooksRepoManifestV2)
  const verdict = data.verdict || 'unknown'
  const continuationCommands = scopeRefreshPlanCommands(
    Array.isArray(data.continuationCommands) ? data.continuationCommands : [],
    repoDir,
  )
  const status = /unavailable|needs_attention/i.test(verdict) || repoBackedCatalogCurrent === false
    ? 'red'
    : staleProcessCount > 0 || stale
      ? 'yellow'
      : 'green'
  const summary = status === 'green'
    ? `FirstBite MCP refresh plan is fresh: ${verdict}; process audit ${processAudit?.status || 'unknown'} with ${staleProcessCount ?? 0}/${processCount ?? 0} stale process(es).`
    : `FirstBite MCP refresh plan: ${verdict}; process audit ${processAudit?.status || 'unknown'} with ${staleProcessCount ?? 'unknown'}/${processCount ?? 'unknown'} stale process(es); repo-backed catalog ${repoBackedCatalog?.catalog_version || 'unknown'} ${repoBackedCatalog?.declared_count ?? 'unknown'}/${repoBackedCatalog?.lane_count ?? 'unknown'} declared lane(s)${missingExpectedLaneIds.length > 0 ? `; missing current manifest lane(s): ${missingExpectedLaneIds.join(', ')}` : ''}.`

  return {
    status,
    reportRoot,
    reportPath: latest.reportPath,
    summaryPath: latest.summaryPath,
    runId: data.runId || data.run_id || latest.runId,
    createdAt,
    ageMinutes,
    searchedReports: reports.length,
    verdict,
    processAudit,
    repoBackedCatalog,
    expectedRepo,
    expectedLaneIds,
    staleProcessCount,
    processCount,
    currentProcessCount: numberOrNull(processAudit?.current_process_count),
    repoPresent,
    laneKeys,
    missingExpectedLaneIds,
    repoBackedCatalogCurrent,
    recommendedSteps: Array.isArray(data.recommendedSteps) ? data.recommendedSteps : [],
    continuationCommands,
    artifacts: data.artifacts || {},
    safety: data.safety || {},
    summary,
    nextAction: status === 'green'
      ? 'Capture live loaded-host list_lanes output into reports/firstbite-loaded-mcp-lanes.json before trusting the in-app MCP boundary.'
      : staleProcessCount > 0
        ? 'Save work and restart/reload Codex/Cursor, then rerun the refresh plan and capture live loaded-host list_lanes output.'
        : 'Rerun the read-only refresh plan and inspect repo-backed catalog availability before loaded-host MCP claims.',
  }
}

function scopeRefreshPlanCommands(commands = [], repoDir = null) {
  if (!repoDir) {
    return commands
  }

  return commands.map(command => {
    if (!/refresh plan/i.test(command?.label || '')) {
      return command
    }
    return {
      ...command,
      command: scopeCommandWithEnv(command.command || '', {
        RESPLIT_CURRENCY_API_REPO: repoDir,
      }),
    }
  })
}

function scopeCommandWithEnv(command, env = {}) {
  const prefix = Object.entries(env)
    .filter(([, value]) => value)
    .filter(([key]) => !new RegExp(`(?:^|\\s)${key}=`).test(command))
    .map(([key, value]) => `${key}=${shellQuoteValue(value)}`)
    .join(' ')
  return prefix ? `${prefix} ${command}` : command
}

function inspectFirstBiteCursorReviewScout({
  reportRoot = DEFAULT_FIRSTBITE_CURSOR_REVIEW_DIR,
  expectedRepo = null,
  repoName = null,
  repoDir = null,
  git = {},
  generatedAt = new Date().toISOString(),
} = {}) {
  const command = repoDir
    ? `bash ~/Development/ai-leo/skills/resplit-watch/scripts/firstbite-cursor-review.sh --repo ${repoDir} --no-cursor`
    : 'bash ~/Development/ai-leo/skills/resplit-watch/scripts/firstbite-cursor-review.sh --repo <repo> --no-cursor'
  const missing = {
    status: 'missing',
    reportRoot,
    reportPath: null,
    reviewPath: null,
    reviewPacketPath: null,
    localCiProofPath: null,
    runId: null,
    createdAt: null,
    ageMinutes: null,
    searchedReports: 0,
    expectedRepo,
    repoName,
    branch: null,
    headSha: null,
    currentBranch: git?.branch || null,
    currentHead: git?.head || null,
    currentForCheckout: null,
    cursorReviewRan: false,
    actionableClaimed: false,
    hasSubstantiveFindings: false,
    localCi: null,
    failedLanes: [],
    summary: 'No FirstBite Cursor/Graphite review scout packet was found for this repo.',
    nextAction: 'Run the read-only no-Cursor review scout before using Cursor/Graphite packet history as local-agent review evidence.',
    command,
  }
  if (!fs.existsSync(reportRoot)) {
    return missing
  }

  const allReports = fs.readdirSync(reportRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const reportPath = path.join(reportRoot, entry.name, 'report.json')
      if (!fs.existsSync(reportPath)) {
        return null
      }
      const stat = fs.statSync(reportPath)
      let data = null
      let parseError = null
      try {
        data = readJsonIfExists(reportPath)
      } catch (error) {
        parseError = error
      }
      return {
        runId: entry.name,
        reportPath,
        runDir: path.join(reportRoot, entry.name),
        mtimeMs: stat.mtimeMs,
        data,
        parseError,
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  const reports = allReports.filter(report => matchesCursorReviewScoutRepo(report, { expectedRepo, repoName, repoDir }))

  if (reports.length === 0) {
    return {
      ...missing,
      searchedReports: allReports.length,
    }
  }

  const latest = reports[0]
  if (latest.parseError || !latest.data) {
    return {
      ...missing,
      status: 'yellow',
      reportPath: latest.reportPath,
      runId: latest.runId,
      searchedReports: reports.length,
      summary: `Latest FirstBite Cursor/Graphite review scout packet could not be parsed: ${latest.reportPath}.`,
      nextAction: 'Rerun the no-Cursor review scout to replace the malformed packet before using review-scout evidence.',
    }
  }

  const data = latest.data
  const createdAt = data.created_at || data.createdAt || null
  const ageMinutes = ageMinutesBetween(createdAt, generatedAt)
  const stale = ageMinutes === null || ageMinutes > FIRSTBITE_CURSOR_REVIEW_FRESHNESS_LIMIT_MINUTES
  const branch = data.branch || null
  const headSha = data.head_sha || data.head || null
  const branchMatches = compareOptionalStrings(branch, git?.branch)
  const headMatches = compareGitHeads(headSha, git?.head)
  const currentForCheckout = branchMatches === false || headMatches === false
    ? false
    : branchMatches === true || headMatches === true
      ? true
      : null
  const cursorReviewRan = Boolean(Number(data.run_cursor)) || data.run_cursor === true || data.run_cursor === 'true'
  const actionableClaimed = data.actionable === true || data.actionable === 'true'
  const substantive = summarizeReviewScoutSubstance(data)
  const localCi = data.local_ci || {}
  const allLanes = Array.isArray(localCi.lanes) ? localCi.lanes : []
  const localCiRepoKey = localCi.local_ci_repo_key || null
  const repoScopeMatches = !expectedRepo || localCiRepoKey === expectedRepo
  const derivedRepoLanes = expectedRepo
    ? allLanes.filter(lane => lane.repo === expectedRepo || String(lane.lane || '').startsWith(`${expectedRepo}_`))
    : allLanes
  const repoScopeDerived = Boolean(expectedRepo && !repoScopeMatches && derivedRepoLanes.length > 0)
  const repoScopeWarning = Boolean(expectedRepo && !repoScopeMatches)
  const lanes = repoScopeMatches || !expectedRepo ? allLanes : derivedRepoLanes
  const failedLanes = lanes
    .filter(lane => lane.status && lane.status !== 'pass')
    .map(lane => ({
      lane: lane.lane || 'unknown',
      repo: lane.repo || null,
      kind: lane.kind || null,
      status: lane.status || 'unknown',
      runId: lane.run_id || null,
      reportPath: lane.report_path || null,
      logPath: lane.log_path || null,
    }))
  const repoLaneCount = repoScopeMatches ? numberOrNull(localCi.repo_lane_count) ?? lanes.length : lanes.length
  const repoLanePassCount = repoScopeMatches
    ? numberOrNull(localCi.repo_lane_pass_count) ?? lanes.filter(lane => lane.status === 'pass').length
    : lanes.filter(lane => lane.status === 'pass').length
  const repoLaneFailCount = repoScopeMatches ? numberOrNull(localCi.repo_lane_fail_count) ?? failedLanes.length : failedLanes.length
  const currentActionable = actionableClaimed && substantive.hasSubstantiveFindings && currentForCheckout !== false
  const status = currentActionable
    ? 'red'
    : currentForCheckout === false
      || stale
      || !cursorReviewRan
      || (actionableClaimed && !substantive.hasSubstantiveFindings)
      || repoScopeWarning
      || repoLaneFailCount > 0
      ? 'yellow'
      : 'green'
  const reviewPath = data.artifacts?.review || path.join(latest.runDir, 'review.md')
  const reviewPacketPath = data.artifacts?.review_packet || path.join(latest.runDir, 'review-packet.md')
  const localCiProofPath = path.join(latest.runDir, 'local-ci-repo-proof.json')
  const mode = cursorReviewRan
    ? `Cursor ${data.cursor_current_model || data.cursor_model || 'model unknown'}`
    : 'no-Cursor packet'
  const currentSummary = currentForCheckout === false
    ? `not current for checkout (${branch || 'unknown'} ${headSha || 'unknown'} vs ${git?.branch || 'unknown'} ${git?.head || 'unknown'})`
    : currentForCheckout === true
      ? 'matches the current checkout'
      : 'current-checkout match unknown'
  const ciSummary = repoLaneCount > 0
    ? `${repoLanePassCount}/${repoLaneCount} repo lane(s) pass${repoLaneFailCount > 0 ? `, ${repoLaneFailCount} fail` : ''}`
    : 'repo lane proof missing'
  const scopeSummary = repoScopeWarning
    ? repoScopeDerived
      ? `local-CI repo key ${localCiRepoKey || 'missing'}; derived ${expectedRepo} lanes from lane metadata`
      : `local-CI repo key ${localCiRepoKey || 'missing'} does not match ${expectedRepo}`
    : expectedRepo
      ? `local-CI repo key matches ${expectedRepo}`
      : 'local-CI repo scope unknown'
  const actionabilitySummary = actionableClaimed
    ? substantive.hasSubstantiveFindings ? 'actionable finding payload present' : 'actionable=true without finding payload'
    : 'no actionable flag'
  const summary = `FirstBite Cursor/Graphite review scout ${mode}: ${currentSummary}; ${ciSummary}; ${scopeSummary}; ${actionabilitySummary}.`

  return {
    status,
    reportRoot,
    reportPath: latest.reportPath,
    reviewPath: fs.existsSync(reviewPath) ? reviewPath : null,
    reviewPacketPath: fs.existsSync(reviewPacketPath) ? reviewPacketPath : null,
    localCiProofPath: fs.existsSync(localCiProofPath) ? localCiProofPath : null,
    runId: data.run_id || latest.runId,
    createdAt,
    ageMinutes,
    freshnessLimitMinutes: FIRSTBITE_CURSOR_REVIEW_FRESHNESS_LIMIT_MINUTES,
    searchedReports: reports.length,
    expectedRepo,
    repoName: data.repo_name || repoName || null,
    repoPath: data.repo || null,
    branch,
    headSha,
    currentBranch: git?.branch || null,
    currentHead: git?.head || null,
    currentForCheckout,
    branchMatches,
    headMatches,
    cursorReviewRan,
    cursorMode: data.cursor_mode || null,
    cursorWorkspaceMode: data.cursor_workspace_mode || null,
    cursorModel: data.cursor_model || null,
    cursorCurrentModel: data.cursor_current_model || null,
    actionableClaimed,
    hasSubstantiveFindings: substantive.hasSubstantiveFindings,
    findingCount: substantive.findingCount,
    fileCount: substantive.fileCount,
    localCi: {
      repoName: localCi.repo_name || null,
      repoKey: localCiRepoKey,
      expectedRepo,
      repoScopeStatus: repoScopeWarning
        ? repoScopeDerived ? 'derived_from_lane_metadata' : 'unscoped'
        : expectedRepo ? 'matched' : 'unknown',
      repoScopeWarning,
      repoLaneCount,
      repoLanePassCount,
      repoLaneFailCount,
      latestLaneCount: numberOrNull(localCi.latest_lane_count),
      latestLanePassCount: numberOrNull(localCi.latest_lane_pass_count),
      latestLaneFailCount: numberOrNull(localCi.latest_lane_fail_count),
    },
    failedLanes,
    summary,
    nextAction: status === 'red'
      ? 'Review the current actionable scout findings before treating local coding-agent review as clean.'
      : currentForCheckout === false
        ? 'Rerun the read-only review scout from the current checkout and compare its repo-scoped local-CI proof before using it as current evidence.'
        : repoScopeWarning
          ? 'Fix or rerun the review scout so local_ci_repo_key matches the expected repo; this cockpit derived repo lanes from lane metadata only.'
        : !cursorReviewRan
          ? 'Treat this as a packet-only scout; run the optional Cursor sidecar only when a spendful read-only model pass is worth it.'
          : repoLaneFailCount > 0
            ? 'Inspect the failed repo lane proof referenced by the review scout and rerun the affected FirstBite lane from current source.'
            : stale
              ? 'Refresh the review scout packet before using it as agent-review evidence.'
              : 'Keep the review scout fresh; it is advisory beside local-CI and launch proof.',
    command,
  }
}

function matchesCursorReviewScoutRepo(report, { expectedRepo, repoName, repoDir } = {}) {
  const data = report.data
  const runId = report.runId || ''
  if (!data) {
    return Boolean(expectedRepo && runId.includes(expectedRepo))
      || Boolean(repoName && runId.includes(repoName))
  }
  const normalizedRepoDir = repoDir ? path.resolve(repoDir) : null
  const reportedRepoDir = data.repo ? path.resolve(String(data.repo)) : null
  return Boolean(expectedRepo && (
    data.local_ci?.local_ci_repo_key === expectedRepo
      || runId.includes(expectedRepo)
  ))
    || Boolean(repoName && (
      data.repo_name === repoName
        || path.basename(String(data.repo || '')) === repoName
        || runId.includes(repoName)
    ))
    || Boolean(normalizedRepoDir && reportedRepoDir && normalizedRepoDir === reportedRepoDir)
}

function compareOptionalStrings(left, right) {
  if (!left || !right) {
    return null
  }
  return String(left) === String(right)
}

function compareGitHeads(left, right) {
  if (!left || !right) {
    return null
  }
  const leftText = String(left)
  const rightText = String(right)
  return leftText.startsWith(rightText) || rightText.startsWith(leftText)
}

function summarizeReviewScoutSubstance(data) {
  const findings = data.findings
  const files = data.files
  const findingCount = Array.isArray(findings)
    ? findings.length
    : findings && typeof findings === 'object'
      ? Object.keys(findings).length
      : typeof findings === 'string' && findings.trim()
        ? 1
        : 0
  const fileCount = Array.isArray(files)
    ? files.length
    : files && typeof files === 'object'
      ? Object.keys(files).length
      : typeof files === 'string' && files.trim()
        ? 1
        : 0
  const hasText = [data.summary, data.proof].some(value => typeof value === 'string' && value.trim().length > 0)
  return {
    findingCount,
    fileCount,
    hasSubstantiveFindings: hasText || findingCount > 0 || fileCount > 0,
  }
}

function normalizeM4PeerProbe(peer) {
  if (!peer || typeof peer !== 'object') {
    return null
  }
  return {
    dashboardUrl: peer.dashboard_url || null,
    sshHost: peer.ssh_host || null,
    http: peer.http || {},
    ssh: peer.ssh || {},
    triggerClaude: peer.trigger_claude || null,
    lanStatus: peer.lan_status || null,
    verdict: peer.verdict || 'unknown',
    executionReady: Boolean(peer.execution_ready),
    proofRule: peer.proof_rule || null,
  }
}

function normalizeM4FreshClonePacket(packet) {
  if (!packet || typeof packet !== 'object') {
    return null
  }
  return {
    available: Boolean(packet.available),
    latestReport: packet.latest_report || null,
    latestSummary: packet.latest_summary || null,
    latestCommands: packet.latest_commands || null,
    summaryExists: Boolean(packet.summary_exists),
    commandsExists: Boolean(packet.commands_exists),
    runId: packet.run_id || null,
    createdAt: packet.created_at || null,
    generatedOnHost: packet.generated_on_host || null,
    generatedMousseySelfName: packet.generated_moussey_self_name || null,
    freshRoot: packet.fresh_root || null,
    defaultTargetedExecuteLane: packet.default_targeted_execute_lane || null,
    targetedExecuteSkipEnv: packet.targeted_execute_skip_env || null,
    completionGates: Array.isArray(packet.completion_gates) ? packet.completion_gates : [],
    executionReady: Boolean(packet.execution_ready),
    supportBoundary: packet.support_boundary || null,
  }
}

function buildPeerExecutionBoundary(m4PeerProbe, m4FreshClonePacket) {
  if (!m4PeerProbe && !m4FreshClonePacket) {
    return {
      status: 'missing',
      summary: 'No M4 peer execution boundary evidence was found in the FirstBite operating readout.',
      executionReady: false,
      supportOnly: false,
      proofRule: 'M4 execution requires an M4-local run_lanes execute report.',
      nextAction: 'Run the FirstBite operating readout with M4 peer probes enabled before claiming peer execution readiness.',
    }
  }

  const executionReady = Boolean(m4PeerProbe?.executionReady)
  const packetAvailable = Boolean(m4FreshClonePacket?.available)
  const status = executionReady ? 'green' : 'yellow'
  const verdict = m4PeerProbe?.verdict || 'no-peer-probe'
  const packetState = packetAvailable
    ? `fresh-clone packet ${m4FreshClonePacket.runId || 'available'}`
    : 'no fresh-clone packet'
  return {
    status,
    summary: executionReady
      ? `M4 peer has local execution proof: ${verdict}; ${packetState}.`
      : `M4 peer is support-only: ${verdict}; ${packetState}; execution_ready=false.`,
    executionReady,
    supportOnly: !executionReady,
    proofRule: m4PeerProbe?.proofRule || m4FreshClonePacket?.supportBoundary || 'M4 execution requires an M4-local run_lanes execute report.',
    nextAction: executionReady
      ? 'Keep M4-local run_lanes execute proof fresh before using the peer as execution capacity.'
      : 'Run the generated fresh-clone commands on the M4 Pro and capture an M4-local run_lanes execute report before calling the peer execution-ready.',
  }
}

function summarizeOperatingReadoutLane(lane) {
  return {
    lane: lane.lane || 'unknown',
    repo: lane.repo || null,
    kind: lane.kind || null,
    status: lane.status || 'unknown',
    runId: lane.run_id || null,
    reportPath: lane.report_path || null,
    logPath: lane.log_path || null,
  }
}

function sourcePromotionPathRole(relPath, trackedPaths = []) {
  if (trackedPaths.includes(relPath)) {
    return 'local-CI contract'
  }
  if (relPath.startsWith('tests/')) {
    return 'verification'
  }
  if (relPath.includes('grafana') || relPath.includes('otel')) {
    return 'telemetry proof'
  }
  if (relPath.includes('trust-preflight')) {
    return 'trust preflight'
  }
  if (relPath.includes('capture-loaded-mcp-probe')) {
    return 'MCP host probe'
  }
  if (relPath.includes('audit-history-backfill')) {
    return 'release-history audit'
  }
  if (relPath.includes('source-promotion-decisions')) {
    return 'source-promotion review'
  }
  if (relPath.includes('reliability-cockpit')) {
    return 'operator cockpit'
  }
  return 'source input'
}

function sourcePromotionPathAction(row) {
  if (!row.currentExists) {
    return 'missing from current checkout'
  }
  if (!row.headExists && !row.originExists) {
    return 'add to tracked source and publish'
  }
  if (!row.headExists) {
    return 'add to HEAD before clean proof'
  }
  if (!row.originExists) {
    return 'publish to origin/main before cross-machine proof'
  }
  if (row.gitStatus?.startsWith('??')) {
    return 'add current-only file'
  }
  if (row.gitStatus) {
    return 'include modified current source'
  }
  return 'already tracked'
}

function shellQuotePaths(paths) {
  return paths.map(relPath => `'${String(relPath).replace(/'/g, "'\\''")}'`).join(' ')
}

function shellQuoteValue(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

function readPackageJsonAtRef(repoDir, ref) {
  return readJsonAtRef(repoDir, ref, 'package.json')
}

function readJsonAtRef(repoDir, ref, relPath) {
  try {
    return JSON.parse(execGit(repoDir, ['show', `${ref}:${relPath}`]))
  } catch {
    return null
  }
}

function inspectFirstBiteRunnerControlPlane({
  aiLeoRepoDir = DEFAULT_AI_LEO_REPO_DIR,
  packageDir = DEFAULT_FIRSTBITE_LOCAL_CI_DIR,
  serverRelativePath = FIRSTBITE_RUNNER_SERVER_RELATIVE_PATH,
  readmeRelativePath = FIRSTBITE_RUNNER_README_RELATIVE_PATH,
  prBranchRef = FIRSTBITE_WARN_EXIT_BRANCH_REF,
} = {}) {
  const packageRelativePath = path.relative(aiLeoRepoDir, packageDir).split(path.sep).join('/')
  const serverPath = path.join(aiLeoRepoDir, serverRelativePath)
  const supportTokens = [
    'expectedExitCodes',
    'yellowExitCodes',
    'exit_classification',
    'trust_status',
    'source_ref',
  ]
  const tokenLabels = {
    expectedExitCodes: 'expected exits',
    yellowExitCodes: 'yellow exits',
    exit_classification: 'exit classification',
    trust_status: 'trust status',
    source_ref: 'source ref',
  }
  const rows = [
    inspectFirstBiteRunnerSource({
      id: 'workingTree',
      label: 'Working tree package',
      ref: 'working tree',
      text: readTextIfExists(serverPath),
      source: serverPath,
      supportTokens,
      tokenLabels,
      missingWhenAbsent: `server.mjs not found at ${serverPath}`,
    }),
    inspectFirstBiteRunnerSource({
      id: 'head',
      label: 'ai-leo HEAD',
      ref: 'HEAD',
      text: gitTextAtRef(aiLeoRepoDir, 'HEAD', serverRelativePath),
      source: `${aiLeoRepoDir}:HEAD:${serverRelativePath}`,
      supportTokens,
      tokenLabels,
      missingWhenAbsent: `HEAD does not contain ${serverRelativePath}`,
    }),
    inspectFirstBiteRunnerSource({
      id: 'originMain',
      label: 'ai-leo origin/main',
      ref: 'origin/main',
      text: gitTextAtRef(aiLeoRepoDir, 'origin/main', serverRelativePath),
      source: `${aiLeoRepoDir}:origin/main:${serverRelativePath}`,
      supportTokens,
      tokenLabels,
      missingWhenAbsent: `origin/main does not contain ${serverRelativePath}`,
    }),
    inspectFirstBiteRunnerSource({
      id: 'prBranch',
      label: 'warn-exit PR branch',
      ref: prBranchRef,
      text: gitTextAtRef(aiLeoRepoDir, prBranchRef, serverRelativePath),
      source: `${aiLeoRepoDir}:${prBranchRef}:${serverRelativePath}`,
      supportTokens,
      tokenLabels,
      missingWhenAbsent: `${prBranchRef} does not contain ${serverRelativePath}`,
    }),
  ]

  const workingTree = rows.find(row => row.id === 'workingTree')
  const head = rows.find(row => row.id === 'head')
  const originMain = rows.find(row => row.id === 'originMain')
  const prBranch = rows.find(row => row.id === 'prBranch')
  const dirty = [
    gitPathStatus(aiLeoRepoDir, serverRelativePath),
    gitPathStatus(aiLeoRepoDir, readmeRelativePath),
  ].filter(Boolean)
  const branch = gitRefShort(aiLeoRepoDir, 'HEAD')
  const originMainHead = gitRefShort(aiLeoRepoDir, 'origin/main')
  const prBranchHead = gitRefShort(aiLeoRepoDir, prBranchRef)
  const activeSupports = Boolean(workingTree?.supports)
  const headSupports = Boolean(head?.supports)
  const durableSupports = Boolean(originMain?.supports)
  const prSupports = Boolean(prBranch?.supports)
  let status = 'red'
  if (activeSupports && durableSupports) {
    status = 'green'
  } else if (activeSupports || durableSupports || prSupports) {
    status = 'yellow'
  }
  let summary = 'Active FirstBite runner package does not preserve expected/yellow trust exits.'
  if (activeSupports && durableSupports && headSupports) {
    summary = 'FirstBite runner expected/yellow exit support is landed on ai-leo origin/main and present in the active package.'
  } else if (activeSupports && durableSupports) {
    summary = 'FirstBite runner expected/yellow exit support is landed on ai-leo origin/main and present in the active package; local ai-leo HEAD is stale or divergent.'
  } else if (durableSupports) {
    summary = 'FirstBite runner expected/yellow exit support is landed on ai-leo origin/main, but the active package is stale.'
  } else if (activeSupports || prSupports) {
    summary = 'FirstBite runner expected/yellow exit support exists locally or on the PR branch, but is not landed on ai-leo origin/main.'
  }
  const nextAction = activeSupports && durableSupports
    ? 'Restart or reload the loaded MCP host, then capture a fresh list_lanes artifact from the in-app MCP boundary.'
    : durableSupports
      ? 'Update the active ai-leo FirstBite runner package from origin/main, restart the Codex/Cursor MCP host, and recapture reports/firstbite-loaded-mcp-lanes.json.'
      : activeSupports || prSupports
        ? 'Merge ai-leo PR #11, update ai-leo origin/main, restart the Codex/Cursor MCP host, and recapture reports/firstbite-loaded-mcp-lanes.json.'
      : 'Port expected/yellow exit support into the active FirstBite runner package before trusting local-agent lane colors.'

  return {
    status,
    summary,
    nextAction,
    aiLeoRepoDir,
    packageDir,
    packageRelativePath,
    serverRelativePath,
    readmeRelativePath,
    prBranchRef,
    branch,
    originMainHead,
    prBranchHead,
    dirty,
    activeSupports,
    headSupports,
    durableSupports,
    prSupports,
    supportTokens,
    rows,
  }
}

function inspectFirstBiteReviewScoutProducerControlPlane({
  aiLeoRepoDir = DEFAULT_AI_LEO_REPO_DIR,
  scriptRelativePath = FIRSTBITE_REVIEW_SCOUT_SCRIPT_RELATIVE_PATH,
  producerBranchRef = FIRSTBITE_REVIEW_SCOUT_PRODUCER_BRANCH_REF,
} = {}) {
  const scriptPath = path.join(aiLeoRepoDir, scriptRelativePath)
  const supportTokens = [
    'MANIFEST_LOCAL_CI_REPO_KEY',
    'MANIFEST_LOCAL_CI_LANE_KEYS_JSON',
    'LOCAL_CI_REPO_KEY',
    'LEDGER_REPO_PATH',
    'local_ci_repo_key',
  ]
  const tokenLabels = {
    MANIFEST_LOCAL_CI_REPO_KEY: 'manifest repo key',
    MANIFEST_LOCAL_CI_LANE_KEYS_JSON: 'manifest lane keys',
    LOCAL_CI_REPO_KEY: 'canonical local-CI repo key',
    LEDGER_REPO_PATH: 'canonical ledger repo path',
    local_ci_repo_key: 'report repo key field',
  }
  const rows = [
    inspectReviewScoutProducerSource({
      id: 'workingTree',
      label: 'Working tree script',
      ref: 'working tree',
      text: readTextIfExists(scriptPath),
      source: scriptPath,
      supportTokens,
      tokenLabels,
      missingWhenAbsent: `firstbite-cursor-review.sh not found at ${scriptPath}`,
    }),
    inspectReviewScoutProducerSource({
      id: 'head',
      label: 'ai-leo HEAD',
      ref: 'HEAD',
      text: gitTextAtRef(aiLeoRepoDir, 'HEAD', scriptRelativePath),
      source: `${aiLeoRepoDir}:HEAD:${scriptRelativePath}`,
      supportTokens,
      tokenLabels,
      missingWhenAbsent: `HEAD does not contain ${scriptRelativePath}`,
    }),
    inspectReviewScoutProducerSource({
      id: 'originMain',
      label: 'ai-leo origin/main',
      ref: 'origin/main',
      text: gitTextAtRef(aiLeoRepoDir, 'origin/main', scriptRelativePath),
      source: `${aiLeoRepoDir}:origin/main:${scriptRelativePath}`,
      supportTokens,
      tokenLabels,
      missingWhenAbsent: `origin/main does not contain ${scriptRelativePath}`,
    }),
    inspectReviewScoutProducerSource({
      id: 'producerBranch',
      label: 'producer feature branch',
      ref: producerBranchRef,
      text: gitTextAtRef(aiLeoRepoDir, producerBranchRef, scriptRelativePath),
      source: `${aiLeoRepoDir}:${producerBranchRef}:${scriptRelativePath}`,
      supportTokens,
      tokenLabels,
      missingWhenAbsent: `${producerBranchRef} does not contain ${scriptRelativePath}`,
    }),
  ]

  const workingTree = rows.find(row => row.id === 'workingTree')
  const head = rows.find(row => row.id === 'head')
  const originMain = rows.find(row => row.id === 'originMain')
  const producerBranch = rows.find(row => row.id === 'producerBranch')
  const dirty = [gitPathStatus(aiLeoRepoDir, scriptRelativePath)].filter(Boolean)
  const branch = gitRefShort(aiLeoRepoDir, 'HEAD')
  const originMainHead = gitRefShort(aiLeoRepoDir, 'origin/main')
  const producerBranchHead = gitRefShort(aiLeoRepoDir, producerBranchRef)
  const activeSupports = Boolean(workingTree?.supports)
  const headSupports = Boolean(head?.supports)
  const durableSupports = Boolean(originMain?.supports)
  const producerBranchSupports = Boolean(producerBranch?.supports)
  let status = 'red'
  if (activeSupports && durableSupports) {
    status = 'green'
  } else if (activeSupports || durableSupports || producerBranchSupports) {
    status = 'yellow'
  }
  let summary = 'Active review-scout producer does not emit canonical repo-key and manifest-lane proof.'
  if (activeSupports && durableSupports && headSupports) {
    summary = 'Review-scout producer canonical repo-key support is landed on ai-leo origin/main and present in the active script.'
  } else if (activeSupports && durableSupports) {
    summary = 'Review-scout producer canonical repo-key support is landed on ai-leo origin/main and present in the active script; local ai-leo HEAD is stale or divergent.'
  } else if (durableSupports) {
    summary = 'Review-scout producer canonical repo-key support is landed on ai-leo origin/main, but the active script is stale.'
  } else if (activeSupports || producerBranchSupports) {
    summary = 'Review-scout producer canonical repo-key support exists locally or on the producer branch, but is not landed on ai-leo origin/main.'
  }
  const nextAction = activeSupports && durableSupports
    ? 'Rerun the review scout after every PR source commit and keep local_ci_repo_key matched to the repo manifest.'
    : durableSupports
      ? 'Update the active ai-leo review-scout script from origin/main, then rerun the canonical review scout from the current checkout.'
      : activeSupports || producerBranchSupports
        ? 'Land the review-scout producer patch on ai-leo origin/main, then rerun the canonical review scout from the current checkout.'
        : 'Port canonical repo-key and manifest-lane support into firstbite-cursor-review.sh before trusting review-scout scope.'

  return {
    status,
    summary,
    nextAction,
    aiLeoRepoDir,
    scriptRelativePath,
    producerBranchRef,
    branch,
    originMainHead,
    producerBranchHead,
    dirty,
    activeSupports,
    headSupports,
    durableSupports,
    producerBranchSupports,
    supportTokens,
    rows,
  }
}

function inspectReviewScoutProducerSource({
  id,
  label,
  ref,
  text,
  source,
  supportTokens = [],
  tokenLabels = {},
  missingWhenAbsent,
}) {
  if (!text) {
    return {
      id,
      label,
      ref,
      source,
      status: 'red',
      supports: false,
      present: false,
      missingTokens: supportTokens,
      summary: missingWhenAbsent || `${label} is missing.`,
    }
  }

  const missingTokens = supportTokens.filter(token => !text.includes(token))
  const supports = missingTokens.length === 0
  return {
    id,
    label,
    ref,
    source,
    status: supports ? 'green' : 'red',
    supports,
    present: true,
    missingTokens,
    summary: supports
      ? `${label} emits canonical review-scout repo-key proof.`
      : `${label} is missing ${missingTokens.map(token => tokenLabels[token] || token).join(', ')}.`,
  }
}

function inspectFirstBiteRunnerSource({
  id,
  label,
  ref,
  text,
  source,
  supportTokens = [],
  tokenLabels = {},
  missingWhenAbsent,
}) {
  if (!text) {
    return {
      id,
      label,
      ref,
      source,
      status: 'red',
      supports: false,
      present: false,
      missingTokens: supportTokens,
      summary: missingWhenAbsent || `${label} is missing.`,
    }
  }

  const missingTokens = supportTokens.filter(token => !text.includes(token))
  const supports = missingTokens.length === 0
  return {
    id,
    label,
    ref,
    source,
    status: supports ? 'green' : 'red',
    supports,
    present: true,
    missingTokens,
    summary: supports
      ? `${label} preserves expected/yellow exit semantics.`
      : `${label} is missing ${missingTokens.map(token => tokenLabels[token] || token).join(', ')}.`,
  }
}

function inspectManifestLaneCommands(currentManifest, headManifest, originManifest) {
  const currentCommands = manifestLaneCommandMap(currentManifest)
  const headCommands = manifestLaneCommandMap(headManifest)
  const originCommands = manifestLaneCommandMap(originManifest)

  return Object.keys(currentCommands).sort().map(laneId => {
    const currentCommand = currentCommands[laneId] || null
    const headCommand = headCommands[laneId] || null
    const originCommand = originCommands[laneId] || null
    const status = currentCommand && headCommand && originCommand
      && normalizeCommand(currentCommand) === normalizeCommand(headCommand)
      && normalizeCommand(currentCommand) === normalizeCommand(originCommand)
      ? 'green'
      : 'red'
    return {
      lane: laneId,
      status,
      currentCommand,
      headCommand,
      originCommand,
      currentPresent: Boolean(currentCommand),
      headPresent: Boolean(headCommand),
      originPresent: Boolean(originCommand),
    }
  })
}

function manifestLaneCommandMap(manifest) {
  const lanes = manifest?.localCi?.lanes || {}
  return Object.fromEntries(Object.entries(lanes)
    .map(([laneId, lane]) => [laneId, lane?.command || null])
    .filter(([, command]) => Boolean(command)))
}

function collectPackageScriptClosure(scripts, seeds) {
  const seen = new Set()
  const queue = [...seeds]
  while (queue.length > 0) {
    const name = queue.shift()
    if (!name || seen.has(name)) {
      continue
    }
    seen.add(name)
    for (const nested of extractNpmRunScriptNames(scripts[name] || '')) {
      if (!seen.has(nested)) {
        queue.push(nested)
      }
    }
  }
  return [...seen].sort()
}

function extractNpmRunScriptNames(command) {
  const names = []
  const pattern = /\bnpm\s+run\s+([A-Za-z0-9:_-]+)/g
  let match
  while ((match = pattern.exec(command || '')) !== null) {
    names.push(match[1])
  }
  return names
}

function extractCommandFilePaths(command) {
  const files = []
  const pattern = /\b(?:node|bash|sh)\s+(?:--[^\s]+\s+)*([A-Za-z0-9_./-]+\.(?:js|mjs|cjs|sh))/g
  let match
  while ((match = pattern.exec(command || '')) !== null) {
    files.push(match[1])
  }
  return files
}

function scriptContractStatus({ currentCommand, headCommand, originCommand }) {
  if (!currentCommand || !headCommand || !originCommand) {
    return 'red'
  }
  if (currentCommand !== headCommand || currentCommand !== originCommand) {
    return 'red'
  }
  return 'green'
}

function inspectTrackedPath(repoDir, relPath) {
  const normalized = relPath.split(path.sep).join('/')
  return {
    path: normalized,
    currentExists: fs.existsSync(path.join(repoDir, normalized)),
    headExists: gitPathExists(repoDir, 'HEAD', normalized),
    originExists: gitPathExists(repoDir, 'origin/main', normalized),
    gitStatus: gitPathStatus(repoDir, normalized),
  }
}

function gitPathExists(repoDir, ref, relPath) {
  try {
    execGit(repoDir, ['cat-file', '-e', `${ref}:${relPath}`])
    return true
  } catch {
    return false
  }
}

function gitTextAtRef(repoDir, ref, relPath) {
  try {
    return execGit(repoDir, ['show', `${ref}:${relPath}`])
  } catch {
    return null
  }
}

function gitRefShort(repoDir, ref) {
  try {
    return execGit(repoDir, ['rev-parse', '--short=12', ref]).trim()
  } catch {
    return null
  }
}

function gitPathStatus(repoDir, relPath) {
  try {
    return execGit(repoDir, ['status', '--short', '--', relPath]).trim()
  } catch {
    return ''
  }
}

function summarizeLaneDiagnostics(lanes) {
  if (lanes.some(lane => lane.diagnostics?.status === 'red')) {
    return 'red'
  }
  if (lanes.some(lane => lane.diagnostics?.status === 'yellow')) {
    return 'yellow'
  }
  return 'green'
}

function summarizeLaneDiagnosticMessages(lanes) {
  const flagged = lanes
    .filter(lane => lane.diagnostics?.status === 'red' || lane.diagnostics?.status === 'yellow')
    .map(lane => `${lane.lane}: ${lane.diagnostics.summary}`)
  return flagged.join(' | ')
}

function inspectTelemetry(wrangler, wranglerPath, packageJson, repoDir, options = {}) {
  const generatedAt = options.generatedAt || new Date().toISOString()
  const productionObservability = wrangler?.env?.production?.observability || null
  const rootObservability = wrangler?.observability || null
  const observability = productionObservability || rootObservability
  const scope = productionObservability ? 'env.production' : 'top-level'
  const logs = observability?.logs || null
  const traces = observability?.traces || null
  const workerLogsEnabled = observability?.enabled === true
  const tracesEnabled = traces?.enabled === true
  const logsEnabled = logs?.enabled === true
  const enabled = workerLogsEnabled || logsEnabled || tracesEnabled
  const destinationNames = Array.from(new Set([
    ...destinationList(traces?.destinations),
    ...destinationList(logs?.destinations),
    traces?.destination,
    traces?.destination_name,
    logs?.destination,
    logs?.destination_name,
  ].filter(Boolean)))
  const verifierPaths = [
    path.join(repoDir, 'scripts', 'verify-cloudflare-otel-destinations.js'),
    path.join(repoDir, 'scripts', 'verify-grafana-otel-smoke.js'),
    path.join(repoDir, 'scripts', 'verify-grafana-tempo.mjs'),
  ]
  const presentVerifierPaths = verifierPaths.filter(verifierPath => fs.existsSync(verifierPath))
  const hasVerifier = presentVerifierPaths.length > 0
  const observabilityScripts = Object.keys(packageJson?.scripts || {})
    .filter(script => /observability|tempo|grafana|otel/i.test(script))
  const cloudflareDestinations = options.cloudflareDestinationsEvidence || inspectCloudflareOtelDestinations(repoDir, generatedAt)
  const evidence = options.grafanaEvidence || inspectGrafanaEvidence(repoDir, generatedAt)

  let status = 'red'
  let summary = 'Cloudflare Worker observability block is missing from wrangler.jsonc.'
  if (enabled && (tracesEnabled || logsEnabled)) {
    status = logsEnabled && tracesEnabled && evidence.status === 'green' ? 'green' : 'yellow'
    summary = logsEnabled && tracesEnabled
      ? (evidence.status === 'green'
        ? 'Worker observability config and fresh Grafana Tempo/Loki evidence are present.'
        : `Worker observability config exists; ${evidence.summary}`)
      : 'Worker observability is only partially enabled; logs and traces both need proof.'
  }

  return {
    status,
    wranglerPath,
    workerName: wrangler?.name || null,
    observability: {
      enabled,
      scope,
      logsEnabled,
      tracesEnabled,
      sampling: {
        logs: logs?.head_sampling_rate ?? observability?.head_sampling_rate ?? null,
        traces: traces?.head_sampling_rate ?? null,
      },
      persistence: {
        logs: logsEnabled ? logs?.persist ?? true : null,
        traces: tracesEnabled ? traces?.persist ?? true : null,
      },
      destinationNames,
    },
    grafana: {
      tempoVerifierPresent: hasVerifier,
      verifierPaths: presentVerifierPaths,
      observabilityScripts,
      evidence,
      plan: '/Users/leokwan/Development/vidux/projects/fleet-otel-observability/PLAN.md#F-C1',
    },
    cloudflare: {
      destinations: cloudflareDestinations,
    },
    summary,
  }
}

function inspectCloudflareOtelDestinations(repoDir, generatedAt = new Date().toISOString()) {
  const expectedPath = path.join(repoDir, DEFAULT_OUTPUT_DIR, CLOUDFLARE_OTEL_DESTINATIONS_BASENAME)
  if (!fs.existsSync(expectedPath)) {
    return {
      status: 'missing',
      latestPath: expectedPath,
      checkedAt: null,
      ageMinutes: null,
      destinationNames: [],
      expected: [],
      checks: [],
      summary: 'No Cloudflare Workers Observability destination proof artifact was found.',
    }
  }

  const data = readJsonIfExists(expectedPath)
  if (!data) {
    return {
      status: 'red',
      latestPath: expectedPath,
      checkedAt: null,
      ageMinutes: null,
      destinationNames: [],
      expected: [],
      checks: [],
      summary: 'Cloudflare destination proof artifact could not be parsed.',
    }
  }

  const checkedAt = data.checkedAt || data.generatedAt || null
  const expected = Array.isArray(data.wrangler?.expected) ? data.wrangler.expected : []
  const destinations = Array.isArray(data.destinations) ? data.destinations : []
  const checks = Array.isArray(data.checks) ? data.checks.map(check => ({
    id: String(check.id || check.label || 'cloudflare-destination-check'),
    label: String(check.label || check.id || 'Cloudflare destination check'),
    status: normalizeStatus(check.status),
    proof: String(check.proof || ''),
    nextAction: String(check.nextAction || ''),
  })) : []

  return {
    status: normalizeStatus(data.status || 'yellow'),
    latestPath: expectedPath,
    checkedAt,
    ageMinutes: ageMinutesBetween(checkedAt, generatedAt),
    destinationNames: destinations.map(destination => destination.name).filter(Boolean),
    expected,
    checks,
    summary: data.summary || 'Cloudflare destination proof artifact did not include a summary.',
  }
}

function inspectGrafanaEvidence(repoDir, generatedAt = new Date().toISOString()) {
  const candidates = collectGrafanaEvidenceFiles(repoDir)
  if (candidates.length === 0) {
    return {
      status: 'missing',
      searchedRoots: ['reports', 'docs', '.cursor/proofs'],
      latestPath: null,
      checkedAt: null,
      ageMinutes: null,
      tempoMatched: false,
      lokiMatched: false,
      traceId: null,
      checks: [],
      summary: 'no fresh Grafana Tempo/Loki proof artifact was found under reports/, docs/, or .cursor/proofs/.',
    }
  }

  const parsed = candidates.map(candidate => parseGrafanaEvidenceFile(candidate, generatedAt))
  const valid = parsed.find(item => item.parseStatus === 'parsed') || parsed[0]
  return valid
}

function collectGrafanaEvidenceFiles(repoDir) {
  const roots = ['reports', 'docs', path.join('.cursor', 'proofs')]
    .map(root => path.join(repoDir, root))
    .filter(root => fs.existsSync(root))
  const candidates = []

  for (const root of roots) {
    walkFiles(root, filePath => {
      const relativePath = path.relative(repoDir, filePath)
      const ext = path.extname(filePath).toLowerCase()
      const basename = path.basename(filePath)
      const proofLike = /(grafana|otel|tempo|loki).*smoke|smoke.*(grafana|otel|tempo|loki)/i.test(relativePath)
      const cockpitReport = basename === `${REPORT_BASENAME}.json` || basename === `${REPORT_BASENAME}.html`
      if (proofLike && !cockpitReport && ['.json', '.md', '.txt'].includes(ext)) {
        const stat = fs.statSync(filePath)
        candidates.push({ path: filePath, relativePath, ext, mtimeMs: stat.mtimeMs })
      }
    })
  }

  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 25)
}

function walkFiles(root, onFile) {
  const entries = fs.readdirSync(root, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') {
      continue
    }
    const filePath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      walkFiles(filePath, onFile)
    } else if (entry.isFile()) {
      onFile(filePath)
    }
  }
}

function parseGrafanaEvidenceFile(candidate, generatedAt) {
  const base = {
    status: 'yellow',
    parseStatus: 'unparsed',
    latestPath: candidate.path,
    checkedAt: null,
    ageMinutes: null,
    tempoMatched: false,
    lokiMatched: false,
    traceId: null,
    checks: [],
    summary: `Grafana proof artifact exists but could not be parsed: ${candidate.relativePath}.`,
  }

  const text = readTextIfExists(candidate.path)
  if (!text) {
    return base
  }

  if (candidate.ext === '.json') {
    try {
      const data = JSON.parse(text)
      const checkedAt = data.checkedAt || data.checked_at || data.createdAt || data.created_at || data.timestamp || null
      const ageMinutes = ageMinutesBetween(checkedAt, generatedAt)
      const traceId = data.grafana?.tempo?.traceId || data.grafana?.tempo?.trace_id || data.tempo?.traceId || data.traceId || null
      const tempoMatched = Boolean(data.grafana?.tempo?.matched || data.tempo?.matched || data.tempoMatched || data.traceFound || traceId)
      const lokiMatched = Boolean(data.grafana?.loki?.matched || data.loki?.matched || data.lokiMatched || data.logFound)
      const checks = normalizeGrafanaEvidenceChecks(data.checks)
      const fresh = ageMinutes !== null && ageMinutes <= 24 * 60
      const status = tempoMatched && lokiMatched && fresh ? 'green' : 'yellow'
      const reason = status === 'green'
        ? `fresh JSON proof found at ${candidate.relativePath}.`
        : tempoMatched || lokiMatched
          ? `partial or stale Grafana proof found at ${candidate.relativePath}.`
          : `JSON proof does not show both Tempo and Loki matches: ${candidate.relativePath}.`
      return {
        status,
        parseStatus: 'parsed',
        latestPath: candidate.path,
        checkedAt,
        ageMinutes,
        tempoMatched,
        lokiMatched,
        traceId,
        checks,
        summary: reason,
      }
    } catch {
      return base
    }
  }

  const checkedAtMatch = text.match(/checked\s*(?:at|on)\s*[:=-]\s*([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.+-]+Z?)/i)
  const checkedAt = checkedAtMatch?.[1] || null
  const ageMinutes = ageMinutesBetween(checkedAt, generatedAt)
  const traceId = text.match(/\btrace[_ -]?id\b[^a-f0-9]*([a-f0-9]{16,64})/i)?.[1] || null
  const tempoMatched = /tempo/i.test(text) && (/match|found|ok|pass/i.test(text) || Boolean(traceId))
  const lokiMatched = /loki|log/i.test(text) && /match|found|ok|pass/i.test(text)

  return {
    status: 'yellow',
    parseStatus: 'parsed',
    latestPath: candidate.path,
    checkedAt,
    ageMinutes,
    tempoMatched,
    lokiMatched,
    traceId,
    checks: [],
    summary: `manual Grafana proof note found at ${candidate.relativePath}; JSON proof is still required for green.`,
  }
}

function normalizeGrafanaEvidenceChecks(checks) {
  if (!Array.isArray(checks)) {
    return []
  }
  return checks
    .filter(check => check && typeof check === 'object')
    .slice(0, 8)
    .map(check => ({
      id: String(check.id || check.label || 'grafana-check'),
      label: String(check.label || check.id || 'Grafana check'),
      status: normalizeStatus(check.status),
      proof: String(check.proof || check.summary || ''),
      nextAction: String(check.nextAction || check.next_action || ''),
    }))
}

function normalizeStatus(status) {
  return ['green', 'yellow', 'red', 'missing'].includes(status) ? status : 'yellow'
}

function ageMinutesBetween(thenIso, nowIso) {
  if (!thenIso) {
    return null
  }
  const then = Date.parse(thenIso)
  const now = Date.parse(nowIso)
  if (!Number.isFinite(then) || !Number.isFinite(now)) {
    return null
  }
  return Math.max(0, Math.round((now - then) / 60000))
}

function destinationList(value) {
  if (Array.isArray(value)) {
    return value.filter(item => typeof item === 'string' && item.length > 0)
  }
  return typeof value === 'string' && value.length > 0 ? [value] : []
}

function inspectGates(packageJson) {
  const scripts = packageJson?.scripts || {}
  const required = [
    'test',
    'check:publish',
    'check',
    'smoke:deploy',
    'audit:backfill-sources',
  ]
  return {
    status: required.every(name => scripts[name]) ? 'green' : 'yellow',
    required: required.map(name => ({
      name,
      command: scripts[name] || null,
      present: Boolean(scripts[name]),
    })),
  }
}

function getGitState(repoDir) {
  const state = {
    status: 'unknown',
    branch: null,
    head: null,
    originMain: null,
    shortStatus: '',
    dirtyCount: null,
    behindOriginMain: null,
  }

  try {
    const statusOutput = execGit(repoDir, ['status', '--short', '--branch'])
    state.shortStatus = statusOutput.trim()
    const firstLine = statusOutput.split('\n')[0] || ''
    state.branch = firstLine.replace(/^##\s+/, '').split('...')[0] || null
    state.dirtyCount = statusOutput.split('\n').filter(line => line && !line.startsWith('##')).length
    state.status = state.dirtyCount > 0 ? 'dirty' : 'clean'
  } catch (error) {
    state.error = error.message
  }

  try {
    state.head = execGit(repoDir, ['rev-parse', '--short=12', 'HEAD']).trim()
  } catch {
    state.head = null
  }

  try {
    state.originMain = execGit(repoDir, ['rev-parse', '--short=12', 'origin/main']).trim()
    if (state.head && state.originMain) {
      state.behindOriginMain = Number(execGit(repoDir, ['rev-list', '--count', 'HEAD..origin/main']).trim())
    }
  } catch {
    state.originMain = null
  }

  return state
}

function execGit(repoDir, args) {
  return execFileSync('git', args, {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function parseNurseLog(text) {
  if (!text) {
    return {
      status: 'missing',
      latestHeading: null,
      latestBullets: [],
      releaseReadiness: 'unknown',
      releaseHistoryEvidence: null,
      currentBlocker: null,
      nextSlice: null,
    }
  }

  const lines = text.split(/\r?\n/)
  const headingIndex = lines.findIndex(line => /^##\s+\d{4}-\d{2}-\d{2}/.test(line))
  if (headingIndex === -1) {
    return {
      status: 'unparsed',
      latestHeading: null,
      latestBullets: [],
      releaseReadiness: 'unknown',
      releaseHistoryEvidence: null,
      currentBlocker: null,
      nextSlice: null,
    }
  }

  const nextHeadingIndex = lines.findIndex((line, index) => index > headingIndex && /^##\s+\d{4}-\d{2}-\d{2}/.test(line))
  const section = lines.slice(headingIndex, nextHeadingIndex === -1 ? undefined : nextHeadingIndex)
  const bullets = section
    .map(line => {
      const match = line.match(/^\s*-\s+(.*)$/)
      return match ? match[1].trim() : null
    })
    .filter(Boolean)
  const firstBullet = bullets[0] || ''
  const blocker = bullets.find(line => /^Current blocker:/i.test(line)) || null
  const nextSlice = bullets.find(line => /^Exact next slice:/i.test(line)) || null
  const releaseHistoryEvidence = findReleaseHistoryEvidence(bullets)
  const releaseReadiness = classifyReleaseHistoryReadiness({
    sectionText: section.join('\n'),
    bullets,
    releaseHistoryEvidence,
  })

  return {
    status: 'parsed',
    latestHeading: section[0].replace(/^##\s+/, '').trim(),
    latestBullets: bullets.slice(0, 8),
    firstBullet,
    releaseReadiness,
    releaseHistoryEvidence,
    currentBlocker: blocker ? blocker.replace(/^Current blocker:\s*/i, '') : null,
    nextSlice: nextSlice ? nextSlice.replace(/^Exact next slice:\s*/i, '') : null,
  }
}

function findReleaseHistoryEvidence(bullets) {
  const priorityMatchers = [
    line => isGreenReleaseHistoryProof(line),
    line => /^`?npm run validate:release`?\s*->/i.test(line),
    line => /validate:release.*expected fail/i.test(line) && !isDerivedReleaseHistorySummary(line),
    line => /available\s+\d+\/30/i.test(line) && !isDerivedReleaseHistorySummary(line),
    line => /missing.*20\d{2}-\d{2}-\d{2}/i.test(line) && !isDerivedReleaseHistorySummary(line),
    line => /^Current blocker:.*(release|history|backfill|strict|May\s+12)/i.test(line),
    line => /release-history risk|history hole/i.test(line),
    line => /^Exact next slice:.*(backfill|history|validate)/i.test(line),
  ]
  for (const matcher of priorityMatchers) {
    const match = bullets.find(line => matcher(line))
    if (match) {
      return match
    }
  }
  return null
}

function classifyReleaseHistoryReadiness({ sectionText = '', bullets = [], releaseHistoryEvidence = null } = {}) {
  const evidenceText = [releaseHistoryEvidence, ...bullets].filter(Boolean).join('\n')
  if (releaseHistoryEvidence && isGreenReleaseHistoryProof(releaseHistoryEvidence)) {
    return 'green'
  }
  if (/NO-GO\/release-readiness|release-history readiness remains yellow|validate:release.*expected fail|available\s+\d+\/30|missing.*20\d{2}-\d{2}-\d{2}|release-history risk|history hole/i.test(evidenceText)) {
    return 'yellow'
  }
  if (isGreenReleaseHistoryProof(evidenceText)) {
    return 'green'
  }
  if (/GO\/current|COMPLETE/.test(sectionText)) {
    return 'green'
  }
  return 'unknown'
}

function isGreenReleaseHistoryProof(text = '') {
  return /strict release validation.*green|validate:release.*(?:green|pass|passed|OK)|validate-package:\s*OK.*strictHistory=on|history points=30.*strictHistory=on/i.test(text)
}

function isDerivedReleaseHistorySummary(line) {
  return /reliability:cockpit|Trust Contracts row|Release-history strict coverage/i.test(line)
}

function parseInbox(text) {
  if (!text) {
    return {
      status: 'missing',
      activeItems: [],
      hasGrafanaItem: false,
      hasStaleGrafanaItem: false,
      hasReleaseHistoryItem: false,
    }
  }

  const activeItems = text.split(/\r?\n/)
    .filter(line => /^- \[ \]/.test(line))
    .map(line => {
      const title = line
        .replace(/^- \[ \]\s+/, '')
        .replace(/\*\*/g, '')
        .split('. ')[0]
        .trim()
      return { title, raw: line.trim() }
    })

  return {
    status: 'parsed',
    activeItems,
    hasGrafanaItem: activeItems.some(item => /grafana|otel|tempo/i.test(item.raw)),
    hasStaleGrafanaItem: activeItems.some(item => /@microlabs\/otel-cf-workers|OTEL_ENDPOINT|OTEL_AUTH_HEADER|wrangler\.toml\s+vars/i.test(item.raw)),
    hasReleaseHistoryItem: activeItems.some(item => /release-history|history hole|backfill/i.test(item.raw)),
  }
}

function inspectLedger({ repoLedgerPath, sharedLedgerPath, repoName, generatedAt = new Date().toISOString() }) {
  const repoAll = readLedgerEntries(repoLedgerPath)
  const sharedAll = readLedgerEntries(sharedLedgerPath)
    .filter(entry => entry.repo === repoName)
  const repoEntries = repoAll.slice(-5)
  const sharedEntries = sharedAll.slice(-8)

  const status = repoEntries.length > 0 || sharedEntries.length > 0 ? 'parsed' : 'empty'

  return {
    status,
    health: summarizeLedgerHealth([...repoAll, ...sharedAll], generatedAt),
    activityMatrix: buildAgentActivityMatrix([...repoAll, ...sharedAll], generatedAt),
    repo: {
      status: repoEntries.length > 0 ? 'parsed' : 'empty',
      path: repoLedgerPath,
      recentEntries: repoEntries,
    },
    shared: {
      status: sharedEntries.length > 0 ? 'parsed' : 'empty',
      path: sharedLedgerPath,
      recentEntries: sharedEntries,
    },
  }
}

function readLedgerEntries(ledgerPath) {
  const text = readTextIfExists(ledgerPath)
  if (!text) {
    return []
  }

  return text.trim().split(/\r?\n/).filter(Boolean).map(line => {
    try {
      const item = JSON.parse(line)
      return {
        ts: item.ts || null,
        eid: item.eid || null,
        event: item.event || null,
        repo: item.repo || null,
        lane: item.lane || null,
        agentId: item.agent_id || item.agent || null,
        summary: item.summary || null,
        proof: item.proof || null,
        handoffStatus: item.handoff_status || null,
        files: item.files || [],
      }
    } catch {
      return {
        ts: null,
        eid: null,
        event: null,
        repo: null,
        lane: null,
        agentId: null,
        summary: line.slice(0, 160),
        proof: null,
        handoffStatus: null,
        files: [],
      }
    }
  })
}

function buildAgentActivityMatrix(entries = [], generatedAt = new Date().toISOString(), limit = MAX_AGENT_ACTIVITY_ROWS) {
  const seen = new Set()
  const rows = []
  const sorted = entries
    .filter(Boolean)
    .slice()
    .sort((a, b) => compareLedgerEntries(b, a))

  for (const entry of sorted) {
    const dedupeKey = entry.eid
      || `${entry.ts || 'no-ts'}:${normalizeAgentId(entry)}:${entry.summary || ''}`
    if (seen.has(dedupeKey)) {
      continue
    }
    seen.add(dedupeKey)
    rows.push(buildAgentActivityRow(entry, generatedAt))
    if (rows.length >= limit) {
      break
    }
  }

  return rows
}

function buildAgentActivityRow(entry, generatedAt) {
  const agentId = normalizeAgentId(entry)
  const handoffStatus = String(entry.handoffStatus || entry.handoff_status || '').trim()
  const ageMinutes = calculateAgeMinutes(entry.ts, generatedAt)
  return {
    ts: entry.ts || null,
    ageMinutes,
    status: classifyAgentActivityStatus(entry),
    agent: agentId.includes('/') ? agentId.split('/')[0] : agentId,
    agentId,
    lane: entry.lane || '',
    event: entry.event || '',
    handoffStatus: handoffStatus || 'unknown',
    proof: selectAgentActivityProof(entry),
    summary: entry.summary || '',
  }
}

function normalizeAgentId(entry) {
  return String(entry.agentId || entry.agent_id || entry.agent || 'unknown').trim() || 'unknown'
}

function classifyAgentActivityStatus(entry) {
  const handoff = String(entry.handoffStatus || entry.handoff_status || '').toLowerCase()
  const text = [
    entry.summary || '',
    entry.proof || '',
    handoff,
    entry.event || '',
  ].join('\n')
  if (handoff === 'resolved' || /\brepairs?:|recovered live freshness/i.test(text)) {
    return 'green'
  }
  if (/^(fail|failed|failure|needs_review|blocked)$/.test(handoff)) {
    return 'red'
  }
  if (/^(in_progress|running|pending|yellow|needs_followup)$/.test(handoff) || /\b(warn|warning|yellow|pending|in progress)\b/i.test(text)) {
    return 'yellow'
  }
  if (/current verdict is red|verdict.*red|RED - missing required trust contract|needs_review|blocked/i.test(text)) {
    return 'red'
  }
  if (/\b(fail|failed|failure)\b/i.test(text) && !/expected fail|known failure|0 failing|recovered/i.test(text)) {
    return 'red'
  }
  if (/^(pass|passed|green|done|complete|completed|success|succeeded)$/.test(handoff) || isRecoveryLedgerEntry(entry)) {
    return 'green'
  }
  return 'yellow'
}

function selectAgentActivityProof(entry) {
  const files = Array.isArray(entry.files) ? entry.files.filter(Boolean) : []
  const proofArtifact = extractProofArtifact(entry.proof)
  if (proofArtifact) {
    return proofArtifact
  }
  const fileArtifact = files.find(file => /\.(json|html|md|log|txt|xcresult|png)$/i.test(file))
    || files.find(file => /(^|\/)(reports|logs|\.agent-ledger|\.firstbite)\//i.test(file))
  if (fileArtifact) {
    return fileArtifact
  }
  const proof = String(entry.proof || '').trim()
  return proof.length <= 160 ? proof : ''
}

function extractProofArtifact(proof) {
  const text = String(proof || '').trim()
  if (!text) {
    return ''
  }
  if (!/\s/.test(text) && looksLikeProofPath(text)) {
    return trimProofPath(text)
  }
  const matches = text.match(/(?:\/Users\/[^\s;,)]+|\/tmp\/[^\s;,)]+|reports\/[^\s;,)]+|\.agent-ledger\/[^\s;,)]+|(?:[A-Za-z0-9_.-]+\/)+[^\s;,)]+\.(?:json|html|md|log|txt|xcresult|png))/g) || []
  const cleaned = matches.map(trimProofPath).filter(looksLikeProofPath)
  return cleaned.find(item => /\.(json|html|md|log)$/i.test(item))
    || cleaned.find(item => /\.(txt|png|xcresult)$/i.test(item))
    || ''
}

function looksLikeProofPath(value) {
  return /(^\/|^reports\/|^\.agent-ledger\/|^\.firstbite\/|\/).+\.(json|html|md|log|txt|xcresult|png)$/i.test(value)
}

function trimProofPath(value) {
  return String(value || '').replace(/[.,:;]+$/g, '')
}

function normalizeComparablePath(value) {
  if (!value) {
    return null
  }
  const resolved = path.resolve(String(value))
  try {
    return fs.realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

function calculateAgeMinutes(ts, generatedAt) {
  const then = Date.parse(ts || '')
  const now = Date.parse(generatedAt || '')
  if (!Number.isFinite(then) || !Number.isFinite(now)) {
    return null
  }
  return Math.max(0, Math.round((now - then) / 60000))
}

function inspectLoadedMcpProbe({
  probePath,
  expectedRepo,
  expectedLaneIds = [],
  generatedAt = new Date().toISOString(),
} = {}) {
  const statusBase = {
    path: probePath,
    expectedRepo: expectedRepo || null,
    expectedLaneIds,
    checkedAt: null,
    ageMinutes: null,
    source: 'missing',
    freshnessStatus: 'yellow',
    freshnessSummary: 'Loaded MCP probe freshness is unknown.',
    catalogVersion: null,
    repoPresent: false,
    expectedLaneCount: expectedLaneIds.length,
    repoKeys: [],
    groupKeys: [],
    allLaneIds: [],
    laneCount: 0,
    loadedLaneIds: [],
    missingLaneIds: expectedLaneIds,
    restartHint: 'MCP clients keep long-lived stdio processes; restart Codex/Cursor if this catalog is missing current repo-manifest lanes.',
  }
  const text = readTextIfExists(probePath)

  if (!text) {
    return {
      ...statusBase,
      status: 'missing',
      summary: `No loaded MCP list_lanes probe artifact found at ${probePath}.`,
      freshnessSummary: `No loaded MCP list_lanes probe artifact found at ${probePath}.`,
    }
  }

  let artifact
  try {
    artifact = JSON.parse(text)
  } catch (error) {
    return {
      ...statusBase,
      status: 'red',
      summary: `Loaded MCP probe artifact is not valid JSON: ${error.message}`,
      freshnessSummary: 'Loaded MCP probe freshness is unknown because the artifact is not valid JSON.',
    }
  }

  const payload = normalizeLoadedMcpPayload(artifact)
  if (!payload) {
    return {
      ...statusBase,
      checkedAt: artifact.checkedAt || null,
      source: artifact.source || 'unknown',
      status: 'red',
      summary: 'Loaded MCP probe artifact did not contain a list_lanes payload.',
      freshnessSummary: 'Loaded MCP probe freshness is unknown because the artifact did not contain a list_lanes payload.',
    }
  }

  const repos = payload.repos || {}
  const groups = payload.groups || {}
  const lanes = payload.lanes || {}
  const repoKeys = Object.keys(repos).sort()
  const groupKeys = Object.keys(groups).sort()
  const allLaneIds = Object.keys(lanes).sort()
  const repoPresent = Boolean(expectedRepo && repos[expectedRepo])
  const loadedLaneIds = allLaneIds
    .filter(laneId => lanes[laneId]?.repo === expectedRepo || expectedLaneIds.includes(laneId))
    .sort()
  const missingLaneIds = expectedLaneIds.filter(laneId => !lanes[laneId])
  const checkedAt = artifact.checkedAt || payload.catalog?.loaded_at || artifact.generatedAt || null
  const ageMinutes = ageMinutesBetween(checkedAt, generatedAt)
  const freshness = classifyLoadedMcpProbeFreshness({ checkedAt, ageMinutes })
  const catalogVersion = payload.catalog?.catalog_version || artifact.catalogVersion || null
  const source = artifact.source || 'loaded MCP list_lanes probe'
  const status = !expectedRepo || expectedLaneIds.length === 0
    ? 'yellow'
    : repoPresent && missingLaneIds.length === 0
      ? 'green'
      : 'red'
  const summary = status === 'green'
    ? `Loaded MCP probe sees ${expectedRepo} and ${loadedLaneIds.length}/${expectedLaneIds.length} expected lane(s).`
    : `Loaded MCP host catalog is missing current lanes for ${expectedRepo || 'unknown repo'}: ${repoPresent ? 'repo present' : 'repo missing'}; missing ${missingLaneIds.length}/${expectedLaneIds.length} expected lane(s).`

  return {
    ...statusBase,
    status,
    checkedAt,
    ageMinutes,
    freshnessStatus: freshness.status,
    freshnessSummary: freshness.summary,
    source,
    catalogVersion,
    repoPresent,
    repoKeys,
    groupKeys,
    allLaneIds,
    laneCount: allLaneIds.length,
    loadedLaneIds,
    missingLaneIds,
    summary,
    restartHint: payload.catalog?.restart_hint || statusBase.restartHint,
  }
}

function classifyLoadedMcpProbeFreshness({ checkedAt, ageMinutes } = {}) {
  if (!checkedAt) {
    return {
      status: 'yellow',
      summary: 'Loaded MCP probe artifact has no checkedAt timestamp.',
    }
  }

  if (ageMinutes === null) {
    return {
      status: 'yellow',
      summary: `Loaded MCP probe artifact timestamp is not comparable: ${checkedAt}.`,
    }
  }

  if (ageMinutes > LOADED_MCP_PROBE_FRESHNESS_LIMIT_MINUTES) {
    return {
      status: 'yellow',
      summary: `Loaded MCP probe artifact is stale: ${ageMinutes}m old; recapture live mcp__firstbite_local_ci.list_lanes output before trusting this boundary.`,
    }
  }

  return {
    status: 'green',
    summary: `Loaded MCP probe artifact is fresh: ${ageMinutes}m old.`,
  }
}

function inspectRepoBackedMcpCatalog({
  artifact,
  packageDir = DEFAULT_FIRSTBITE_LOCAL_CI_DIR,
  expectedRepo,
  expectedRepoPath = null,
  expectedLaneIds = [],
  generatedAt = new Date().toISOString(),
} = {}) {
  const normalizedExpectedRepoPath = normalizeComparablePath(expectedRepoPath)
  const statusBase = {
    packageDir,
    command: 'npm run --silent call -- list_lanes {}',
    expectedRepo: expectedRepo || null,
    expectedRepoPath: normalizedExpectedRepoPath,
    requestedRepoPath: artifact?.repoDir ? normalizeComparablePath(artifact.repoDir) : null,
    actualRepoPath: null,
    repoPathMatchesExpected: expectedRepoPath ? null : true,
    expectedLaneIds,
    checkedAt: null,
    ageMinutes: null,
    source: 'repo-backed package:list_lanes',
    catalogVersion: null,
    repoPresent: false,
    expectedLaneCount: expectedLaneIds.length,
    repoKeys: [],
    groupKeys: [],
    allLaneIds: [],
    laneCount: 0,
    loadedLaneIds: [],
    missingLaneIds: expectedLaneIds,
    manifestPortability: null,
    manifestStates: [],
    restartHint: 'MCP clients keep long-lived stdio processes; restart Codex/Cursor if the loaded host is missing current repo-manifest lanes.',
  }

  if (!artifact) {
    return {
      ...statusBase,
      status: 'missing',
      summary: 'Repo-backed FirstBite MCP catalog probe was not run.',
    }
  }

  if (artifact.error) {
    return {
      ...statusBase,
      checkedAt: artifact.checkedAt || null,
      ageMinutes: ageMinutesBetween(artifact.checkedAt || null, generatedAt),
      status: 'red',
      summary: `Repo-backed FirstBite MCP list_lanes probe failed: ${artifact.error}`,
      stderr: artifact.stderr || '',
    }
  }

  const payload = normalizeLoadedMcpPayload(artifact)
  if (!payload) {
    return {
      ...statusBase,
      checkedAt: artifact.checkedAt || null,
      ageMinutes: ageMinutesBetween(artifact.checkedAt || null, generatedAt),
      status: 'red',
      summary: 'Repo-backed FirstBite MCP probe did not return a list_lanes payload.',
    }
  }

  const repos = payload.repos || {}
  const groups = payload.groups || {}
  const lanes = payload.lanes || {}
  const catalog = payload.catalog || {}
  const manifestStates = catalog.manifest_states || []
  const repoKeys = Object.keys(repos).sort()
  const groupKeys = Object.keys(groups).sort()
  const allLaneIds = Object.keys(lanes).sort()
  const repoPresent = Boolean(expectedRepo && repos[expectedRepo])
  const repoState = expectedRepo ? manifestStates.find(state => state.repo === expectedRepo) : null
  const actualRepoPath = normalizeComparablePath(
    expectedRepo ? repos[expectedRepo]?.path || repos[expectedRepo]?.repo_path || repoState?.repo_path : null,
  )
  const repoPathMatchesExpected = normalizedExpectedRepoPath && actualRepoPath
    ? actualRepoPath === normalizedExpectedRepoPath
    : normalizedExpectedRepoPath
      ? null
      : true
  const loadedLaneIds = allLaneIds
    .filter(laneId => lanes[laneId]?.repo === expectedRepo || expectedLaneIds.includes(laneId))
    .sort()
  const missingLaneIds = expectedLaneIds.filter(laneId => !lanes[laneId])
  const checkedAt = artifact.checkedAt || catalog.loaded_at || artifact.generatedAt || null
  const catalogVersion = catalog.catalog_version || artifact.catalogVersion || null
  const catalogCurrent = catalogVersion === 'repo-manifest-v2'
  const laneCount = catalog.lane_count ?? Object.keys(lanes).length
  const repoPathMismatch = repoPathMatchesExpected === false
  const repoPathUnknown = normalizedExpectedRepoPath && repoPathMatchesExpected === null
  const status = !expectedRepo || expectedLaneIds.length === 0
    ? 'yellow'
    : repoPathMismatch
      ? 'red'
      : repoPresent && missingLaneIds.length === 0 && catalogCurrent && !repoPathUnknown
      ? 'green'
      : repoPresent && missingLaneIds.length === 0
        ? 'yellow'
        : 'red'
  const portability = catalog.manifest_portability || null
  const portabilityText = portability
    ? ` fresh_clone_ready=${String(portability.fresh_clone_ready)}, active_ready=${String(portability.ready)}.`
    : ''
  const repoPathText = normalizedExpectedRepoPath
    ? repoPathMatchesExpected === true
      ? ` repo_path=${actualRepoPath}.`
      : repoPathMatchesExpected === false
        ? ` catalog_path=${actualRepoPath}, expected_path=${normalizedExpectedRepoPath}.`
        : ` catalog_path=unknown, expected_path=${normalizedExpectedRepoPath}.`
    : ''
  const summary = status === 'green'
    ? `Repo-backed FirstBite MCP sees ${catalogVersion} with ${laneCount} lane(s); ${expectedRepo} has ${loadedLaneIds.length}/${expectedLaneIds.length} expected lane(s).${repoPathText}${portabilityText}`
    : repoPathMismatch
      ? `Repo-backed FirstBite MCP catalog is reading the wrong checkout for ${expectedRepo}: ${repoPathText.trim()}`
      : `Repo-backed FirstBite MCP catalog is not current for ${expectedRepo || 'unknown repo'}: ${repoPresent ? 'repo present' : 'repo missing'}; missing ${missingLaneIds.length}/${expectedLaneIds.length} expected lane(s); catalog ${catalogVersion || 'unknown'}.${repoPathText}`

  return {
    ...statusBase,
    status,
    checkedAt,
    ageMinutes: ageMinutesBetween(checkedAt, generatedAt),
    source: artifact.source || statusBase.source,
    catalogVersion,
    repoPresent,
    actualRepoPath,
    repoPathMatchesExpected,
    repoKeys,
    groupKeys,
    allLaneIds,
    laneCount,
    loadedLaneIds,
    missingLaneIds,
    manifestPortability: portability,
    manifestStates,
    summary,
    restartHint: catalog.restart_hint || statusBase.restartHint,
  }
}

function buildMcpCatalogDelta({
  loadedMcpProbe,
  repoBackedMcpProbe,
  expectedRepo,
  expectedLaneIds = [],
} = {}) {
  const missing = {
    status: 'yellow',
    expectedRepo: expectedRepo || null,
    expectedLaneIds,
    loadedCheckedAt: loadedMcpProbe?.checkedAt || null,
    repoBackedCheckedAt: repoBackedMcpProbe?.checkedAt || null,
    loadedLaneCount: loadedMcpProbe?.laneCount ?? null,
    repoBackedLaneCount: repoBackedMcpProbe?.laneCount ?? null,
    missingReposInLoaded: [],
    missingGroupsInLoaded: [],
    missingLanesInLoaded: [],
    missingExpectedLanesInLoaded: expectedLaneIds,
    summary: 'Loaded-vs-repo-backed MCP catalog delta could not be computed.',
    nextAction: 'Capture both loaded MCP and repo-backed MCP list_lanes outputs before trusting host/catalog boundaries.',
  }

  if (!loadedMcpProbe || !repoBackedMcpProbe) {
    return missing
  }

  const loadedRepos = loadedMcpProbe.repoKeys || []
  const repoBackedRepos = repoBackedMcpProbe.repoKeys || []
  const loadedGroups = loadedMcpProbe.groupKeys || []
  const repoBackedGroups = repoBackedMcpProbe.groupKeys || []
  const loadedLanes = loadedMcpProbe.allLaneIds || []
  const repoBackedLanes = repoBackedMcpProbe.allLaneIds || []
  const missingReposInLoaded = arrayDifference(repoBackedRepos, loadedRepos)
  const missingGroupsInLoaded = arrayDifference(repoBackedGroups, loadedGroups)
  const missingLanesInLoaded = arrayDifference(repoBackedLanes, loadedLanes)
  const missingExpectedLanesInLoaded = expectedLaneIds.filter(laneId => !loadedLanes.includes(laneId))
  const expectedRepoMissing = Boolean(expectedRepo && !loadedRepos.includes(expectedRepo))
  const red = expectedRepoMissing || missingExpectedLanesInLoaded.length > 0
  const yellow = loadedMcpProbe.freshnessStatus !== 'green'
    || missingReposInLoaded.length > 0
    || missingGroupsInLoaded.length > 0
    || missingLanesInLoaded.length > 0
  const status = red ? 'red' : yellow ? 'yellow' : 'green'
  const summary = status === 'green'
    ? `Loaded MCP host matches the repo-backed catalog for ${expectedRepo || 'expected repo'}: ${loadedMcpProbe.laneCount ?? 'unknown'} lane(s).`
    : `Loaded MCP host differs from repo-backed catalog: missing ${missingReposInLoaded.length} repo(s), ${missingExpectedLanesInLoaded.length}/${expectedLaneIds.length} expected FX lane(s), ${missingGroupsInLoaded.length} group(s), and ${missingLanesInLoaded.length} total lane(s).`

  return {
    status,
    expectedRepo: expectedRepo || null,
    expectedLaneIds,
    loadedCheckedAt: loadedMcpProbe.checkedAt || null,
    repoBackedCheckedAt: repoBackedMcpProbe.checkedAt || null,
    loadedLaneCount: loadedMcpProbe.laneCount ?? null,
    repoBackedLaneCount: repoBackedMcpProbe.laneCount ?? null,
    loadedCatalogVersion: loadedMcpProbe.catalogVersion || null,
    repoBackedCatalogVersion: repoBackedMcpProbe.catalogVersion || null,
    missingReposInLoaded,
    missingGroupsInLoaded,
    missingLanesInLoaded,
    missingExpectedLanesInLoaded,
    summary,
    nextAction: status === 'green'
      ? 'Keep using loaded MCP host only while this delta and freshness remain green.'
      : 'Restart or reload the Codex/Cursor MCP host, capture mcp__firstbite_local_ci.list_lanes again, and require this delta to clear before trusting loaded-host execution.',
  }
}

function captureRepoBackedMcpCatalog({
  packageDir = DEFAULT_FIRSTBITE_LOCAL_CI_DIR,
  generatedAt = new Date().toISOString(),
  repoDir = null,
  execFile = execFileSync,
} = {}) {
  if (!fs.existsSync(path.join(packageDir, 'package.json'))) {
    return {
      checkedAt: generatedAt,
      source: 'repo-backed package:list_lanes',
      error: `package.json not found at ${packageDir}`,
    }
  }

  const env = { ...process.env, NO_COLOR: '1' }
  if (repoDir) {
    env[RESPLIT_CURRENCY_API_REPO_ENV] = repoDir
  }

  try {
    const stdout = execFile('npm', ['run', '--silent', 'call', '--', 'list_lanes', '{}'], {
      cwd: packageDir,
      encoding: 'utf8',
      timeout: 20000,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const parsed = parseJsonObjectFromMixedOutput(stdout)
    return {
      checkedAt: generatedAt,
      source: 'repo-backed package:list_lanes',
      command: 'npm run --silent call -- list_lanes {}',
      repoDir: repoDir || null,
      content: parsed.content,
      isError: parsed.isError || false,
    }
  } catch (error) {
    return {
      checkedAt: generatedAt,
      source: 'repo-backed package:list_lanes',
      command: 'npm run --silent call -- list_lanes {}',
      repoDir: repoDir || null,
      error: error.message,
      stderr: error.stderr ? String(error.stderr) : '',
    }
  }
}

function normalizeLoadedMcpPayload(artifact) {
  if (artifact?.payload && typeof artifact.payload === 'object') {
    return artifact.payload
  }

  if (artifact?.content?.[0]?.text) {
    try {
      return JSON.parse(artifact.content[0].text)
    } catch {
      return null
    }
  }

  if (artifact?.repos || artifact?.lanes || artifact?.groups || artifact?.catalog) {
    return artifact
  }

  return null
}

function summarizeLedgerHealth(entries, generatedAt) {
  const recentEntries = entries
    .filter(entry => isRecentLedgerEntry(entry, generatedAt, 24))
    .sort(compareLedgerEntries)
  const failureRows = recentEntries.filter(isFailureLedgerEntry)
  const recoveryRows = recentEntries.filter(isRecoveryLedgerEntry)
  const unresolvedFailures = failureRows.filter(failure => !recoveryRows.some(recovery => recoveryCoversFailure(failure, recovery)))
  const latestFailure = failureRows.at(-1) || null
  const latestRecovery = recoveryRows.at(-1) || null
  const repairRows = recoveryRows.filter(isRepairLedgerEntry)

  if (failureRows.length === 0) {
    return {
      status: 'green',
      windowHours: 24,
      failureRows: [],
      recoveryRows: recoveryRows.slice(-3),
      latestFailure: null,
      latestRecovery,
      summary: 'No failure rows found for this repo in the last 24h ledger window.',
    }
  }

  if (unresolvedFailures.length === 0) {
    const recoverySummary = repairRows.length > 0
      ? `${failureRows.length} failure row(s) found in the last 24h, all with later recovery evidence. Append-only repair marker(s) are present for the stale failure history.`
      : `${failureRows.length} failure row(s) found in the last 24h, all with later recovery evidence. Fleet health may still show degraded until append-only repair markers are emitted.`

    return {
      status: 'yellow',
      windowHours: 24,
      failureRows: failureRows.slice(-5),
      recoveryRows: recoveryRows.slice(-5),
      repairRows: repairRows.slice(-5),
      latestFailure,
      latestRecovery,
      summary: recoverySummary,
    }
  }

  return {
    status: 'red',
    windowHours: 24,
    failureRows: unresolvedFailures.slice(-5),
    recoveryRows: recoveryRows.slice(-5),
    repairRows: repairRows.slice(-5),
    latestFailure: unresolvedFailures.at(-1) || latestFailure,
    latestRecovery,
    summary: `${unresolvedFailures.length} unrecovered failure row(s) found in the last 24h ledger window.`,
  }
}

function isRecentLedgerEntry(entry, generatedAt, hours) {
  const then = Date.parse(entry.ts || '')
  const now = Date.parse(generatedAt || '')
  if (!Number.isFinite(then) || !Number.isFinite(now)) {
    return false
  }
  return then <= now && now - then <= hours * 60 * 60 * 1000
}

function compareLedgerEntries(a, b) {
  return Date.parse(a.ts || '') - Date.parse(b.ts || '')
}

function isFailureLedgerEntry(entry) {
  const handoff = String(entry.handoff_status || entry.handoffStatus || '').toLowerCase()
  const text = `${entry.summary || ''}\n${entry.proof || ''}\n${handoff}`
  if (handoff === 'resolved' || /\brepairs?:|recovered live freshness/i.test(text)) {
    return false
  }
  if (handoff === 'in_progress' || handoff === 'done' || handoff === 'complete') {
    return false
  }
  const hasFailureHandoff = /^(fail|failed|failure|blocked)$/.test(handoff)
  if (handoff && !hasFailureHandoff) {
    return false
  }
  return /\b(fail|failed|failure)\b|current verdict is red|verdict.*red|RED - missing required trust contract/i.test(text)
}

function isRecoveryLedgerEntry(entry) {
  const text = `${entry.summary || ''}\n${entry.proof || ''}\n${entry.handoff_status || entry.handoffStatus || ''}`
  return /recovered live freshness|after-gh-pages-catchup|overall=pass|\bpass(?:es|ed)?\b|0 failing|repair(?:s)?:/i.test(text)
}

function isRepairLedgerEntry(entry) {
  const text = `${entry.summary || ''}\n${entry.proof || ''}\n${entry.handoff_status || entry.handoffStatus || ''}`
  return /repair(?:s)?:/i.test(text)
}

function recoveryCoversFailure(failure, recovery) {
  const failureTs = Date.parse(failure.ts || '')
  const recoveryTs = Date.parse(recovery.ts || '')
  if (!Number.isFinite(failureTs) || !Number.isFinite(recoveryTs) || recoveryTs <= failureTs) {
    return false
  }

  if (failure.lane && recovery.lane && failure.lane === recovery.lane) {
    return true
  }

  const recoveryText = `${recovery.summary || ''}\n${recovery.proof || ''}`
  return /recovered live freshness|after-gh-pages-catchup|full MCP aggregate|direct MCP aggregate PASS/i.test(recoveryText)
}

function findLatestMcpProofForRepo({ repoDir, repoKey, expectedLaneIds = [], reportRoot }) {
  const summary = {
    reportRoot,
    searchedReports: 0,
    latest: null,
    latestComplete: null,
    latestCleanComplete: null,
    latestPartial: null,
    history: [],
  }
  let latestComplete = null
  let latestCleanComplete = null

  if (!repoKey || !fs.existsSync(reportRoot)) {
    return summary
  }

  const reports = fs.readdirSync(reportRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const reportPath = path.join(reportRoot, entry.name, 'report.json')
      if (!fs.existsSync(reportPath)) {
        return null
      }
      const stat = fs.statSync(reportPath)
      return { reportPath, mtimeMs: stat.mtimeMs }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 100)

  for (const report of reports) {
    summary.searchedReports += 1
    const data = readJsonIfExists(report.reportPath)
    if (data?.mode === 'dry_run') {
      continue
    }
    const lanes = collectReportLanes(data)
    const matching = lanes.filter(lane => lane.repo === repoKey || lane.repo_path === repoDir || lane.declaration_path?.startsWith(repoDir))
    if (matching.length === 0) {
      continue
    }
    const proof = buildMcpProof({
      data,
      matching,
      reportPath: report.reportPath,
      expectedLaneIds,
    })

    if (summary.history.length < MAX_MCP_HISTORY) {
      summary.history.push(summarizeMcpProofForHistory(proof))
    }

    if (proof.coverage.complete && !latestComplete) {
      latestComplete = proof
    }
    if (proof.coverage.complete && isCleanExecutionProof(proof) && !latestCleanComplete) {
      latestCleanComplete = proof
    }
    if (!proof.coverage.complete && !summary.latestPartial) {
      summary.latestPartial = proof
    }
  }

  summary.latest = latestCleanComplete || latestComplete || summary.latestPartial
  summary.latestComplete = latestComplete
  summary.latestCleanComplete = latestCleanComplete

  return summary
}

function isCleanExecutionProof(proof) {
  if (!proof?.executionSourceState) {
    return false
  }
  if (proof.executionSourceState.dirtyCount !== 0) {
    return false
  }
  return proof.executionSourceState.syncStatus === 'origin_main'
    || proof.executionSourceState.syncStatus === 'not_origin_main'
}

function summarizeMcpProofForHistory(proof) {
  const diagnosticStatus = summarizeLaneDiagnostics(proof.lanes || [])
  const diagnosticSummary = summarizeLaneDiagnosticMessages(proof.lanes || [])
  const sourceTrustStatus = sourceStateTrustStatus(proof.executionSourceState || proof.sourceState)
  const trustStatus = isRedProofStatus(proof.status) || diagnosticStatus === 'red'
    ? 'red'
    : proof.coverage?.complete === false || diagnosticStatus === 'yellow' || sourceTrustStatus === 'yellow'
      ? 'yellow'
      : proof.status === 'pass'
        ? 'green'
        : 'yellow'

  return {
    runId: proof.runId,
    mode: proof.mode,
    createdAt: proof.createdAt,
    status: proof.status,
    trustStatus,
    reportPath: proof.reportPath,
    requestedSourceRef: proof.requestedSourceRef || null,
    resolvedSourceRef: proof.resolvedSourceRef || null,
    coverage: proof.coverage,
    laneCount: proof.lanes.length,
    sourceState: proof.sourceState ? {
      syncStatus: proof.sourceState.syncStatus,
      dirtyCount: proof.sourceState.dirtyCount,
      aheadOriginMain: proof.sourceState.aheadOriginMain,
      behindOriginMain: proof.sourceState.behindOriginMain,
      head: proof.sourceState.head,
      upstreamHead: proof.sourceState.upstreamHead,
    } : null,
    primarySourceState: proof.primarySourceState ? {
      syncStatus: proof.primarySourceState.syncStatus,
      dirtyCount: proof.primarySourceState.dirtyCount,
      aheadOriginMain: proof.primarySourceState.aheadOriginMain,
      behindOriginMain: proof.primarySourceState.behindOriginMain,
      head: proof.primarySourceState.head,
      upstreamHead: proof.primarySourceState.upstreamHead,
    } : null,
    diagnostics: {
      status: diagnosticStatus,
      summary: diagnosticSummary || 'No lane warnings found.',
    },
  }
}

function sourceStateTrustStatus(sourceState) {
  if (!sourceState) {
    return 'yellow'
  }
  if (sourceState.dirtyCount > 0) {
    return 'yellow'
  }
  if (sourceState.syncStatus !== 'origin_main') {
    return 'yellow'
  }
  return 'green'
}

function isRedProofStatus(status) {
  return status === 'fail' || status === 'error' || status === 'red'
}

function isYellowProofStatus(status) {
  return status === 'warn' || status === 'yellow' || status === 'partial'
}

function buildMcpProof({ data, matching, reportPath, expectedLaneIds }) {
  const executionLane = matching.find(lane => lane.execution_source_state || lane.source_state) || matching[0]
  const primaryLane = matching.find(lane => lane.primary_source_state) || matching.find(lane => lane.source_state) || matching[0]
  const requestedSourceRef = data.source_ref || executionLane?.requested_source_ref || null
  const resolvedSourceRef = executionLane?.resolved_source_ref || null
  const executionSourceState = normalizeSourceState(
    executionLane,
    executionLane?.execution_source_state ? 'execution_source_state' : 'source_state',
  )
  const primarySourceState = normalizeSourceState(
    primaryLane,
    primaryLane?.primary_source_state ? 'primary_source_state' : 'source_state',
  )
  const sourceState = executionSourceState || primarySourceState
  const laneIds = matching.map(lane => lane.lane).filter(Boolean)
  const missingLaneIds = expectedLaneIds.filter(laneId => !laneIds.includes(laneId))
  return {
    reportPath,
    runId: data.run_id || path.basename(path.dirname(reportPath)),
    mode: data.mode || null,
    createdAt: data.created_at || null,
    status: data.overall || summarizeLaneStatuses(matching),
    host: data.host || matching[0]?.host || null,
    requestedSourceRef,
    resolvedSourceRef,
    sourceState,
    executionSourceState: sourceState,
    primarySourceState,
    coverage: {
      expectedLaneIds,
      laneIds,
      missingLaneIds,
      complete: missingLaneIds.length === 0,
    },
    lanes: matching.map(lane => ({
      lane: lane.lane,
      kind: lane.kind,
      command: lane.command || null,
      status: lane.status,
      rc: lane.rc ?? null,
      reason: lane.reason || null,
      expectedExitCodes: lane.expected_exit_codes || lane.expectedExitCodes || [],
      yellowExitCodes: lane.yellow_exit_codes || lane.yellowExitCodes || [],
      exitClassification: lane.exit_classification || null,
      trustStatus: lane.trust_status || null,
      sourceHead: lane.source_head || null,
      requestedSourceRef: lane.requested_source_ref || data.source_ref || null,
      resolvedSourceRef: lane.resolved_source_ref || null,
      logPath: lane.log_path || null,
      worktree: lane.worktree ?? null,
      cwd: lane.cwd || null,
      primarySourceState: normalizeSourceState(lane, lane.primary_source_state ? 'primary_source_state' : 'source_state'),
      executionSourceState: normalizeSourceState(lane, lane.execution_source_state ? 'execution_source_state' : 'source_state'),
      diagnostics: inspectLaneLog(lane.log_path, lane),
    })),
  }
}

function inspectLaneLog(logPath, lane = null) {
  if (!logPath) {
    return {
      status: isRedProofStatus(lane?.status) ? 'red' : isYellowProofStatus(lane?.status) ? 'yellow' : 'unknown',
      summary: isRedProofStatus(lane?.status)
        ? 'Lane failed, but no lane log path was recorded.'
        : isYellowProofStatus(lane?.status)
          ? (lane?.reason || 'Lane reported an expected warning, but no lane log path was recorded.')
          : 'No lane log path recorded.',
      tags: [],
    }
  }

  const text = readTextIfExists(logPath)
  if (!text) {
    return {
      status: isRedProofStatus(lane?.status) ? 'red' : isYellowProofStatus(lane?.status) ? 'yellow' : 'unknown',
      summary: isRedProofStatus(lane?.status)
        ? 'Lane failed, but the lane log is not available on this machine.'
        : isYellowProofStatus(lane?.status)
          ? (lane?.reason || 'Lane reported an expected warning, but the lane log is not available on this machine.')
          : 'Lane log is not available on this machine.',
      tags: [],
    }
  }

  if (isRedProofStatus(lane?.status) && lane?.kind && lane.kind !== 'ui') {
    const summary = extractGenericLaneFailure(text)
    return {
      status: 'red',
      summary: summary || lane.reason || 'Lane failed; no live-smoke diagnostics expected for this lane kind.',
      tags: [],
    }
  }

  if (isYellowProofStatus(lane?.status) && lane?.kind && lane.kind !== 'ui') {
    return {
      status: 'yellow',
      summary: lane.reason || `Lane exited with expected yellow status ${lane.status}.`,
      tags: [],
    }
  }

  if (lane?.kind && lane.kind !== 'ui') {
    return {
      status: 'green',
      summary: 'No live-smoke diagnostics expected for this lane kind.',
      tags: [],
    }
  }

  const tags = []
  if (/smoke-check-deploy:\s+FAILED/i.test(text) || /(?:cloudflare|github fallback) latest date expected/i.test(text)) {
    tags.push('smoke_failed')
  }
  if (/publish window grace accepted/i.test(text)) {
    tags.push('publish_grace')
  }
  if (/worker coverage recovery gap/i.test(text)) {
    tags.push('coverage_recovery_gap')
  }

  if (tags.includes('smoke_failed')) {
    const line = extractSmokeFailureSummary(text)
    return {
      status: 'red',
      summary: line || 'Live smoke failed.',
      tags,
    }
  }

  if (tags.includes('publish_grace')) {
    const line = text.split(/\r?\n/).find(item => /publish window grace accepted/i.test(item))
    return {
      status: 'yellow',
      summary: line ? line.trim().slice(0, 220) : 'Live smoke passed inside publish grace window.',
      tags,
    }
  }

  if (tags.includes('coverage_recovery_gap')) {
    const line = text.split(/\r?\n/).find(item => /worker coverage recovery gap/i.test(item))
    return {
      status: 'yellow',
      summary: line ? line.trim().slice(0, 220) : 'Live smoke passed with archive recovery coverage gap.',
      tags,
    }
  }

  if (isRedProofStatus(lane?.status)) {
    return {
      status: 'red',
      summary: 'Lane failed; no known live-smoke diagnostic line was found in the log.',
      tags: [],
    }
  }

  if (isYellowProofStatus(lane?.status)) {
    return {
      status: 'yellow',
      summary: lane.reason || `Lane exited with expected yellow status ${lane.status}.`,
      tags,
    }
  }

  return {
    status: 'green',
    summary: 'No known lane warnings found in the log.',
    tags,
  }
}

function extractSmokeFailureSummary(text) {
  const lines = text.split(/\r?\n/)
  const staleSurfacePattern = /(?:cloudflare|github fallback) latest date expected/i
  const plainError = lines.find(item => new RegExp(`Error:\\s+${staleSurfacePattern.source}`, 'i').test(item))
  if (plainError) {
    return plainError.trim().slice(0, 220)
  }

  for (const line of lines) {
    const match = line.match(/\[FX_PUBLISH\]\s+(\{.*\})/)
    if (!match) {
      continue
    }
    try {
      const payload = JSON.parse(match[1])
      if (payload.error && staleSurfacePattern.test(payload.error)) {
        return `Error: ${payload.error}`.slice(0, 220)
      }
    } catch {
      // Keep scanning; malformed monitoring lines should not hide later plain errors.
    }
  }

  const genericLine = lines.find(item => staleSurfacePattern.test(item) || /smoke-check-deploy:\s+FAILED/i.test(item))
  return genericLine ? genericLine.trim().slice(0, 220) : null
}

function extractGenericLaneFailure(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  const signal = lines.find(line => (
    /^Error:/i.test(line)
    || /^npm ERR!/i.test(line)
    || /^✖\s+/.test(line)
    || /Missing script|ENOENT|not found|command not found/i.test(line)
  ))
  return signal ? signal.slice(0, 220) : null
}

function normalizeSourceState(lane, field = 'source_state') {
  const state = lane?.[field]
  if (!state || typeof state !== 'object') {
    return null
  }

  return {
    repoPath: state.repo_path || lane.cwd || lane.primary_repo_path || lane.repo_path || null,
    exists: state.exists ?? null,
    isGit: state.is_git ?? null,
    branch: state.branch || null,
    head: state.head || lane.source_head || null,
    upstream: state.upstream || null,
    upstreamHead: state.upstream_head || state.origin_main_local_head || null,
    remoteHead: state.origin_main_remote_head || null,
    dirtyCount: numberOrNull(state.dirty_count),
    aheadOriginMain: numberOrNull(state.ahead_origin_main),
    behindOriginMain: numberOrNull(state.behind_origin_main),
    syncStatus: state.sync_status || deriveSourceSyncStatus(state),
  }
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : Number.isFinite(Number(value)) ? Number(value) : null
}

function deriveSourceSyncStatus(state) {
  if (state.dirty_count > 0) {
    return 'dirty'
  }
  if (state.behind_origin_main > 0 || state.ahead_origin_main > 0) {
    return 'diverged'
  }
  if (state.is_git === false || state.exists === false) {
    return 'unavailable'
  }
  return 'clean'
}

function evaluateMcpProofFreshness(proof, generatedAt = new Date().toISOString()) {
  if (!proof) {
    return {
      status: 'yellow',
      ageMinutes: null,
      summary: 'No execute report was found for this repo.',
    }
  }

  if (isRedProofStatus(proof.status)) {
    return {
      status: 'red',
      ageMinutes: ageMinutesBetween(proof.createdAt, generatedAt),
      summary: 'Latest MCP execute report failed.',
    }
  }

  const ageMinutes = ageMinutesBetween(proof.createdAt, generatedAt)
  if (ageMinutes === null) {
    return {
      status: 'yellow',
      ageMinutes: null,
      summary: 'Latest MCP execute report is missing created_at, so freshness cannot be trusted.',
    }
  }

  if (ageMinutes > 6 * 60) {
    return {
      status: 'yellow',
      ageMinutes,
      summary: `Latest MCP execute report is ${ageMinutes} minute(s) old; rerun before launch claims.`,
    }
  }

  if (!proof.sourceState) {
    return {
      status: 'yellow',
      ageMinutes,
      summary: 'Latest MCP execute report is fresh but missing source_state.',
    }
  }

  if (proof.coverage && !proof.coverage.complete) {
    return {
      status: 'yellow',
      ageMinutes,
      summary: `Latest MCP execute report is partial; missing lane(s): ${proof.coverage.missingLaneIds.join(', ')}.`,
    }
  }

  if (proof.lanes.some(lane => !lane.sourceHead || !lane.logPath)) {
    return {
      status: 'yellow',
      ageMinutes,
      summary: 'Latest MCP execute report is fresh but one or more lanes lack source_head or log_path.',
    }
  }

  if (isYellowProofStatus(proof.status)) {
    return {
      status: 'yellow',
      ageMinutes,
      summary: `Latest MCP execute report is ${proof.status}; at least one trust lane has expected warning evidence.`,
    }
  }

  return {
    status: 'green',
    ageMinutes,
    summary: `Fresh MCP execute report (${ageMinutes} minute(s) old) includes source_state, source heads, and logs.`,
  }
}

function collectReportLanes(data) {
  if (!data) {
    return []
  }
  const lanes = []
  if (Array.isArray(data.lanes)) {
    lanes.push(...data.lanes)
  }
  if (Array.isArray(data.latest_lane_proof)) {
    lanes.push(...data.latest_lane_proof)
  }
  return lanes
}

function summarizeLaneStatuses(lanes) {
  if (lanes.some(lane => isRedProofStatus(lane.status))) {
    return 'fail'
  }
  if (lanes.some(lane => isYellowProofStatus(lane.status))) {
    return 'warn'
  }
  if (lanes.length > 0 && lanes.every(lane => lane.status === 'pass')) {
    return 'pass'
  }
  return 'unknown'
}

function computeRisks({ git, localCi, telemetry, nurseLog, inbox, ledger, reviewScout }) {
  const risks = []

  if (git?.dirtyCount > 0) {
    risks.push({
      status: 'yellow',
      label: 'Dirty primary checkout',
      detail: `${git.dirtyCount} changed path(s) in the primary checkout; do not treat local proof as clean-main proof.`,
    })
  }

  if (git?.behindOriginMain > 0) {
    risks.push({
      status: 'yellow',
      label: 'Behind origin/main',
      detail: `Local HEAD is ${git.behindOriginMain} commit(s) behind origin/main.`,
    })
  }

  if (localCi.status !== 'green') {
    risks.push({
      status: localCi.status === 'red' ? 'red' : localCi.manifestPresent ? 'yellow' : 'red',
      label: 'Local-CI proof gap',
      detail: localCi.summary,
    })
  }

  if (localCi.proofFreshness?.status !== 'green') {
    risks.push({
      status: localCi.proofFreshness?.status || 'yellow',
      label: 'MCP proof freshness gap',
      detail: localCi.proofFreshness?.summary || 'Latest MCP proof freshness is unknown.',
    })
  }

  const proofSource = localCi.mcpProof?.latest?.executionSourceState || localCi.mcpProof?.latest?.sourceState
  if (proofSource && ((proofSource.dirtyCount || 0) > 0 || (proofSource.behindOriginMain || 0) > 0 || (proofSource.aheadOriginMain || 0) > 0)) {
    risks.push({
      status: 'yellow',
      label: 'MCP proof source is not clean-main',
      detail: `Latest MCP proof execution source_state is ${proofSource.syncStatus || 'unknown'}: dirty ${proofSource.dirtyCount ?? 'unknown'}, ahead ${proofSource.aheadOriginMain ?? 'unknown'}, behind ${proofSource.behindOriginMain ?? 'unknown'}.`,
    })
  }

  if (localCi.trackedSource?.status && localCi.trackedSource.status !== 'green') {
    risks.push({
      status: localCi.trackedSource.status,
      label: 'Tracked local-CI source gap',
      detail: localCi.trackedSource.summary,
    })
  }

  if (localCi.cleanProofReadiness?.status && localCi.cleanProofReadiness.status !== 'green') {
    risks.push({
      status: localCi.cleanProofReadiness.status,
      label: 'Clean proof targetability gap',
      detail: localCi.cleanProofReadiness.summary,
    })
  }

  if (localCi.sourcePromotionBundle?.status && localCi.sourcePromotionBundle.status !== 'green') {
    risks.push({
      status: localCi.sourcePromotionBundle.status,
      label: 'Source promotion bundle gap',
      detail: localCi.sourcePromotionBundle.summary,
    })
  }

  if (localCi.operatingReadout?.status && localCi.operatingReadout.status !== 'green' && localCi.operatingReadout.status !== 'missing') {
    risks.push({
      status: localCi.operatingReadout.status,
      label: 'FirstBite operating readout gap',
      detail: localCi.operatingReadout.summary,
    })
  }

  if (localCi.runnerControlPlane?.status && localCi.runnerControlPlane.status !== 'green') {
    risks.push({
      status: localCi.runnerControlPlane.status,
      label: 'FirstBite runner durability gap',
      detail: localCi.runnerControlPlane.summary,
    })
  }

  if (localCi.reviewScoutProducerControlPlane?.status && localCi.reviewScoutProducerControlPlane.status !== 'green') {
    risks.push({
      status: localCi.reviewScoutProducerControlPlane.status,
      label: 'Review-scout producer durability gap',
      detail: localCi.reviewScoutProducerControlPlane.summary,
    })
  }

  const peerBoundary = localCi.operatingReadout?.peerExecutionBoundary
  if (peerBoundary?.status && peerBoundary.status !== 'green' && peerBoundary.status !== 'missing') {
    risks.push({
      status: peerBoundary.status,
      label: 'M4 peer execution boundary',
      detail: peerBoundary.summary,
    })
  }

  const loadedMcpProbe = localCi.loadedMcpProbe
  if (loadedMcpProbe?.status && loadedMcpProbe.status !== 'green') {
    risks.push({
      status: loadedMcpProbe.status === 'missing' ? 'yellow' : loadedMcpProbe.status,
      label: 'Loaded MCP lane catalog gap',
      detail: loadedMcpProbe.summary,
    })
  }
  if (loadedMcpProbe?.status !== 'missing' && loadedMcpProbe?.freshnessStatus && loadedMcpProbe.freshnessStatus !== 'green') {
    risks.push({
      status: 'yellow',
      label: 'Loaded MCP probe freshness gap',
      detail: loadedMcpProbe.freshnessSummary,
    })
  }

  const repoBackedMcpProbe = localCi.repoBackedMcpProbe
  if (repoBackedMcpProbe?.status === 'red') {
    risks.push({
      status: 'red',
      label: 'Repo-backed MCP catalog gap',
      detail: repoBackedMcpProbe.summary,
    })
  }

  const cloudflareDestinations = telemetry.cloudflare?.destinations
  if (cloudflareDestinations?.status && cloudflareDestinations.status !== 'green') {
    risks.push({
      status: cloudflareDestinations.status === 'missing' ? 'yellow' : cloudflareDestinations.status,
      label: 'Cloudflare OTEL destination gap',
      detail: cloudflareDestinations.summary,
    })
  }

  if (telemetry.status !== 'green') {
    risks.push({
      status: telemetry.status,
      label: 'OTEL/Grafana proof gap',
      detail: telemetry.summary,
    })
  }

  if (ledger?.health?.status === 'red') {
    risks.push({
      status: ledger.health.status,
      label: 'Agent ledger failure history',
      detail: ledger.health.summary,
    })
  }

  if (reviewScout?.status && reviewScout.status !== 'green' && reviewScout.status !== 'missing') {
    risks.push({
      status: reviewScout.status,
      label: 'Coding-agent review scout gap',
      detail: reviewScout.summary,
    })
  }

  if (nurseLog.releaseReadiness === 'yellow') {
    risks.push({
      status: 'yellow',
      label: 'Release-history readiness yellow',
      detail: releaseHistorySummary(nurseLog),
    })
  }

  if (!loadedMcpProbe?.status && /loaded Desktop MCP|Desktop MCP server|MCP server.*stale|reload\/restart/i.test(nurseLog.currentBlocker || '')) {
    risks.push({
      status: 'yellow',
      label: 'Loaded MCP server stale',
      detail: 'The direct MCP package sees the FX lanes, but the already-loaded Desktop MCP server still needs reload/restart before it exposes them.',
    })
  }

  if (inbox.hasStaleGrafanaItem) {
    risks.push({
      status: 'yellow',
      label: 'Stale Grafana INBOX row',
      detail: 'INBOX still carries older Worker-side OTEL instructions; reconcile it against the Fleet OTEL plan and current wrangler config.',
    })
  }

  return risks
}

function buildTrustContracts({ git, localCi, telemetry, nurseLog, ledger, reviewScout }) {
  const proof = localCi?.mcpProof?.latest
  const evidence = telemetry?.grafana?.evidence
  const cloudflareDestinations = telemetry?.cloudflare?.destinations
  const loadedMcp = localCi?.loadedMcpProbe
  const repoBackedMcp = localCi?.repoBackedMcpProbe
  const mcpRefreshPlan = localCi?.mcpRefreshPlan
  const trackedSource = localCi?.trackedSource
  const cleanProofReadiness = localCi?.cleanProofReadiness
  const sourcePromotionBundle = localCi?.sourcePromotionBundle
  const operatingReadout = localCi?.operatingReadout
  const runnerControlPlane = localCi?.runnerControlPlane
  const reviewScoutProducerControlPlane = localCi?.reviewScoutProducerControlPlane
  const peerBoundary = operatingReadout?.peerExecutionBoundary

  const contracts = [
    {
      gate: 'Primary checkout',
      status: git?.dirtyCount > 0 || git?.behindOriginMain > 0 ? 'yellow' : 'green',
      current: `dirty ${git?.dirtyCount ?? 'unknown'} / behind ${git?.behindOriginMain ?? 'unknown'} on ${git?.branch || 'unknown'}`,
      proof: 'git status --short --branch',
      nextAction: git?.dirtyCount > 0 || git?.behindOriginMain > 0
        ? 'Separate user changes from cockpit work, then prove the intended launch source from clean current origin/main.'
        : 'Keep this green by running release proof from the same checkout.',
    },
    {
      gate: 'Tracked local-CI contract',
      status: trackedSource?.status || 'yellow',
      current: trackedSource?.summary || 'Tracked source contract was not inspected.',
      proof: 'cockpit Tracked Source Contract section',
      nextAction: trackedSource?.status === 'green'
        ? 'Rerun clean-worktree local CI from the tracked contract.'
        : 'Land or sync .firstbite/local-ci.json, package scripts, and referenced script files onto tracked source before trusting clean-lane proof.',
    },
    {
      gate: 'Clean proof targetability',
      status: cleanProofReadiness?.status || 'yellow',
      current: cleanProofReadiness?.summary || 'Clean proof readiness was not inspected.',
      proof: 'cockpit Clean Proof Readiness section',
      nextAction: cleanProofReadiness?.nextAction || 'Inspect the FirstBite runner contract before trusting clean worktree proof.',
    },
    {
      gate: 'Source promotion bundle',
      status: sourcePromotionBundle?.status || 'yellow',
      current: sourcePromotionBundle?.summary || 'Source promotion bundle was not built.',
      proof: 'cockpit Source Promotion Bundle section',
      nextAction: sourcePromotionBundle?.nextAction || 'Review current-only control-plane files before rerunning clean local CI.',
    },
    {
      gate: 'FirstBite operating readout',
      status: operatingReadout?.status === 'missing' ? 'yellow' : operatingReadout?.status || 'yellow',
      current: operatingReadout?.summary || 'FirstBite operating readout was not inspected.',
      proof: operatingReadout?.reportPath || 'firstbite-operating-readout/report.json',
      nextAction: operatingReadout?.nextAction || 'Run the FirstBite operating readout before cross-agent local-CI claims.',
    },
    {
      gate: 'FirstBite runner durability',
      status: runnerControlPlane?.status || 'yellow',
      current: runnerControlPlane?.summary || 'FirstBite runner package durability was not inspected.',
      proof: runnerControlPlane?.serverRelativePath || FIRSTBITE_RUNNER_SERVER_RELATIVE_PATH,
      nextAction: runnerControlPlane?.nextAction || 'Prove expected/yellow exit support is landed in ai-leo and loaded by the MCP host.',
    },
    {
      gate: 'Review-scout producer durability',
      status: reviewScoutProducerControlPlane?.status || 'yellow',
      current: reviewScoutProducerControlPlane?.summary || 'Review-scout producer durability was not inspected.',
      proof: reviewScoutProducerControlPlane?.scriptRelativePath || FIRSTBITE_REVIEW_SCOUT_SCRIPT_RELATIVE_PATH,
      nextAction: reviewScoutProducerControlPlane?.nextAction || 'Prove firstbite-cursor-review.sh emits canonical repo-key proof and is landed on ai-leo origin/main.',
    },
  ]

  if (peerBoundary && peerBoundary.status !== 'missing') {
    contracts.push({
      gate: 'M4 peer execution boundary',
      status: peerBoundary.status,
      current: peerBoundary.summary,
      proof: operatingReadout?.m4FreshClonePacket?.latestCommands || operatingReadout?.reportPath || 'firstbite-operating-readout/report.json',
      nextAction: peerBoundary.nextAction,
    })
  }

  contracts.push(
    {
      gate: 'Selected local-CI proof',
      status: localCi?.status || 'red',
      current: localCi?.summary || 'No local-CI summary available.',
      proof: proof?.reportPath || 'missing MCP execute report',
      nextAction: localCi?.status === 'green'
        ? 'Keep the latest complete clean proof attached to the cockpit.'
        : 'Rerun all FX lanes from clean current source with commands matching .firstbite/local-ci.json.',
    },
    {
      gate: 'Loaded MCP host catalog',
      status: loadedMcp?.status || 'yellow',
      current: [
        loadedMcp?.summary || 'No loaded-host MCP probe artifact was found.',
        mcpRefreshPlan?.status && mcpRefreshPlan.status !== 'missing' ? `Refresh packet: ${mcpRefreshPlan.summary}` : '',
      ].filter(Boolean).join(' '),
      proof: loadedMcp?.status && loadedMcp.status !== 'missing'
        ? loadedMcp.path
        : mcpRefreshPlan?.reportPath || 'reports/firstbite-loaded-mcp-lanes.json',
      nextAction: loadedMcp?.status === 'green'
        ? 'Use the in-app MCP tool only while its catalog age and lane count remain current.'
        : mcpRefreshPlan?.staleProcessCount > 0
          ? 'Save work and restart/reload Codex/Cursor, rerun the refresh plan, then capture a fresh live loaded-host list_lanes artifact.'
        : 'Restart or reload Codex/Cursor MCP host, capture a fresh list_lanes artifact, and require all resplit_currency_api lanes.',
    },
    {
      gate: 'Repo-backed MCP package',
      status: repoBackedMcp?.status || 'yellow',
      current: repoBackedMcp?.summary || 'Repo-backed MCP package probe was not captured.',
      proof: repoBackedMcp?.packageDir || DEFAULT_FIRSTBITE_LOCAL_CI_DIR,
      nextAction: repoBackedMcp?.status === 'green'
        ? 'Treat this as the control-plane source until loaded host catches up.'
        : 'Run the repo-backed FirstBite list_lanes call and fix manifest parsing before executing lanes.',
    },
    {
      gate: 'Cloudflare OTEL destinations',
      status: cloudflareDestinations?.status === 'missing' ? 'yellow' : cloudflareDestinations?.status || 'yellow',
      current: cloudflareDestinations?.summary || 'Cloudflare Workers Observability destination proof was not inspected.',
      proof: cloudflareDestinations?.latestPath || 'reports/cloudflare-otel-destinations.json',
      nextAction: cloudflareDestinations?.status === 'green'
        ? 'Keep destination proof fresh before relying on Grafana delivery evidence.'
        : 'Run npm run observability:cloudflare-destinations with a Workers Observability Read token and confirm logs/traces destinations match wrangler.jsonc.',
    },
    {
      gate: 'OTEL/Grafana evidence',
      status: telemetry?.status || 'red',
      current: telemetry?.summary || 'No telemetry summary available.',
      proof: evidence?.latestPath || 'reports/grafana-otel-smoke.json',
      nextAction: telemetry?.status === 'green'
        ? 'Keep fresh Tempo and Loki evidence under the cockpit evidence roots.'
        : 'After Cloudflare destinations exist, run npm run observability:otel-smoke with Grafana read env until Tempo and Loki both match.',
    },
    {
      gate: 'Release-history strict coverage',
      status: nurseLog?.releaseReadiness === 'green' ? 'green' : 'yellow',
      current: releaseHistorySummary(nurseLog),
      proof: 'npm run validate:release',
      nextAction: nurseLog?.releaseReadiness === 'green'
        ? 'Keep strict release validation green through the daily publish window.'
        : 'Backfill or age out the May 12-23 history gap; keep FX launch readiness yellow until strict validation passes.',
    },
    {
      gate: 'Agent ledger health',
      status: ledger?.health?.status || 'yellow',
      current: ledger?.health?.summary || 'Ledger health was not computed.',
      proof: '/Users/leokwan/Development/ai/hooks/ledger-fleet-health.sh --repo resplit-currency-api --archive',
      nextAction: ledger?.health?.status === 'green' || ledger?.health?.status === 'yellow'
        ? 'Continue append-only handoffs; repair stale failures only with scoped later evidence.'
        : 'Resolve unrecovered ledger failure rows before using agent history as trust evidence.',
    },
    {
      gate: 'Coding-agent review scout',
      status: reviewScout?.status === 'missing' ? 'yellow' : reviewScout?.status || 'yellow',
      current: reviewScout?.summary || 'Cursor/Graphite review scout was not inspected.',
      proof: reviewScout?.reportPath || path.join(DEFAULT_FIRSTBITE_CURSOR_REVIEW_DIR, '<run-id>', 'report.json'),
      nextAction: reviewScout?.nextAction || 'Run the read-only no-Cursor review scout before using coding-agent review history as trust evidence.',
    },
  )

  return contracts
}

function buildOperatorActionQueue({ localCi = {}, telemetry = {}, nurseLog = {}, inbox = {}, ledger = {}, reviewScout = {}, contracts = [] } = {}) {
  const byGate = new Map((contracts || []).map(contract => [contract.gate, contract]))
  const sourcePromotion = localCi.sourcePromotionBundle || {}
  const cleanProof = localCi.cleanProofReadiness || {}
  const loadedMcp = localCi.loadedMcpProbe || {}
  const mcpRefreshPlan = localCi.mcpRefreshPlan || {}
  const operatingReadout = localCi.operatingReadout || {}
  const runnerControlPlane = localCi.runnerControlPlane || {}
  const reviewScoutProducerControlPlane = localCi.reviewScoutProducerControlPlane || {}
  const cloudflareDestinations = telemetry.cloudflare?.destinations || {}
  const grafanaEvidence = telemetry.grafana?.evidence || {}
  const actions = []

  if (contractNeedsAction(byGate.get('Source promotion bundle')) || contractNeedsAction(byGate.get('Tracked local-CI contract'))) {
    actions.push(operatorAction({
      id: 'source-promotion-review',
      priority: 1,
      owner: 'Local source',
      gate: 'Source promotion bundle',
      status: worstStatus([byGate.get('Source promotion bundle')?.status, byGate.get('Tracked local-CI contract')?.status, sourcePromotion.status]),
      proof: 'reports/resplit-fx-source-promotion-packet.md',
      command: sourcePromotion.commands?.writePacket || 'npm run source:promotion-packet',
      blocker: sourcePromotion.summary || byGate.get('Source promotion bundle')?.current || 'Source promotion bundle has not been generated.',
      nextAction: 'Review the packet, stage only exact candidates, and keep hold-by-default rows out unless separately reviewed.',
      evidenceRequired: 'A staged or landed diff whose paths match the packet stage candidates, with hold-by-default rows reviewed separately.',
      unblocks: 'Clean worktree FirstBite proof',
      canRunNow: true,
      boundary: 'local',
    }))
  }

  if (contractNeedsAction(byGate.get('Clean proof targetability')) || contractNeedsAction(byGate.get('Selected local-CI proof'))) {
    actions.push(operatorAction({
      id: 'clean-firstbite-proof',
      priority: 2,
      owner: 'FirstBite local CI',
      gate: 'Clean proof targetability',
      status: worstStatus([byGate.get('Clean proof targetability')?.status, byGate.get('Selected local-CI proof')?.status, cleanProof.status]),
      proof: byGate.get('Selected local-CI proof')?.proof || 'FirstBite worktree=true execute report',
      command: cleanProof.commands?.cleanWorktree || '',
      blocker: cleanProof.summary || byGate.get('Selected local-CI proof')?.current || 'Clean FirstBite proof has not run against the current tracked contract.',
      nextAction: cleanProof.nextAction || byGate.get('Selected local-CI proof')?.nextAction || 'Run clean worktree local CI from the landed contract.',
      evidenceRequired: 'A fresh worktree=true execute report with all resplit_currency_api lanes passing and commands matching .firstbite/local-ci.json.',
      unblocks: 'Selected local-CI proof',
      canRunNow: sourcePromotion.status === 'green',
      blockedBy: sourcePromotion.status === 'green' ? '' : 'Source promotion bundle must land first.',
      boundary: 'local-ci',
    }))
  }

  if (contractNeedsAction(byGate.get('FirstBite runner durability'))) {
    actions.push(operatorAction({
      id: 'firstbite-runner-durability',
      priority: 3,
      owner: 'ai-leo MCP runner',
      gate: 'FirstBite runner durability',
      status: byGate.get('FirstBite runner durability')?.status || runnerControlPlane.status || 'yellow',
      proof: runnerControlPlane.serverRelativePath || FIRSTBITE_RUNNER_SERVER_RELATIVE_PATH,
      command: 'cd /Users/leokwan/Development/ai-leo-worktrees/firstbite-mcp-warn-exits-20260525 && gh pr view 11 --json state,isDraft,mergeStateStatus,headRefName',
      blocker: runnerControlPlane.summary || byGate.get('FirstBite runner durability')?.current || 'FirstBite runner durability was not inspected.',
      nextAction: runnerControlPlane.nextAction || byGate.get('FirstBite runner durability')?.nextAction || 'Land expected/yellow exit support in ai-leo, restart the loaded MCP host, and recapture list_lanes.',
      evidenceRequired: 'ai-leo origin/main contains expected/yellow exit support and a fresh loaded-host MCP catalog sees the repo-manifest-v2 FX lanes.',
      unblocks: 'Loaded MCP host catalog',
      canRunNow: Boolean(runnerControlPlane.activeSupports || runnerControlPlane.prSupports),
      blockedBy: runnerControlPlane.activeSupports || runnerControlPlane.prSupports ? '' : 'Runner support is not present locally or on the PR branch.',
      boundary: 'local-agent-control-plane',
    }))
  }

  if (contractNeedsAction(byGate.get('Review-scout producer durability'))) {
    actions.push(operatorAction({
      id: 'review-scout-producer-durability',
      priority: 3,
      owner: 'ai-leo review scout',
      gate: 'Review-scout producer durability',
      status: byGate.get('Review-scout producer durability')?.status || reviewScoutProducerControlPlane.status || 'yellow',
      proof: reviewScoutProducerControlPlane.scriptRelativePath || FIRSTBITE_REVIEW_SCOUT_SCRIPT_RELATIVE_PATH,
      command: `cd /Users/leokwan/Development/ai-leo && git branch -r --contains ${reviewScoutProducerControlPlane.producerBranchHead || 'HEAD'}`,
      blocker: reviewScoutProducerControlPlane.summary || byGate.get('Review-scout producer durability')?.current || 'Review-scout producer durability was not inspected.',
      nextAction: reviewScoutProducerControlPlane.nextAction || byGate.get('Review-scout producer durability')?.nextAction || 'Land canonical repo-key support in firstbite-cursor-review.sh, then rerun the scout.',
      evidenceRequired: 'ai-leo origin/main contains firstbite-cursor-review.sh canonical repo-key support, and a fresh scout packet records repo=resplit-currency-api plus local_ci_repo_key=resplit_currency_api.',
      unblocks: 'Local coding-agent review trust',
      canRunNow: Boolean(reviewScoutProducerControlPlane.activeSupports || reviewScoutProducerControlPlane.producerBranchSupports),
      blockedBy: reviewScoutProducerControlPlane.activeSupports || reviewScoutProducerControlPlane.producerBranchSupports ? '' : 'Producer support is not present locally or on the known feature branch.',
      boundary: 'local-agent-review',
    }))
  }

  if (contractNeedsAction(byGate.get('Loaded MCP host catalog'))) {
    actions.push(operatorAction({
      id: 'loaded-mcp-refresh',
      priority: 3,
      owner: 'Codex/Cursor MCP host',
      gate: 'Loaded MCP host catalog',
      status: byGate.get('Loaded MCP host catalog')?.status || loadedMcp.status || 'yellow',
      proof: loadedMcp.status && loadedMcp.status !== 'missing'
        ? loadedMcp.path
        : mcpRefreshPlan.reportPath || 'reports/firstbite-loaded-mcp-lanes.json',
      command: mcpRefreshPlan.continuationCommands?.find(command => /refresh plan/i.test(command.label || ''))?.command || LOADED_MCP_REUSE_COMMAND,
      blocker: loadedMcp.summary || mcpRefreshPlan.summary || byGate.get('Loaded MCP host catalog')?.current || 'Loaded MCP catalog was not captured.',
      nextAction: mcpRefreshPlan.staleProcessCount > 0
        ? 'Save work and restart/reload Codex/Cursor, then rerun the refresh plan and capture live list_lanes output into the loaded-host probe artifact.'
        : 'Use --reuse-existing only to refresh the previous artifact; true green still requires a Codex/Cursor MCP host restart or reload plus a live list_lanes capture.',
      evidenceRequired: 'Fresh loaded-host list_lanes artifact with repo-manifest-v2 and all current resplit_currency_api lanes present.',
      unblocks: 'In-app local coding agent trust',
      canRunNow: true,
      blockedBy: '',
      boundary: 'local-agent-host',
    }))
  }

  if (contractNeedsAction(byGate.get('Cloudflare OTEL destinations'))) {
    const missingReadConfig = /Missing Cloudflare read config|CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_API_TOKEN/i.test(cloudflareDestinations.summary || '')
    actions.push(operatorAction({
      id: 'cloudflare-otel-destinations',
      priority: 4,
      owner: 'Cloudflare',
      gate: 'Cloudflare OTEL destinations',
      status: byGate.get('Cloudflare OTEL destinations')?.status || cloudflareDestinations.status || 'yellow',
      proof: cloudflareDestinations.latestPath || 'reports/cloudflare-otel-destinations.json',
      command: 'npm run observability:cloudflare-destinations',
      blocker: cloudflareDestinations.summary || byGate.get('Cloudflare OTEL destinations')?.current || 'Cloudflare destination proof was not inspected.',
      nextAction: byGate.get('Cloudflare OTEL destinations')?.nextAction || 'Run the Cloudflare destination verifier before treating wrangler destination names as real dashboard state.',
      evidenceRequired: 'A sanitized Cloudflare destination report where logs and traces destinations are enabled and match wrangler.jsonc.',
      unblocks: 'OTEL/Grafana delivery proof',
      canRunNow: !missingReadConfig,
      blockedBy: missingReadConfig ? 'Requires CLOUDFLARE_ACCOUNT_ID and a Workers Observability Read API token.' : '',
      boundary: 'cloudflare-control-plane',
    }))
  }

  if (contractNeedsAction(byGate.get('OTEL/Grafana evidence'))) {
    actions.push(operatorAction({
      id: 'grafana-otel-proof',
      priority: 5,
      owner: 'Cloudflare/Grafana',
      gate: 'OTEL/Grafana evidence',
      status: byGate.get('OTEL/Grafana evidence')?.status || telemetry.status || 'yellow',
      proof: grafanaEvidence.latestPath || 'reports/grafana-otel-smoke.json',
      command: 'npm run observability:otel-smoke -- --since-minutes 60',
      blocker: telemetry.summary || byGate.get('OTEL/Grafana evidence')?.current || 'Grafana evidence was not inspected.',
      nextAction: byGate.get('OTEL/Grafana evidence')?.nextAction || 'Run the live Grafana smoke after destinations and read credentials exist.',
      evidenceRequired: 'A fresh smoke artifact where Worker trigger, Grafana config, Tempo query, and Loki query are all green.',
      unblocks: 'OTEL/Grafana launch trust',
      canRunNow: false,
      blockedBy: 'Requires Cloudflare destination setup, deployment, and Grafana read env.',
      boundary: 'external-observability',
    }))
  }

  if (contractNeedsAction(byGate.get('Release-history strict coverage'))) {
    actions.push(operatorAction({
      id: 'release-history-backfill',
      priority: 5,
      owner: 'FX data',
      gate: 'Release-history strict coverage',
      status: byGate.get('Release-history strict coverage')?.status || 'yellow',
      proof: 'npm run validate:release',
      command: 'npm run audit:backfill-sources -- --from 2026-05-12 --to 2026-05-23 && npm run validate:release',
      blocker: releaseHistoryActionSummary(nurseLog, inbox),
      nextAction: byGate.get('Release-history strict coverage')?.nextAction || 'Find a complete single source or keep the gate yellow until the gap ages out.',
      evidenceRequired: 'Strict validation green, or an audit artifact proving every missing date has complete single-source coverage before backfill.',
      unblocks: 'FX release readiness',
      canRunNow: true,
      boundary: 'data-quality',
    }))
  }

  if (contractNeedsAction(byGate.get('FirstBite operating readout'))) {
    actions.push(operatorAction({
      id: 'firstbite-operating-readout',
      priority: 6,
      owner: 'Local agent fleet',
      gate: 'FirstBite operating readout',
      status: byGate.get('FirstBite operating readout')?.status || operatingReadout.status || 'yellow',
      proof: operatingReadout.reportPath || '~/.agent-ledger/firstbite-operating-readout/<run-id>/report.json',
      command: 'bash /Users/leokwan/Development/ai-leo/skills/local-ci/scripts/firstbite-operating-readout.sh',
      blocker: operatingReadout.summary || byGate.get('FirstBite operating readout')?.current || 'FirstBite operating readout is not green.',
      nextAction: byGate.get('FirstBite operating readout')?.nextAction || 'Refresh the operating readout and inspect failed lanes.',
      evidenceRequired: 'Fresh readout separating FX repo proof from broader fleet warnings.',
      unblocks: 'Fleet-wide local agent confidence',
      canRunNow: true,
      boundary: 'local-agent-fleet',
    }))
  }

  if (contractNeedsAction(byGate.get('M4 peer execution boundary'))) {
    const peerBoundary = operatingReadout.peerExecutionBoundary || {}
    const m4Packet = operatingReadout.m4FreshClonePacket || {}
    actions.push(operatorAction({
      id: 'm4-peer-execute-proof',
      priority: 7,
      owner: 'M4 local agent peer',
      gate: 'M4 peer execution boundary',
      status: byGate.get('M4 peer execution boundary')?.status || peerBoundary.status || 'yellow',
      proof: byGate.get('M4 peer execution boundary')?.proof || operatingReadout.reportPath || '~/.agent-ledger/firstbite-operating-readout/<run-id>/report.json',
      command: m4Packet.latestCommands || 'Run generated fresh-clone-commands.sh on the M4 Pro',
      blocker: peerBoundary.summary || byGate.get('M4 peer execution boundary')?.current || 'M4 peer does not have local execute proof.',
      nextAction: peerBoundary.nextAction || byGate.get('M4 peer execution boundary')?.nextAction || 'Capture an M4-local run_lanes execute report before claiming peer execution capacity.',
      evidenceRequired: 'M4-local support preflight plus run_lanes execute report from the M4 host; Studio HTTP/LAN/SSH probes are not execution proof.',
      unblocks: 'Peer execution capacity trust',
      canRunNow: false,
      blockedBy: 'Requires running the generated packet on the M4 Pro and capturing proof from that host.',
      boundary: 'peer-execution',
    }))
  }

  if (contractNeedsAction(byGate.get('Coding-agent review scout'))) {
    actions.push(operatorAction({
      id: 'coding-agent-review-scout',
      priority: 7,
      owner: 'Cursor/Graphite review scout',
      gate: 'Coding-agent review scout',
      status: byGate.get('Coding-agent review scout')?.status || reviewScout.status || 'yellow',
      proof: reviewScout.reportPath || '~/.agent-ledger/firstbite-cursor-review/<run-id>/report.json',
      command: reviewScout.command || 'bash ~/Development/ai-leo/skills/resplit-watch/scripts/firstbite-cursor-review.sh --repo <repo> --no-cursor',
      blocker: reviewScout.summary || byGate.get('Coding-agent review scout')?.current || 'Review scout packet is missing or not current.',
      nextAction: byGate.get('Coding-agent review scout')?.nextAction || reviewScout.nextAction || 'Refresh the review scout packet from the current checkout.',
      evidenceRequired: 'A fresh review scout packet whose branch/head matches the current checkout, with explicit no-Cursor or Cursor-sidecar status, a matching local_ci_repo_key, and repo-scoped local-CI proof paths.',
      unblocks: 'Local coding-agent review trust',
      canRunNow: true,
      boundary: 'local-agent-review',
    }))
  }

  if (ledger?.health?.status === 'red') {
    actions.push(operatorAction({
      id: 'ledger-health-repair',
      priority: 7,
      owner: 'Ledger',
      gate: 'Agent ledger health',
      status: 'red',
      proof: '/Users/leokwan/Development/ai/hooks/ledger-fleet-health.sh --repo resplit-currency-api --archive',
      command: 'bash /Users/leokwan/Development/ai-leo/skills/ledger/scripts/audit_ledger_quality.sh',
      blocker: ledger.health.summary || 'Ledger health is red.',
      nextAction: 'Repair stale ledger rows with append-only scoped evidence.',
      evidenceRequired: 'Ledger audit and fleet health return green/yellow with no unrecovered failures.',
      unblocks: 'Agent history trust',
      canRunNow: true,
      boundary: 'ledger',
    }))
  }

  return actions.sort((a, b) => a.priority - b.priority)
}

function operatorAction(row) {
  return {
    id: row.id,
    priority: row.priority,
    owner: row.owner,
    gate: row.gate,
    status: row.status || 'yellow',
    boundary: row.boundary || 'local',
    canRunNow: Boolean(row.canRunNow),
    blockedBy: row.blockedBy || '',
    command: row.command || '',
    proof: row.proof || '',
    blocker: row.blocker || '',
    nextAction: row.nextAction || '',
    evidenceRequired: row.evidenceRequired || '',
    unblocks: row.unblocks || '',
  }
}

function buildOperatorRecoveryFlow(actions = []) {
  const actionable = actions.filter(action => action.status && action.status !== 'green')
  const runnableNow = actionable.filter(action => action.canRunNow)
  const waitingOnDependency = actionable.filter(action => !action.canRunNow)
  const nextLocalAction = runnableNow[0] || null
  const firstBlockedAction = waitingOnDependency[0] || null
  const boundaries = unique(actionable.map(action => action.boundary || 'local')).map(boundary => {
    const rows = actionable.filter(action => (action.boundary || 'local') === boundary)
    return {
      boundary,
      count: rows.length,
      red: rows.filter(action => action.status === 'red').length,
      yellow: rows.filter(action => action.status === 'yellow' || action.status === 'missing').length,
      actions: rows.map(action => action.id),
    }
  })

  return {
    status: worstStatus(actionable.map(action => action.status)),
    summary: actionable.length === 0
      ? 'No recovery actions are currently required.'
      : `${runnableNow.length} runnable action(s) now; ${waitingOnDependency.length} action(s) waiting on local or external dependencies.`,
    nextLocalAction: nextLocalAction ? recoveryFlowAction(nextLocalAction) : null,
    firstBlockedAction: firstBlockedAction ? recoveryFlowAction(firstBlockedAction) : null,
    runnableNow: runnableNow.map(recoveryFlowAction),
    waitingOnDependency: waitingOnDependency.map(recoveryFlowAction),
    boundaries,
  }
}

function recoveryFlowAction(action) {
  return {
    id: action.id,
    priority: action.priority,
    status: action.status,
    owner: action.owner,
    boundary: action.boundary,
    command: action.command,
    proof: action.proof,
    blocker: actionBlockerText(action),
    unblocks: action.unblocks,
  }
}

function buildEvidenceFreshnessLedger({
  repoDir,
  generatedAt = new Date().toISOString(),
  localCi = {},
  telemetry = {},
  preflight = null,
  reviewScout = null,
} = {}) {
  const sourcePacketPath = path.join(repoDir || '', DEFAULT_OUTPUT_DIR, SOURCE_PROMOTION_PACKET_BASENAME)
  const sourcePacket = readJsonIfExists(sourcePacketPath)
  const cloudflareDestinations = telemetry?.cloudflare?.destinations || null
  const grafanaEvidence = telemetry?.grafana?.evidence || null
  const rows = [
    buildEvidenceFreshnessRow({
      id: 'local-trust-preflight',
      surface: 'Local trust preflight',
      artifact: preflight?.path || path.join(repoDir || '', DEFAULT_OUTPUT_DIR, TRUST_PREFLIGHT_BASENAME),
      checkedAt: preflight?.generatedAt || null,
      ageMinutes: preflight?.ageMinutes ?? ageMinutesBetween(preflight?.generatedAt || null, generatedAt),
      trustStatus: preflight?.status || 'missing',
      summary: preflight?.summary || 'No local trust preflight artifact has been generated yet.',
      nextAction: 'npm run trust:preflight',
      missingSummary: 'Local trust preflight proof is missing.',
    }),
    buildEvidenceFreshnessRow({
      id: 'source-promotion-packet',
      surface: 'Source promotion packet',
      artifact: sourcePacketPath,
      secondaryArtifact: path.join(repoDir || '', DEFAULT_OUTPUT_DIR, 'resplit-fx-source-promotion-packet.md'),
      checkedAt: sourcePacket?.generatedAt || sourcePacket?.checkedAt || null,
      ageMinutes: ageMinutesBetween(sourcePacket?.generatedAt || sourcePacket?.checkedAt || null, generatedAt),
      trustStatus: sourcePacket?.status || localCi?.sourcePromotionBundle?.status || 'missing',
      summary: summarizeSourcePromotionPacket(sourcePacket, localCi?.sourcePromotionBundle),
      nextAction: localCi?.sourcePromotionBundle?.commands?.writePacket || 'npm run source:promotion-packet',
      missingSummary: 'Source promotion packet proof is missing.',
    }),
    buildEvidenceFreshnessRow({
      id: 'selected-firstbite-execute-proof',
      surface: 'Selected FirstBite execute proof',
      artifact: localCi?.mcpProof?.latest?.reportPath || null,
      checkedAt: localCi?.mcpProof?.latest?.createdAt || null,
      ageMinutes: localCi?.proofFreshness?.ageMinutes ?? ageMinutesBetween(localCi?.mcpProof?.latest?.createdAt || null, generatedAt),
      trustStatus: isRedProofStatus(localCi?.mcpProof?.latest?.status)
        ? 'red'
        : localCi?.proofFreshness?.status || localCi?.status || 'missing',
      summary: localCi?.proofFreshness?.summary || 'No selected FirstBite execute proof was found.',
      nextAction: localCi?.cleanProofReadiness?.commands?.cleanWorktree || 'mcp__firstbite_local_ci.run_lanes execute',
      freshnessStatus: localCi?.proofFreshness?.status,
      freshForMinutes: 6 * 60,
      missingStatus: 'yellow',
      missingSummary: 'Selected FirstBite execute proof is missing.',
    }),
    buildEvidenceFreshnessRow({
      id: 'loaded-mcp-host-probe',
      surface: 'Loaded MCP host probe',
      artifact: localCi?.loadedMcpProbe?.path || path.join(repoDir || '', DEFAULT_OUTPUT_DIR, LOADED_MCP_PROBE_BASENAME),
      checkedAt: localCi?.loadedMcpProbe?.checkedAt || null,
      ageMinutes: localCi?.loadedMcpProbe?.ageMinutes ?? ageMinutesBetween(localCi?.loadedMcpProbe?.checkedAt || null, generatedAt),
      trustStatus: localCi?.loadedMcpProbe?.status || 'missing',
      summary: localCi?.loadedMcpProbe?.freshnessSummary || localCi?.loadedMcpProbe?.summary || 'No loaded MCP host probe was found.',
      nextAction: LOADED_MCP_REUSE_COMMAND,
      freshnessStatus: localCi?.loadedMcpProbe?.freshnessStatus,
      missingStatus: 'yellow',
      missingSummary: 'Loaded MCP host probe is missing.',
    }),
    buildEvidenceFreshnessRow({
      id: 'firstbite-mcp-refresh-plan',
      surface: 'FirstBite MCP refresh plan',
      artifact: localCi?.mcpRefreshPlan?.reportPath || path.join(os.homedir(), '.agent-ledger', 'firstbite-mcp-refresh-plan', '<run-id>', 'report.json'),
      secondaryArtifact: localCi?.mcpRefreshPlan?.summaryPath || null,
      checkedAt: localCi?.mcpRefreshPlan?.createdAt || null,
      ageMinutes: localCi?.mcpRefreshPlan?.ageMinutes ?? ageMinutesBetween(localCi?.mcpRefreshPlan?.createdAt || null, generatedAt),
      trustStatus: localCi?.mcpRefreshPlan?.status || 'missing',
      summary: localCi?.mcpRefreshPlan?.summary || 'No FirstBite MCP refresh plan packet was found.',
      nextAction: localCi?.mcpRefreshPlan?.continuationCommands?.find(command => /refresh plan/i.test(command.label || ''))?.command || 'bash ~/Development/ai-leo/skills/local-ci/scripts/firstbite-mcp-refresh-plan.sh',
      missingStatus: 'yellow',
      missingSummary: 'FirstBite MCP refresh plan is missing.',
    }),
    buildEvidenceFreshnessRow({
      id: 'repo-backed-mcp-catalog',
      surface: 'Repo-backed MCP catalog',
      artifact: localCi?.repoBackedMcpProbe?.packageDir || DEFAULT_FIRSTBITE_LOCAL_CI_DIR,
      checkedAt: localCi?.repoBackedMcpProbe?.checkedAt || null,
      ageMinutes: localCi?.repoBackedMcpProbe?.ageMinutes ?? ageMinutesBetween(localCi?.repoBackedMcpProbe?.checkedAt || null, generatedAt),
      trustStatus: localCi?.repoBackedMcpProbe?.status || 'missing',
      summary: localCi?.repoBackedMcpProbe?.summary || 'Repo-backed FirstBite MCP catalog probe was not run.',
      nextAction: 'cd ~/Development/ai-leo/skills/resplit-watch/mcp/firstbite-local-ci && npm run --silent call -- list_lanes {}',
      missingStatus: 'red',
      missingSummary: 'Repo-backed MCP catalog proof is missing.',
    }),
    buildEvidenceFreshnessRow({
      id: 'firstbite-runner-control-plane',
      surface: 'FirstBite runner control plane',
      artifact: localCi?.runnerControlPlane?.serverRelativePath || FIRSTBITE_RUNNER_SERVER_RELATIVE_PATH,
      secondaryArtifact: localCi?.runnerControlPlane?.packageDir || DEFAULT_FIRSTBITE_LOCAL_CI_DIR,
      checkedAt: generatedAt,
      ageMinutes: 0,
      trustStatus: localCi?.runnerControlPlane?.status || 'missing',
      summary: localCi?.runnerControlPlane?.summary || 'FirstBite runner control plane was not inspected.',
      nextAction: localCi?.runnerControlPlane?.nextAction || 'Land runner semantics in ai-leo and refresh loaded MCP host.',
      missingStatus: 'red',
      missingSummary: 'FirstBite runner control plane proof is missing.',
    }),
    buildEvidenceFreshnessRow({
      id: 'review-scout-producer-control-plane',
      surface: 'Review-scout producer control plane',
      artifact: localCi?.reviewScoutProducerControlPlane?.scriptRelativePath || FIRSTBITE_REVIEW_SCOUT_SCRIPT_RELATIVE_PATH,
      secondaryArtifact: localCi?.reviewScoutProducerControlPlane?.aiLeoRepoDir || DEFAULT_AI_LEO_REPO_DIR,
      checkedAt: generatedAt,
      ageMinutes: 0,
      trustStatus: localCi?.reviewScoutProducerControlPlane?.status || 'missing',
      summary: localCi?.reviewScoutProducerControlPlane?.summary || 'Review-scout producer control plane was not inspected.',
      nextAction: localCi?.reviewScoutProducerControlPlane?.nextAction || 'Land canonical repo-key support in ai-leo and rerun the review scout.',
      missingStatus: 'red',
      missingSummary: 'Review-scout producer control-plane proof is missing.',
    }),
    buildEvidenceFreshnessRow({
      id: 'cloudflare-otel-destinations',
      surface: 'Cloudflare OTEL destinations',
      artifact: cloudflareDestinations?.latestPath || path.join(repoDir || '', DEFAULT_OUTPUT_DIR, CLOUDFLARE_OTEL_DESTINATIONS_BASENAME),
      checkedAt: cloudflareDestinations?.checkedAt || null,
      ageMinutes: cloudflareDestinations?.ageMinutes ?? ageMinutesBetween(cloudflareDestinations?.checkedAt || null, generatedAt),
      trustStatus: cloudflareDestinations?.status || 'missing',
      summary: cloudflareDestinations?.summary || 'No Cloudflare Workers Observability destination proof artifact was found.',
      nextAction: 'npm run observability:cloudflare-destinations',
      missingStatus: 'yellow',
      missingSummary: 'Cloudflare destination proof is missing.',
    }),
    buildEvidenceFreshnessRow({
      id: 'grafana-otel-smoke',
      surface: 'Grafana OTEL smoke',
      artifact: grafanaEvidence?.latestPath || path.join(repoDir || '', DEFAULT_OUTPUT_DIR, 'grafana-otel-smoke.json'),
      checkedAt: grafanaEvidence?.checkedAt || null,
      ageMinutes: grafanaEvidence?.ageMinutes ?? ageMinutesBetween(grafanaEvidence?.checkedAt || null, generatedAt),
      trustStatus: grafanaEvidence?.status || 'missing',
      summary: grafanaEvidence?.summary || 'No Grafana Tempo/Loki proof artifact was found.',
      nextAction: 'npm run observability:otel-smoke -- --since-minutes 60',
      missingStatus: 'red',
      missingSummary: 'Grafana OTEL smoke proof is missing.',
    }),
    buildEvidenceFreshnessRow({
      id: 'firstbite-operating-readout',
      surface: 'FirstBite operating readout',
      artifact: localCi?.operatingReadout?.reportPath || localCi?.operatingReadout?.reportRoot || DEFAULT_FIRSTBITE_OPERATING_READOUT_DIR,
      secondaryArtifact: localCi?.operatingReadout?.summaryPath || null,
      checkedAt: localCi?.operatingReadout?.createdAt || null,
      ageMinutes: localCi?.operatingReadout?.ageMinutes ?? ageMinutesBetween(localCi?.operatingReadout?.createdAt || null, generatedAt),
      trustStatus: localCi?.operatingReadout?.status || 'missing',
      summary: localCi?.operatingReadout?.summary || 'No FirstBite operating readout report was found.',
      nextAction: 'bash ~/Development/ai-leo/skills/local-ci/scripts/firstbite-operating-readout.sh',
      freshForMinutes: FIRSTBITE_OPERATING_READOUT_FRESHNESS_LIMIT_MINUTES,
      missingStatus: 'red',
      missingSummary: 'FirstBite operating readout proof is missing.',
    }),
    buildEvidenceFreshnessRow({
      id: 'coding-agent-review-scout',
      surface: 'Coding-agent review scout',
      artifact: reviewScout?.reportPath || reviewScout?.reportRoot || DEFAULT_FIRSTBITE_CURSOR_REVIEW_DIR,
      secondaryArtifact: reviewScout?.reviewPath || reviewScout?.reviewPacketPath || null,
      checkedAt: reviewScout?.createdAt || null,
      ageMinutes: reviewScout?.ageMinutes ?? ageMinutesBetween(reviewScout?.createdAt || null, generatedAt),
      trustStatus: reviewScout?.status || 'missing',
      summary: reviewScout?.summary || 'No FirstBite Cursor/Graphite review scout packet was found.',
      nextAction: reviewScout?.command || 'bash ~/Development/ai-leo/skills/resplit-watch/scripts/firstbite-cursor-review.sh --repo <repo> --no-cursor',
      freshForMinutes: FIRSTBITE_CURSOR_REVIEW_FRESHNESS_LIMIT_MINUTES,
      missingStatus: 'yellow',
      missingSummary: 'Coding-agent review scout proof is missing.',
    }),
  ]

  const status = worstStatus(rows.map(row => row.freshnessStatus))
  const fresh = rows.filter(row => row.freshnessStatus === 'green').length
  const staleOrMissing = rows.length - fresh
  return {
    status,
    summary: `${fresh} fresh, ${staleOrMissing} stale/missing across ${rows.length} proof artifact(s); trust colors remain separate.`,
    generatedAt,
    freshnessLimitMinutes: PROOF_FRESHNESS_LIMIT_MINUTES,
    rows,
  }
}

function buildLaunchTrustAudit({ contracts = [], localCi = {}, telemetry = {}, nurseLog = {}, ledger = {}, reviewScout = {} } = {}) {
  const byGate = new Map((contracts || []).map(contract => [contract.gate, contract]))
  const rows = [
    trustAuditRow({
      id: 'overall-launch-trust',
      surface: 'Overall Resplit FX launch trust',
      boundary: 'release',
      owner: 'Release operator',
      status: worstStatus((contracts || []).map(contract => contract.status)),
      allowedWhenGreen: 'Resplit FX reliability cockpit can support a launch-ready claim across source, local CI, loaded agents, peer execution, OTEL/Grafana, release history, and ledger handoff.',
      forbiddenUntilGreen: 'Do not call Resplit FX launch-ready while any trust contract below is red or yellow.',
      evidence: contracts.length > 0 ? `${contracts.length} trust contract(s) in this cockpit` : 'No trust contracts generated.',
      gap: summarizeNonGreenContracts(contracts),
      nextAction: 'Work the Operator Action Queue top-down until every launch-critical row turns green.',
    }),
    trustAuditRow({
      id: 'source-contract',
      surface: 'Tracked source and source promotion',
      boundary: 'local',
      owner: 'Local source',
      status: worstStatus([
        byGate.get('Primary checkout')?.status,
        byGate.get('Tracked local-CI contract')?.status,
        byGate.get('Source promotion bundle')?.status,
      ]),
      allowedWhenGreen: 'Current local-CI contract and cockpit sources are present on tracked source and can be used for clean proof.',
      forbiddenUntilGreen: 'Do not treat dirty/current-only control-plane files as launch source.',
      evidence: joinEvidence([
        byGate.get('Primary checkout')?.proof,
        byGate.get('Tracked local-CI contract')?.proof,
        byGate.get('Source promotion bundle')?.proof,
      ]),
      gap: joinEvidence([
        byGate.get('Primary checkout')?.current,
        byGate.get('Tracked local-CI contract')?.current,
        byGate.get('Source promotion bundle')?.current,
      ]),
      nextAction: byGate.get('Source promotion bundle')?.nextAction || localCi?.sourcePromotionBundle?.nextAction || 'Review and land the source-promotion bundle.',
    }),
    trustAuditRow({
      id: 'clean-firstbite-local-ci',
      surface: 'Clean FirstBite local-CI execution',
      boundary: 'local-ci',
      owner: 'FirstBite local CI',
      status: worstStatus([
        byGate.get('Clean proof targetability')?.status,
        byGate.get('Selected local-CI proof')?.status,
      ]),
      allowedWhenGreen: 'A clean worktree FirstBite execute report proves all resplit_currency_api lanes with commands matching .firstbite/local-ci.json.',
      forbiddenUntilGreen: 'Do not claim local CI validates the current launch source.',
      evidence: byGate.get('Selected local-CI proof')?.proof || localCi?.mcpProof?.latest?.reportPath || 'FirstBite execute report missing.',
      gap: joinEvidence([
        byGate.get('Clean proof targetability')?.current,
        byGate.get('Selected local-CI proof')?.current,
      ]),
      nextAction: byGate.get('Clean proof targetability')?.nextAction || localCi?.cleanProofReadiness?.nextAction || 'Run clean worktree FirstBite proof after source promotion lands.',
    }),
    trustAuditRow({
      id: 'loaded-agent-mcp',
      surface: 'Loaded Codex/Cursor MCP host',
      boundary: 'local-agent-host',
      owner: 'Codex/Cursor MCP host',
      status: worstStatus([
        byGate.get('Loaded MCP host catalog')?.status,
        localCi?.mcpCatalogDelta?.status,
        localCi?.loadedMcpProbe?.freshnessStatus,
      ]),
      allowedWhenGreen: 'The loaded in-app MCP host can be trusted to expose the current repo-backed FirstBite catalog and FX lanes.',
      forbiddenUntilGreen: 'Do not claim Codex/Cursor loaded MCP can execute or even see FX lanes from the current host process.',
      evidence: byGate.get('Loaded MCP host catalog')?.proof || localCi?.loadedMcpProbe?.path || 'reports/firstbite-loaded-mcp-lanes.json',
      gap: joinEvidence([
        localCi?.loadedMcpProbe?.summary,
        localCi?.mcpCatalogDelta?.summary,
      ]),
      nextAction: localCi?.mcpCatalogDelta?.nextAction || byGate.get('Loaded MCP host catalog')?.nextAction || 'Restart/reload the MCP host and capture live list_lanes.',
    }),
    trustAuditRow({
      id: 'repo-backed-mcp-source',
      surface: 'Repo-backed FirstBite MCP package',
      boundary: 'control-plane',
      owner: 'FirstBite MCP package',
      status: byGate.get('Repo-backed MCP package')?.status || localCi?.repoBackedMcpProbe?.status || 'yellow',
      allowedWhenGreen: 'The repo-backed package is the current control-plane source of truth for lane catalog comparison.',
      forbiddenUntilGreen: 'Do not debug loaded-host drift until the package catalog itself is current and readable.',
      evidence: byGate.get('Repo-backed MCP package')?.proof || localCi?.repoBackedMcpProbe?.packageDir || DEFAULT_FIRSTBITE_LOCAL_CI_DIR,
      gap: byGate.get('Repo-backed MCP package')?.current || localCi?.repoBackedMcpProbe?.summary || 'Repo-backed MCP package proof missing.',
      nextAction: byGate.get('Repo-backed MCP package')?.nextAction || 'Run the repo-backed FirstBite list_lanes call.',
    }),
    trustAuditRow({
      id: 'firstbite-runner-durability',
      surface: 'FirstBite runner durability',
      boundary: 'local-agent-control-plane',
      owner: 'ai-leo MCP runner',
      status: byGate.get('FirstBite runner durability')?.status || localCi?.runnerControlPlane?.status || 'yellow',
      allowedWhenGreen: 'Expected/yellow exit handling is landed on ai-leo origin/main and present in the active FirstBite runner package.',
      forbiddenUntilGreen: 'Do not claim local-agent lane colors are durable while runner semantics exist only locally or on an unmerged PR branch.',
      evidence: byGate.get('FirstBite runner durability')?.proof || localCi?.runnerControlPlane?.serverRelativePath || FIRSTBITE_RUNNER_SERVER_RELATIVE_PATH,
      gap: byGate.get('FirstBite runner durability')?.current || localCi?.runnerControlPlane?.summary || 'FirstBite runner durability proof missing.',
      nextAction: byGate.get('FirstBite runner durability')?.nextAction || localCi?.runnerControlPlane?.nextAction || 'Land ai-leo runner support and restart loaded MCP host.',
    }),
    trustAuditRow({
      id: 'review-scout-producer-durability',
      surface: 'Review-scout producer durability',
      boundary: 'local-agent-review',
      owner: 'ai-leo review scout',
      status: byGate.get('Review-scout producer durability')?.status || localCi?.reviewScoutProducerControlPlane?.status || 'yellow',
      allowedWhenGreen: 'firstbite-cursor-review.sh is landed on ai-leo origin/main and emits canonical repo-key plus manifest-lane proof.',
      forbiddenUntilGreen: 'Do not treat a current review-scout packet as durable producer behavior if the script support only exists locally or on a feature branch.',
      evidence: byGate.get('Review-scout producer durability')?.proof || localCi?.reviewScoutProducerControlPlane?.scriptRelativePath || FIRSTBITE_REVIEW_SCOUT_SCRIPT_RELATIVE_PATH,
      gap: byGate.get('Review-scout producer durability')?.current || localCi?.reviewScoutProducerControlPlane?.summary || 'Review-scout producer durability proof missing.',
      nextAction: byGate.get('Review-scout producer durability')?.nextAction || localCi?.reviewScoutProducerControlPlane?.nextAction || 'Land review-scout producer support in ai-leo and rerun the scout.',
    }),
    trustAuditRow({
      id: 'peer-execution',
      surface: 'M4 peer execution',
      boundary: 'peer-execution',
      owner: 'M4 local agent peer',
      status: byGate.get('M4 peer execution boundary')?.status || localCi?.operatingReadout?.peerExecutionBoundary?.status || 'yellow',
      allowedWhenGreen: 'The M4 peer has produced local execute proof from that Mac and can be treated as execution-ready.',
      forbiddenUntilGreen: 'Do not treat LAN pings, dashboard health, or Studio-side handoffs as M4 execute proof.',
      evidence: byGate.get('M4 peer execution boundary')?.proof || localCi?.operatingReadout?.m4FreshClonePacket?.latestCommands || 'M4 execute report missing.',
      gap: byGate.get('M4 peer execution boundary')?.current || localCi?.operatingReadout?.peerExecutionBoundary?.summary || 'M4 peer boundary missing.',
      nextAction: byGate.get('M4 peer execution boundary')?.nextAction || 'Run the generated packet on the M4 Pro and capture local proof.',
    }),
    trustAuditRow({
      id: 'otel-cloudflare-destinations',
      surface: 'Cloudflare Workers Observability destinations',
      boundary: 'cloudflare-control-plane',
      owner: 'Cloudflare',
      status: byGate.get('Cloudflare OTEL destinations')?.status || telemetry?.cloudflare?.destinations?.status || 'yellow',
      allowedWhenGreen: 'Cloudflare dashboard destinations for logs and traces are enabled and match wrangler.jsonc by name and dataset.',
      forbiddenUntilGreen: 'Do not claim wrangler destination names are real Cloudflare dashboard state without read-only Cloudflare API proof.',
      evidence: byGate.get('Cloudflare OTEL destinations')?.proof || telemetry?.cloudflare?.destinations?.latestPath || 'reports/cloudflare-otel-destinations.json',
      gap: byGate.get('Cloudflare OTEL destinations')?.current || telemetry?.cloudflare?.destinations?.summary || 'Cloudflare destination proof missing.',
      nextAction: byGate.get('Cloudflare OTEL destinations')?.nextAction || 'Run the Cloudflare destination verifier with Workers Observability Read credentials.',
    }),
    trustAuditRow({
      id: 'otel-grafana-proof',
      surface: 'OTEL/Grafana observability',
      boundary: 'external-observability',
      owner: 'Cloudflare/Grafana',
      status: byGate.get('OTEL/Grafana evidence')?.status || telemetry?.status || 'yellow',
      allowedWhenGreen: 'Worker trigger, Grafana config, Tempo query, and Loki query all have fresh positive evidence.',
      forbiddenUntilGreen: 'Do not claim telemetry is launch-trusted from config alone or an old nurse-log note.',
      evidence: byGate.get('OTEL/Grafana evidence')?.proof || telemetry?.grafana?.evidence?.latestPath || 'reports/grafana-otel-smoke.json',
      gap: byGate.get('OTEL/Grafana evidence')?.current || telemetry?.summary || 'Grafana proof missing.',
      nextAction: byGate.get('OTEL/Grafana evidence')?.nextAction || 'Run the live Grafana OTEL smoke after destinations and read env exist.',
    }),
    trustAuditRow({
      id: 'release-history-quality',
      surface: 'Release-history data quality',
      boundary: 'data-quality',
      owner: 'FX data',
      status: byGate.get('Release-history strict coverage')?.status || (nurseLog?.releaseReadiness === 'green' ? 'green' : 'yellow'),
      allowedWhenGreen: 'Strict release validation proves the 30-calendar-day FX history window is complete.',
      forbiddenUntilGreen: 'Do not claim release readiness while the May 12-23 history hole or strict validation gap remains.',
      evidence: byGate.get('Release-history strict coverage')?.proof || 'npm run validate:release',
      gap: byGate.get('Release-history strict coverage')?.current || releaseHistorySummary(nurseLog),
      nextAction: byGate.get('Release-history strict coverage')?.nextAction || 'Backfill or age out the history gap, then rerun strict validation.',
    }),
    trustAuditRow({
      id: 'agent-ledger-fleet',
      surface: 'Agent ledger and fleet handoff',
      boundary: 'local-agent-fleet',
      owner: 'Ledger / local agent fleet',
      status: worstStatus([
        byGate.get('FirstBite operating readout')?.status,
        byGate.get('Agent ledger health')?.status,
        byGate.get('Coding-agent review scout')?.status,
        ledger?.health?.status,
      ]),
      allowedWhenGreen: 'Recent ledger and operating-readout evidence can be used as coordination context for the local agent fleet.',
      forbiddenUntilGreen: 'Do not use ledger or fleet rows as proof of execution readiness when they are stale, failed, or support-only.',
      evidence: joinEvidence([
        byGate.get('FirstBite operating readout')?.proof,
        byGate.get('Agent ledger health')?.proof,
        byGate.get('Coding-agent review scout')?.proof,
      ]),
      gap: joinEvidence([
        byGate.get('FirstBite operating readout')?.current,
        byGate.get('Agent ledger health')?.current,
        byGate.get('Coding-agent review scout')?.current,
      ]),
      nextAction: byGate.get('FirstBite operating readout')?.nextAction || byGate.get('Coding-agent review scout')?.nextAction || reviewScout?.nextAction || byGate.get('Agent ledger health')?.nextAction || 'Run fleet health and operating readout before broad launch claims.',
    }),
  ]

  const red = rows.filter(row => row.status === 'red').length
  const yellow = rows.filter(row => row.status === 'yellow' || row.status === 'missing').length
  const green = rows.filter(row => row.status === 'green').length
  return {
    status: worstStatus(rows.map(row => row.status)),
    summary: `${green} allowed, ${yellow} caution, ${red} forbidden claim boundary(s) across ${rows.length} launch-trust surfaces.`,
    rows,
  }
}

function trustAuditRow({
  id,
  surface,
  boundary,
  owner,
  status,
  allowedWhenGreen,
  forbiddenUntilGreen,
  evidence,
  gap,
  nextAction,
} = {}) {
  const normalized = normalizeStatus(status)
  return {
    id,
    surface,
    boundary,
    owner,
    status: normalized,
    claimAllowed: normalized === 'green',
    allowedClaim: normalized === 'green' ? allowedWhenGreen : 'Only a limited diagnostic claim is allowed for this surface.',
    forbiddenClaim: normalized === 'green' ? '' : forbiddenUntilGreen,
    evidence: evidence || 'missing',
    gap: gap || 'No gap detail recorded.',
    nextAction: nextAction || '',
  }
}

function summarizeNonGreenContracts(contracts = []) {
  const nonGreen = contracts.filter(contract => contract.status && contract.status !== 'green')
  if (nonGreen.length === 0) {
    return 'All trust contracts are green.'
  }
  return nonGreen.map(contract => `${contract.gate}: ${contract.status}`).join('; ')
}

function joinEvidence(values = []) {
  return values.filter(value => typeof value === 'string' && value.trim()).join(' | ')
}

function buildEvidenceFreshnessRow({
  id,
  surface,
  artifact,
  secondaryArtifact = null,
  checkedAt,
  ageMinutes,
  trustStatus = 'yellow',
  summary = '',
  nextAction = '',
  freshForMinutes = PROOF_FRESHNESS_LIMIT_MINUTES,
  freshnessStatus,
  missingStatus = 'red',
  missingSummary,
} = {}) {
  const freshness = freshnessStatus
    ? {
      status: normalizeStatus(freshnessStatus),
      summary: summary || `${surface || id} freshness supplied by source artifact.`,
    }
    : classifyEvidenceFreshness({
      checkedAt,
      ageMinutes,
      freshForMinutes,
      missingStatus,
      label: surface || id,
      missingSummary,
    })

  return {
    id,
    surface,
    freshnessStatus: freshness.status,
    freshnessSummary: freshness.summary,
    trustStatus: normalizeStatus(trustStatus),
    checkedAt: checkedAt || null,
    ageMinutes: ageMinutes ?? null,
    freshForMinutes,
    artifact: artifact || '',
    secondaryArtifact,
    summary,
    nextAction,
  }
}

function classifyEvidenceFreshness({
  checkedAt,
  ageMinutes,
  freshForMinutes = PROOF_FRESHNESS_LIMIT_MINUTES,
  missingStatus = 'red',
  label = 'Proof artifact',
  missingSummary,
} = {}) {
  if (!checkedAt) {
    return {
      status: normalizeStatus(missingStatus),
      summary: missingSummary || `${label} has no checkedAt timestamp.`,
    }
  }

  if (ageMinutes === null || ageMinutes === undefined) {
    return {
      status: 'yellow',
      summary: `${label} timestamp is not comparable: ${checkedAt}.`,
    }
  }

  if (ageMinutes > freshForMinutes) {
    return {
      status: 'yellow',
      summary: `${label} is stale: ${ageMinutes}m old; refresh before trusting this proof boundary.`,
    }
  }

  return {
    status: 'green',
    summary: `${label} is fresh: ${ageMinutes}m old.`,
  }
}

function summarizeSourcePromotionPacket(packet, bundle) {
  if (packet?.summary?.headline) {
    return packet.summary.headline
  }
  if (typeof packet?.summary === 'string') {
    return packet.summary
  }
  if (packet?.status) {
    const stageCount = Array.isArray(packet.stageCandidates) ? packet.stageCandidates.length : null
    const holdCount = Array.isArray(packet.holdByDefault) ? packet.holdByDefault.length : null
    return `Source promotion packet is ${packet.status}; stage candidates ${stageCount ?? 'unknown'}, hold-by-default ${holdCount ?? 'unknown'}.`
  }
  return bundle?.summary || 'No source promotion packet artifact was found.'
}

function contractNeedsAction(contract) {
  return Boolean(contract && contract.status && contract.status !== 'green')
}

function worstStatus(statuses) {
  const normalized = statuses.filter(Boolean)
  if (normalized.includes('red')) {
    return 'red'
  }
  if (normalized.includes('yellow') || normalized.includes('missing')) {
    return 'yellow'
  }
  if (normalized.includes('green')) {
    return 'green'
  }
  return 'yellow'
}

function releaseHistoryActionSummary(nurseLog, inbox) {
  const inboxItem = (inbox?.activeItems || []).find(item => /release-history|history hole|backfill|May 12-23|2026-05-12/i.test(item.raw || item.title || ''))
  if (inboxItem?.title) {
    return inboxItem.title
  }
  return releaseHistorySummary(nurseLog)
}

function releaseHistorySummary(nurseLog) {
  if (nurseLog?.releaseHistoryEvidence) {
    return nurseLog.releaseHistoryEvidence
  }
  const bullets = nurseLog?.latestBullets || []
  const specific = bullets.find(line => /validate:release|available\s+\d+\/30|missing.*20\d{2}-\d{2}-\d{2}|release-history risk|history hole|backfill/i.test(line))
  if (specific) {
    return specific
  }
  if (nurseLog?.releaseReadiness === 'green') {
    return 'Strict release validation is green in the latest local readout.'
  }
  return 'Strict release validation is not green; run npm run validate:release for the exact missing-date proof.'
}

function summarizeVerdict(risks) {
  if (risks.some(risk => risk.status === 'red')) {
    return {
      status: 'red',
      label: 'RED - missing required trust contract',
    }
  }
  if (risks.some(risk => risk.status === 'yellow')) {
    return {
      status: 'yellow',
      label: 'YELLOW - control surface exists, proof still split',
    }
  }
  return {
    status: 'green',
    label: 'GREEN - current local trust gates are declared and proven',
  }
}

function renderHtml(report) {
  const sections = [
    renderSummary(report),
    renderTrustPreflight(report.trustModel.preflight),
    renderLaunchTrustAudit(report.trustModel.launchTrustAudit),
    renderEvidenceFreshnessLedger(report.trustModel.evidenceFreshness),
    renderOperatorRecoveryFlow(report.trustModel.operatorRecoveryFlow),
    renderOperatorActionQueue(report.trustModel.operatorActions),
    renderTrustContracts(report.trustModel.contracts),
    renderLaneTable(report.localCi),
    renderLocalCiProof(report.localCi),
    renderGates(report.gates),
    renderTelemetry(report.telemetry),
    renderAgentState(report.agentState),
    renderRisks(report.trustModel.risks),
  ].join('\n')

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(report.title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f7f2;
      --ink: #1e2019;
      --muted: #686b61;
      --line: #d8d6ca;
      --panel: #fffef7;
      --green: #2f7d57;
      --yellow: #a86f16;
      --red: #b33a2c;
      --blue: #2f5f8f;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(1180px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 24px 0 40px;
    }
    header {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 16px;
      align-items: end;
      padding-bottom: 18px;
      border-bottom: 1px solid var(--line);
    }
    h1, h2 {
      margin: 0;
      letter-spacing: 0;
    }
    h1 { font-size: 28px; line-height: 1.1; }
    h2 { font-size: 16px; margin-bottom: 10px; }
    h3 { font-size: 13px; margin: 14px 0 6px; color: var(--muted); text-transform: uppercase; }
    .meta { color: var(--muted); font-size: 13px; }
    .status {
      display: inline-flex;
      align-items: center;
      min-height: 28px;
      padding: 4px 10px;
      border-radius: 8px;
      border: 1px solid currentColor;
      font-weight: 700;
      white-space: normal;
      overflow-wrap: anywhere;
    }
    .green { color: var(--green); }
    .yellow { color: var(--yellow); }
    .red { color: var(--red); }
    .blue { color: var(--blue); }
    .grid {
      display: grid;
      grid-template-columns: repeat(12, 1fr);
      gap: 14px;
      margin-top: 18px;
    }
    section {
      grid-column: span 12;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
      min-width: 0;
    }
    .half { grid-column: span 6; }
    .third { grid-column: span 4; }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    th, td {
      padding: 9px 8px;
      border-top: 1px solid var(--line);
      vertical-align: top;
      text-align: left;
      overflow-wrap: anywhere;
    }
    th {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      background: #ece9db;
      border-radius: 5px;
      padding: 2px 4px;
      white-space: normal;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    ul {
      margin: 0;
      padding-left: 18px;
    }
    li + li { margin-top: 6px; }
    .kv {
      display: grid;
      grid-template-columns: 160px 1fr;
      gap: 8px 12px;
    }
    .kv div:nth-child(odd) {
      color: var(--muted);
    }
    @media (max-width: 760px) {
      header { grid-template-columns: 1fr; }
      .half, .third { grid-column: span 12; }
      h1 { font-size: 24px; }
      .kv { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    ${sections}
  </main>
</body>
</html>
`
}

function renderLaunchTrustAudit(audit) {
  if (!audit) {
    return ''
  }

  const rows = audit.rows || []
  return `<section>
    <h2>Launch Trust Audit</h2>
    <div class="kv">
      <div>Status</div><div><span class="${escapeHtml(audit.status || 'yellow')}">${escapeHtml(audit.status || 'unknown')}</span> ${escapeHtml(audit.summary || '')}</div>
      <div>Rule</div><div>Each row states the strongest allowed claim for this surface; red/yellow rows name the overclaim that remains forbidden.</div>
    </div>
    <table>
      <thead><tr><th>Surface</th><th>Status</th><th>Boundary</th><th>Claim allowed?</th><th>Allowed claim</th><th>Forbidden until green</th><th>Evidence</th><th>Gap / next action</th></tr></thead>
      <tbody>
        ${rows.length === 0 ? '<tr><td colspan="8">No launch trust audit rows were generated.</td></tr>' : rows.map(row => `<tr><td><code>${escapeHtml(row.id || '')}</code><div class="meta">${escapeHtml(row.surface || '')} · ${escapeHtml(row.owner || '')}</div></td><td><span class="${escapeHtml(row.status || 'yellow')}">${escapeHtml(row.status || 'unknown')}</span></td><td><code>${escapeHtml(row.boundary || '')}</code></td><td>${row.claimAllowed ? '<span class="green">yes</span>' : '<span class="red">no</span>'}</td><td>${escapeHtml(row.allowedClaim || '')}</td><td>${escapeHtml(row.forbiddenClaim || 'none')}</td><td><code>${escapeHtml(row.evidence || '')}</code></td><td>${escapeHtml(row.gap || '')}<div class="meta">${escapeHtml(row.nextAction || '')}</div></td></tr>`).join('\n')}
      </tbody>
    </table>
  </section>`
}

function renderTrustPreflight(preflight) {
  if (!preflight) {
    return ''
  }

  const checked = preflight.generatedAt
    ? `${preflight.generatedAt}${preflight.ageMinutes === null ? '' : ` (${preflight.ageMinutes}m old)`}`
    : 'missing'
  const commands = preflight.commands || []
  return `<section>
    <h2>Local Trust Preflight</h2>
    <div class="kv">
      <div>Status</div><div><span class="${escapeHtml(preflight.status)}">${escapeHtml(preflight.status)}</span> ${escapeHtml(preflight.summary || '')}</div>
      <div>Generated</div><div>${escapeHtml(checked)}</div>
      <div>Mode</div><div>${escapeHtml(preflight.mode || 'unknown')}</div>
      <div>JSON</div><div><code>${escapeHtml(preflight.path || '')}</code></div>
      <div>Markdown</div><div><code>${escapeHtml(preflight.markdownPath || 'not written')}</code></div>
      <div>Cockpit verdict at run</div><div>${preflight.cockpitVerdict ? `<span class="${escapeHtml(preflight.cockpitVerdict.status || 'yellow')}">${escapeHtml(preflight.cockpitVerdict.label || preflight.cockpitVerdict.status || 'unknown')}</span>` : 'unknown'}</div>
    </div>
    <table>
      <thead><tr><th>Check</th><th>Status</th><th>Exit</th><th>Expected</th><th>Yellow</th><th>Duration</th><th>Command</th></tr></thead>
      <tbody>
        ${commands.length === 0 ? '<tr><td colspan="7">Run <code>npm run trust:preflight</code> to create this artifact.</td></tr>' : commands.map(command => `<tr><td>${escapeHtml(command.label || command.id)}</td><td><span class="${escapeHtml(command.status || 'yellow')}">${escapeHtml(command.status || 'unknown')}</span></td><td>${escapeHtml(String(command.rc ?? 'n/a'))}</td><td>${escapeHtml((command.expectedExitCodes || []).join(', ') || 'n/a')}</td><td>${escapeHtml((command.yellowExitCodes || []).join(', ') || 'none')}</td><td>${escapeHtml(String(command.durationMs ?? 'n/a'))}ms</td><td><code>${escapeHtml(command.command || '')}</code></td></tr>`).join('\n')}
      </tbody>
    </table>
  </section>`
}

function renderEvidenceFreshnessLedger(freshness) {
  if (!freshness) {
    return ''
  }

  const rows = freshness.rows || []
  return `<section>
    <h2>Evidence Freshness Ledger</h2>
    <div class="kv">
      <div>Status</div><div><span class="${escapeHtml(freshness.status || 'yellow')}">${escapeHtml(freshness.status || 'unknown')}</span> ${escapeHtml(freshness.summary || '')}</div>
      <div>Fresh window</div><div>${escapeHtml(String(freshness.freshnessLimitMinutes ?? 'unknown'))}m default; row-specific windows may differ.</div>
    </div>
    <table>
      <thead><tr><th>Proof</th><th>Freshness</th><th>Trust</th><th>Age</th><th>Artifact</th><th>Summary</th><th>Next action</th></tr></thead>
      <tbody>
        ${rows.length === 0 ? '<tr><td colspan="7">No proof freshness rows were generated.</td></tr>' : rows.map(row => `<tr><td><code>${escapeHtml(row.id || '')}</code><div class="meta">${escapeHtml(row.surface || '')}</div></td><td><span class="${escapeHtml(row.freshnessStatus || 'yellow')}">${escapeHtml(row.freshnessStatus || 'unknown')}</span><div class="meta">${escapeHtml(row.freshnessSummary || '')}</div></td><td><span class="${escapeHtml(row.trustStatus || 'yellow')}">${escapeHtml(row.trustStatus || 'unknown')}</span></td><td>${escapeHtml(row.checkedAt || 'missing')}<div class="meta">${row.ageMinutes === null || row.ageMinutes === undefined ? 'unknown age' : `${escapeHtml(String(row.ageMinutes))}m old`} · window ${escapeHtml(String(row.freshForMinutes ?? 'unknown'))}m</div></td><td><code>${escapeHtml(row.artifact || '')}</code>${row.secondaryArtifact ? `<div class="meta"><code>${escapeHtml(row.secondaryArtifact)}</code></div>` : ''}</td><td>${escapeHtml(row.summary || '')}</td><td>${escapeHtml(row.nextAction || '')}</td></tr>`).join('\n')}
      </tbody>
    </table>
  </section>`
}

function renderOperatorRecoveryFlow(flow) {
  if (!flow) {
    return ''
  }

  const runnable = flow.runnableNow || []
  const waiting = flow.waitingOnDependency || []
  const rows = [
    ...runnable.map(action => ({ ...action, phase: 'run now' })),
    ...waiting.map(action => ({ ...action, phase: 'after dependency' })),
  ]
  const nextLocalAction = flow.nextLocalAction
    ? `<code>${escapeHtml(flow.nextLocalAction.id)}</code> · <code>${escapeHtml(flow.nextLocalAction.command || '')}</code>`
    : 'none'
  const firstDependency = flow.firstBlockedAction
    ? `<code>${escapeHtml(flow.firstBlockedAction.id)}</code> · ${escapeHtml(flow.firstBlockedAction.blocker || '')}`
    : 'none'

  return `<section>
    <h2>Operator Recovery Flow</h2>
    <div class="kv">
      <div>Status</div><div><span class="${escapeHtml(flow.status || 'yellow')}">${escapeHtml(flow.status || 'unknown')}</span> ${escapeHtml(flow.summary || '')}</div>
      <div>Next local action</div><div>${nextLocalAction}</div>
      <div>First dependency</div><div>${firstDependency}</div>
    </div>
    <table>
      <thead><tr><th>Phase</th><th>Priority</th><th>Action</th><th>Status</th><th>Boundary</th><th>Owner</th><th>Unblocks</th><th>Proof</th></tr></thead>
      <tbody>
        ${rows.length === 0 ? '<tr><td colspan="8">No recovery actions are currently required.</td></tr>' : rows.map(action => `<tr><td>${escapeHtml(action.phase)}</td><td>${escapeHtml(String(action.priority || ''))}</td><td><code>${escapeHtml(action.id || '')}</code></td><td><span class="${escapeHtml(action.status || 'yellow')}">${escapeHtml(action.status || 'unknown')}</span></td><td><code>${escapeHtml(action.boundary || '')}</code></td><td>${escapeHtml(action.owner || '')}</td><td>${escapeHtml(action.unblocks || '')}</td><td><code>${escapeHtml(action.proof || '')}</code></td></tr>`).join('\n')}
      </tbody>
    </table>
    <table>
      <thead><tr><th>Boundary</th><th>Actions</th><th>Red</th><th>Yellow</th><th>Action ids</th></tr></thead>
      <tbody>
        ${(flow.boundaries || []).length === 0 ? '<tr><td colspan="5">No active boundaries.</td></tr>' : flow.boundaries.map(boundary => `<tr><td><code>${escapeHtml(boundary.boundary || '')}</code></td><td>${escapeHtml(String(boundary.count ?? 0))}</td><td>${escapeHtml(String(boundary.red ?? 0))}</td><td>${escapeHtml(String(boundary.yellow ?? 0))}</td><td>${(boundary.actions || []).map(id => `<code>${escapeHtml(id)}</code>`).join(' ')}</td></tr>`).join('\n')}
      </tbody>
    </table>
  </section>`
}

function renderOperatorActionQueue(actions = []) {
  return `<section>
    <h2>Operator Action Queue</h2>
    <table>
      <thead><tr><th>Priority</th><th>Action</th><th>Status</th><th>Owner</th><th>Gate</th><th>Boundary</th><th>Can run now</th><th>Command</th><th>Proof required</th><th>Blocker / dependency</th></tr></thead>
      <tbody>
        ${actions.length === 0 ? '<tr><td colspan="10">No operator actions were generated.</td></tr>' : actions.map(action => `<tr><td>${escapeHtml(String(action.priority || ''))}</td><td><code>${escapeHtml(action.id || '')}</code></td><td><span class="${escapeHtml(action.status || 'yellow')}">${escapeHtml(action.status || 'unknown')}</span></td><td>${escapeHtml(action.owner || '')}</td><td>${escapeHtml(action.gate || '')}<div class="meta">${escapeHtml(action.nextAction || '')}</div></td><td><code>${escapeHtml(action.boundary || '')}</code></td><td>${action.canRunNow ? '<span class="green">yes</span>' : '<span class="yellow">after dependency</span>'}</td><td><code>${escapeHtml(action.command || '')}</code></td><td>${escapeHtml(action.evidenceRequired || action.proof || '')}<div class="meta"><code>${escapeHtml(action.proof || '')}</code></div></td><td>${escapeHtml(actionBlockerText(action))}</td></tr>`).join('\n')}
      </tbody>
    </table>
  </section>`
}

function actionBlockerText(action) {
  return action.blockedBy || action.blocker || 'none'
}

function renderTrustContracts(contracts = []) {
  return `<section>
    <h2>Trust Contracts</h2>
    <table>
      <thead><tr><th>Gate</th><th>Status</th><th>Current truth</th><th>Proof artifact</th><th>Next action</th></tr></thead>
      <tbody>
        ${contracts.length === 0 ? '<tr><td colspan="5">No trust contracts were generated.</td></tr>' : contracts.map(contract => `<tr><td>${escapeHtml(contract.gate || 'unknown')}</td><td><span class="${escapeHtml(contract.status || 'yellow')}">${escapeHtml(contract.status || 'unknown')}</span></td><td>${escapeHtml(contract.current || '')}</td><td><code>${escapeHtml(contract.proof || '')}</code></td><td>${escapeHtml(contract.nextAction || '')}</td></tr>`).join('\n')}
      </tbody>
    </table>
  </section>`
}

function renderSummary(report) {
  return `<header>
  <div>
    <h1>${escapeHtml(report.title)}</h1>
    <div class="meta">${escapeHtml(report.repo.path)} · generated ${escapeHtml(report.generatedAt)}</div>
  </div>
  <div class="status ${escapeHtml(report.verdict.status)}">${escapeHtml(report.verdict.label)}</div>
</header>
<div class="grid">
  <section class="third">
    <h2>Repo State</h2>
    <div class="kv">
      <div>Branch</div><div><code>${escapeHtml(report.repo.git.branch || 'unknown')}</code></div>
      <div>HEAD</div><div><code>${escapeHtml(report.repo.git.head || 'unknown')}</code></div>
      <div>origin/main</div><div><code>${escapeHtml(report.repo.git.originMain || 'unknown')}</code></div>
      <div>Dirty paths</div><div>${escapeHtml(String(report.repo.git.dirtyCount ?? 'unknown'))}</div>
      <div>Behind</div><div>${escapeHtml(String(report.repo.git.behindOriginMain ?? 'unknown'))}</div>
    </div>
  </section>
  <section class="third">
    <h2>FirstBite Local CI</h2>
    <div class="status ${escapeHtml(report.localCi.status)}">${escapeHtml(report.localCi.summary)}</div>
  </section>
  <section class="third">
    <h2>Telemetry</h2>
    <div class="status ${escapeHtml(report.telemetry.status)}">${escapeHtml(report.telemetry.summary)}</div>
  </section>`
}

function renderLaneTable(localCi) {
  return `<section>
    <h2>Repo-Owned Local CI Lanes</h2>
    <table>
      <thead><tr><th>Lane</th><th>Kind</th><th>Command</th><th>Expected</th><th>Yellow</th><th>Timeout</th></tr></thead>
      <tbody>
        ${localCi.lanes.map(lane => `<tr><td><code>${escapeHtml(lane.id)}</code></td><td>${escapeHtml(lane.kind || '')}</td><td><code>${escapeHtml(lane.command || '')}</code>${lane.note ? `<div class="meta">${escapeHtml(lane.note)}</div>` : ''}</td><td>${escapeHtml((lane.expectedExitCodes || []).join(', ') || '0')}</td><td>${escapeHtml((lane.yellowExitCodes || []).join(', ') || 'none')}</td><td>${escapeHtml(String(lane.timeoutMs || ''))}</td></tr>`).join('\n')}
      </tbody>
    </table>
  </section>`
}

function renderLocalCiProof(localCi) {
  const proof = localCi.mcpProof?.latest
  const partial = localCi.mcpProof?.latestPartial
  if (!proof) {
    return `<section>
      <h2>Latest MCP Proof</h2>
      <p class="meta">No execute proof found under <code>${escapeHtml(localCi.mcpProof?.reportRoot || 'unknown')}</code>.</p>
      ${renderCleanProofReadiness(localCi.cleanProofReadiness)}
      ${renderSourcePromotionBundle(localCi.sourcePromotionBundle)}
      ${renderSourcePromotionPacket(localCi.sourcePromotionPacket)}
      ${renderFirstBiteOperatingReadout(localCi.operatingReadout)}
      ${renderFirstBiteRunnerControlPlane(localCi.runnerControlPlane)}
      ${renderReviewScoutProducerControlPlane(localCi.reviewScoutProducerControlPlane)}
      ${renderRepoBackedMcpProbe(localCi.repoBackedMcpProbe)}
      ${renderMcpCatalogDelta(localCi.mcpCatalogDelta)}
      ${renderFirstBiteMcpRefreshPlan(localCi.mcpRefreshPlan)}
      ${renderLoadedMcpProbe(localCi.loadedMcpProbe)}
      ${renderTrackedSourceContract(localCi.trackedSource)}
    </section>`
  }

  return `<section>
    <h2>Latest MCP Proof</h2>
    <div class="kv">
      <div>Run</div><div><code>${escapeHtml(proof.runId)}</code></div>
      <div>Mode</div><div>${escapeHtml(proof.mode || 'unknown')}</div>
      <div>Created</div><div>${escapeHtml(proof.createdAt || 'unknown')}</div>
      <div>Freshness</div><div><span class="${escapeHtml(localCi.proofFreshness?.status || 'yellow')}">${escapeHtml(localCi.proofFreshness?.summary || 'unknown')}</span></div>
      <div>Manifest command match</div><div><span class="${escapeHtml(localCi.proofManifestMatch?.status || 'yellow')}">${escapeHtml(localCi.proofManifestMatch?.summary || 'unknown')}</span></div>
      <div>Status</div><div><span class="${proof.status === 'pass' ? 'green' : proof.status === 'fail' ? 'red' : 'yellow'}">${escapeHtml(proof.status)}</span></div>
      <div>Host</div><div>${escapeHtml(proof.host || 'unknown')}</div>
      <div>Requested source ref</div><div><code>${escapeHtml(proof.requestedSourceRef || 'not recorded')}</code></div>
      <div>Resolved source ref</div><div><code>${escapeHtml(proof.resolvedSourceRef || 'not recorded')}</code></div>
      <div>Execution sync</div><div>${escapeHtml(proof.executionSourceState?.syncStatus || proof.sourceState?.syncStatus || 'missing source_state')}</div>
      <div>Execution dirty / ahead / behind</div><div>${escapeHtml(String((proof.executionSourceState || proof.sourceState)?.dirtyCount ?? 'unknown'))} / ${escapeHtml(String((proof.executionSourceState || proof.sourceState)?.aheadOriginMain ?? 'unknown'))} / ${escapeHtml(String((proof.executionSourceState || proof.sourceState)?.behindOriginMain ?? 'unknown'))}</div>
      <div>Execution upstream</div><div><code>${escapeHtml((proof.executionSourceState || proof.sourceState)?.upstream || 'unknown')}</code> <code>${escapeHtml((proof.executionSourceState || proof.sourceState)?.upstreamHead || 'unknown')}</code></div>
      <div>Primary checkout during proof</div><div>${proof.primarySourceState ? `${escapeHtml(proof.primarySourceState.syncStatus || 'unknown')} · dirty ${escapeHtml(String(proof.primarySourceState.dirtyCount ?? 'unknown'))} / ahead ${escapeHtml(String(proof.primarySourceState.aheadOriginMain ?? 'unknown'))} / behind ${escapeHtml(String(proof.primarySourceState.behindOriginMain ?? 'unknown'))}` : 'not recorded by this MCP report'}</div>
      <div>Coverage</div><div>${proof.coverage?.complete ? 'complete' : `partial; missing ${escapeHtml((proof.coverage?.missingLaneIds || []).join(', ') || 'unknown')}`}</div>
      <div>Newer partial</div><div>${partial && partial.runId !== proof.runId ? `<code>${escapeHtml(partial.runId)}</code> (${escapeHtml(partial.coverage?.missingLaneIds?.join(', ') || 'unknown missing lanes')})` : 'none'}</div>
      <div>Report</div><div><code>${escapeHtml(proof.reportPath)}</code></div>
    </div>
    ${renderCleanProofReadiness(localCi.cleanProofReadiness)}
    ${renderSourcePromotionBundle(localCi.sourcePromotionBundle)}
    ${renderSourcePromotionPacket(localCi.sourcePromotionPacket)}
    ${renderFirstBiteOperatingReadout(localCi.operatingReadout)}
    ${renderFirstBiteRunnerControlPlane(localCi.runnerControlPlane)}
    ${renderReviewScoutProducerControlPlane(localCi.reviewScoutProducerControlPlane)}
    ${renderCurrentManifestProof(localCi.currentManifestProof)}
    ${renderRepoBackedMcpProbe(localCi.repoBackedMcpProbe)}
    ${renderMcpCatalogDelta(localCi.mcpCatalogDelta)}
    ${renderFirstBiteMcpRefreshPlan(localCi.mcpRefreshPlan)}
    ${renderLoadedMcpProbe(localCi.loadedMcpProbe)}
    ${renderTrackedSourceContract(localCi.trackedSource)}
    <table>
      <thead><tr><th>Lane</th><th>Kind</th><th>Status</th><th>Proof Command</th><th>Execution Source</th><th>Worktree</th><th>Diagnostics</th><th>Log</th></tr></thead>
      <tbody>
        ${proof.lanes.map(lane => `<tr><td><code>${escapeHtml(lane.lane)}</code></td><td>${escapeHtml(lane.kind || '')}</td><td><span class="${lane.status === 'pass' ? 'green' : lane.status === 'fail' ? 'red' : 'yellow'}">${escapeHtml(lane.status || 'unknown')}</span></td><td><code>${escapeHtml(lane.command || 'unknown')}</code></td><td><code>${escapeHtml(lane.sourceHead || 'unknown')}</code><div class="meta">${escapeHtml(lane.executionSourceState?.syncStatus || 'unknown')} · dirty ${escapeHtml(String(lane.executionSourceState?.dirtyCount ?? 'unknown'))} / ahead ${escapeHtml(String(lane.executionSourceState?.aheadOriginMain ?? 'unknown'))} / behind ${escapeHtml(String(lane.executionSourceState?.behindOriginMain ?? 'unknown'))}</div><div class="meta">source_ref ${escapeHtml(lane.requestedSourceRef || 'not recorded')} -&gt; ${escapeHtml(lane.resolvedSourceRef || 'not recorded')}</div></td><td>${lane.worktree === null ? 'unknown' : escapeHtml(String(lane.worktree))}</td><td><span class="${escapeHtml(lane.diagnostics?.status || 'unknown')}">${escapeHtml(lane.diagnostics?.summary || 'unknown')}</span></td><td><code>${escapeHtml(lane.logPath || 'missing')}</code></td></tr>`).join('\n')}
      </tbody>
    </table>
    ${renderMcpProofHistory(localCi.mcpProof?.history || [])}
  </section>`
}

function renderCurrentManifestProof(proof) {
  if (!proof || proof.selected) {
    return ''
  }

  const statusClass = proof.status === 'green' ? 'green' : proof.status === 'red' ? 'red' : 'yellow'
  return `<h2>Current Manifest Proof</h2>
    <div class="kv">
      <div>Status</div><div><span class="${statusClass}">${escapeHtml(proof.status || 'unknown')}</span> supporting evidence; selected clean proof remains <code>${escapeHtml(proof.selectedRunId || 'unknown')}</code></div>
      <div>Run</div><div><code>${escapeHtml(proof.runId || 'unknown')}</code></div>
      <div>Created</div><div>${escapeHtml(proof.createdAt || 'unknown')}</div>
      <div>Source</div><div>${escapeHtml(proof.sourceSummary || 'missing source_state')}</div>
      <div>Freshness</div><div><span class="${escapeHtml(proof.freshness?.status || 'yellow')}">${escapeHtml(proof.freshness?.summary || 'unknown')}</span></div>
      <div>Manifest command match</div><div><span class="${escapeHtml(proof.manifestMatch?.status || 'yellow')}">${escapeHtml(proof.manifestMatch?.summary || 'unknown')}</span></div>
      <div>Diagnostics</div><div><span class="${escapeHtml(proof.diagnosticStatus || 'yellow')}">${escapeHtml(proof.diagnosticSummary || 'No lane diagnostic warnings.')}</span></div>
      <div>Report</div><div><code>${escapeHtml(proof.reportPath || 'missing')}</code></div>
    </div>`
}

function renderCleanProofReadiness(readiness) {
  if (!readiness) {
    return ''
  }

  const statusClass = readiness.status === 'green' ? 'green' : readiness.status === 'red' ? 'red' : 'yellow'
  const reasons = readiness.reasons || []
  return `<h2>Clean Proof Readiness</h2>
    <div class="kv">
      <div>Status</div><div><span class="${statusClass}">${escapeHtml(readiness.status || 'unknown')}</span> ${escapeHtml(readiness.summary || '')}</div>
      <div>Runner contract</div><div>${escapeHtml(readiness.runnerContract || '')}</div>
      <div>Selected proof</div><div>${readiness.selectedProof ? `<code>${escapeHtml(readiness.selectedProof.runId || 'unknown')}</code> ${escapeHtml(readiness.selectedProof.status || 'unknown')} · ${escapeHtml(readiness.selectedProof.source || 'unknown source')} · <code>${escapeHtml(readiness.selectedProof.sourceRef || 'source_ref not recorded')}</code>` : 'missing'}</div>
      <div>Current-manifest proof</div><div>${readiness.currentManifestProof ? `<code>${escapeHtml(readiness.currentManifestProof.runId || 'unknown')}</code> ${escapeHtml(readiness.currentManifestProof.status || 'unknown')} · ${escapeHtml(readiness.currentManifestProof.source || 'unknown source')}` : 'none'}</div>
      <div>Next action</div><div>${escapeHtml(readiness.nextAction || '')}</div>
      <div>Clean command</div><div><code>${escapeHtml(readiness.commands?.cleanWorktree || '')}</code></div>
      <div>Dirty-support command</div><div><code>${escapeHtml(readiness.commands?.dirtySupporting || '')}</code></div>
    </div>
    <table>
      <thead><tr><th>Area</th><th>Status</th><th>Reason</th></tr></thead>
      <tbody>
        ${reasons.length === 0 ? '<tr><td colspan="3">No clean-proof readiness blockers found.</td></tr>' : reasons.map(reason => `<tr><td>${escapeHtml(reason.area || 'unknown')}</td><td><span class="${escapeHtml(reason.status || 'yellow')}">${escapeHtml(reason.status || 'unknown')}</span></td><td>${escapeHtml(reason.detail || '')}</td></tr>`).join('\n')}
      </tbody>
    </table>`
}

function renderSourcePromotionBundle(bundle) {
  if (!bundle) {
    return ''
  }

  const statusClass = bundle.status === 'green' ? 'green' : bundle.status === 'red' ? 'red' : 'yellow'
  const files = bundle.files || []
  const commandDrift = bundle.commandDrift || []
  const recommendedPaths = (bundle.recommendedPaths || []).length > 0
    ? bundle.recommendedPaths.map(relPath => `<code>${escapeHtml(relPath)}</code>`).join(' ')
    : 'none'

  return `<h2>Source Promotion Bundle</h2>
    <div class="kv">
      <div>Status</div><div><span class="${statusClass}">${escapeHtml(bundle.status || 'unknown')}</span> ${escapeHtml(bundle.summary || '')}</div>
      <div>Recommended paths</div><div>${recommendedPaths}</div>
      <div>Next action</div><div>${escapeHtml(bundle.nextAction || '')}</div>
      <div>Inspect status</div><div><code>${escapeHtml(bundle.commands?.inspectStatus || '')}</code></div>
      <div>Inspect diff</div><div><code>${escapeHtml(bundle.commands?.inspectDiff || '')}</code></div>
      <div>Inspect untracked</div><div><code>${escapeHtml(bundle.commands?.inspectUntracked || '')}</code></div>
      <div>Write packet</div><div><code>${escapeHtml(bundle.commands?.writePacket || '')}</code></div>
      <div>Review packet</div><div><code>${escapeHtml(bundle.commands?.reviewPacket || '')}</code></div>
      <div>Clean proof after promotion</div><div><code>${escapeHtml(bundle.commands?.cleanProofAfterPromotion || '')}</code></div>
    </div>
    <table>
      <thead><tr><th>Path</th><th>Role</th><th>Current</th><th>HEAD</th><th>origin/main</th><th>Git status</th><th>Action</th></tr></thead>
      <tbody>
        ${files.map(row => `<tr><td><code>${escapeHtml(row.path)}</code></td><td>${escapeHtml(row.role || 'source input')}</td><td><span class="${row.currentExists ? 'green' : 'red'}">${row.currentExists ? 'present' : 'missing'}</span></td><td><span class="${row.headExists ? 'green' : 'red'}">${row.headExists ? 'tracked' : 'missing'}</span></td><td><span class="${row.originExists ? 'green' : 'red'}">${row.originExists ? 'tracked' : 'missing'}</span></td><td><code>${escapeHtml(row.gitStatus || 'clean')}</code></td><td>${escapeHtml(row.action || '')}</td></tr>`).join('\n')}
      </tbody>
    </table>
    <table>
      <thead><tr><th>Command</th><th>Kind</th><th>Status</th><th>Current</th><th>HEAD</th><th>origin/main</th></tr></thead>
      <tbody>
        ${commandDrift.length === 0 ? '<tr><td colspan="6">No command drift rows.</td></tr>' : commandDrift.map(row => `<tr><td><code>${escapeHtml(row.name || 'unknown')}</code></td><td>${escapeHtml(row.kind || '')}</td><td><span class="${escapeHtml(row.status || 'yellow')}">${escapeHtml(row.status || 'unknown')}</span></td><td><code>${escapeHtml(row.current || 'missing')}</code></td><td><code>${escapeHtml(row.head || 'missing')}</code></td><td><code>${escapeHtml(row.origin || 'missing')}</code></td></tr>`).join('\n')}
      </tbody>
    </table>`
}

function renderSourcePromotionPacket(packet) {
  if (!packet) {
    return ''
  }

  const statusClass = ['green', 'yellow', 'red'].includes(packet.status) ? packet.status : 'yellow'
  const generated = packet.generatedAt
    ? `${packet.generatedAt}${packet.ageMinutes === null ? '' : ` (${packet.ageMinutes}m old)`}`
    : 'missing'
  const review = packet.promotionReview || {}
  const rows = review.rows || []
  const stagingGate = packet.stagingGate || null
  const stagedBundle = packet.stagedBundle || null
  const gateStatusClass = ['green', 'yellow', 'red'].includes(stagingGate?.status) ? stagingGate.status : 'yellow'
  const stagedStatusClass = ['green', 'yellow', 'red'].includes(stagedBundle?.status) ? stagedBundle.status : 'yellow'
  const blockedRows = stagingGate?.blockedRows || []

  return `<h2>Source Promotion Packet Reconciliation</h2>
    <div class="kv">
      <div>Status</div><div><span class="${statusClass}">${escapeHtml(packet.status || 'unknown')}</span> ${escapeHtml(packet.summary || '')}</div>
      <div>Generated</div><div>${escapeHtml(generated)}</div>
      <div>JSON</div><div><code>${escapeHtml(packet.artifactPath || '')}</code></div>
      <div>Markdown</div><div><code>${escapeHtml(packet.markdownPath || '')}</code></div>
      <div>Write packet</div><div><code>${escapeHtml(packet.commands?.writePacket || 'npm run source:promotion-packet')}</code></div>
      <div>Inspect origin diff</div><div><code>${escapeHtml(packet.commands?.inspectOriginDiff || '')}</code></div>
      <div>Full stage gate</div><div>${stagingGate ? `<span class="${gateStatusClass}">${escapeHtml(stagingGate.status || 'unknown')}</span> ${escapeHtml(stagingGate.summary || '')}` : 'missing'}</div>
      <div>Full stage command</div><div><code>${escapeHtml(stagingGate?.fullStageCommand || packet.commands?.stageExactBundle || '')}</code></div>
      <div>Stage non-red candidates</div><div><code>${escapeHtml(stagingGate?.nonRedStageCommand || packet.commands?.stageNonRedCandidates || '')}</code></div>
      <div>Staged bundle attestation</div><div>${stagedBundle ? `<span class="${stagedStatusClass}">${escapeHtml(stagedBundle.status || 'unknown')}</span> ${escapeHtml(stagedBundle.summary || '')}` : 'missing'}</div>
      <div>Verify staged exact bundle</div><div><code>${escapeHtml(packet.commands?.verifyStagedExactBundle || '')}</code></div>
    </div>
    ${stagingGate ? `<table>
      <thead><tr><th>Blocked path</th><th>Classification</th><th>Δ origin</th><th>Review command</th><th>Action</th></tr></thead>
      <tbody>
        ${blockedRows.length === 0 ? '<tr><td colspan="5">No red rows block full-bundle staging.</td></tr>' : blockedRows.map(row => `<tr><td><code>${escapeHtml(row.path || '')}</code></td><td><code>${escapeHtml(row.classification || '')}</code></td><td>${escapeHtml(formatDelta(row.lineDeltaVsOrigin))}</td><td><code>${escapeHtml(row.reviewCommand || '')}</code></td><td>${escapeHtml(row.action || '')}</td></tr>`).join('\n')}
      </tbody>
    </table>` : ''}
    ${stagedBundle ? `<table>
      <thead><tr><th>Index category</th><th>Paths</th></tr></thead>
      <tbody>
        <tr><td>Staged candidates</td><td>${formatPathList(stagedBundle.stagedStageablePaths)}</td></tr>
        <tr><td>Unstaged candidates</td><td>${formatPathList(stagedBundle.unstagedStageablePaths)}</td></tr>
        <tr><td>Unexpected staged</td><td>${formatPathList(stagedBundle.unexpectedStagedPaths)}</td></tr>
        <tr><td>Dirty after staging</td><td>${formatPathList(stagedBundle.dirtyAfterStagingPaths)}</td></tr>
        <tr><td>Next action</td><td>${escapeHtml(stagedBundle.nextAction || '')}</td></tr>
      </tbody>
    </table>` : ''}
    <table>
      <thead><tr><th>Path</th><th>Status</th><th>Classification</th><th>Current</th><th>HEAD</th><th>origin/main</th><th>Δ HEAD</th><th>Δ origin</th><th>Decision</th><th>Review command</th><th>Action</th></tr></thead>
      <tbody>
        ${rows.length === 0 ? '<tr><td colspan="11">Run <code>npm run source:promotion-packet</code> to generate candidate reconciliation rows.</td></tr>' : rows.map(row => `<tr><td><code>${escapeHtml(row.path || '')}</code></td><td><span class="${escapeHtml(row.status || 'yellow')}">${escapeHtml(row.status || 'unknown')}</span></td><td><code>${escapeHtml(row.classification || '')}</code></td><td><code>${escapeHtml(formatHashLines(row.currentHash, row.currentLines))}</code></td><td><code>${escapeHtml(formatHashLines(row.headHash, row.headLines))}</code></td><td><code>${escapeHtml(formatHashLines(row.originHash, row.originLines))}</code></td><td>${escapeHtml(formatDelta(row.lineDeltaVsHead))}</td><td>${escapeHtml(formatDelta(row.lineDeltaVsOrigin))}</td><td><code>${escapeHtml(formatReviewDecision(row.reviewDecision))}</code></td><td><code>${escapeHtml(row.reviewCommand || '')}</code></td><td>${escapeHtml(row.action || '')}</td></tr>`).join('\n')}
      </tbody>
    </table>`
}

function renderFirstBiteOperatingReadout(readout) {
  if (!readout) {
    return ''
  }

  const statusClass = readout.status === 'green' ? 'green' : readout.status === 'red' ? 'red' : 'yellow'
  const checked = readout.createdAt
    ? `${readout.createdAt}${readout.ageMinutes === null ? '' : ` (${readout.ageMinutes}m old)`}`
    : 'missing'
  const failedLanes = readout.failedLanes || []
  const manifest = readout.manifestPortability
  const fxManifest = readout.expectedManifestState
  const moussey = readout.mousseyLocal
  const localCiApi = moussey?.localCiApi
  const lanStatus = moussey?.lanStatus
  const peerBoundary = readout.peerExecutionBoundary
  const m4Peer = readout.m4PeerProbe
  const m4Packet = readout.m4FreshClonePacket

  return `<h2>FirstBite Operating Readout</h2>
    <div class="kv">
      <div>Status</div><div><span class="${statusClass}">${escapeHtml(readout.status || 'unknown')}</span> ${escapeHtml(readout.summary || '')}</div>
      <div>Run</div><div><code>${escapeHtml(readout.runId || 'unknown')}</code></div>
      <div>Created</div><div>${escapeHtml(checked)}</div>
      <div>Local CI latest proofs</div><div>${escapeHtml(String(readout.localCi?.latestLanePassCount ?? 'unknown'))}/${escapeHtml(String(readout.localCi?.latestLaneCount ?? 'unknown'))} pass · ${escapeHtml(String(readout.localCi?.latestLaneFailCount ?? 'unknown'))} fail</div>
      <div>Catalog</div><div>${escapeHtml(readout.catalog?.version || 'missing')} · declared ${escapeHtml(String(readout.catalog?.declaredCount ?? 'unknown'))}/${escapeHtml(String(readout.catalog?.laneCount ?? 'unknown'))} · expected repo ${readout.catalog?.repoPresent ? 'present' : 'missing'}</div>
      <div>Manifest portability</div><div>${manifest ? `fresh clone ${escapeHtml(String(manifest.fresh_clone_ready))} · active checkout ${escapeHtml(String(manifest.ready))} · uncommitted repos ${escapeHtml(String(manifest.uncommitted_repo_count ?? 'unknown'))}` : 'unknown'}</div>
      <div>FX manifest state</div><div>${fxManifest ? `${escapeHtml(fxManifest.portability_status || 'unknown')} · <code>${escapeHtml(fxManifest.porcelain || 'clean')}</code>` : 'missing from readout'}</div>
      <div>Moussey /coding</div><div>${escapeHtml(moussey?.verdict || 'unknown')} · local CI ${escapeHtml(String(localCiApi?.latest_lane_pass_count ?? 'unknown'))}/${escapeHtml(String(localCiApi?.latest_lane_count ?? 'unknown'))} pass · LAN peers ${escapeHtml(String(lanStatus?.healthy_peer_count ?? 'unknown'))}/${escapeHtml(String(lanStatus?.peer_count ?? 'unknown'))} healthy</div>
      <div>M4 peer boundary</div><div><span class="${escapeHtml(peerBoundary?.status || 'yellow')}">${escapeHtml(peerBoundary?.summary || 'No M4 peer boundary recorded.')}</span></div>
      <div>M4 peer probe</div><div>${escapeHtml(m4Peer?.verdict || 'missing')} · execution_ready=${escapeHtml(String(m4Peer?.executionReady ?? false))}${m4Peer?.dashboardUrl ? ` · <code>${escapeHtml(m4Peer.dashboardUrl)}</code>` : ''}</div>
      <div>M4 fresh-clone packet</div><div>${escapeHtml(m4Packet?.available ? 'available' : 'missing')} · commands <code>${escapeHtml(m4Packet?.latestCommands || 'missing')}</code>${m4Packet?.completionGates?.length ? ` · gates ${escapeHtml(String(m4Packet.completionGates.length))}` : ''}</div>
      ${peerBoundary?.proofRule ? `<div>M4 proof rule</div><div>${escapeHtml(peerBoundary.proofRule)}</div>` : ''}
      <div>Report</div><div><code>${escapeHtml(readout.reportPath || '')}</code></div>
      <div>Summary</div><div><code>${escapeHtml(readout.summaryPath || '')}</code></div>
      <div>Next action</div><div>${escapeHtml(readout.nextAction || '')}</div>
    </div>
    <table>
      <thead><tr><th>Failed lane</th><th>Repo</th><th>Kind</th><th>Status</th><th>Run</th><th>Log</th></tr></thead>
      <tbody>
        ${failedLanes.length === 0 ? '<tr><td colspan="6">No failed lanes in the latest operating readout.</td></tr>' : failedLanes.map(lane => `<tr><td><code>${escapeHtml(lane.lane || 'unknown')}</code></td><td>${escapeHtml(lane.repo || '')}</td><td>${escapeHtml(lane.kind || '')}</td><td><span class="${lane.status === 'fail' ? 'red' : 'yellow'}">${escapeHtml(lane.status || 'unknown')}</span></td><td><code>${escapeHtml(lane.runId || '')}</code></td><td><code>${escapeHtml(lane.logPath || '')}</code></td></tr>`).join('\n')}
      </tbody>
    </table>`
}

function renderFirstBiteRunnerControlPlane(controlPlane) {
  if (!controlPlane) {
    return ''
  }

  const statusClass = controlPlane.status === 'green' ? 'green' : controlPlane.status === 'red' ? 'red' : 'yellow'
  const dirty = (controlPlane.dirty || []).length > 0 ? controlPlane.dirty.join('; ') : 'clean for runner files'
  const rows = controlPlane.rows || []

  return `<h2>FirstBite Runner Control Plane</h2>
    <div class="kv">
      <div>Status</div><div><span class="${statusClass}">${escapeHtml(controlPlane.status || 'unknown')}</span> ${escapeHtml(controlPlane.summary || '')}</div>
      <div>ai-leo repo</div><div><code>${escapeHtml(controlPlane.aiLeoRepoDir || DEFAULT_AI_LEO_REPO_DIR)}</code></div>
      <div>Package dir</div><div><code>${escapeHtml(controlPlane.packageDir || DEFAULT_FIRSTBITE_LOCAL_CI_DIR)}</code></div>
      <div>Server path</div><div><code>${escapeHtml(controlPlane.serverRelativePath || FIRSTBITE_RUNNER_SERVER_RELATIVE_PATH)}</code></div>
      <div>Refs</div><div>HEAD <code>${escapeHtml(controlPlane.branch || 'unknown')}</code> · origin/main <code>${escapeHtml(controlPlane.originMainHead || 'unknown')}</code> · PR branch <code>${escapeHtml(controlPlane.prBranchHead || 'missing')}</code></div>
      <div>Runner file status</div><div><code>${escapeHtml(dirty)}</code></div>
      <div>Next action</div><div>${escapeHtml(controlPlane.nextAction || '')}</div>
    </div>
    <table>
      <thead><tr><th>Boundary</th><th>Status</th><th>Supports warn exits</th><th>Ref</th><th>Missing tokens</th><th>Source</th><th>Summary</th></tr></thead>
      <tbody>
        ${rows.length === 0 ? '<tr><td colspan="7">No FirstBite runner control-plane rows were generated.</td></tr>' : rows.map(row => `<tr><td>${escapeHtml(row.label || row.id || '')}</td><td><span class="${escapeHtml(row.status || 'yellow')}">${escapeHtml(row.status || 'unknown')}</span></td><td>${row.supports ? '<span class="green">yes</span>' : '<span class="red">no</span>'}</td><td><code>${escapeHtml(row.ref || '')}</code></td><td><code>${escapeHtml((row.missingTokens || []).join(', ') || 'none')}</code></td><td><code>${escapeHtml(row.source || '')}</code></td><td>${escapeHtml(row.summary || '')}</td></tr>`).join('\n')}
      </tbody>
    </table>`
}

function renderReviewScoutProducerControlPlane(controlPlane) {
  if (!controlPlane) {
    return ''
  }

  const statusClass = controlPlane.status === 'green' ? 'green' : controlPlane.status === 'red' ? 'red' : 'yellow'
  const dirty = (controlPlane.dirty || []).length > 0 ? controlPlane.dirty.join('; ') : 'clean for producer script'
  const rows = controlPlane.rows || []

  return `<h2>Review Scout Producer Control Plane</h2>
    <div class="kv">
      <div>Status</div><div><span class="${statusClass}">${escapeHtml(controlPlane.status || 'unknown')}</span> ${escapeHtml(controlPlane.summary || '')}</div>
      <div>ai-leo repo</div><div><code>${escapeHtml(controlPlane.aiLeoRepoDir || DEFAULT_AI_LEO_REPO_DIR)}</code></div>
      <div>Script path</div><div><code>${escapeHtml(controlPlane.scriptRelativePath || FIRSTBITE_REVIEW_SCOUT_SCRIPT_RELATIVE_PATH)}</code></div>
      <div>Refs</div><div>HEAD <code>${escapeHtml(controlPlane.branch || 'unknown')}</code> · origin/main <code>${escapeHtml(controlPlane.originMainHead || 'unknown')}</code> · producer branch <code>${escapeHtml(controlPlane.producerBranchHead || 'missing')}</code></div>
      <div>Producer file status</div><div><code>${escapeHtml(dirty)}</code></div>
      <div>Next action</div><div>${escapeHtml(controlPlane.nextAction || '')}</div>
    </div>
    <table>
      <thead><tr><th>Boundary</th><th>Status</th><th>Emits repo key proof</th><th>Ref</th><th>Missing tokens</th><th>Source</th><th>Summary</th></tr></thead>
      <tbody>
        ${rows.length === 0 ? '<tr><td colspan="7">No review-scout producer control-plane rows were generated.</td></tr>' : rows.map(row => `<tr><td>${escapeHtml(row.label || row.id || '')}</td><td><span class="${escapeHtml(row.status || 'yellow')}">${escapeHtml(row.status || 'unknown')}</span></td><td>${row.supports ? '<span class="green">yes</span>' : '<span class="red">no</span>'}</td><td><code>${escapeHtml(row.ref || '')}</code></td><td><code>${escapeHtml((row.missingTokens || []).join(', ') || 'none')}</code></td><td><code>${escapeHtml(row.source || '')}</code></td><td>${escapeHtml(row.summary || '')}</td></tr>`).join('\n')}
      </tbody>
    </table>`
}

function renderTrackedSourceContract(trackedSource) {
  if (!trackedSource) {
    return ''
  }

  const statusClass = trackedSource.status === 'green' ? 'green' : trackedSource.status === 'red' ? 'red' : 'yellow'
  return `<h2>Tracked Source Contract</h2>
    <div class="kv">
      <div>Status</div><div><span class="${statusClass}">${escapeHtml(trackedSource.status)}</span> ${escapeHtml(trackedSource.summary)}</div>
      <div>Refs</div><div><code>${escapeHtml(trackedSource.refs?.head || 'HEAD')}</code> / <code>${escapeHtml(trackedSource.refs?.origin || 'origin/main')}</code>${trackedSource.refs?.originAvailable === false ? ' (origin package missing)' : ''}</div>
    </div>
    <table>
      <thead><tr><th>Manifest lane</th><th>Status</th><th>Current</th><th>HEAD</th><th>origin/main</th></tr></thead>
      <tbody>
        ${(trackedSource.manifestLaneCommands || []).map(row => `<tr><td><code>${escapeHtml(row.lane)}</code></td><td><span class="${escapeHtml(row.status)}">${escapeHtml(row.status)}</span></td><td><code>${escapeHtml(row.currentCommand || 'missing')}</code></td><td><code>${escapeHtml(row.headCommand || 'missing')}</code></td><td><code>${escapeHtml(row.originCommand || 'missing')}</code></td></tr>`).join('\n')}
      </tbody>
    </table>
    <table>
      <thead><tr><th>Contract file</th><th>Current</th><th>HEAD</th><th>origin/main</th><th>Git status</th></tr></thead>
      <tbody>
        ${(trackedSource.files || []).map(row => `<tr><td><code>${escapeHtml(row.path)}</code></td><td><span class="${row.currentExists ? 'green' : 'red'}">${row.currentExists ? 'present' : 'missing'}</span></td><td><span class="${row.headExists ? 'green' : 'red'}">${row.headExists ? 'tracked' : 'missing'}</span></td><td><span class="${row.originExists ? 'green' : 'red'}">${row.originExists ? 'tracked' : 'missing'}</span></td><td><code>${escapeHtml(row.gitStatus || 'clean')}</code></td></tr>`).join('\n')}
      </tbody>
    </table>
    <table>
      <thead><tr><th>Package script</th><th>Status</th><th>Current</th><th>HEAD</th><th>origin/main</th></tr></thead>
      <tbody>
        ${(trackedSource.requiredScripts || []).map(row => `<tr><td><code>${escapeHtml(row.name)}</code></td><td><span class="${escapeHtml(row.status)}">${escapeHtml(row.status)}</span></td><td><code>${escapeHtml(row.currentCommand || 'missing')}</code></td><td><code>${escapeHtml(row.headCommand || 'missing')}</code></td><td><code>${escapeHtml(row.originCommand || 'missing')}</code></td></tr>`).join('\n')}
      </tbody>
    </table>`
}

function renderRepoBackedMcpProbe(probe) {
  if (!probe) {
    return ''
  }

  const statusClass = probe.status === 'green' ? 'green' : probe.status === 'red' ? 'red' : 'yellow'
  const missing = (probe.missingLaneIds || []).length > 0 ? probe.missingLaneIds.join(', ') : 'none'
  const loaded = (probe.loadedLaneIds || []).length > 0 ? probe.loadedLaneIds.join(', ') : 'none'
  const checked = probe.checkedAt
    ? `${probe.checkedAt}${probe.ageMinutes === null ? '' : ` (${probe.ageMinutes}m old)`}`
    : 'unknown'
  const portability = probe.manifestPortability
    ? `fresh clone ${String(probe.manifestPortability.fresh_clone_ready)} · active checkout ${String(probe.manifestPortability.ready)}`
    : 'unknown'
  const pathMatch = probe.repoPathMatchesExpected === true
    ? 'yes'
    : probe.repoPathMatchesExpected === false
      ? 'no'
      : 'unknown'

  return `<h2>Repo-Backed MCP Catalog</h2>
    <div class="kv">
      <div>Status</div><div><span class="${statusClass}">${escapeHtml(probe.status || 'unknown')}</span> ${escapeHtml(probe.summary || '')}</div>
      <div>Source</div><div>${escapeHtml(probe.source || 'unknown')}</div>
      <div>Checked</div><div>${escapeHtml(checked)}</div>
      <div>Expected repo</div><div><code>${escapeHtml(probe.expectedRepo || 'unknown')}</code></div>
      <div>Catalog</div><div>${escapeHtml(probe.catalogVersion || 'unknown')} · ${escapeHtml(String(probe.laneCount ?? 'unknown'))} loaded lane(s)</div>
      <div>Loaded FX lanes</div><div><code>${escapeHtml(loaded)}</code></div>
      <div>Missing FX lanes</div><div><code>${escapeHtml(missing)}</code></div>
      <div>Catalog repo path</div><div><code>${escapeHtml(probe.actualRepoPath || 'unknown')}</code></div>
      <div>Expected repo path</div><div><code>${escapeHtml(probe.expectedRepoPath || 'unknown')}</code></div>
      <div>Requested repo path</div><div><code>${escapeHtml(probe.requestedRepoPath || 'none')}</code></div>
      <div>Repo path match</div><div><span class="${pathMatch === 'yes' ? 'green' : pathMatch === 'no' ? 'red' : 'yellow'}">${escapeHtml(pathMatch)}</span></div>
      <div>Manifest portability</div><div>${escapeHtml(portability)}</div>
      <div>Package dir</div><div><code>${escapeHtml(probe.packageDir || 'unknown')}</code></div>
      <div>Command</div><div><code>${escapeHtml(probe.command || '')}</code></div>
    </div>`
}

function renderMcpCatalogDelta(delta) {
  if (!delta) {
    return ''
  }

  const statusClass = delta.status === 'green' ? 'green' : delta.status === 'red' ? 'red' : 'yellow'
  const missingRepos = (delta.missingReposInLoaded || []).length > 0 ? delta.missingReposInLoaded.join(', ') : 'none'
  const missingGroups = (delta.missingGroupsInLoaded || []).length > 0 ? delta.missingGroupsInLoaded.join(', ') : 'none'
  const missingExpected = (delta.missingExpectedLanesInLoaded || []).length > 0 ? delta.missingExpectedLanesInLoaded.join(', ') : 'none'
  const missingLanes = (delta.missingLanesInLoaded || []).length > 0 ? delta.missingLanesInLoaded.join(', ') : 'none'

  return `<h2>Loaded MCP Catalog Delta</h2>
    <div class="kv">
      <div>Status</div><div><span class="${statusClass}">${escapeHtml(delta.status || 'unknown')}</span> ${escapeHtml(delta.summary || '')}</div>
      <div>Loaded checked</div><div>${escapeHtml(delta.loadedCheckedAt || 'unknown')}</div>
      <div>Repo-backed checked</div><div>${escapeHtml(delta.repoBackedCheckedAt || 'unknown')}</div>
      <div>Lane counts</div><div>loaded ${escapeHtml(String(delta.loadedLaneCount ?? 'unknown'))} / repo-backed ${escapeHtml(String(delta.repoBackedLaneCount ?? 'unknown'))}</div>
      <div>Catalog versions</div><div>loaded ${escapeHtml(delta.loadedCatalogVersion || 'unknown')} / repo-backed ${escapeHtml(delta.repoBackedCatalogVersion || 'unknown')}</div>
      <div>Missing repos in loaded host</div><div><code>${escapeHtml(missingRepos)}</code></div>
      <div>Missing expected FX lanes</div><div><code>${escapeHtml(missingExpected)}</code></div>
      <div>Missing groups in loaded host</div><div><code>${escapeHtml(missingGroups)}</code></div>
      <div>Missing total lanes in loaded host</div><div><code>${escapeHtml(missingLanes)}</code></div>
      <div>Next action</div><div>${escapeHtml(delta.nextAction || '')}</div>
    </div>`
}

function renderFirstBiteMcpRefreshPlan(plan) {
  if (!plan) {
    return ''
  }

  const statusClass = plan.status === 'green' ? 'green' : plan.status === 'red' ? 'red' : 'yellow'
  const checked = plan.createdAt
    ? `${plan.createdAt}${plan.ageMinutes === null ? '' : ` (${plan.ageMinutes}m old)`}`
    : 'unknown'
  const stalePids = (plan.processAudit?.stale_pids || []).length > 0
    ? plan.processAudit.stale_pids.join(', ')
    : 'none'
  const currentPids = (plan.processAudit?.current_pids || []).length > 0
    ? plan.processAudit.current_pids.join(', ')
    : 'none'
  const missingExpected = (plan.missingExpectedLaneIds || []).length > 0
    ? plan.missingExpectedLaneIds.join(', ')
    : 'none'
  const steps = (plan.recommendedSteps || []).slice(0, 5)

  return `<h2>FirstBite MCP Refresh Plan</h2>
    <div class="kv">
      <div>Status</div><div><span class="${statusClass}">${escapeHtml(plan.status || 'unknown')}</span> ${escapeHtml(plan.summary || '')}</div>
      <div>Verdict</div><div><code>${escapeHtml(plan.verdict || 'unknown')}</code></div>
      <div>Checked</div><div>${escapeHtml(checked)}</div>
      <div>Process audit</div><div>${escapeHtml(plan.processAudit?.status || 'unknown')} · stale ${escapeHtml(String(plan.staleProcessCount ?? 'unknown'))}/${escapeHtml(String(plan.processCount ?? 'unknown'))}</div>
      <div>Stale PIDs</div><div><code>${escapeHtml(stalePids)}</code></div>
      <div>Current PIDs</div><div><code>${escapeHtml(currentPids)}</code></div>
      <div>Repo-backed catalog</div><div>${escapeHtml(plan.repoBackedCatalog?.catalog_version || 'unknown')} · ${escapeHtml(String(plan.repoBackedCatalog?.declared_count ?? 'unknown'))}/${escapeHtml(String(plan.repoBackedCatalog?.lane_count ?? 'unknown'))} declared lane(s)</div>
      <div>Missing current manifest lanes</div><div><code>${escapeHtml(missingExpected)}</code></div>
      <div>Report</div><div><code>${escapeHtml(plan.reportPath || 'missing')}</code></div>
      <div>Summary</div><div><code>${escapeHtml(plan.summaryPath || 'missing')}</code></div>
      <div>Next action</div><div>${escapeHtml(plan.nextAction || '')}</div>
      <div>Recommended steps</div><div>${steps.length ? `<ul>${steps.map(step => `<li>${escapeHtml(step)}</li>`).join('\n')}</ul>` : 'none'}</div>
    </div>`
}

function renderLoadedMcpProbe(probe) {
  if (!probe) {
    return ''
  }

  const statusClass = probe.status === 'green' ? 'green' : probe.status === 'red' ? 'red' : 'yellow'
  const missing = (probe.missingLaneIds || []).length > 0 ? probe.missingLaneIds.join(', ') : 'none'
  const loaded = (probe.loadedLaneIds || []).length > 0 ? probe.loadedLaneIds.join(', ') : 'none'
  const checked = probe.checkedAt
    ? `${probe.checkedAt}${probe.ageMinutes === null ? '' : ` (${probe.ageMinutes}m old)`}`
    : 'unknown'
  const freshnessClass = probe.freshnessStatus === 'green' ? 'green' : probe.freshnessStatus === 'red' ? 'red' : 'yellow'

  return `<h2>Loaded MCP Host Probe</h2>
    <div class="kv">
      <div>Status</div><div><span class="${statusClass}">${escapeHtml(probe.status || 'unknown')}</span> ${escapeHtml(probe.summary || '')}</div>
      <div>Source</div><div>${escapeHtml(probe.source || 'unknown')}</div>
      <div>Checked</div><div>${escapeHtml(checked)}</div>
      <div>Freshness</div><div><span class="${freshnessClass}">${escapeHtml(probe.freshnessStatus || 'unknown')}</span> ${escapeHtml(probe.freshnessSummary || '')}</div>
      <div>Expected repo</div><div><code>${escapeHtml(probe.expectedRepo || 'unknown')}</code></div>
      <div>Catalog</div><div>${escapeHtml(probe.catalogVersion || 'unknown')} · ${escapeHtml(String(probe.laneCount ?? 'unknown'))} loaded lane(s)</div>
      <div>Loaded FX lanes</div><div><code>${escapeHtml(loaded)}</code></div>
      <div>Missing FX lanes</div><div><code>${escapeHtml(missing)}</code></div>
      <div>Probe file</div><div><code>${escapeHtml(probe.path || 'missing')}</code></div>
      <div>Restart hint</div><div>${escapeHtml(probe.restartHint || '')}</div>
    </div>`
}

function renderMcpProofHistory(history) {
  if (!history.length) {
    return '<h2>Proof History</h2><p class="meta">No matching MCP proof history found.</p>'
  }

  return `<h2>Proof History</h2>
    <table>
      <thead><tr><th>Run</th><th>Created</th><th>Trust</th><th>Lane status</th><th>Coverage</th><th>Source</th><th>Diagnostics</th></tr></thead>
      <tbody>
        ${history.map(item => {
    const coverage = item.coverage?.complete
      ? `complete (${escapeHtml(String(item.laneCount))})`
      : `partial; missing ${escapeHtml((item.coverage?.missingLaneIds || []).join(', ') || 'unknown')}`
    const source = item.sourceState
      ? `exec ${escapeHtml(item.sourceState.syncStatus || 'unknown')} · dirty ${escapeHtml(String(item.sourceState.dirtyCount ?? 'unknown'))} / ahead ${escapeHtml(String(item.sourceState.aheadOriginMain ?? 'unknown'))} / behind ${escapeHtml(String(item.sourceState.behindOriginMain ?? 'unknown'))}`
      : 'missing source_state'
    return `<tr><td><code>${escapeHtml(item.runId || 'unknown')}</code></td><td>${escapeHtml(item.createdAt || 'unknown')}</td><td><span class="${escapeHtml(item.trustStatus || 'yellow')}">${escapeHtml(item.trustStatus || 'unknown')}</span></td><td><span class="${item.status === 'pass' ? 'green' : item.status === 'fail' ? 'red' : 'yellow'}">${escapeHtml(item.status || 'unknown')}</span></td><td>${coverage}</td><td>${source}</td><td><span class="${escapeHtml(item.diagnostics?.status || 'unknown')}">${escapeHtml(item.diagnostics?.summary || 'unknown')}</span></td></tr>`
  }).join('\n')}
      </tbody>
    </table>`
}

function renderGates(gates) {
  return `<section class="half">
    <h2>Repo Gates</h2>
    <table>
      <thead><tr><th>Script</th><th>Command</th></tr></thead>
      <tbody>
        ${gates.required.map(gate => `<tr><td><span class="${gate.present ? 'green' : 'red'}">${escapeHtml(gate.name)}</span></td><td><code>${escapeHtml(gate.command || 'missing')}</code></td></tr>`).join('\n')}
      </tbody>
    </table>
  </section>`
}

function renderTelemetry(telemetry) {
  const evidence = telemetry.grafana.evidence || {
    status: 'missing',
    latestPath: null,
    checkedAt: null,
    ageMinutes: null,
    tempoMatched: false,
      lokiMatched: false,
      traceId: null,
      checks: [],
      summary: 'no Grafana evidence loaded',
    }
  const cloudflare = telemetry.cloudflare?.destinations || {
    status: 'missing',
    latestPath: null,
    checkedAt: null,
    ageMinutes: null,
    destinationNames: [],
    expected: [],
    checks: [],
    summary: 'no Cloudflare destination evidence loaded',
  }
  const checks = Array.isArray(evidence.checks) ? evidence.checks : []
  const cloudflareChecks = Array.isArray(cloudflare.checks) ? cloudflare.checks : []
  const persistence = telemetry.observability.persistence || {}
  return `<section class="half">
    <h2>Cloudflare OTEL Destinations + Grafana OTEL Smoke</h2>
    <div class="kv">
      <div>Worker</div><div><code>${escapeHtml(telemetry.workerName || 'unknown')}</code></div>
      <div>Scope</div><div>${escapeHtml(telemetry.observability.scope || 'unknown')}</div>
      <div>Observability</div><div>${telemetry.observability.enabled ? 'enabled' : 'missing'}</div>
      <div>Logs</div><div>${telemetry.observability.logsEnabled ? 'enabled' : 'missing'}</div>
      <div>Traces</div><div>${telemetry.observability.tracesEnabled ? 'enabled' : 'missing'}</div>
      <div>Sampling</div><div>logs ${escapeHtml(String(telemetry.observability.sampling.logs ?? 'unknown'))} / traces ${escapeHtml(String(telemetry.observability.sampling.traces ?? 'unknown'))}</div>
      <div>Persistence</div><div>logs ${escapeHtml(formatTelemetryPersistence(persistence.logs))} / traces ${escapeHtml(formatTelemetryPersistence(persistence.traces))}</div>
      <div>Destinations</div><div>${telemetry.observability.destinationNames.length > 0 ? telemetry.observability.destinationNames.map(name => `<code>${escapeHtml(name)}</code>`).join(' ') : 'missing'}</div>
      <div>Cloudflare proof</div><div><span class="${escapeHtml(cloudflare.status)}">${escapeHtml(cloudflare.status)}</span> ${escapeHtml(cloudflare.summary)}</div>
      <div>Cloudflare file</div><div><code>${escapeHtml(cloudflare.latestPath || 'missing')}</code></div>
      <div>Cloudflare names</div><div>${cloudflare.destinationNames?.length ? cloudflare.destinationNames.map(name => `<code>${escapeHtml(name)}</code>`).join(' ') : 'missing'}</div>
      <div>Verifier</div><div>${telemetry.grafana.tempoVerifierPresent ? 'present' : 'missing'}${telemetry.grafana.verifierPaths?.length ? ` <code>${escapeHtml(telemetry.grafana.verifierPaths.map(item => path.relative(process.cwd(), item)).join(', '))}</code>` : ''}</div>
      <div>Grafana evidence</div><div><span class="${escapeHtml(evidence.status)}">${escapeHtml(evidence.status)}</span> ${escapeHtml(evidence.summary)}</div>
      <div>Evidence file</div><div><code>${escapeHtml(evidence.latestPath || 'missing')}</code></div>
      <div>Tempo / Loki</div><div>${evidence.tempoMatched ? 'tempo matched' : 'tempo missing'} / ${evidence.lokiMatched ? 'loki matched' : 'loki missing'}</div>
      <div>Trace ID</div><div><code>${escapeHtml(evidence.traceId || 'missing')}</code></div>
      <div>Checked</div><div>${escapeHtml(evidence.checkedAt || 'unknown')}${evidence.ageMinutes === null ? '' : ` (${escapeHtml(String(evidence.ageMinutes))}m old)`}</div>
      <div>Plan</div><div><code>${escapeHtml(telemetry.grafana.plan)}</code></div>
    </div>
    ${cloudflareChecks.length > 0 ? `<h3>Cloudflare OTEL Destinations Checklist</h3>
    <table><thead><tr><th>Check</th><th>Status</th><th>Proof</th><th>Next</th></tr></thead><tbody>
      ${cloudflareChecks.map(check => `<tr><td>${escapeHtml(check.label || check.id)}</td><td><span class="${escapeHtml(check.status || 'yellow')}">${escapeHtml(check.status || 'yellow')}</span></td><td>${escapeHtml(check.proof || '')}</td><td>${escapeHtml(check.nextAction || '')}</td></tr>`).join('')}
    </tbody></table>` : ''}
    ${checks.length > 0 ? `<h3>Grafana OTEL Smoke Checklist</h3>
    <table>
      <thead><tr><th>Check</th><th>Status</th><th>Proof</th><th>Next</th></tr></thead>
      <tbody>
        ${checks.map(check => `<tr><td>${escapeHtml(check.label || check.id || 'Grafana check')}</td><td><span class="${escapeHtml(check.status || 'yellow')}">${escapeHtml(check.status || 'yellow')}</span></td><td>${escapeHtml(check.proof || '')}</td><td>${escapeHtml(check.nextAction || '')}</td></tr>`).join('\n')}
      </tbody>
    </table>` : ''}
  </section>`
}

function formatTelemetryPersistence(value) {
  if (value === false) return 'external-only'
  if (value === true) return 'dashboard+external'
  return 'unknown'
}

function renderAgentState(agentState) {
  const repoLedger = agentState.ledger.repo || { status: agentState.ledger.status, recentEntries: [] }
  const sharedLedger = agentState.ledger.shared || { status: 'unknown', recentEntries: [] }
  const ledgerHealth = agentState.ledger.health || { status: 'unknown', summary: 'Ledger health was not computed.', failureRows: [], recoveryRows: [] }
  const activityMatrix = agentState.ledger.activityMatrix || []
  const reviewScout = agentState.reviewScout || {}
  const latestShared = sharedLedger.recentEntries?.at(-1)
  const latestFailure = ledgerHealth.latestFailure || ledgerHealth.failureRows?.at?.(-1)
  const latestRecovery = ledgerHealth.latestRecovery || ledgerHealth.recoveryRows?.at?.(-1)

  return `<section class="half">
    <h2>Nurse Log</h2>
    <div class="kv">
      <div>Latest</div><div>${escapeHtml(agentState.nurseLog.latestHeading || 'missing')}</div>
      <div>Readiness</div><div>${escapeHtml(agentState.nurseLog.releaseReadiness)}</div>
      <div>Blocker</div><div>${escapeHtml(agentState.nurseLog.currentBlocker || 'none recorded')}</div>
      <div>Next slice</div><div>${escapeHtml(agentState.nurseLog.nextSlice || 'none recorded')}</div>
    </div>
  </section>
  <section class="half">
    <h2>INBOX / Ledger</h2>
    <div class="kv">
      <div>Active INBOX</div><div>${escapeHtml(String(agentState.inbox.activeItems.length))}</div>
      <div>Grafana row</div><div>${agentState.inbox.hasGrafanaItem ? 'present' : 'absent'}</div>
      <div>Legacy Grafana row</div><div>${agentState.inbox.hasStaleGrafanaItem ? 'present' : 'absent'}</div>
      <div>Release row</div><div>${agentState.inbox.hasReleaseHistoryItem ? 'present' : 'absent'}</div>
      <div>Repo ledger</div><div>${escapeHtml(repoLedger.status)} (${escapeHtml(String(repoLedger.recentEntries?.length || 0))})</div>
      <div>Shared ledger</div><div>${escapeHtml(sharedLedger.status)} (${escapeHtml(String(sharedLedger.recentEntries?.length || 0))})</div>
      <div>Ledger health</div><div><span class="${escapeHtml(ledgerHealth.status)}">${escapeHtml(ledgerHealth.status)}</span> ${escapeHtml(ledgerHealth.summary || '')}</div>
      <div>Latest failure</div><div>${latestFailure ? `${escapeHtml(latestFailure.ts || 'unknown')} · ${escapeHtml(latestFailure.summary || 'no summary')}` : 'none in window'}</div>
      <div>Latest recovery</div><div>${latestRecovery ? `${escapeHtml(latestRecovery.ts || 'unknown')} · ${escapeHtml(latestRecovery.summary || 'no summary')}` : 'none in window'}</div>
      <div>Latest shared</div><div>${escapeHtml(latestShared?.summary || 'none recorded')}</div>
      <div>Review scout</div><div><span class="${escapeHtml(reviewScout.status || 'yellow')}">${escapeHtml(reviewScout.status || 'unknown')}</span> ${escapeHtml(reviewScout.summary || 'not inspected')}</div>
    </div>
  </section>
  ${renderReviewScout(reviewScout)}
  ${renderAgentActivityMatrix(activityMatrix)}`
}

function renderReviewScout(reviewScout = {}) {
  const failedLanes = reviewScout.failedLanes || []
  const checked = reviewScout.createdAt
    ? `${reviewScout.createdAt}${reviewScout.ageMinutes === null ? '' : ` (${escapeHtml(String(reviewScout.ageMinutes))}m old)`}`
    : 'missing'
  const checkout = reviewScout.currentForCheckout === true
    ? 'current'
    : reviewScout.currentForCheckout === false
      ? 'not current'
      : 'unknown'
  return `<section>
    <h2>Coding-Agent Review Scout</h2>
    <div class="kv">
      <div>Status</div><div><span class="${escapeHtml(reviewScout.status || 'yellow')}">${escapeHtml(reviewScout.status || 'unknown')}</span> ${escapeHtml(reviewScout.summary || '')}</div>
      <div>Run</div><div><code>${escapeHtml(reviewScout.runId || 'missing')}</code></div>
      <div>Checked</div><div>${escapeHtml(checked)}</div>
      <div>Checkout match</div><div>${escapeHtml(checkout)} · packet <code>${escapeHtml(reviewScout.branch || 'unknown')}</code> <code>${escapeHtml(reviewScout.headSha || 'unknown')}</code> / current <code>${escapeHtml(reviewScout.currentBranch || 'unknown')}</code> <code>${escapeHtml(reviewScout.currentHead || 'unknown')}</code></div>
      <div>Cursor sidecar</div><div>${reviewScout.cursorReviewRan ? 'ran' : 'not run'} · ${escapeHtml(reviewScout.cursorCurrentModel || reviewScout.cursorModel || 'model unknown')}</div>
      <div>Actionable payload</div><div>${reviewScout.actionableClaimed ? 'claimed' : 'not claimed'} · findings ${escapeHtml(String(reviewScout.findingCount ?? 0))} · files ${escapeHtml(String(reviewScout.fileCount ?? 0))}</div>
      <div>Local-CI scope</div><div><span class="${reviewScout.localCi?.repoScopeWarning ? 'yellow' : 'green'}">${escapeHtml(reviewScout.localCi?.repoScopeStatus || 'unknown')}</span> · key <code>${escapeHtml(reviewScout.localCi?.repoKey || 'missing')}</code> / expected <code>${escapeHtml(reviewScout.localCi?.expectedRepo || reviewScout.expectedRepo || 'unknown')}</code></div>
      <div>Repo lanes</div><div>${escapeHtml(String(reviewScout.localCi?.repoLanePassCount ?? 'unknown'))}/${escapeHtml(String(reviewScout.localCi?.repoLaneCount ?? 'unknown'))} pass · ${escapeHtml(String(reviewScout.localCi?.repoLaneFailCount ?? 'unknown'))} fail</div>
      <div>Report</div><div><code>${escapeHtml(reviewScout.reportPath || 'missing')}</code></div>
      <div>Review</div><div><code>${escapeHtml(reviewScout.reviewPath || 'missing')}</code></div>
      <div>Local-CI proof</div><div><code>${escapeHtml(reviewScout.localCiProofPath || 'missing')}</code></div>
      <div>Next action</div><div>${escapeHtml(reviewScout.nextAction || '')}</div>
    </div>
    <table>
      <thead><tr><th>Lane</th><th>Status</th><th>Run</th><th>Report</th><th>Log</th></tr></thead>
      <tbody>
        ${failedLanes.length === 0 ? '<tr><td colspan="5">No failed repo lanes in the latest review scout packet.</td></tr>' : failedLanes.map(lane => `<tr><td><code>${escapeHtml(lane.lane || 'unknown')}</code></td><td><span class="${lane.status === 'fail' ? 'red' : 'yellow'}">${escapeHtml(lane.status || 'unknown')}</span></td><td><code>${escapeHtml(lane.runId || '')}</code></td><td><code>${escapeHtml(lane.reportPath || '')}</code></td><td><code>${escapeHtml(lane.logPath || '')}</code></td></tr>`).join('\n')}
      </tbody>
    </table>
  </section>`
}

function renderAgentActivityMatrix(rows = []) {
  return `<section>
    <h2>Agent Activity Matrix</h2>
    <table>
      <thead><tr><th>Status</th><th>When</th><th>Agent</th><th>Lane / Handoff</th><th>Proof</th><th>Summary</th></tr></thead>
      <tbody>
        ${rows.length === 0 ? '<tr><td colspan="6">No recent local-agent ledger rows found for this repo.</td></tr>' : rows.map(row => `<tr><td><span class="${escapeHtml(row.status || 'yellow')}">${escapeHtml(row.status || 'unknown')}</span></td><td>${escapeHtml(formatAgentActivityTime(row))}</td><td><code>${escapeHtml(row.agent || 'unknown')}</code></td><td>${escapeHtml(row.lane || row.event || 'unlabeled')}<br><code>${escapeHtml(row.handoffStatus || 'unknown')}</code></td><td><code>${escapeHtml(row.proof || 'none recorded')}</code></td><td>${escapeHtml(row.summary || 'no summary')}</td></tr>`).join('\n')}
      </tbody>
    </table>
  </section>`
}

function formatAgentActivityTime(row) {
  const age = row.ageMinutes === null || row.ageMinutes === undefined ? '' : ` (${row.ageMinutes}m old)`
  return `${row.ts || 'unknown'}${age}`
}

function formatHashLines(hash, lines) {
  if (!hash) {
    return 'missing'
  }
  return `${hash} / ${lines === null || lines === undefined ? '?' : lines}l`
}

function formatDelta(delta) {
  if (delta === null || delta === undefined) {
    return 'n/a'
  }
  return delta > 0 ? `+${delta}` : String(delta)
}

function formatReviewDecision(decision) {
  if (!decision) {
    return 'none'
  }
  return `${decision.status || 'unknown'}:${decision.decision || 'unknown'}`
}

function formatPathList(paths) {
  const rows = Array.isArray(paths) ? paths.filter(Boolean) : []
  return rows.length > 0
    ? rows.map(relPath => `<code>${escapeHtml(relPath)}</code>`).join(', ')
    : 'none'
}

function renderRisks(risks) {
  return `<section>
    <h2>Trust Gaps</h2>
    ${risks.length === 0 ? '<p>No current trust gaps found by the local readout.</p>' : `<ul>${risks.map(risk => `<li><strong class="${escapeHtml(risk.status)}">${escapeHtml(risk.label)}</strong>: ${escapeHtml(risk.detail)}</li>`).join('\n')}</ul>`}
  </section>
</div>`
}

function readJsonIfExists(filePath) {
  const text = readTextIfExists(filePath)
  if (!text) {
    return null
  }
  return JSON.parse(text)
}

function readJsoncIfExists(filePath) {
  const text = readTextIfExists(filePath)
  if (!text) {
    return null
  }
  return JSON.parse(stripJsonComments(text))
}

function readTextIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      return ''
    }
    throw error
  }
}

function parseJsonObjectFromMixedOutput(text) {
  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    throw new Error('no JSON object found in command output')
  }
  return JSON.parse(text.slice(firstBrace, lastBrace + 1))
}

function stripJsonComments(text) {
  let output = ''
  let inString = false
  let escaped = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const next = text[index + 1]

    if (!inString && char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') {
        index += 1
      }
      output += '\n'
      continue
    }

    output += char

    if (char === '"' && !escaped) {
      inString = !inString
    }
    escaped = char === '\\' && !escaped
  }

  return output
}

function unique(values) {
  return [...new Set(values)]
}

function arrayDifference(expected = [], actual = []) {
  const actualSet = new Set(actual)
  return expected.filter(value => !actualSet.has(value))
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

module.exports = {
  LOADED_MCP_PROBE_BASENAME,
  REPORT_BASENAME,
  TRUST_PREFLIGHT_BASENAME,
  assessCleanProofReadiness,
  buildAgentActivityMatrix,
  buildEvidenceFreshnessLedger,
  buildLaunchTrustAudit,
  buildMcpCatalogDelta,
  buildReport,
  buildSourcePromotionBundle,
  buildOperatorActionQueue,
  buildOperatorRecoveryFlow,
  buildTrustContracts,
  captureRepoBackedMcpCatalog,
  classifyEvidenceFreshness,
  classifyLoadedMcpProbeFreshness,
  computeRisks,
  evaluateProofManifestMatch,
  evaluateMcpProofFreshness,
  findLatestMcpProofForRepo,
  inspectCloudflareOtelDestinations,
  inspectFirstBiteReviewScoutProducerControlPlane,
  inspectFirstBiteRunnerControlPlane,
  inspectFirstBiteCursorReviewScout,
  inspectFirstBiteMcpRefreshPlan,
  inspectFirstBiteOperatingReadout,
  inspectGrafanaEvidence,
  inspectLaneLog,
  inspectLoadedMcpProbe,
  inspectRepoBackedMcpCatalog,
  inspectTelemetry,
  inspectTrustPreflight,
  inspectTrackedSourceContract,
  main,
  normalizeLoadedMcpPayload,
  parseInbox,
  parseNurseLog,
  renderHtml,
  stripJsonComments,
}
