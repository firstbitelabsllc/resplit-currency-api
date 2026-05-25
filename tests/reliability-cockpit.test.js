const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const {
  assessCleanProofReadiness,
  buildAgentActivityMatrix,
  buildEvidenceFreshnessLedger,
  buildLaunchTrustAudit,
  buildMcpCatalogDelta,
  buildOperatorActionQueue,
  buildOperatorRecoveryFlow,
  buildReport,
  buildSourcePromotionBundle,
  buildTrustContracts,
  captureRepoBackedMcpCatalog,
  computeRisks,
  evaluateProofManifestMatch,
  evaluateMcpProofFreshness,
  findLatestMcpProofForRepo,
  inspectCloudflareOtelDestinations,
  inspectFirstBiteRunnerControlPlane,
  inspectFirstBiteMcpRefreshPlan,
  inspectFirstBiteOperatingReadout,
  inspectGrafanaEvidence,
  inspectLaneLog,
  inspectLoadedMcpProbe,
  inspectRepoBackedMcpCatalog,
  inspectTelemetry,
  inspectTrackedSourceContract,
  parseInbox,
  parseNurseLog,
  renderHtml,
  stripJsonComments,
} = require('../scripts/reliability-cockpit.js')

test('stripJsonComments preserves URL strings while removing line comments', () => {
  const parsed = JSON.parse(stripJsonComments(`{
    // comment
    "endpoint": "https://example.com/otlp",
    "enabled": true
  }`))

  assert.equal(parsed.endpoint, 'https://example.com/otlp')
  assert.equal(parsed.enabled, true)
})

test('parseNurseLog captures latest release-history blocker', () => {
  const log = `# Resplit Nurse Log

## 2026-05-24 04:34 EDT

- \`GO/publish-recovery\`, \`NO-GO/release-readiness\` for \`resplit-currency-api\`.
- Fresh proof:
  - \`npm run reliability:cockpit\` -> regenerated with a \`Release-history strict coverage\` row that cites \`npm run validate:release\` failure (\`available 18/30\`)
  - \`npm run check:publish\` -> pass with known recovery warnings for missing \`2026-05-12\`..\`2026-05-23\`
  - \`npm run validate:release\` -> expected fail (\`available 18/30\`, missing \`2026-05-12\`..\`2026-05-23\`)
- Exact next slice: backfill May 12-23 from an authoritative historical source.
- Current blocker: full 30-calendar-day FX history is not restored.

## 2026-04-22 20:27 EDT

- \`GO/current\` for observability.
`

  const parsed = parseNurseLog(log)

  assert.equal(parsed.latestHeading, '2026-05-24 04:34 EDT')
  assert.equal(parsed.releaseReadiness, 'yellow')
  assert.match(parsed.releaseHistoryEvidence, /available 18\/30/)
  assert.match(parsed.currentBlocker, /FX history/)
  assert.match(parsed.nextSlice, /backfill/)
})

test('parseInbox detects Grafana and release-history rows', () => {
  const parsed = parseInbox(`
- [ ] [2026-05-24] **P1 release-history risk: gap remains.**
- [ ] [2026-05-24] **Grafana Cloud observability on Cloudflare Workers: first-party destinations configured.**
- [ ] [2026-04-16] **Legacy Grafana Cloud observability.** Use @microlabs/otel-cf-workers with OTEL_ENDPOINT.
`)

  assert.equal(parsed.activeItems.length, 3)
  assert.equal(parsed.hasGrafanaItem, true)
  assert.equal(parsed.hasStaleGrafanaItem, true)
  assert.equal(parsed.hasReleaseHistoryItem, true)
})

test('buildAgentActivityMatrix classifies recent local-agent handoffs', () => {
  const rows = buildAgentActivityMatrix([
    {
      ts: '2026-05-25T00:50:00.000Z',
      eid: 'evt_green',
      agentId: 'codex/abc123',
      lane: 'trust-preflight',
      handoffStatus: 'done',
      summary: 'Full trust preflight passed targeted tests.',
      proof: 'node --check pass; generated reports/resplit-fx-trust-preflight.json and reports/resplit-fx-trust-preflight.md',
    },
    {
      ts: '2026-05-25T00:55:00.000Z',
      eid: 'evt_yellow',
      agent_id: 'ledger-emit/local',
      lane: 'handoff',
      handoff_status: 'in_progress',
      summary: 'Writing append-only handoff row.',
      files: ['.agent-ledger/activity.jsonl'],
    },
    {
      ts: '2026-05-25T00:59:00.000Z',
      eid: 'evt_red',
      agentId: 'firstbite-local-ci-mcp/runner',
      lane: 'resplit_currency_api_integration',
      handoffStatus: 'needs_review',
      summary: 'Latest MCP proof command drift needs review.',
      files: ['reports/firstbite/report.json'],
    },
  ], '2026-05-25T01:00:00.000Z')

  assert.deepEqual(rows.map(row => row.status), ['red', 'yellow', 'green'])
  assert.equal(rows[0].agent, 'firstbite-local-ci-mcp')
  assert.equal(rows[0].ageMinutes, 1)
  assert.equal(rows[0].proof, 'reports/firstbite/report.json')
  assert.equal(rows[1].agent, 'ledger-emit')
  assert.equal(rows[2].proof, 'reports/resplit-fx-trust-preflight.json')
})

test('buildAgentActivityMatrix does not treat unresolved as resolved', () => {
  const rows = buildAgentActivityMatrix([{
    ts: '2026-05-25T00:59:00.000Z',
    agentId: 'ledger-emit/local',
    lane: 'trust-surface',
    handoffStatus: 'in_progress',
    summary: 'Cockpit blockers are still unresolved.',
    proof: 'npm run test 163/163 pass',
  }], '2026-05-25T01:00:00.000Z')

  assert.equal(rows[0].status, 'yellow')

  const standaloneResolvedWord = buildAgentActivityMatrix([{
    ts: '2026-05-25T00:59:00.000Z',
    agentId: 'ledger-emit/local',
    lane: 'trust-surface',
    handoffStatus: 'in_progress',
    summary: 'Do not treat a sentence about resolved recovery semantics as recovery proof.',
    proof: 'npm run test 164/164 pass',
  }], '2026-05-25T01:00:00.000Z')

  assert.equal(standaloneResolvedWord[0].status, 'yellow')

  const redVerdictButInProgress = buildAgentActivityMatrix([{
    ts: '2026-05-25T00:59:00.000Z',
    agentId: 'ledger-emit/local',
    lane: 'trust-surface',
    handoffStatus: 'in_progress',
    summary: 'The cockpit verdict is RED - missing required trust contract.',
    proof: 'reports/resplit-fx-reliability-cockpit.html',
  }], '2026-05-25T01:00:00.000Z')

  assert.equal(redVerdictButInProgress[0].status, 'yellow')
})

test('inspectTelemetry reports missing wrangler observability as red', () => {
  const telemetry = inspectTelemetry({ name: 'resplit-fx' }, '/tmp/wrangler.jsonc', { scripts: {} }, '/tmp/repo')

  assert.equal(telemetry.status, 'red')
  assert.equal(telemetry.observability.enabled, false)
  assert.match(telemetry.summary, /missing/)
})

test('inspectTelemetry reports trace config as pending proof', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-cockpit-'))
  fs.mkdirSync(path.join(repoDir, 'scripts'))
  fs.writeFileSync(path.join(repoDir, 'scripts', 'verify-grafana-tempo.mjs'), '')

  const telemetry = inspectTelemetry({
    name: 'resplit-fx',
    observability: {
      enabled: true,
      logs: { enabled: true, head_sampling_rate: 0.1, destinations: ['grafana-logs-prod'] },
      traces: { enabled: true, head_sampling_rate: 0.1, destinations: ['grafana-traces-prod'] },
    },
  }, path.join(repoDir, 'wrangler.jsonc'), {
    scripts: { 'observability:tempo-smoke': 'node scripts/verify-grafana-tempo.mjs' },
  }, repoDir)

  assert.equal(telemetry.status, 'yellow')
  assert.equal(telemetry.observability.scope, 'top-level')
  assert.equal(telemetry.observability.tracesEnabled, true)
  assert.deepEqual(telemetry.observability.destinationNames, ['grafana-traces-prod', 'grafana-logs-prod'])
  assert.deepEqual(telemetry.observability.persistence, { logs: true, traces: true })
  assert.equal(telemetry.grafana.tempoVerifierPresent, true)
  assert.equal(telemetry.grafana.evidence.status, 'missing')
})

test('inspectTelemetry accepts first-party OTEL export blocks without root worker logs', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-cockpit-'))

  const telemetry = inspectTelemetry({
    name: 'resplit-fx',
    observability: {
      logs: {
        enabled: true,
        head_sampling_rate: 0.1,
        persist: false,
        destinations: ['grafana-logs-prod'],
      },
      traces: {
        enabled: true,
        head_sampling_rate: 0.1,
        persist: false,
        destinations: ['grafana-traces-prod'],
      },
    },
  }, path.join(repoDir, 'wrangler.jsonc'), {
    scripts: { 'observability:otel-smoke': 'node scripts/verify-grafana-otel-smoke.js' },
  }, repoDir)

  assert.equal(telemetry.status, 'yellow')
  assert.equal(telemetry.observability.enabled, true)
  assert.equal(telemetry.observability.logsEnabled, true)
  assert.equal(telemetry.observability.tracesEnabled, true)
  assert.deepEqual(telemetry.observability.persistence, { logs: false, traces: false })
  assert.match(telemetry.summary, /config exists/)
})

test('inspectTelemetry recognizes the combined OTEL smoke verifier', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-cockpit-'))
  fs.mkdirSync(path.join(repoDir, 'scripts'))
  const verifierPath = path.join(repoDir, 'scripts', 'verify-grafana-otel-smoke.js')
  fs.writeFileSync(verifierPath, '')

  const telemetry = inspectTelemetry({
    name: 'resplit-fx',
    observability: {
      enabled: true,
      logs: { enabled: true, head_sampling_rate: 0.1, destinations: ['grafana-logs-prod'] },
      traces: { enabled: true, head_sampling_rate: 0.1, destinations: ['grafana-traces-prod'] },
    },
  }, path.join(repoDir, 'wrangler.jsonc'), {
    scripts: { 'observability:otel-smoke': 'node scripts/verify-grafana-otel-smoke.js' },
  }, repoDir)

  assert.equal(telemetry.status, 'yellow')
  assert.equal(telemetry.grafana.tempoVerifierPresent, true)
  assert.deepEqual(telemetry.grafana.verifierPaths, [verifierPath])
  assert.deepEqual(telemetry.grafana.observabilityScripts, ['observability:otel-smoke'])
  assert.equal(telemetry.grafana.evidence.status, 'missing')
})

test('inspectCloudflareOtelDestinations reads sanitized destination proof', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-cockpit-'))
  fs.mkdirSync(path.join(repoDir, 'reports'))
  fs.writeFileSync(path.join(repoDir, 'reports', 'cloudflare-otel-destinations.json'), JSON.stringify({
    checkedAt: '2026-05-24T23:30:00.000Z',
    status: 'green',
    summary: 'Cloudflare Workers Observability destinations match wrangler.jsonc.',
    wrangler: {
      expected: [
        { stream: 'logs', name: 'grafana-logs-prod', dataset: 'opentelemetry-logs' },
      ],
    },
    destinations: [{ name: 'grafana-logs-prod' }],
    checks: [{
      id: 'logs-destination',
      label: 'logs destination grafana-logs-prod',
      status: 'green',
      proof: 'Destination is enabled.',
      nextAction: 'Keep fresh.',
    }],
  }))

  const proof = inspectCloudflareOtelDestinations(repoDir, '2026-05-25T00:00:00.000Z')

  assert.equal(proof.status, 'green')
  assert.equal(proof.ageMinutes, 30)
  assert.deepEqual(proof.destinationNames, ['grafana-logs-prod'])
  assert.equal(proof.checks[0].status, 'green')
})

test('inspectGrafanaEvidence reports missing proof as missing', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-cockpit-'))

  const evidence = inspectGrafanaEvidence(repoDir, '2026-05-25T00:00:00.000Z')

  assert.equal(evidence.status, 'missing')
  assert.equal(evidence.tempoMatched, false)
  assert.equal(evidence.lokiMatched, false)
})

test('inspectGrafanaEvidence accepts fresh JSON Tempo and Loki proof', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-cockpit-'))
  fs.mkdirSync(path.join(repoDir, 'reports'))
  fs.writeFileSync(path.join(repoDir, 'reports', 'grafana-otel-smoke.json'), JSON.stringify({
    checkedAt: '2026-05-24T23:30:00.000Z',
    worker: 'resplit-fx',
    grafana: {
      tempo: { matched: true, traceId: '0123456789abcdef0123456789abcdef' },
      loki: { matched: true },
    },
    checks: [
      {
        id: 'tempo-query',
        label: 'Tempo trace query',
        status: 'green',
        proof: 'Tempo matched 1 trace result.',
        nextAction: 'Keep the trace id attached.',
      },
    ],
  }))

  const evidence = inspectGrafanaEvidence(repoDir, '2026-05-25T00:00:00.000Z')

  assert.equal(evidence.status, 'green')
  assert.equal(evidence.tempoMatched, true)
  assert.equal(evidence.lokiMatched, true)
  assert.equal(evidence.ageMinutes, 30)
  assert.deepEqual(evidence.checks, [
    {
      id: 'tempo-query',
      label: 'Tempo trace query',
      status: 'green',
      proof: 'Tempo matched 1 trace result.',
      nextAction: 'Keep the trace id attached.',
    },
  ])
})

test('inspectGrafanaEvidence keeps stale JSON proof yellow', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-cockpit-'))
  fs.mkdirSync(path.join(repoDir, 'reports'))
  fs.writeFileSync(path.join(repoDir, 'reports', 'grafana-otel-smoke.json'), JSON.stringify({
    checkedAt: '2026-05-23T00:00:00.000Z',
    grafana: {
      tempo: { matched: true, traceId: '0123456789abcdef0123456789abcdef' },
      loki: { matched: true },
    },
  }))

  const evidence = inspectGrafanaEvidence(repoDir, '2026-05-25T00:00:00.000Z')

  assert.equal(evidence.status, 'yellow')
  assert.equal(evidence.tempoMatched, true)
  assert.equal(evidence.lokiMatched, true)
  assert.equal(evidence.ageMinutes, 2880)
})

test('evaluateMcpProofFreshness requires source state and lane artifacts', () => {
  const missingState = evaluateMcpProofFreshness({
    status: 'pass',
    createdAt: '2026-05-24T23:55:00.000Z',
    lanes: [{ sourceHead: 'abc', logPath: '/tmp/run.log' }],
  }, '2026-05-25T00:00:00.000Z')
  const fresh = evaluateMcpProofFreshness({
    status: 'pass',
    createdAt: '2026-05-24T23:55:00.000Z',
    sourceState: { syncStatus: 'dirty', dirtyCount: 1, behindOriginMain: 0, aheadOriginMain: 0 },
    lanes: [{ sourceHead: 'abc', logPath: '/tmp/run.log' }],
  }, '2026-05-25T00:00:00.000Z')
  const warned = evaluateMcpProofFreshness({
    status: 'warn',
    createdAt: '2026-05-24T23:55:00.000Z',
    sourceState: { syncStatus: 'clean', dirtyCount: 0, behindOriginMain: 0, aheadOriginMain: 0 },
    lanes: [{ sourceHead: 'abc', logPath: '/tmp/run.log' }],
  }, '2026-05-25T00:00:00.000Z')

  assert.equal(missingState.status, 'yellow')
  assert.equal(fresh.status, 'green')
  assert.equal(fresh.ageMinutes, 5)
  assert.equal(warned.status, 'yellow')
  assert.match(warned.summary, /expected warning/)
})

test('inspectLaneLog classifies publish grace and live smoke failures', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-cockpit-'))
  const graceLog = path.join(dir, 'grace.log')
  const failLog = path.join(dir, 'fail.log')
  fs.writeFileSync(graceLog, 'smoke-check-deploy: WARNING publish window grace accepted 2026-05-24; strict expected 2026-05-25 until 2026-05-25T03:45:00.000Z\n')
  fs.writeFileSync(failLog, 'smoke-check-deploy: FAILED\nError: cloudflare latest date expected 2026-05-25, got 2026-05-24\n')

  assert.equal(inspectLaneLog(graceLog).status, 'yellow')
  assert.deepEqual(inspectLaneLog(graceLog).tags, ['publish_grace'])
  assert.equal(inspectLaneLog(graceLog, { kind: 'unit' }).status, 'green')
  assert.equal(inspectLaneLog(failLog).status, 'red')
  assert.equal(inspectLaneLog(failLog).summary, 'Error: cloudflare latest date expected 2026-05-25, got 2026-05-24')
  assert.ok(inspectLaneLog(failLog).tags.includes('smoke_failed'))
  const unitLog = path.join(dir, 'unit.log')
  fs.writeFileSync(unitLog, '✖ validate-package still fails when a latest currency artifact is missing\n  Error: ENOENT: no such file or directory, lstat package\n')
  assert.match(inspectLaneLog(unitLog, { kind: 'unit', status: 'fail' }).summary, /validate-package/)
  const warnLog = path.join(dir, 'warn.log')
  fs.writeFileSync(warnLog, '===== FINAL SUMMARY =====\nrc=1\n')
  const warned = inspectLaneLog(warnLog, { kind: 'integration', status: 'warn', reason: 'command exited with expected yellow code 1' })
  assert.equal(warned.status, 'yellow')
  assert.match(warned.summary, /expected yellow code 1/)
  const publishJsonLog = path.join(dir, 'publish-json.log')
  fs.writeFileSync(publishJsonLog, '[FX_PUBLISH] {"error":"cloudflare latest date expected 2026-05-25, got 2026-05-24"}\nsmoke-check-deploy: FAILED\n')
  assert.equal(inspectLaneLog(publishJsonLog).summary, 'Error: cloudflare latest date expected 2026-05-25, got 2026-05-24')
  const githubFallbackLog = path.join(dir, 'github-fallback.log')
  fs.writeFileSync(githubFallbackLog, '[FX_PUBLISH] {"error":"github fallback latest date expected 2026-05-25, got 2026-05-24"}\nsmoke-check-deploy: FAILED\n')
  assert.equal(inspectLaneLog(githubFallbackLog).summary, 'Error: github fallback latest date expected 2026-05-25, got 2026-05-24')
  fs.writeFileSync(path.join(dir, 'generic-fail.log'), 'test runner exited with code 1\n')
  assert.equal(inspectLaneLog(path.join(dir, 'generic-fail.log'), { kind: 'ui', status: 'fail' }).status, 'red')
  assert.match(inspectLaneLog('', { status: 'fail' }).summary, /no lane log path/)
})

test('computeRisks preserves failed local CI as red', () => {
  const risks = computeRisks({
    git: { dirtyCount: 0, behindOriginMain: 0 },
    localCi: { status: 'red', manifestPresent: true, summary: 'latest MCP proof failed', mcpProof: {} },
    telemetry: { status: 'green', summary: 'ok' },
    nurseLog: { releaseReadiness: 'green', currentBlocker: 'the loaded Desktop MCP server still needs reload/restart to see FX.' },
    inbox: { hasStaleGrafanaItem: false },
  })

  assert.equal(risks.find(risk => risk.label === 'Local-CI proof gap')?.status, 'red')
  assert.equal(risks.find(risk => risk.label === 'Loaded MCP server stale')?.status, 'yellow')
})

test('evaluateProofManifestMatch catches same-lane command drift', () => {
  const match = evaluateProofManifestMatch([
    { id: 'resplit_currency_api_integration', command: 'npm ci && npm run check:publish' },
  ], {
    lanes: [
      { lane: 'resplit_currency_api_integration', command: 'npm ci && npm run check' },
    ],
  })

  assert.equal(match.status, 'red')
  assert.equal(match.mismatches[0].lane, 'resplit_currency_api_integration')
  assert.match(match.summary, /command drift/)

  const clean = evaluateProofManifestMatch([
    { id: 'resplit_currency_api_unit', command: 'npm ci && npm run test' },
  ], {
    lanes: [
      { lane: 'resplit_currency_api_unit', command: 'npm   ci && npm run test' },
    ],
  })
  assert.equal(clean.status, 'green')
})

test('inspectTrackedSourceContract exposes untracked manifest and missing HEAD scripts', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-cockpit-git-'))
  const git = (...args) => {
    require('node:child_process').execFileSync('git', args, {
      cwd: repoDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }
  git('init')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test User')
  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({
    scripts: {
      test: 'node --test tests/*.test.js',
      'smoke:deploy': 'node scripts/smoke-check-deploy.js',
    },
  }, null, 2))
  fs.mkdirSync(path.join(repoDir, 'scripts'))
  fs.writeFileSync(path.join(repoDir, 'scripts', 'smoke-check-deploy.js'), '')
  git('add', '.')
  git('commit', '-m', 'initial')
  git('branch', 'origin/main')

  fs.mkdirSync(path.join(repoDir, '.firstbite'))
  const manifest = {
    repo: 'resplit_currency_api',
    localCi: {
      lanes: {
        resplit_currency_api_integration: {
          command: 'npm ci && npm run check:publish',
        },
        resplit_currency_api_ui: {
          command: 'npm ci && npm run smoke:deploy',
        },
      },
    },
  }
  fs.writeFileSync(path.join(repoDir, '.firstbite', 'local-ci.json'), JSON.stringify(manifest, null, 2))
  const packageJson = {
    scripts: {
      generate: 'node currscript.js',
      validate: 'node scripts/validate-package.js',
      test: 'node --test tests/*.test.js',
      'smoke:deploy': 'node scripts/smoke-check-deploy.js',
      'check:publish': 'npm run generate && npm run validate && npm run test',
      'reliability:cockpit': 'node scripts/reliability-cockpit.js',
    },
  }
  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify(packageJson, null, 2))
  fs.writeFileSync(path.join(repoDir, 'currscript.js'), '')
  fs.writeFileSync(path.join(repoDir, 'scripts', 'validate-package.js'), '')
  fs.writeFileSync(path.join(repoDir, 'scripts', 'reliability-cockpit.js'), '')

  const contract = inspectTrackedSourceContract({
    repoDir,
    manifest,
    packageJson,
    manifestPath: path.join(repoDir, '.firstbite', 'local-ci.json'),
  })

  assert.equal(contract.status, 'red')
  assert.equal(contract.files.find(row => row.path === '.firstbite/local-ci.json').headExists, false)
  assert.equal(contract.requiredScripts.find(row => row.name === 'check:publish').headPresent, false)
  assert.equal(contract.manifestLaneCommands.find(row => row.lane === 'resplit_currency_api_integration').status, 'red')
  assert.equal(contract.requiredScripts.find(row => row.name === 'smoke:deploy').status, 'green')
  assert.match(contract.summary, /missing from HEAD/)
})

test('inspectTrackedSourceContract flags tracked manifest command drift', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-cockpit-git-'))
  const git = (...args) => {
    require('node:child_process').execFileSync('git', args, {
      cwd: repoDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }
  git('init')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test User')
  fs.mkdirSync(path.join(repoDir, '.firstbite'), { recursive: true })
  fs.mkdirSync(path.join(repoDir, 'scripts'))
  const trackedManifest = {
    repo: 'resplit_currency_api',
    localCi: {
      lanes: {
        resplit_currency_api_integration: {
          command: 'npm ci && npm run check',
        },
        resplit_currency_api_ui: {
          command: 'npm ci && npm run smoke:deploy',
        },
      },
    },
  }
  const trackedPackageJson = {
    scripts: {
      check: 'npm run generate && npm run validate && npm run test',
      generate: 'node currscript.js',
      validate: 'node scripts/validate-package.js',
      test: 'node --test tests/*.test.js',
      'smoke:deploy': 'node scripts/smoke-check-deploy.js',
      'reliability:cockpit': 'node scripts/reliability-cockpit.js',
    },
  }
  fs.writeFileSync(path.join(repoDir, '.firstbite', 'local-ci.json'), JSON.stringify(trackedManifest, null, 2))
  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify(trackedPackageJson, null, 2))
  fs.writeFileSync(path.join(repoDir, 'currscript.js'), '')
  fs.writeFileSync(path.join(repoDir, 'scripts', 'validate-package.js'), '')
  fs.writeFileSync(path.join(repoDir, 'scripts', 'smoke-check-deploy.js'), '')
  fs.writeFileSync(path.join(repoDir, 'scripts', 'reliability-cockpit.js'), '')
  git('add', '.')
  git('commit', '-m', 'initial')
  git('branch', 'origin/main')

  const currentManifest = {
    repo: 'resplit_currency_api',
    localCi: {
      lanes: {
        resplit_currency_api_integration: {
          command: 'npm ci && npm run check:publish',
        },
        resplit_currency_api_ui: {
          command: 'npm ci && npm run smoke:deploy',
        },
      },
    },
  }
  const currentPackageJson = {
    scripts: {
      ...trackedPackageJson.scripts,
      'check:publish': 'npm run generate && npm run validate && npm run test',
    },
  }
  fs.writeFileSync(path.join(repoDir, '.firstbite', 'local-ci.json'), JSON.stringify(currentManifest, null, 2))
  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify(currentPackageJson, null, 2))

  const contract = inspectTrackedSourceContract({
    repoDir,
    manifest: currentManifest,
    packageJson: currentPackageJson,
    manifestPath: path.join(repoDir, '.firstbite', 'local-ci.json'),
  })
  const integration = contract.manifestLaneCommands.find(row => row.lane === 'resplit_currency_api_integration')
  const ui = contract.manifestLaneCommands.find(row => row.lane === 'resplit_currency_api_ui')

  assert.equal(contract.status, 'red')
  assert.equal(integration.status, 'red')
  assert.equal(integration.currentCommand, 'npm ci && npm run check:publish')
  assert.equal(integration.originCommand, 'npm ci && npm run check')
  assert.equal(ui.status, 'green')
  assert.match(contract.summary, /1 manifest lane command drift/)
})

test('assessCleanProofReadiness blocks clean launch proof when runner target is stale', () => {
  const readiness = assessCleanProofReadiness({
    lanes: [
      { id: 'resplit_currency_api_unit' },
      { id: 'resplit_currency_api_integration' },
      { id: 'resplit_currency_api_ui' },
    ],
    proof: {
      runId: 'clean-drift',
      status: 'pass',
      executionSourceState: {
        syncStatus: 'not_origin_main',
        dirtyCount: 0,
        aheadOriginMain: 0,
        behindOriginMain: 10,
      },
    },
    proofFreshness: { status: 'green', summary: 'fresh' },
    proofManifestMatch: {
      status: 'red',
      summary: 'Latest MCP proof command drift: integration expected "npm run check:publish", ran "npm run check"',
    },
    diagnosticStatus: 'green',
    trackedSource: {
      status: 'red',
      summary: '1 manifest lane command drift(s); 2 untracked/current-only contract file(s)',
    },
    currentManifestProof: {
      runId: 'dirty-current',
      status: 'yellow',
      sourceSummary: 'dirty source, dirty 40, ahead 0, behind 10',
    },
    repoBackedMcpProbe: {
      manifestPortability: {
        fresh_clone_ready: true,
        ready: false,
      },
    },
    git: {
      branch: 'main',
      dirtyCount: 40,
      behindOriginMain: 10,
    },
  })

  assert.equal(readiness.status, 'red')
  assert.match(readiness.runnerContract, /source_ref=refs\/remotes\/origin\/main/)
  assert.match(readiness.summary, /clean-proof readiness issue/)
  assert.match(readiness.nextAction, /Land or sync/)
  assert.match(readiness.commands.cleanWorktree, /"worktree":true/)
  assert.match(readiness.commands.cleanWorktree, /"source_ref":"refs\/remotes\/origin\/main"/)
  assert.match(readiness.commands.dirtySupporting, /"worktree":false/)
  assert.ok(readiness.reasons.some(reason => reason.area === 'manifest commands' && reason.status === 'red'))
  assert.ok(readiness.reasons.some(reason => reason.area === 'current manifest proof' && reason.status === 'yellow'))
})

test('assessCleanProofReadiness trusts pinned origin/main source_ref despite dirty registered checkout', () => {
  const readiness = assessCleanProofReadiness({
    lanes: [
      { id: 'resplit_currency_api_unit' },
      { id: 'resplit_currency_api_integration' },
      { id: 'resplit_currency_api_ui' },
    ],
    proof: {
      runId: 'clean-origin-main',
      status: 'pass',
      requestedSourceRef: 'refs/remotes/origin/main',
      resolvedSourceRef: 'fb37a0fed2d098cf9a015cd0d9102a794bbaadf6',
      executionSourceState: {
        syncStatus: 'origin_main',
        dirtyCount: 0,
        aheadOriginMain: 0,
        behindOriginMain: 0,
      },
    },
    proofFreshness: { status: 'green', summary: 'fresh' },
    proofManifestMatch: { status: 'green', summary: 'commands match' },
    diagnosticStatus: 'green',
    trackedSource: {
      status: 'green',
      summary: 'tracked source contract is clean',
    },
    repoBackedMcpProbe: {
      manifestPortability: {
        fresh_clone_ready: true,
        ready: false,
      },
    },
    git: {
      branch: 'main',
      dirtyCount: 43,
      behindOriginMain: 12,
    },
  })

  assert.equal(readiness.status, 'green')
  assert.match(readiness.summary, /clean-origin-main/)
  assert.equal(readiness.reasons.length, 0)
  assert.equal(readiness.selectedProof.sourceRef, 'refs/remotes/origin/main')
})

test('buildSourcePromotionBundle turns dirty cockpit source into a tracked-source checklist', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-cockpit-promotion-'))
  const git = (...args) => {
    require('node:child_process').execFileSync('git', args, {
      cwd: repoDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }
  git('init')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test User')
  fs.mkdirSync(path.join(repoDir, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({
    scripts: {
      generate: 'node currscript.js',
      test: 'node --test tests/*.test.js',
      'smoke:deploy': 'node scripts/smoke-check-deploy.js',
    },
  }, null, 2))
  fs.writeFileSync(path.join(repoDir, 'currscript.js'), '')
  fs.writeFileSync(path.join(repoDir, 'scripts', 'smoke-check-deploy.js'), '')
  git('add', '.')
  git('commit', '-m', 'initial')
  git('branch', 'origin/main')

  fs.mkdirSync(path.join(repoDir, '.firstbite'), { recursive: true })
  const manifest = {
    repo: 'resplit_currency_api',
    localCi: {
      lanes: {
        resplit_currency_api_integration: {
          command: 'npm ci && npm run check:publish',
        },
        resplit_currency_api_ui: {
          command: 'npm ci && npm run smoke:deploy',
        },
      },
    },
  }
  const packageJson = {
    scripts: {
      generate: 'node currscript.js',
      validate: 'node scripts/validate-package.js',
      test: 'node --test tests/*.test.js',
      'smoke:deploy': 'node scripts/smoke-check-deploy.js',
      'check:publish': 'npm run generate && npm run validate && npm run test',
      'reliability:cockpit': 'node scripts/reliability-cockpit.js',
    },
  }
  fs.writeFileSync(path.join(repoDir, '.firstbite', 'local-ci.json'), JSON.stringify(manifest, null, 2))
  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify(packageJson, null, 2))
  fs.writeFileSync(path.join(repoDir, 'scripts', 'reliability-cockpit.js'), '')

  const trackedSource = inspectTrackedSourceContract({
    repoDir,
    manifest,
    packageJson,
    manifestPath: path.join(repoDir, '.firstbite', 'local-ci.json'),
  })
  const bundle = buildSourcePromotionBundle({
    repoDir,
    trackedSource,
    cleanProofReadiness: {
      status: 'red',
      commands: { cleanWorktree: 'firstbite clean command' },
    },
  })

  assert.equal(bundle.status, 'red')
  assert.equal(bundle.files.find(row => row.path === '.firstbite/local-ci.json').action, 'add to tracked source and publish')
  assert.equal(bundle.files.find(row => row.path === 'package.json').action, 'include modified current source')
  assert.ok(bundle.recommendedPaths.includes('.firstbite/local-ci.json'))
  assert.ok(bundle.recommendedPaths.includes('package.json'))
  assert.ok(bundle.commandDrift.some(row => row.name === 'check:publish' && row.kind === 'package script'))
  assert.match(bundle.commands.inspectStatus, /git status --short --/)
  assert.match(bundle.commands.inspectUntracked, /git ls-files --others/)
  assert.equal(bundle.commands.writePacket, 'npm run source:promotion-packet')
  assert.equal(bundle.commands.reviewPacket, path.join('reports', 'resplit-fx-source-promotion-packet.md'))
  assert.match(bundle.commands.cleanProofAfterPromotion, /firstbite clean command/)
  assert.match(bundle.nextAction, /land the listed current-only and modified/)
})

test('buildSourcePromotionBundle stays green after source lands even when clean proof is still red', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-cockpit-promotion-landed-'))
  const git = (...args) => {
    require('node:child_process').execFileSync('git', args, {
      cwd: repoDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }
  const writeText = (relPath, content = '') => {
    const absPath = path.join(repoDir, relPath)
    fs.mkdirSync(path.dirname(absPath), { recursive: true })
    fs.writeFileSync(absPath, content)
  }
  const writeJson = (relPath, value) => writeText(relPath, `${JSON.stringify(value, null, 2)}\n`)

  git('init')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test User')

  const manifest = {
    repo: 'resplit_currency_api',
    localCi: {
      lanes: {
        resplit_currency_api_unit: {
          command: 'npm ci && npm run generate && npm run test',
        },
        resplit_currency_api_integration: {
          command: 'npm ci && npm run check:publish',
        },
        resplit_currency_api_ui: {
          command: 'npm ci && npm run smoke:deploy',
        },
      },
    },
  }
  const packageJson = {
    scripts: {
      generate: 'node currscript.js',
      validate: 'node scripts/validate-package.js',
      test: 'node --test tests/*.test.js',
      'smoke:deploy': 'node scripts/smoke-check-deploy.js',
      check: 'npm run generate && npm run validate && npm run test',
      'check:publish': 'npm run generate && npm run validate && npm run test',
      'reliability:cockpit': 'node scripts/reliability-cockpit.js',
      'source:promotion-packet': 'node scripts/source-promotion-packet.js',
      'observability:cloudflare-destinations': 'node scripts/verify-cloudflare-otel-destinations.js',
    },
  }

  writeJson('.firstbite/local-ci.json', manifest)
  writeJson('.firstbite/source-promotion-decisions.json', { version: 1, decisions: [] })
  writeJson('package.json', packageJson)
  for (const relPath of [
    'currscript.js',
    'scripts/reliability-cockpit.js',
    'tests/reliability-cockpit.test.js',
    'scripts/source-promotion-packet.js',
    'tests/source-promotion-packet.test.js',
    'scripts/trust-preflight.js',
    'tests/trust-preflight.test.js',
    'scripts/capture-loaded-mcp-probe.js',
    'tests/capture-loaded-mcp-probe.test.js',
    'scripts/verify-grafana-otel-smoke.js',
    'tests/verify-grafana-otel-smoke.test.js',
    'scripts/verify-cloudflare-otel-destinations.js',
    'tests/verify-cloudflare-otel-destinations.test.js',
    'scripts/audit-history-backfill-sources.js',
    'tests/audit-history-backfill-sources.test.js',
    'scripts/smoke-check-deploy.js',
    'tests/smoke-check-deploy.test.js',
    'scripts/validate-package.js',
    'tests/validate-package.test.js',
  ]) {
    writeText(relPath, '')
  }
  git('add', '.')
  git('commit', '-m', 'land source-promotion surface')
  git('branch', 'origin/main')

  const trackedSource = inspectTrackedSourceContract({
    repoDir,
    manifest,
    packageJson,
    manifestPath: path.join(repoDir, '.firstbite', 'local-ci.json'),
  })
  const bundle = buildSourcePromotionBundle({
    repoDir,
    trackedSource,
    cleanProofReadiness: {
      status: 'red',
      commands: { cleanWorktree: 'firstbite clean command' },
    },
  })

  assert.equal(trackedSource.status, 'green')
  assert.equal(bundle.status, 'green')
  assert.equal(bundle.summary, 'Source promotion bundle is tracked; clean worktree proof can target the current cockpit and local-CI contract.')
  assert.equal(bundle.nextAction, 'Run the clean worktree FirstBite command and attach the new report.')
  assert.equal(bundle.counts.currentOnlyFiles, 0)
  assert.equal(bundle.counts.modifiedFiles, 0)
  assert.equal(bundle.counts.missingOriginFiles, 0)
  assert.equal(bundle.counts.commandDrift, 0)
  assert.deepEqual(bundle.recommendedPaths, [])
  assert.equal(bundle.commands.cleanProofAfterPromotion, 'firstbite clean command')
  assert.ok(bundle.files.every(row => row.action === 'already tracked'))
})

test('inspectFirstBiteOperatingReadout surfaces fleet readiness without hiding non-FX failures', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-firstbite-readout-'))
  const runDir = path.join(root, '20260525T064939Z-31520')
  fs.mkdirSync(runDir, { recursive: true })
  const reportPath = path.join(runDir, 'report.json')
  fs.writeFileSync(reportPath, JSON.stringify({
    run_id: '20260525T064939Z-31520',
    created_at: '2026-05-25T06:50:32Z',
    local_ci: {
      latest_lane_count: 18,
      latest_lane_pass_count: 17,
      latest_lane_fail_count: 1,
      run_root: '/tmp/firstbite-local-ci',
      catalog: {
        catalog_version: 'repo-manifest-v2',
        loaded_at: '2026-05-25T06:50:16Z',
        server_pid: 42442,
        lane_count: 15,
        declared_count: 15,
        repo_count: 5,
        repo_keys: ['resplit_web', 'resplit_ios', 'resplit_currency_api', 'strongyes_web', 'moussey'],
        manifest_portability: {
          fresh_clone_ready: true,
          ready: false,
          uncommitted_repo_count: 5,
        },
        manifest_states: [{
          repo: 'resplit_currency_api',
          portability_status: 'untracked',
          porcelain: '?? .firstbite/local-ci.json',
        }],
      },
      latest_lane_proof: [
        { lane: 'resplit_currency_api_unit', repo: 'resplit_currency_api', kind: 'unit', status: 'pass', run_id: 'fx-pass' },
        { lane: 'resplit_ios_ui_full', repo: 'resplit_ios', kind: 'ui', status: 'fail', run_id: 'ios-fail', log_path: '/tmp/ios.log' },
      ],
    },
    moussey_local: {
      verdict: 'ready',
      local_ci_api: { latest_lane_count: 18, latest_lane_pass_count: 17, latest_lane_fail_count: 1 },
      lan_status: { peer_count: 3, healthy_peer_count: 3 },
      proof_rule: 'localhost API success',
    },
    m4_peer_probe: {
      dashboard_url: 'http://Leos-Macbook-M4-Pro.local:4321',
      ssh_host: 'Leos-Macbook-M4-Pro.local',
      verdict: 'stale_receiver_manual_local_refresh_required',
      execution_ready: false,
      proof_rule: 'M4 execution requires an M4-local run_lanes execute report.',
    },
    m4_fresh_clone_packet: {
      available: true,
      latest_report: '/tmp/m4/report.json',
      latest_summary: '/tmp/m4/summary.md',
      latest_commands: '/tmp/m4/fresh-clone-commands.sh',
      run_id: 'm4-fresh-clone-after-mcp15-20260525',
      created_at: '2026-05-25T06:40:00Z',
      completion_gates: [
        'Run generated fresh-clone-commands.sh on the M4 Pro, not Mac Studio.',
        'Only a passing M4-local run_lanes execute report proves M4 execution.',
      ],
      execution_ready: false,
      support_boundary: 'Packet is a handoff only.',
    },
  }, null, 2))

  const readout = inspectFirstBiteOperatingReadout({
    reportRoot: root,
    expectedRepo: 'resplit_currency_api',
    generatedAt: '2026-05-25T06:55:32Z',
  })

  assert.equal(readout.status, 'yellow')
  assert.equal(readout.catalog.version, 'repo-manifest-v2')
  assert.equal(readout.catalog.repoPresent, true)
  assert.equal(readout.localCi.latestLaneFailCount, 1)
  assert.equal(readout.failedLanes[0].lane, 'resplit_ios_ui_full')
  assert.equal(readout.expectedRepoFailures.length, 0)
  assert.equal(readout.mousseyLocal.verdict, 'ready')
  assert.equal(readout.m4PeerProbe.verdict, 'stale_receiver_manual_local_refresh_required')
  assert.equal(readout.m4FreshClonePacket.latestCommands, '/tmp/m4/fresh-clone-commands.sh')
  assert.equal(readout.peerExecutionBoundary.status, 'yellow')
  assert.equal(readout.peerExecutionBoundary.executionReady, false)
  assert.match(readout.peerExecutionBoundary.summary, /support-only/)
  assert.match(readout.summary, /17\/18 lane proof/)
  assert.match(readout.summary, /active_ready=false/)
  assert.match(readout.summary, /M4 peer support-only/)
})

test('inspectFirstBiteMcpRefreshPlan surfaces stale loaded-client process audit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-firstbite-refresh-'))
  const runDir = path.join(root, '20260525T112208Z-16715')
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify({
    runId: '20260525T112208Z-16715',
    createdAt: '2026-05-25T11:22:10Z',
    verdict: 'stale_loaded_clients_need_host_app_restart',
    processAudit: {
      status: 'stale_processes_visible',
      process_count: 19,
      stale_process_count: 17,
      current_process_count: 2,
      stale_pids: [11702],
      current_pids: [9143],
    },
    repoBackedCatalog: {
      catalog_version: 'repo-manifest-v2',
      lane_count: 15,
      declared_count: 15,
      repo_keys: ['resplit_currency_api'],
      lane_keys: ['resplit_currency_api_unit', 'resplit_currency_api_ui'],
    },
    authority: {
      repoBackedCatalogCurrent: true,
    },
    recommendedSteps: [
      'Trust repo-backed npm call for current catalog truth.',
      'Save work and quit/reopen Codex/Cursor if loaded clients expose the stale surface.',
    ],
    continuationCommands: [{
      label: 'Rerun stale MCP refresh plan',
      command: 'bash refresh',
    }],
    safety: {
      readOnly: true,
      killsProcesses: false,
    },
  }, null, 2))

  const plan = inspectFirstBiteMcpRefreshPlan({
    reportRoot: root,
    expectedRepo: 'resplit_currency_api',
    expectedLaneIds: ['resplit_currency_api_unit', 'resplit_currency_api_ui'],
    generatedAt: '2026-05-25T11:25:10Z',
  })

  assert.equal(plan.status, 'yellow')
  assert.equal(plan.verdict, 'stale_loaded_clients_need_host_app_restart')
  assert.equal(plan.staleProcessCount, 17)
  assert.equal(plan.processCount, 19)
  assert.equal(plan.currentProcessCount, 2)
  assert.equal(plan.repoBackedCatalogCurrent, true)
  assert.equal(plan.repoPresent, true)
  assert.deepEqual(plan.missingExpectedLaneIds, [])
  assert.equal(plan.continuationCommands[0].command, 'bash refresh')
  assert.match(plan.summary, /17\/19 stale process/)
  assert.match(plan.nextAction, /restart\/reload Codex\/Cursor/)
})

test('inspectFirstBiteMcpRefreshPlan rejects stale repo-backed catalog against current manifest lanes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-firstbite-refresh-stale-'))
  const runDir = path.join(root, '20260525T112208Z-16715')
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify({
    runId: '20260525T112208Z-16715',
    createdAt: '2026-05-25T11:22:10Z',
    verdict: 'stale_loaded_clients_need_host_app_restart',
    processAudit: {
      status: 'stale_processes_visible',
      process_count: 19,
      stale_process_count: 17,
    },
    repoBackedCatalog: {
      catalog_version: 'repo-manifest-v2',
      lane_count: 15,
      declared_count: 15,
      repo_keys: ['resplit_currency_api'],
      lane_keys: ['resplit_currency_api_unit', 'resplit_currency_api_integration', 'resplit_currency_api_ui'],
    },
    authority: {
      repoBackedCatalogCurrent: true,
    },
  }, null, 2))

  const plan = inspectFirstBiteMcpRefreshPlan({
    reportRoot: root,
    expectedRepo: 'resplit_currency_api',
    expectedLaneIds: [
      'resplit_currency_api_unit',
      'resplit_currency_api_integration',
      'resplit_currency_api_trust_preflight',
      'resplit_currency_api_ui',
    ],
    generatedAt: '2026-05-25T11:25:10Z',
  })

  assert.equal(plan.status, 'red')
  assert.equal(plan.repoBackedCatalogCurrent, false)
  assert.deepEqual(plan.missingExpectedLaneIds, ['resplit_currency_api_trust_preflight'])
  assert.match(plan.summary, /missing current manifest lane/)
})

test('inspectLoadedMcpProbe detects stale in-process lane catalogs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-mcp-probe-'))
  const probePath = path.join(dir, 'firstbite-loaded-mcp-lanes.json')
  fs.writeFileSync(probePath, JSON.stringify({
    checkedAt: '2026-05-25T00:00:00.000Z',
    source: 'codex-mcp-tool:list_lanes',
    content: [{
      type: 'text',
      text: JSON.stringify({
        repos: { resplit_web: { path: '/repo' } },
        lanes: { resplit_web_unit: { repo: 'resplit_web' } },
      }),
    }],
  }))

  const probe = inspectLoadedMcpProbe({
    probePath,
    expectedRepo: 'resplit_currency_api',
    expectedLaneIds: ['resplit_currency_api_unit', 'resplit_currency_api_integration', 'resplit_currency_api_ui'],
    generatedAt: '2026-05-25T00:05:00.000Z',
  })

  assert.equal(probe.status, 'red')
  assert.equal(probe.repoPresent, false)
  assert.equal(probe.missingLaneIds.length, 3)
  assert.equal(probe.freshnessStatus, 'green')
  assert.match(probe.summary, /missing current lanes/)
})

test('inspectLoadedMcpProbe marks old probe artifacts as stale evidence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-mcp-probe-'))
  const probePath = path.join(dir, 'firstbite-loaded-mcp-lanes.json')
  fs.writeFileSync(probePath, JSON.stringify({
    checkedAt: '2026-05-25T00:00:00.000Z',
    repos: { resplit_currency_api: { path: '/repo' } },
    lanes: {
      resplit_currency_api_unit: { repo: 'resplit_currency_api' },
      resplit_currency_api_integration: { repo: 'resplit_currency_api' },
      resplit_currency_api_ui: { repo: 'resplit_currency_api' },
    },
  }))

  const probe = inspectLoadedMcpProbe({
    probePath,
    expectedRepo: 'resplit_currency_api',
    expectedLaneIds: ['resplit_currency_api_unit', 'resplit_currency_api_integration', 'resplit_currency_api_ui'],
    generatedAt: '2026-05-25T02:00:00.000Z',
  })

  assert.equal(probe.status, 'green')
  assert.equal(probe.freshnessStatus, 'yellow')
  assert.match(probe.freshnessSummary, /120m old/)
})

test('inspectLoadedMcpProbe accepts a current repo-manifest catalog', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-mcp-probe-'))
  const probePath = path.join(dir, 'firstbite-loaded-mcp-lanes.json')
  fs.writeFileSync(probePath, JSON.stringify({
    checkedAt: '2026-05-25T00:00:00.000Z',
    source: 'repo-backed package:list_lanes',
    catalog: { catalog_version: 'repo-manifest-v2', restart_hint: 'restart host app' },
    repos: { resplit_currency_api: { path: '/repo' } },
    lanes: {
      resplit_currency_api_unit: { repo: 'resplit_currency_api' },
      resplit_currency_api_integration: { repo: 'resplit_currency_api' },
      resplit_currency_api_ui: { repo: 'resplit_currency_api' },
    },
  }))

  const probe = inspectLoadedMcpProbe({
    probePath,
    expectedRepo: 'resplit_currency_api',
    expectedLaneIds: ['resplit_currency_api_unit', 'resplit_currency_api_integration', 'resplit_currency_api_ui'],
    generatedAt: '2026-05-25T00:05:00.000Z',
  })

  assert.equal(probe.status, 'green')
  assert.equal(probe.repoPresent, true)
  assert.deepEqual(probe.missingLaneIds, [])
  assert.equal(probe.catalogVersion, 'repo-manifest-v2')
})

test('inspectRepoBackedMcpCatalog reports current package catalog and portability', () => {
  const probe = inspectRepoBackedMcpCatalog({
    artifact: {
      checkedAt: '2026-05-25T00:00:00.000Z',
      source: 'repo-backed package:list_lanes',
      content: [{
        type: 'text',
        text: JSON.stringify({
          catalog: {
            catalog_version: 'repo-manifest-v2',
            lane_count: 15,
            manifest_portability: {
              fresh_clone_ready: true,
              ready: false,
            },
            manifest_states: [
              { repo: 'resplit_currency_api', portability_status: 'untracked' },
            ],
          },
          repos: { resplit_currency_api: { path: '/repo' } },
          lanes: {
            resplit_currency_api_unit: { repo: 'resplit_currency_api' },
            resplit_currency_api_integration: { repo: 'resplit_currency_api' },
            resplit_currency_api_ui: { repo: 'resplit_currency_api' },
          },
        }),
      }],
    },
    packageDir: '/mcp/firstbite-local-ci',
    expectedRepo: 'resplit_currency_api',
    expectedLaneIds: ['resplit_currency_api_unit', 'resplit_currency_api_integration', 'resplit_currency_api_ui'],
    generatedAt: '2026-05-25T00:05:00.000Z',
  })

  assert.equal(probe.status, 'green')
  assert.equal(probe.catalogVersion, 'repo-manifest-v2')
  assert.equal(probe.laneCount, 15)
  assert.equal(probe.manifestPortability.fresh_clone_ready, true)
  assert.equal(probe.manifestPortability.ready, false)
  assert.match(probe.summary, /active_ready=false/)
})

test('captureRepoBackedMcpCatalog points package probe at the selected repo dir', () => {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firstbite-package-'))
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: 'firstbite-local-ci' }))
  const repoDir = '/tmp/resplit-fx-worktree'
  let seenOptions = null

  const artifact = captureRepoBackedMcpCatalog({
    packageDir,
    repoDir,
    generatedAt: '2026-05-25T00:00:00.000Z',
    execFile: (_bin, _args, options) => {
      seenOptions = options
      return JSON.stringify({
        content: [{
          type: 'text',
          text: JSON.stringify({
            catalog: { catalog_version: 'repo-manifest-v2', lane_count: 1 },
            repos: { resplit_currency_api: { path: repoDir } },
            lanes: { resplit_currency_api_unit: { repo: 'resplit_currency_api' } },
          }),
        }],
      })
    },
  })

  assert.equal(seenOptions.cwd, packageDir)
  assert.equal(seenOptions.env.RESPLIT_CURRENCY_API_REPO, repoDir)
  assert.equal(seenOptions.env.NO_COLOR, '1')
  assert.equal(artifact.repoDir, repoDir)
  assert.equal(JSON.parse(artifact.content[0].text).repos.resplit_currency_api.path, repoDir)
})

test('inspectRepoBackedMcpCatalog flags package catalog command failures', () => {
  const probe = inspectRepoBackedMcpCatalog({
    artifact: {
      checkedAt: '2026-05-25T00:00:00.000Z',
      source: 'repo-backed package:list_lanes',
      error: 'spawn npm ENOENT',
    },
    packageDir: '/missing',
    expectedRepo: 'resplit_currency_api',
    expectedLaneIds: ['resplit_currency_api_unit'],
    generatedAt: '2026-05-25T00:05:00.000Z',
  })

  assert.equal(probe.status, 'red')
  assert.match(probe.summary, /failed/)
})

test('inspectFirstBiteRunnerControlPlane separates local support from durable ai-leo origin/main', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-leo-runner-'))
  const serverRel = 'skills/resplit-watch/mcp/firstbite-local-ci/src/server.mjs'
  const packageDir = path.join(repoDir, 'skills', 'resplit-watch', 'mcp', 'firstbite-local-ci')
  const serverPath = path.join(repoDir, serverRel)
  const git = args => execFileSync('git', args, {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const writeServer = text => {
    fs.mkdirSync(path.dirname(serverPath), { recursive: true })
    fs.writeFileSync(serverPath, text)
  }

  git(['init', '-b', 'main'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Test Runner'])
  writeServer('const status = rc === 0 ? "pass" : "fail"\n')
  git(['add', serverRel])
  git(['commit', '-m', 'unsupported runner'])
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD'])

  writeServer([
    'const expectedExitCodes = lane.expectedExitCodes',
    'const yellowExitCodes = lane.yellowExitCodes',
    'const exit_classification = "expected_yellow"',
    'const trust_status = "yellow"',
    'const source_ref = resolvedSourceRef',
  ].join('\n'))
  git(['add', serverRel])
  git(['commit', '-m', 'support yellow exits'])
  git(['update-ref', 'refs/remotes/origin/codex/firstbite-mcp-warn-exits-20260525', 'HEAD'])

  const controlPlane = inspectFirstBiteRunnerControlPlane({
    aiLeoRepoDir: repoDir,
    packageDir,
  })

  assert.equal(controlPlane.status, 'yellow')
  assert.equal(controlPlane.activeSupports, true)
  assert.equal(controlPlane.headSupports, true)
  assert.equal(controlPlane.durableSupports, false)
  assert.equal(controlPlane.prSupports, true)
  assert.equal(controlPlane.dirty.length, 0)
  assert.match(controlPlane.summary, /not landed on ai-leo origin\/main/)
  assert.match(controlPlane.nextAction, /Merge ai-leo PR #11/)
  assert.equal(controlPlane.rows.find(row => row.id === 'workingTree').status, 'green')
  assert.equal(controlPlane.rows.find(row => row.id === 'head').status, 'green')
  assert.equal(controlPlane.rows.find(row => row.id === 'originMain').status, 'red')
  assert.deepEqual(controlPlane.rows.find(row => row.id === 'prBranch').missingTokens, [])
})

test('inspectFirstBiteRunnerControlPlane treats origin/main plus active package support as durable despite stale local HEAD', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-leo-runner-durable-'))
  const serverRel = 'skills/resplit-watch/mcp/firstbite-local-ci/src/server.mjs'
  const packageDir = path.join(repoDir, 'skills', 'resplit-watch', 'mcp', 'firstbite-local-ci')
  const serverPath = path.join(repoDir, serverRel)
  const git = args => execFileSync('git', args, {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const writeServer = text => {
    fs.mkdirSync(path.dirname(serverPath), { recursive: true })
    fs.writeFileSync(serverPath, text)
  }
  const supportedServer = [
    'const expectedExitCodes = lane.expectedExitCodes',
    'const yellowExitCodes = lane.yellowExitCodes',
    'const exit_classification = "expected_yellow"',
    'const trust_status = "yellow"',
    'const source_ref = resolvedSourceRef',
  ].join('\n')

  git(['init', '-b', 'main'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Test Runner'])
  writeServer('const status = rc === 0 ? "pass" : "fail"\n')
  git(['add', serverRel])
  git(['commit', '-m', 'unsupported runner'])
  writeServer(supportedServer)
  git(['add', serverRel])
  git(['commit', '-m', 'support yellow exits'])
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD'])
  git(['reset', '--hard', 'HEAD~1'])
  writeServer(supportedServer)

  const controlPlane = inspectFirstBiteRunnerControlPlane({
    aiLeoRepoDir: repoDir,
    packageDir,
  })

  assert.equal(controlPlane.status, 'green')
  assert.equal(controlPlane.activeSupports, true)
  assert.equal(controlPlane.headSupports, false)
  assert.equal(controlPlane.durableSupports, true)
  assert.match(controlPlane.summary, /local ai-leo HEAD is stale/)
  assert.match(controlPlane.nextAction, /Restart or reload/)
  assert.doesNotMatch(controlPlane.nextAction, /PR #11/)
  assert.equal(controlPlane.rows.find(row => row.id === 'workingTree').status, 'green')
  assert.equal(controlPlane.rows.find(row => row.id === 'head').status, 'red')
  assert.equal(controlPlane.rows.find(row => row.id === 'originMain').status, 'green')
})

test('buildMcpCatalogDelta explains loaded host drift against repo-backed catalog', () => {
  const delta = buildMcpCatalogDelta({
    expectedRepo: 'resplit_currency_api',
    expectedLaneIds: [
      'resplit_currency_api_unit',
      'resplit_currency_api_integration',
      'resplit_currency_api_ui',
    ],
    loadedMcpProbe: {
      status: 'red',
      freshnessStatus: 'green',
      checkedAt: '2026-05-25T08:00:00.000Z',
      laneCount: 12,
      catalogVersion: null,
      repoKeys: ['resplit_web', 'resplit_ios', 'strongyes_web', 'moussey'],
      groupKeys: ['critical_fast', 'all_critical'],
      allLaneIds: ['resplit_web_unit', 'resplit_ios_unit'],
    },
    repoBackedMcpProbe: {
      status: 'green',
      checkedAt: '2026-05-25T08:00:00.000Z',
      laneCount: 15,
      catalogVersion: 'repo-manifest-v2',
      repoKeys: ['resplit_web', 'resplit_ios', 'resplit_currency_api', 'strongyes_web', 'moussey'],
      groupKeys: ['critical_fast', 'all_critical', 'resplit_currency_api_all'],
      allLaneIds: [
        'resplit_web_unit',
        'resplit_ios_unit',
        'resplit_currency_api_unit',
        'resplit_currency_api_integration',
        'resplit_currency_api_ui',
      ],
    },
  })

  assert.equal(delta.status, 'red')
  assert.deepEqual(delta.missingReposInLoaded, ['resplit_currency_api'])
  assert.deepEqual(delta.missingExpectedLanesInLoaded, [
    'resplit_currency_api_unit',
    'resplit_currency_api_integration',
    'resplit_currency_api_ui',
  ])
  assert.deepEqual(delta.missingGroupsInLoaded, ['resplit_currency_api_all'])
  assert.match(delta.summary, /missing 1 repo/)
  assert.match(delta.nextAction, /Restart or reload/)
})

test('computeRisks flags loaded MCP catalog drift from probe artifacts', () => {
  const risks = computeRisks({
    git: { dirtyCount: 0, behindOriginMain: 0 },
    localCi: {
      status: 'green',
      summary: 'ok',
      proofFreshness: { status: 'green', summary: 'fresh' },
      mcpProof: {},
      loadedMcpProbe: { status: 'red', summary: 'Loaded MCP probe is stale for resplit_currency_api.' },
    },
    telemetry: { status: 'green', summary: 'ok' },
    nurseLog: { releaseReadiness: 'green', currentBlocker: 'the loaded Desktop MCP server still needs reload/restart to see FX.' },
    inbox: { hasStaleGrafanaItem: false },
  })

  assert.equal(risks.find(risk => risk.label === 'Loaded MCP lane catalog gap')?.status, 'red')
  assert.equal(risks.some(risk => risk.label === 'Loaded MCP server stale'), false)
})

test('computeRisks flags stale loaded MCP probe artifacts separately from catalog status', () => {
  const risks = computeRisks({
    git: { dirtyCount: 0, behindOriginMain: 0 },
    localCi: {
      status: 'green',
      summary: 'ok',
      proofFreshness: { status: 'green', summary: 'fresh' },
      mcpProof: {},
      loadedMcpProbe: {
        status: 'green',
        summary: 'Loaded MCP probe sees resplit_currency_api.',
        freshnessStatus: 'yellow',
        freshnessSummary: 'Loaded MCP probe artifact is stale: 120m old.',
      },
    },
    telemetry: { status: 'green', summary: 'ok' },
    nurseLog: { releaseReadiness: 'green' },
    inbox: { hasStaleGrafanaItem: false },
  })

  assert.equal(risks.find(risk => risk.label === 'Loaded MCP probe freshness gap')?.status, 'yellow')
})

test('findLatestMcpProofForRepo prefers complete manifest proof over newer partial proof', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-cockpit-'))
  const mcpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-mcp-'))
  fs.mkdirSync(path.join(mcpRoot, 'complete'))
  fs.mkdirSync(path.join(mcpRoot, 'partial'))

  const completePath = path.join(mcpRoot, 'complete', 'report.json')
  const partialPath = path.join(mcpRoot, 'partial', 'report.json')
  fs.mkdirSync(path.join(mcpRoot, 'failed'))
  const failedPath = path.join(mcpRoot, 'failed', 'report.json')
  fs.writeFileSync(completePath, JSON.stringify({
    run_id: 'complete',
    mode: 'execute',
    created_at: '2026-05-25T00:00:00.000Z',
    lanes: [
      { lane: 'lane_a', repo: 'repo_key', kind: 'unit', status: 'pass', source_head: 'abc', log_path: '/tmp/a.log' },
      { lane: 'lane_b', repo: 'repo_key', kind: 'ui', status: 'pass', source_head: 'abc', log_path: '/tmp/b.log' },
    ],
  }))
  fs.writeFileSync(partialPath, JSON.stringify({
    run_id: 'partial',
    mode: 'execute',
    created_at: '2026-05-25T00:01:00.000Z',
    lanes: [
      { lane: 'lane_b', repo: 'repo_key', kind: 'ui', status: 'pass', source_head: 'abc', log_path: '/tmp/b.log' },
    ],
  }))
  fs.writeFileSync(failedPath, JSON.stringify({
    run_id: 'failed',
    mode: 'execute',
    created_at: '2026-05-24T23:59:00.000Z',
    overall: 'fail',
    lanes: [
      { lane: 'lane_a', repo: 'repo_key', kind: 'unit', status: 'pass', source_head: 'abc', log_path: '/tmp/a.log' },
      { lane: 'lane_b', repo: 'repo_key', kind: 'ui', status: 'fail', source_head: 'abc', log_path: '/tmp/b.log' },
    ],
  }))
  fs.utimesSync(completePath, new Date('2026-05-25T00:00:00Z'), new Date('2026-05-25T00:00:00Z'))
  fs.utimesSync(partialPath, new Date('2026-05-25T00:01:00Z'), new Date('2026-05-25T00:01:00Z'))
  fs.utimesSync(failedPath, new Date('2026-05-24T23:59:00Z'), new Date('2026-05-24T23:59:00Z'))

  const proof = findLatestMcpProofForRepo({
    repoDir,
    repoKey: 'repo_key',
    expectedLaneIds: ['lane_a', 'lane_b'],
    reportRoot: mcpRoot,
  })

  assert.equal(proof.latest.runId, 'complete')
  assert.equal(proof.latest.coverage.complete, true)
  assert.equal(proof.latestPartial.runId, 'partial')
  assert.deepEqual(proof.latestPartial.coverage.missingLaneIds, ['lane_a'])
  assert.deepEqual(proof.history.map(item => item.runId), ['partial', 'complete', 'failed'])
  assert.deepEqual(proof.history.map(item => item.trustStatus), ['yellow', 'yellow', 'red'])
})

test('findLatestMcpProofForRepo distinguishes primary checkout from execution worktree', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-cockpit-'))
  const mcpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-mcp-'))
  fs.mkdirSync(path.join(mcpRoot, 'worktree-proof'))
  fs.writeFileSync(path.join(mcpRoot, 'worktree-proof', 'report.json'), JSON.stringify({
    run_id: 'worktree-proof',
    mode: 'execute',
    created_at: '2026-05-25T00:00:00.000Z',
    overall: 'pass',
    source_ref: 'refs/remotes/origin/main',
    lanes: [
      {
        lane: 'lane_a',
        repo: 'repo_key',
        kind: 'unit',
        command: 'npm run test',
        status: 'pass',
        source_head: 'abc',
        requested_source_ref: 'refs/remotes/origin/main',
        resolved_source_ref: 'abcdef1234567890',
        log_path: '/tmp/a.log',
        worktree: true,
        cwd: '/tmp/firstbite-local-ci/lane_a',
        primary_source_state: {
          repo_path: repoDir,
          exists: true,
          is_git: true,
          branch: 'main',
          head: 'abc',
          upstream: 'origin/main',
          upstream_head: 'def',
          dirty_count: 12,
          ahead_origin_main: 0,
          behind_origin_main: 9,
          sync_status: 'dirty',
        },
        execution_source_state: {
          repo_path: '/tmp/firstbite-local-ci/lane_a',
          exists: true,
          is_git: true,
          branch: '',
          head: 'abc',
          upstream: null,
          upstream_head: 'def',
          dirty_count: 0,
          ahead_origin_main: 0,
          behind_origin_main: 9,
          sync_status: 'not_origin_main',
        },
      },
      {
        lane: 'lane_b',
        repo: 'repo_key',
        kind: 'ui',
        status: 'pass',
        source_head: 'abc',
        requested_source_ref: 'refs/remotes/origin/main',
        resolved_source_ref: 'abcdef1234567890',
        log_path: '/tmp/b.log',
        worktree: true,
        cwd: '/tmp/firstbite-local-ci/lane_b',
        primary_source_state: {
          repo_path: repoDir,
          exists: true,
          is_git: true,
          branch: 'main',
          head: 'abc',
          upstream: 'origin/main',
          upstream_head: 'def',
          dirty_count: 12,
          ahead_origin_main: 0,
          behind_origin_main: 9,
          sync_status: 'dirty',
        },
        execution_source_state: {
          repo_path: '/tmp/firstbite-local-ci/lane_b',
          exists: true,
          is_git: true,
          branch: '',
          head: 'abc',
          upstream: null,
          upstream_head: 'def',
          dirty_count: 0,
          ahead_origin_main: 0,
          behind_origin_main: 9,
          sync_status: 'not_origin_main',
        },
      },
    ],
  }))

  const proof = findLatestMcpProofForRepo({
    repoDir,
    repoKey: 'repo_key',
    expectedLaneIds: ['lane_a', 'lane_b'],
    reportRoot: mcpRoot,
  })

  assert.equal(proof.latest.sourceState.syncStatus, 'not_origin_main')
  assert.equal(proof.latest.sourceState.dirtyCount, 0)
  assert.equal(proof.latest.requestedSourceRef, 'refs/remotes/origin/main')
  assert.equal(proof.latest.resolvedSourceRef, 'abcdef1234567890')
  assert.equal(proof.latest.primarySourceState.syncStatus, 'dirty')
  assert.equal(proof.latest.primarySourceState.dirtyCount, 12)
  assert.equal(proof.latest.lanes[0].worktree, true)
  assert.equal(proof.latest.lanes[0].requestedSourceRef, 'refs/remotes/origin/main')
  assert.equal(proof.latest.lanes[0].executionSourceState.repoPath, '/tmp/firstbite-local-ci/lane_a')
  assert.equal(proof.history[0].requestedSourceRef, 'refs/remotes/origin/main')
  assert.equal(proof.history[0].sourceState.syncStatus, 'not_origin_main')
  assert.equal(proof.history[0].primarySourceState.syncStatus, 'dirty')
})

test('findLatestMcpProofForRepo keeps expected yellow lane exits as yellow proof', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-cockpit-'))
  const mcpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-mcp-'))
  fs.mkdirSync(path.join(mcpRoot, 'warn-proof'))
  const cleanSource = {
    repo_path: '/tmp/firstbite-clean',
    exists: true,
    is_git: true,
    head: 'abc',
    upstream_head: 'abc',
    dirty_count: 0,
    ahead_origin_main: 0,
    behind_origin_main: 0,
    sync_status: 'origin_main',
  }

  fs.writeFileSync(path.join(mcpRoot, 'warn-proof', 'report.json'), JSON.stringify({
    run_id: 'warn-proof',
    mode: 'execute',
    created_at: '2026-05-25T00:00:00.000Z',
    overall: 'warn',
    lanes: [
      {
        lane: 'lane_a',
        repo: 'repo_key',
        kind: 'unit',
        command: 'npm run test',
        status: 'pass',
        rc: 0,
        source_head: 'abc',
        log_path: '/tmp/a.log',
        execution_source_state: cleanSource,
      },
      {
        lane: 'lane_b',
        repo: 'repo_key',
        kind: 'integration',
        command: 'npm run trust:preflight',
        status: 'warn',
        rc: 1,
        reason: 'command exited with expected yellow code 1',
        expected_exit_codes: [0, 1],
        yellow_exit_codes: [1],
        exit_classification: 'expected_yellow',
        trust_status: 'yellow',
        source_head: 'abc',
        log_path: '/tmp/b.log',
        execution_source_state: cleanSource,
      },
    ],
  }))

  const proof = findLatestMcpProofForRepo({
    repoDir,
    repoKey: 'repo_key',
    expectedLaneIds: ['lane_a', 'lane_b'],
    reportRoot: mcpRoot,
  })

  assert.equal(proof.latest.runId, 'warn-proof')
  assert.equal(proof.latest.status, 'warn')
  assert.equal(proof.latest.lanes[1].diagnostics.status, 'yellow')
  assert.deepEqual(proof.latest.lanes[1].yellowExitCodes, [1])
  assert.deepEqual(proof.history.map(item => item.trustStatus), ['yellow'])
})

test('findLatestMcpProofForRepo keeps clean execution proof ahead of newer dirty active proof', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-cockpit-'))
  const mcpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-mcp-'))
  fs.mkdirSync(path.join(mcpRoot, 'clean-red'))
  fs.mkdirSync(path.join(mcpRoot, 'dirty-green'))

  const cleanPath = path.join(mcpRoot, 'clean-red', 'report.json')
  const dirtyPath = path.join(mcpRoot, 'dirty-green', 'report.json')
  const cleanSource = {
    repo_path: '/tmp/firstbite-clean',
    exists: true,
    is_git: true,
    head: 'abc',
    upstream_head: 'def',
    dirty_count: 0,
    ahead_origin_main: 0,
    behind_origin_main: 9,
    sync_status: 'not_origin_main',
  }
  const dirtySource = {
    repo_path: repoDir,
    exists: true,
    is_git: true,
    branch: 'main',
    head: 'abc',
    upstream: 'origin/main',
    upstream_head: 'def',
    dirty_count: 35,
    ahead_origin_main: 0,
    behind_origin_main: 9,
    sync_status: 'dirty',
  }

  fs.writeFileSync(cleanPath, JSON.stringify({
    run_id: 'clean-red',
    mode: 'execute',
    created_at: '2026-05-25T00:00:00.000Z',
    overall: 'fail',
    lanes: [
      { lane: 'lane_a', repo: 'repo_key', kind: 'unit', status: 'fail', source_head: 'abc', worktree: true, execution_source_state: cleanSource, primary_source_state: dirtySource },
      { lane: 'lane_b', repo: 'repo_key', kind: 'ui', status: 'pass', source_head: 'abc', worktree: true, execution_source_state: cleanSource, primary_source_state: dirtySource },
    ],
  }))
  fs.writeFileSync(dirtyPath, JSON.stringify({
    run_id: 'dirty-green',
    mode: 'execute',
    created_at: '2026-05-25T00:01:00.000Z',
    overall: 'pass',
    lanes: [
      { lane: 'lane_a', repo: 'repo_key', kind: 'unit', status: 'pass', source_head: 'abc', worktree: false, execution_source_state: dirtySource, primary_source_state: dirtySource },
      { lane: 'lane_b', repo: 'repo_key', kind: 'ui', status: 'pass', source_head: 'abc', worktree: false, execution_source_state: dirtySource, primary_source_state: dirtySource },
    ],
  }))
  fs.utimesSync(cleanPath, new Date('2026-05-25T00:00:00Z'), new Date('2026-05-25T00:00:00Z'))
  fs.utimesSync(dirtyPath, new Date('2026-05-25T00:01:00Z'), new Date('2026-05-25T00:01:00Z'))

  const proof = findLatestMcpProofForRepo({
    repoDir,
    repoKey: 'repo_key',
    expectedLaneIds: ['lane_a', 'lane_b'],
    reportRoot: mcpRoot,
  })

  assert.equal(proof.latest.runId, 'clean-red')
  assert.equal(proof.latest.status, 'fail')
  assert.equal(proof.latest.executionSourceState.dirtyCount, 0)
  assert.equal(proof.latestComplete.runId, 'dirty-green')
  assert.equal(proof.latestCleanComplete.runId, 'clean-red')
  assert.deepEqual(proof.history.map(item => item.runId), ['dirty-green', 'clean-red'])
  assert.deepEqual(proof.history.map(item => item.trustStatus), ['yellow', 'red'])
})

test('inspectTelemetry prefers production observability when present', () => {
  const telemetry = inspectTelemetry({
    name: 'resplit-fx',
    observability: {
      enabled: true,
      logs: { enabled: true, head_sampling_rate: 1, destinations: ['dev-logs'] },
      traces: { enabled: true, head_sampling_rate: 1, destinations: ['dev-traces'] },
    },
    env: {
      production: {
        observability: {
          enabled: true,
          logs: { enabled: true, head_sampling_rate: 0.1, destinations: ['grafana-logs-prod'] },
          traces: { enabled: true, head_sampling_rate: 0.1, destinations: ['grafana-traces-prod'] },
        },
      },
    },
  }, '/tmp/wrangler.jsonc', { scripts: {} }, '/tmp/repo')

  assert.equal(telemetry.observability.scope, 'env.production')
  assert.equal(telemetry.observability.sampling.logs, 0.1)
  assert.deepEqual(telemetry.observability.destinationNames, ['grafana-traces-prod', 'grafana-logs-prod'])
})

test('buildReport joins manifest, nurse, inbox, ledger, and MCP proof', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-cockpit-'))
  fs.mkdirSync(path.join(repoDir, '.firstbite'), { recursive: true })
  fs.mkdirSync(path.join(repoDir, '.cursor', 'plans'), { recursive: true })
  fs.mkdirSync(path.join(repoDir, '.agent-ledger'), { recursive: true })
  fs.mkdirSync(path.join(repoDir, 'reports'), { recursive: true })
  fs.mkdirSync(path.join(repoDir, 'scripts'), { recursive: true })

  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({
    name: 'resplit-currency-api',
    scripts: {
      test: 'node --test tests/*.test.js',
      'check:publish': 'npm run generate && npm run validate && npm run test',
      check: 'npm run generate && npm run validate:release && npm run test',
      'smoke:deploy': 'node scripts/smoke-check-deploy.js',
      'audit:backfill-sources': 'node scripts/audit-history-backfill-sources.js',
    },
  }))
  fs.writeFileSync(path.join(repoDir, '.firstbite', 'local-ci.json'), JSON.stringify({
    version: 1,
    repo: 'resplit_currency_api',
    display: 'Resplit FX',
    localCi: {
      lanes: {
        resplit_currency_api_unit: { kind: 'unit', command: 'npm run test', timeoutMs: 1 },
        resplit_currency_api_integration: { kind: 'integration', command: 'npm run check:publish', timeoutMs: 1 },
        resplit_currency_api_ui: { kind: 'ui', command: 'npm run smoke:deploy', timeoutMs: 1 },
      },
    },
  }))
  fs.writeFileSync(path.join(repoDir, 'wrangler.jsonc'), JSON.stringify({ name: 'resplit-fx' }))
  fs.writeFileSync(path.join(repoDir, 'reports', 'firstbite-loaded-mcp-lanes.json'), JSON.stringify({
    checkedAt: '2026-05-24T23:58:00.000Z',
    source: 'codex-mcp-tool:list_lanes',
    catalog: { catalog_version: 'repo-manifest-v2' },
    repos: { resplit_currency_api: { path: repoDir } },
    lanes: {
      resplit_currency_api_unit: { repo: 'resplit_currency_api' },
      resplit_currency_api_integration: { repo: 'resplit_currency_api' },
      resplit_currency_api_ui: { repo: 'resplit_currency_api' },
    },
  }))
  fs.writeFileSync(path.join(repoDir, '.cursor', 'plans', 'resplit-nurse.log.md'), `## 2026-05-24 04:34 EDT
- \`NO-GO/release-readiness\`
- Current blocker: history missing.
`)
  fs.writeFileSync(path.join(repoDir, 'INBOX.md'), '- [ ] **Grafana Cloud observability on Cloudflare Workers.**\n')
  fs.writeFileSync(path.join(repoDir, '.agent-ledger', 'activity.jsonl'), '{"ts":"now","agent_id":"codex/test","summary":"ok"}\n')
  const sharedLedgerPath = path.join(repoDir, 'shared-ledger.jsonl')
  fs.writeFileSync(sharedLedgerPath, `${JSON.stringify({
    ts: '2026-05-24T23:30:00.000Z',
    eid: 'evt_fail',
    event: 'stop',
    repo: 'resplit-currency-api',
    lane: 'resplit-fx-reliability-cockpit',
    agent_id: 'ledger-emit/fail',
    summary: 'Cockpit current verdict is red because latest direct MCP aggregate failed on live Worker date freshness.',
    files: ['scripts/reliability-cockpit.js'],
  })}\n${JSON.stringify({
    ts: '2026-05-24T23:50:00.000Z',
    eid: 'evt_shared',
    event: 'stop',
    repo: 'resplit-currency-api',
    lane: 'resplit-fx-reliability-cockpit',
    agent_id: 'ledger-emit/test',
    summary: 'Resplit FX reliability cockpit recovered live freshness; latest full MCP aggregate passes unit, integration, and live smoke.',
    files: ['scripts/reliability-cockpit.js'],
  })}\n${JSON.stringify({
    ts: '2026-05-24T23:55:00.000Z',
    eid: 'evt_repair',
    event: 'stop',
    repo: 'resplit-currency-api',
    lane: 'resplit-fx-reliability-cockpit',
    agent_id: 'ledger-emit/repair',
    summary: 'Resolved stale Resplit FX cockpit red ledger marker after live freshness recovery proof.',
    proof: 'repairs:evt_fail; full MCP aggregate PASS',
    handoff_status: 'resolved',
    files: ['scripts/reliability-cockpit.js'],
  })}\n${JSON.stringify({
    ts: '2026-05-24T23:57:00.000Z',
    eid: 'evt_review',
    event: 'stop',
    repo: 'resplit-currency-api',
    lane: 'fx-otel-grafana-trust',
    agent_id: 'codex/review',
    summary: 'Draft PR remains review-needed while external Grafana proof is pending.',
    proof: 'Cloudflare destination and Grafana read-token proof still separate from local cockpit work.',
    handoff_status: 'needs_review',
    files: ['scripts/reliability-cockpit.js'],
  })}\n`)

  const mcpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-mcp-'))
  fs.mkdirSync(path.join(mcpRoot, 'run-1'))
  fs.writeFileSync(path.join(mcpRoot, 'run-1', 'report.json'), JSON.stringify({
    run_id: 'run-1',
    mode: 'execute',
    created_at: '2026-05-24T23:55:00.000Z',
    overall: 'pass',
    host: 'local',
    lanes: [
      {
        lane: 'resplit_currency_api_unit',
        repo: 'resplit_currency_api',
        kind: 'unit',
        command: 'npm run test',
        status: 'pass',
        rc: 0,
        source_head: 'abc',
        log_path: '/tmp/run.log',
        source_state: {
          repo_path: repoDir,
          exists: true,
          is_git: true,
          branch: 'main',
          head: 'abc',
          upstream: 'origin/main',
          upstream_head: 'abc',
          dirty_count: 0,
          ahead_origin_main: 0,
          behind_origin_main: 0,
          sync_status: 'clean',
        },
      },
      {
        lane: 'resplit_currency_api_integration',
        repo: 'resplit_currency_api',
        kind: 'integration',
        command: 'npm run check:publish',
        status: 'pass',
        rc: 0,
        source_head: 'abc',
        log_path: '/tmp/run-integration.log',
        source_state: {
          repo_path: repoDir,
          exists: true,
          is_git: true,
          branch: 'main',
          head: 'abc',
          upstream: 'origin/main',
          upstream_head: 'abc',
          dirty_count: 0,
          ahead_origin_main: 0,
          behind_origin_main: 0,
          sync_status: 'clean',
        },
      },
      {
        lane: 'resplit_currency_api_ui',
        repo: 'resplit_currency_api',
        kind: 'ui',
        command: 'npm run smoke:deploy',
        status: 'pass',
        rc: 0,
        source_head: 'abc',
        log_path: '/tmp/run-ui.log',
        source_state: {
          repo_path: repoDir,
          exists: true,
          is_git: true,
          branch: 'main',
          head: 'abc',
          upstream: 'origin/main',
          upstream_head: 'abc',
          dirty_count: 0,
          ahead_origin_main: 0,
          behind_origin_main: 0,
          sync_status: 'clean',
        },
      },
    ],
  }))

  const report = buildReport({
    repoDir,
    generatedAt: '2026-05-25T00:00:00.000Z',
    gitState: { status: 'clean', dirtyCount: 0, branch: 'main', head: 'abc', originMain: 'abc', behindOriginMain: 0 },
    mcpReportRoot: mcpRoot,
    sharedLedgerPath,
  })

  assert.equal(report.localCi.lanes.length, 3)
  assert.equal(report.localCi.status, 'green')
  assert.equal(report.localCi.proofManifestMatch.status, 'green')
  assert.equal(report.localCi.mcpProof.latest.runId, 'run-1')
  assert.equal(report.localCi.mcpProof.history.length, 1)
  assert.equal(report.localCi.proofFreshness.status, 'green')
  assert.equal(report.localCi.mcpProof.latest.sourceState.syncStatus, 'clean')
  assert.equal(report.localCi.loadedMcpProbe.status, 'green')
  assert.equal(report.localCi.loadedMcpProbe.loadedLaneIds.length, 3)
  assert.equal(report.telemetry.status, 'red')
  assert.equal(report.telemetry.grafana.evidence.status, 'missing')
  assert.equal(report.agentState.inbox.hasGrafanaItem, true)
  assert.equal(report.agentState.inbox.hasStaleGrafanaItem, false)
  assert.equal(report.agentState.ledger.repo.recentEntries.length, 1)
  assert.equal(report.agentState.ledger.shared.recentEntries.length, 4)
  assert.equal(report.agentState.ledger.shared.recentEntries[2].summary, 'Resolved stale Resplit FX cockpit red ledger marker after live freshness recovery proof.')
  assert.equal(report.agentState.ledger.shared.recentEntries[3].handoffStatus, 'needs_review')
  assert.equal(report.agentState.ledger.health.status, 'yellow')
  assert.equal(report.agentState.ledger.health.failureRows.length, 1)
  assert.equal(report.agentState.ledger.health.recoveryRows.length, 2)
  assert.equal(report.agentState.ledger.health.repairRows.length, 1)
  assert.equal(report.agentState.ledger.health.summary, '1 failure row(s) found in the last 24h, all with later recovery evidence. Append-only repair marker(s) are present for the stale failure history.')
  assert.equal(report.trustModel.risks.some(risk => risk.label === 'Agent ledger failure history'), false)
  assert.equal(report.trustModel.launchTrustAudit.status, 'red')
  assert.equal(report.trustModel.launchTrustAudit.rows.find(row => row.id === 'repo-backed-mcp-source').claimAllowed, false)
  assert.match(renderHtml(report), /Launch Trust Audit/)
})

test('buildReport surfaces newer current-manifest proof without overriding clean-source selection', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-cockpit-'))
  fs.mkdirSync(path.join(repoDir, '.firstbite'), { recursive: true })
  fs.mkdirSync(path.join(repoDir, 'reports'), { recursive: true })

  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({
    name: 'resplit-currency-api',
    scripts: {
      test: 'node --test tests/*.test.js',
      'check:publish': 'npm run generate && npm run validate && npm run test',
      'smoke:deploy': 'node scripts/smoke-check-deploy.js',
    },
  }))
  fs.writeFileSync(path.join(repoDir, '.firstbite', 'local-ci.json'), JSON.stringify({
    version: 1,
    repo: 'resplit_currency_api',
    display: 'Resplit FX',
    localCi: {
      lanes: {
        resplit_currency_api_unit: { kind: 'unit', command: 'npm run test', timeoutMs: 1 },
        resplit_currency_api_integration: { kind: 'integration', command: 'npm run check:publish', timeoutMs: 1 },
        resplit_currency_api_ui: { kind: 'ui', command: 'npm run smoke:deploy', timeoutMs: 1 },
      },
    },
  }))
  fs.writeFileSync(path.join(repoDir, 'wrangler.jsonc'), JSON.stringify({ name: 'resplit-fx' }))

  const mcpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-mcp-'))
  fs.mkdirSync(path.join(mcpRoot, 'clean-drift'))
  fs.mkdirSync(path.join(mcpRoot, 'dirty-current'))
  const cleanPath = path.join(mcpRoot, 'clean-drift', 'report.json')
  const dirtyPath = path.join(mcpRoot, 'dirty-current', 'report.json')
  const cleanSource = {
    repo_path: '/tmp/firstbite-clean',
    exists: true,
    is_git: true,
    head: 'abc',
    upstream: 'origin/main',
    upstream_head: 'def',
    dirty_count: 0,
    ahead_origin_main: 0,
    behind_origin_main: 0,
    sync_status: 'origin_main',
  }
  const dirtySource = {
    repo_path: repoDir,
    exists: true,
    is_git: true,
    branch: 'main',
    head: 'abc',
    upstream: 'origin/main',
    upstream_head: 'def',
    dirty_count: 40,
    ahead_origin_main: 0,
    behind_origin_main: 10,
    sync_status: 'dirty',
  }

  const lane = (id, kind, command, source) => ({
    lane: id,
    repo: 'resplit_currency_api',
    kind,
    command,
    status: 'pass',
    rc: 0,
    source_head: 'abc',
    execution_source_state: source,
    primary_source_state: source,
  })

  fs.writeFileSync(cleanPath, JSON.stringify({
    run_id: 'clean-drift',
    mode: 'execute',
    created_at: '2026-05-25T00:00:00.000Z',
    overall: 'pass',
    lanes: [
      lane('resplit_currency_api_unit', 'unit', 'npm run test', cleanSource),
      lane('resplit_currency_api_integration', 'integration', 'npm run check', cleanSource),
      lane('resplit_currency_api_ui', 'ui', 'npm run smoke:deploy', cleanSource),
    ],
  }))
  fs.writeFileSync(dirtyPath, JSON.stringify({
    run_id: 'dirty-current',
    mode: 'execute',
    created_at: '2026-05-25T00:01:00.000Z',
    overall: 'pass',
    lanes: [
      lane('resplit_currency_api_unit', 'unit', 'npm run test', dirtySource),
      lane('resplit_currency_api_integration', 'integration', 'npm run check:publish', dirtySource),
      lane('resplit_currency_api_ui', 'ui', 'npm run smoke:deploy', dirtySource),
    ],
  }))
  fs.utimesSync(cleanPath, new Date('2026-05-25T00:00:00Z'), new Date('2026-05-25T00:00:00Z'))
  fs.utimesSync(dirtyPath, new Date('2026-05-25T00:01:00Z'), new Date('2026-05-25T00:01:00Z'))

  const report = buildReport({
    repoDir,
    generatedAt: '2026-05-25T00:02:00.000Z',
    gitState: { status: 'dirty', dirtyCount: 40, branch: 'main', head: 'abc', originMain: 'def', behindOriginMain: 10 },
    mcpReportRoot: mcpRoot,
    sharedLedgerPath: path.join(repoDir, 'missing-shared-ledger.jsonl'),
  })
  const html = renderHtml(report)

  assert.equal(report.localCi.status, 'red')
  assert.equal(report.localCi.proofManifestMatch.status, 'red')
  assert.equal(report.localCi.mcpProof.latest.runId, 'clean-drift')
  assert.equal(report.localCi.mcpProof.latestComplete.runId, 'dirty-current')
  assert.equal(report.localCi.currentManifestProof.runId, 'dirty-current')
  assert.equal(report.localCi.currentManifestProof.status, 'yellow')
  assert.equal(report.localCi.cleanProofReadiness.status, 'red')
  assert.equal(report.localCi.sourcePromotionBundle.status, 'red')
  assert.match(report.localCi.cleanProofReadiness.runnerContract, /source_ref=refs\/remotes\/origin\/main/)
  assert.match(report.localCi.summary, /Newer current-manifest proof dirty-current passed/)
  assert.match(html, /Current Manifest Proof/)
  assert.match(html, /Clean Proof Readiness/)
  assert.match(html, /Source Promotion Bundle/)
  assert.match(html, /source_ref=refs\/remotes\/origin\/main/)
  assert.match(html, /dirty-current/)
  assert.match(html, /supporting evidence/)
})

test('computeRisks only elevates unresolved ledger failures', () => {
  const base = {
    git: { dirtyCount: 0, behindOriginMain: 0 },
    localCi: {
      status: 'green',
      summary: 'ok',
      proofFreshness: { status: 'green', summary: 'fresh' },
      mcpProof: {},
    },
    telemetry: { status: 'green', summary: 'ok' },
    nurseLog: { releaseReadiness: 'green', currentBlocker: '' },
    inbox: { hasStaleGrafanaItem: false },
  }

  const recoveredRisks = computeRisks({
    ...base,
    ledger: {
      health: {
        status: 'yellow',
        summary: '1 failure row(s) found in the last 24h, all with later recovery evidence.',
      },
    },
  })
  assert.equal(recoveredRisks.some(risk => risk.label === 'Agent ledger failure history'), false)

  const unresolvedRisks = computeRisks({
    ...base,
    ledger: {
      health: {
        status: 'red',
        summary: '1 unrecovered failure row(s) found in the last 24h ledger window.',
      },
    },
  })
  assert.equal(unresolvedRisks.find(risk => risk.label === 'Agent ledger failure history')?.status, 'red')
})

test('buildTrustContracts turns cockpit state into explicit proof actions', () => {
  const contracts = buildTrustContracts({
    git: { branch: 'main', dirtyCount: 2, behindOriginMain: 10 },
    localCi: {
      status: 'red',
      summary: 'Latest MCP proof command drift',
      trackedSource: { status: 'red', summary: 'contract missing from tracked source' },
      cleanProofReadiness: {
        status: 'red',
        summary: 'tracked contract cannot produce clean launch proof',
        nextAction: 'sync tracked source and rerun clean worktree local CI',
      },
      sourcePromotionBundle: {
        status: 'red',
        summary: '2 current-only files; 1 modified file',
        nextAction: 'review and land bundle before clean proof',
      },
      operatingReadout: {
        status: 'yellow',
        summary: '17/18 lane proof(s) pass; non-FX lane failed',
        reportPath: '/tmp/firstbite-operating-readout/report.json',
        nextAction: 'inspect failed lane before broad launch claims',
        m4FreshClonePacket: {
          latestCommands: '/tmp/m4/fresh-clone-commands.sh',
        },
        peerExecutionBoundary: {
          status: 'yellow',
          summary: 'M4 peer is support-only: stale receiver; fresh-clone packet available; execution_ready=false.',
          nextAction: 'run generated fresh-clone commands on M4',
        },
      },
      runnerControlPlane: {
        status: 'yellow',
        summary: 'FirstBite runner support exists on PR branch, not origin/main.',
        serverRelativePath: 'skills/resplit-watch/mcp/firstbite-local-ci/src/server.mjs',
        nextAction: 'merge ai-leo PR #11 and restart host',
      },
      loadedMcpProbe: {
        status: 'red',
        summary: 'Loaded MCP catalog is missing resplit_currency_api lanes',
        path: '/tmp/loaded.json',
      },
      repoBackedMcpProbe: {
        status: 'green',
        summary: 'Repo-backed catalog has 15 lanes',
        packageDir: '/tmp/firstbite-local-ci',
      },
      mcpProof: { latest: { reportPath: '/tmp/report.json' } },
    },
    telemetry: {
      status: 'yellow',
      summary: 'Worker observability config exists; JSON proof does not show both Tempo and Loki matches.',
      cloudflare: {
        destinations: {
          status: 'yellow',
          summary: 'Cloudflare destination proof is missing.',
          latestPath: '/tmp/cloudflare-otel-destinations.json',
        },
      },
      grafana: { evidence: { latestPath: '/tmp/grafana-otel-smoke.json' } },
    },
    nurseLog: {
      releaseReadiness: 'yellow',
      currentBlocker: 'Telemetry still lacks Grafana proof.',
      latestBullets: [
        '`npm run validate:release` -> expected fail (`available 18/30`, missing `2026-05-12`..`2026-05-23`)',
      ],
    },
    ledger: { health: { status: 'green', summary: 'healthy' } },
  })

  assert.equal(contracts.length, 14)
  assert.deepEqual(contracts.map(contract => contract.gate), [
    'Primary checkout',
    'Tracked local-CI contract',
    'Clean proof targetability',
    'Source promotion bundle',
    'FirstBite operating readout',
    'FirstBite runner durability',
    'M4 peer execution boundary',
    'Selected local-CI proof',
    'Loaded MCP host catalog',
    'Repo-backed MCP package',
    'Cloudflare OTEL destinations',
    'OTEL/Grafana evidence',
    'Release-history strict coverage',
    'Agent ledger health',
  ])
  assert.equal(contracts.find(contract => contract.gate === 'Loaded MCP host catalog').status, 'red')
  assert.equal(contracts.find(contract => contract.gate === 'Clean proof targetability').status, 'red')
  assert.equal(contracts.find(contract => contract.gate === 'Source promotion bundle').status, 'red')
  assert.equal(contracts.find(contract => contract.gate === 'FirstBite operating readout').status, 'yellow')
  assert.equal(contracts.find(contract => contract.gate === 'FirstBite runner durability').status, 'yellow')
  assert.equal(contracts.find(contract => contract.gate === 'M4 peer execution boundary').status, 'yellow')
  assert.match(contracts.find(contract => contract.gate === 'Clean proof targetability').nextAction, /sync tracked source/)
  assert.match(contracts.find(contract => contract.gate === 'Source promotion bundle').nextAction, /land bundle/)
  assert.match(contracts.find(contract => contract.gate === 'FirstBite operating readout').nextAction, /failed lane/)
  assert.match(contracts.find(contract => contract.gate === 'FirstBite runner durability').nextAction, /PR #11/)
  assert.match(contracts.find(contract => contract.gate === 'M4 peer execution boundary').current, /support-only/)
  assert.equal(contracts.find(contract => contract.gate === 'M4 peer execution boundary').proof, '/tmp/m4/fresh-clone-commands.sh')
  assert.match(contracts.find(contract => contract.gate === 'Loaded MCP host catalog').nextAction, /Restart or reload/)
  assert.equal(contracts.find(contract => contract.gate === 'Cloudflare OTEL destinations').proof, '/tmp/cloudflare-otel-destinations.json')
  assert.equal(contracts.find(contract => contract.gate === 'OTEL/Grafana evidence').proof, '/tmp/grafana-otel-smoke.json')
  assert.match(contracts.find(contract => contract.gate === 'Release-history strict coverage').current, /available 18\/30/)
  assert.match(contracts.find(contract => contract.gate === 'Release-history strict coverage').nextAction, /May 12-23/)
})

test('buildTrustContracts uses refresh-plan proof when loaded probe is missing', () => {
  const contracts = buildTrustContracts({
    git: { branch: 'main', dirtyCount: 0, behindOriginMain: 0 },
    localCi: {
      status: 'yellow',
      summary: 'Selected local-CI proof is not clean-current yet.',
      trackedSource: { status: 'green', summary: 'tracked' },
      cleanProofReadiness: { status: 'yellow', summary: 'needs clean proof' },
      sourcePromotionBundle: { status: 'green', summary: 'tracked' },
      operatingReadout: { status: 'green', summary: 'readout fresh', reportPath: '/tmp/readout.json' },
      runnerControlPlane: { status: 'green', summary: 'runner durable', serverRelativePath: 'server.mjs' },
      loadedMcpProbe: {
        status: 'missing',
        summary: 'No loaded MCP host probe was found.',
      },
      mcpRefreshPlan: {
        status: 'yellow',
        summary: 'FirstBite MCP refresh plan: stale_loaded_clients_need_host_app_restart; process audit stale_processes_visible with 17/19 stale process(es).',
        reportPath: '/tmp/refresh/report.json',
        staleProcessCount: 17,
      },
      repoBackedMcpProbe: { status: 'green', summary: 'repo-backed ok', packageDir: '/tmp/firstbite-local-ci' },
      mcpProof: { latest: { reportPath: '/tmp/report.json' } },
    },
    telemetry: {
      status: 'yellow',
      summary: 'Grafana proof missing.',
      cloudflare: { destinations: { status: 'yellow', summary: 'missing', latestPath: '/tmp/cloudflare.json' } },
      grafana: { evidence: { latestPath: '/tmp/grafana.json' } },
    },
    nurseLog: { releaseReadiness: 'yellow', latestBullets: [] },
    ledger: { health: { status: 'green', summary: 'healthy' } },
  })

  const loaded = contracts.find(contract => contract.gate === 'Loaded MCP host catalog')
  assert.equal(loaded.proof, '/tmp/refresh/report.json')
  assert.match(loaded.current, /Refresh packet/)
  assert.match(loaded.nextAction, /restart\/reload Codex\/Cursor/)
})

test('buildLaunchTrustAudit states allowed and forbidden launch claims per boundary', () => {
  const contracts = buildTrustContracts({
    git: { branch: 'main', dirtyCount: 2, behindOriginMain: 10 },
    localCi: {
      status: 'red',
      summary: 'Latest MCP proof command drift',
      trackedSource: { status: 'red', summary: 'contract missing from tracked source' },
      cleanProofReadiness: {
        status: 'red',
        summary: 'tracked contract cannot produce clean launch proof',
        nextAction: 'sync tracked source and rerun clean worktree local CI',
      },
      sourcePromotionBundle: {
        status: 'red',
        summary: '2 current-only files; 1 modified file',
        nextAction: 'review and land bundle before clean proof',
      },
      operatingReadout: {
        status: 'yellow',
        summary: '17/18 lane proof(s) pass; non-FX lane failed',
        reportPath: '/tmp/firstbite-operating-readout/report.json',
        nextAction: 'inspect failed lane before broad launch claims',
        m4FreshClonePacket: { latestCommands: '/tmp/m4/fresh-clone-commands.sh' },
        peerExecutionBoundary: {
          status: 'yellow',
          summary: 'M4 peer is support-only: stale receiver; execution_ready=false.',
          nextAction: 'run generated fresh-clone commands on M4',
        },
      },
      loadedMcpProbe: {
        status: 'red',
        freshnessStatus: 'green',
        summary: 'Loaded MCP catalog is missing resplit_currency_api lanes',
        path: '/tmp/loaded.json',
      },
      mcpCatalogDelta: {
        status: 'red',
        summary: 'Loaded MCP host differs from repo-backed catalog.',
        nextAction: 'restart MCP host',
      },
      repoBackedMcpProbe: {
        status: 'green',
        summary: 'Repo-backed catalog has 15 lanes',
        packageDir: '/tmp/firstbite-local-ci',
      },
      mcpProof: { latest: { reportPath: '/tmp/report.json' } },
    },
    telemetry: {
      status: 'yellow',
      summary: 'Worker observability config exists; JSON proof does not show both Tempo and Loki matches.',
      cloudflare: {
        destinations: {
          status: 'yellow',
          summary: 'Cloudflare destination proof is missing.',
          latestPath: '/tmp/cloudflare-otel-destinations.json',
        },
      },
      grafana: { evidence: { latestPath: '/tmp/grafana-otel-smoke.json' } },
    },
    nurseLog: {
      releaseReadiness: 'yellow',
      latestBullets: ['`npm run validate:release` -> expected fail (`available 18/30`)'],
    },
    ledger: { health: { status: 'green', summary: 'healthy' } },
  })
  const audit = buildLaunchTrustAudit({
    contracts,
    localCi: {
      loadedMcpProbe: {
        status: 'red',
        freshnessStatus: 'green',
        summary: 'Loaded MCP catalog is missing resplit_currency_api lanes',
        path: '/tmp/loaded.json',
      },
      mcpCatalogDelta: {
        status: 'red',
        summary: 'Loaded MCP host differs from repo-backed catalog.',
        nextAction: 'restart MCP host',
      },
      repoBackedMcpProbe: {
        status: 'green',
        summary: 'Repo-backed catalog has 15 lanes',
        packageDir: '/tmp/firstbite-local-ci',
      },
      operatingReadout: {
        peerExecutionBoundary: {
          status: 'yellow',
          summary: 'M4 peer is support-only: stale receiver; execution_ready=false.',
        },
        m4FreshClonePacket: { latestCommands: '/tmp/m4/fresh-clone-commands.sh' },
      },
    },
    telemetry: {
      status: 'yellow',
      summary: 'Tempo/Loki missing',
      cloudflare: {
        destinations: {
          status: 'yellow',
          summary: 'Cloudflare destination proof is missing.',
          latestPath: '/tmp/cloudflare-otel-destinations.json',
        },
      },
      grafana: { evidence: { latestPath: '/tmp/grafana.json' } },
    },
    nurseLog: { releaseReadiness: 'yellow', latestBullets: ['available 18/30'] },
    ledger: { health: { status: 'green' } },
  })

  assert.equal(audit.status, 'red')
  assert.match(audit.summary, /forbidden claim boundary/)
  assert.equal(audit.rows.find(row => row.id === 'repo-backed-mcp-source').claimAllowed, true)
  assert.equal(audit.rows.find(row => row.id === 'loaded-agent-mcp').claimAllowed, false)
  assert.match(audit.rows.find(row => row.id === 'loaded-agent-mcp').forbiddenClaim, /loaded MCP/)
  assert.match(audit.rows.find(row => row.id === 'peer-execution').forbiddenClaim, /LAN pings/)
  assert.match(audit.rows.find(row => row.id === 'otel-cloudflare-destinations').forbiddenClaim, /Cloudflare dashboard state/)
  assert.match(audit.rows.find(row => row.id === 'otel-grafana-proof').forbiddenClaim, /config alone/)
  assert.match(audit.rows.find(row => row.id === 'overall-launch-trust').forbiddenClaim, /launch-ready/)
})

test('buildOperatorActionQueue prioritizes proof-producing recovery actions', () => {
  const contracts = buildTrustContracts({
    git: { branch: 'main', dirtyCount: 2, behindOriginMain: 10 },
    localCi: {
      status: 'red',
      summary: 'Latest MCP proof command drift',
      trackedSource: { status: 'red', summary: 'contract missing from tracked source' },
      cleanProofReadiness: {
        status: 'red',
        summary: 'tracked contract cannot produce clean launch proof',
        nextAction: 'sync tracked source and rerun clean worktree local CI',
        commands: { cleanWorktree: 'firstbite clean command' },
      },
      sourcePromotionBundle: {
        status: 'red',
        summary: '2 current-only files; 1 modified file',
        nextAction: 'review and land bundle before clean proof',
        commands: { writePacket: 'npm run source:promotion-packet' },
      },
      operatingReadout: {
        status: 'yellow',
        summary: '17/18 lane proof(s) pass; non-FX lane failed',
        reportPath: '/tmp/firstbite/report.json',
        m4FreshClonePacket: {
          latestCommands: '/tmp/m4/fresh-clone-commands.sh',
        },
        peerExecutionBoundary: {
          status: 'yellow',
          summary: 'M4 peer is support-only: stale receiver; fresh-clone packet available; execution_ready=false.',
          nextAction: 'run generated fresh-clone commands on M4',
        },
      },
      loadedMcpProbe: {
        status: 'red',
        summary: 'Loaded MCP catalog is missing resplit_currency_api lanes',
        path: '/tmp/loaded.json',
      },
      runnerControlPlane: {
        status: 'yellow',
        summary: 'FirstBite runner support exists on PR branch, not origin/main.',
        serverRelativePath: 'skills/resplit-watch/mcp/firstbite-local-ci/src/server.mjs',
        activeSupports: true,
        prSupports: true,
        nextAction: 'merge ai-leo PR #11 and restart host',
      },
      repoBackedMcpProbe: { status: 'green', summary: 'repo-backed ok' },
      mcpProof: { latest: { reportPath: '/tmp/report.json' } },
    },
    telemetry: {
      status: 'yellow',
      summary: 'Tempo/Loki missing',
      cloudflare: {
        destinations: {
          status: 'yellow',
          summary: 'Missing Cloudflare read config: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN.',
          latestPath: '/tmp/cloudflare.json',
        },
      },
      grafana: { evidence: { latestPath: '/tmp/grafana.json' } },
    },
    nurseLog: {
      releaseReadiness: 'yellow',
      latestBullets: ['`npm run validate:release` -> expected fail (`available 18/30`)'],
    },
    ledger: { health: { status: 'green', summary: 'healthy' } },
  })
  const actions = buildOperatorActionQueue({
    contracts,
    localCi: {
      sourcePromotionBundle: {
        status: 'red',
        summary: '2 current-only files; 1 modified file',
        commands: { writePacket: 'npm run source:promotion-packet' },
      },
      cleanProofReadiness: {
        status: 'red',
        summary: 'tracked contract cannot produce clean launch proof',
        commands: { cleanWorktree: 'firstbite clean command' },
      },
      loadedMcpProbe: {
        status: 'red',
        summary: 'Loaded MCP catalog is missing resplit_currency_api lanes',
        path: '/tmp/loaded.json',
      },
      runnerControlPlane: {
        status: 'yellow',
        summary: 'FirstBite runner support exists on PR branch, not origin/main.',
        serverRelativePath: 'skills/resplit-watch/mcp/firstbite-local-ci/src/server.mjs',
        activeSupports: true,
        prSupports: true,
        nextAction: 'merge ai-leo PR #11 and restart host',
      },
      operatingReadout: {
        status: 'yellow',
        summary: '17/18 lane proof(s) pass; non-FX lane failed',
        reportPath: '/tmp/firstbite/report.json',
        m4FreshClonePacket: {
          latestCommands: '/tmp/m4/fresh-clone-commands.sh',
        },
        peerExecutionBoundary: {
          status: 'yellow',
          summary: 'M4 peer is support-only: stale receiver; fresh-clone packet available; execution_ready=false.',
          nextAction: 'run generated fresh-clone commands on M4',
        },
      },
    },
    telemetry: {
      status: 'yellow',
      summary: 'Tempo/Loki missing',
      cloudflare: {
        destinations: {
          status: 'yellow',
          summary: 'Missing Cloudflare read config: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN.',
          latestPath: '/tmp/cloudflare.json',
        },
      },
      grafana: { evidence: { latestPath: '/tmp/grafana.json' } },
    },
    nurseLog: { releaseReadiness: 'yellow', latestBullets: ['available 18/30'] },
    inbox: {
      activeItems: [{
        title: '[2026-05-24] P1 release-history risk: daily publish is fresh, but the May 12-23 history hole remains',
        raw: '- [ ] [2026-05-24] **P1 release-history risk: daily publish is fresh, but the May 12-23 history hole remains.**',
      }],
    },
    ledger: { health: { status: 'green' } },
  })

  assert.deepEqual(actions.map(action => action.id), [
    'source-promotion-review',
    'clean-firstbite-proof',
    'firstbite-runner-durability',
    'loaded-mcp-refresh',
    'cloudflare-otel-destinations',
    'grafana-otel-proof',
    'release-history-backfill',
    'firstbite-operating-readout',
    'm4-peer-execute-proof',
  ])
  assert.equal(actions[0].canRunNow, true)
  assert.equal(actions.find(action => action.id === 'clean-firstbite-proof').canRunNow, false)
  assert.match(actions.find(action => action.id === 'clean-firstbite-proof').blockedBy, /Source promotion/)
  assert.match(actions.find(action => action.id === 'clean-firstbite-proof').command, /firstbite clean command/)
  assert.equal(actions.find(action => action.id === 'firstbite-runner-durability').canRunNow, true)
  assert.match(actions.find(action => action.id === 'firstbite-runner-durability').nextAction, /PR #11/)
  assert.equal(actions.find(action => action.id === 'loaded-mcp-refresh').canRunNow, true)
  assert.match(actions.find(action => action.id === 'loaded-mcp-refresh').command, /--reuse-existing/)
  assert.match(actions.find(action => action.id === 'loaded-mcp-refresh').nextAction, /host restart/)
  assert.match(actions.find(action => action.id === 'cloudflare-otel-destinations').blockedBy, /Workers Observability Read/)
  assert.match(actions.find(action => action.id === 'grafana-otel-proof').blockedBy, /Grafana read env/)
  assert.match(actions.find(action => action.id === 'release-history-backfill').command, /audit:backfill-sources/)
  assert.match(actions.find(action => action.id === 'release-history-backfill').blocker, /May 12-23/)
  assert.equal(actions.find(action => action.id === 'm4-peer-execute-proof').canRunNow, false)
  assert.match(actions.find(action => action.id === 'm4-peer-execute-proof').command, /fresh-clone-commands/)
  assert.match(actions.find(action => action.id === 'm4-peer-execute-proof').blockedBy, /M4 Pro/)
})

test('buildOperatorRecoveryFlow separates runnable work from dependencies', () => {
  const flow = buildOperatorRecoveryFlow([
    {
      id: 'source-promotion-review',
      priority: 1,
      status: 'red',
      owner: 'Local source',
      boundary: 'local-source',
      canRunNow: true,
      command: 'npm run source:promotion-packet',
      proof: 'reports/resplit-fx-source-promotion-packet.md',
      blocker: '13 current-only file(s)',
      unblocks: 'Clean FirstBite proof',
    },
    {
      id: 'clean-firstbite-proof',
      priority: 2,
      status: 'red',
      owner: 'FirstBite local CI',
      boundary: 'local-ci',
      canRunNow: false,
      blockedBy: 'Source promotion bundle must land first.',
      command: 'npm run firstbite',
      proof: '/tmp/firstbite/report.json',
      unblocks: 'Launch local-CI trust',
    },
    {
      id: 'grafana-otel-proof',
      priority: 3,
      status: 'yellow',
      owner: 'Cloudflare/Grafana',
      boundary: 'external-observability',
      canRunNow: false,
      blockedBy: 'Requires Grafana read env.',
      command: 'npm run observability:otel-smoke',
      proof: 'reports/grafana-otel-smoke.json',
      unblocks: 'OTEL/Grafana launch trust',
    },
  ])

  assert.equal(flow.status, 'red')
  assert.match(flow.summary, /1 runnable action/)
  assert.equal(flow.nextLocalAction.id, 'source-promotion-review')
  assert.equal(flow.firstBlockedAction.id, 'clean-firstbite-proof')
  assert.deepEqual(flow.runnableNow.map(action => action.id), ['source-promotion-review'])
  assert.deepEqual(flow.waitingOnDependency.map(action => action.id), ['clean-firstbite-proof', 'grafana-otel-proof'])
  assert.deepEqual(flow.boundaries.find(boundary => boundary.boundary === 'external-observability').actions, ['grafana-otel-proof'])
})

test('buildEvidenceFreshnessLedger separates artifact age from trust status', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-freshness-'))
  fs.mkdirSync(path.join(repoDir, 'reports'), { recursive: true })
  fs.writeFileSync(path.join(repoDir, 'reports', 'resplit-fx-source-promotion-packet.json'), JSON.stringify({
    generatedAt: '2026-05-25T07:30:00.000Z',
    status: 'red',
    summary: { headline: 'Source promotion packet is still red.' },
    stageCandidates: ['package.json'],
    holdByDefault: [],
  }))

  const ledger = buildEvidenceFreshnessLedger({
    repoDir,
    generatedAt: '2026-05-25T07:45:00.000Z',
    preflight: {
      status: 'red',
      summary: '7 green, 2 yellow, 0 red; cockpit verdict red.',
      path: path.join(repoDir, 'reports', 'resplit-fx-trust-preflight.json'),
      generatedAt: '2026-05-25T07:40:00.000Z',
      ageMinutes: 5,
    },
    localCi: {
      status: 'yellow',
      proofFreshness: {
        status: 'green',
        ageMinutes: 30,
        summary: 'Latest MCP execute report is fresh.',
      },
      mcpProof: {
        latest: {
          status: 'pass',
          reportPath: '/tmp/firstbite/report.json',
          createdAt: '2026-05-25T07:15:00.000Z',
        },
      },
      loadedMcpProbe: {
        status: 'red',
        path: path.join(repoDir, 'reports', 'firstbite-loaded-mcp-lanes.json'),
        checkedAt: '2026-05-25T06:30:00.000Z',
        ageMinutes: 75,
        freshnessStatus: 'yellow',
        freshnessSummary: 'Loaded MCP probe artifact is stale: 75m old.',
        summary: 'Loaded MCP catalog is missing resplit_currency_api lanes.',
      },
      repoBackedMcpProbe: {
        status: 'green',
        packageDir: '/tmp/firstbite-local-ci',
        checkedAt: '2026-05-25T07:44:00.000Z',
        ageMinutes: 1,
        summary: 'Repo-backed FirstBite MCP sees repo-manifest-v2 with 15 lane(s).',
      },
      sourcePromotionBundle: {
        status: 'red',
        summary: 'current-only local CI files remain',
        commands: { writePacket: 'npm run source:promotion-packet' },
      },
      operatingReadout: {
        status: 'green',
        reportPath: '/tmp/readout/report.json',
        summaryPath: '/tmp/readout/summary.md',
        createdAt: '2026-05-25T07:35:00.000Z',
        ageMinutes: 10,
        summary: 'FirstBite operating readout is fresh.',
      },
      mcpRefreshPlan: {
        status: 'yellow',
        reportPath: '/tmp/refresh/report.json',
        summaryPath: '/tmp/refresh/summary.md',
        createdAt: '2026-05-25T07:42:00.000Z',
        ageMinutes: 3,
        summary: 'FirstBite MCP refresh plan: stale_loaded_clients_need_host_app_restart; process audit stale_processes_visible with 17/19 stale process(es).',
        continuationCommands: [{
          label: 'Rerun stale MCP refresh plan',
          command: 'bash refresh',
        }],
      },
    },
    telemetry: {
      cloudflare: {
        destinations: {
          status: 'yellow',
          latestPath: path.join(repoDir, 'reports', 'cloudflare-otel-destinations.json'),
          checkedAt: '2026-05-25T07:38:00.000Z',
          ageMinutes: 7,
          summary: 'Missing Cloudflare read config.',
        },
      },
      grafana: {
        evidence: {
          status: 'yellow',
          latestPath: path.join(repoDir, 'reports', 'grafana-otel-smoke.json'),
          checkedAt: '2026-05-25T07:36:00.000Z',
          ageMinutes: 9,
          summary: 'JSON proof does not show both Tempo and Loki matches.',
        },
      },
    },
  })

  const preflight = ledger.rows.find(row => row.id === 'local-trust-preflight')
  const packet = ledger.rows.find(row => row.id === 'source-promotion-packet')
  const loaded = ledger.rows.find(row => row.id === 'loaded-mcp-host-probe')
  const refresh = ledger.rows.find(row => row.id === 'firstbite-mcp-refresh-plan')
  const cloudflare = ledger.rows.find(row => row.id === 'cloudflare-otel-destinations')
  const grafana = ledger.rows.find(row => row.id === 'grafana-otel-smoke')

  assert.equal(ledger.status, 'yellow')
  assert.equal(preflight.freshnessStatus, 'green')
  assert.equal(preflight.trustStatus, 'red')
  assert.equal(packet.freshnessStatus, 'green')
  assert.equal(packet.trustStatus, 'red')
  assert.equal(loaded.freshnessStatus, 'yellow')
  assert.equal(loaded.trustStatus, 'red')
  assert.equal(refresh.freshnessStatus, 'green')
  assert.equal(refresh.trustStatus, 'yellow')
  assert.equal(refresh.artifact, '/tmp/refresh/report.json')
  assert.equal(cloudflare.freshnessStatus, 'green')
  assert.equal(cloudflare.trustStatus, 'yellow')
  assert.equal(grafana.freshnessStatus, 'green')
  assert.equal(grafana.trustStatus, 'yellow')
  assert.match(ledger.summary, /trust colors remain separate/)
})

test('renderHtml escapes dynamic values', () => {
  const html = renderHtml({
    generatedAt: 'now',
    title: '<bad>',
    repo: {
      path: '/tmp/<repo>',
      git: { branch: 'main', head: '<x>', originMain: 'origin', dirtyCount: 0, behindOriginMain: 0 },
    },
    verdict: { status: 'yellow', label: '<warn>' },
    localCi: {
      status: 'yellow',
      summary: '<summary>',
      lanes: [],
      operatingReadout: {
        status: 'yellow',
        summary: '<readout-summary>',
        runId: '<readout-run>',
        createdAt: '<readout-created>',
        ageMinutes: 5,
        reportPath: '/tmp/<readout>.json',
        summaryPath: '/tmp/<readout>.md',
        localCi: { latestLanePassCount: 17, latestLaneCount: 18, latestLaneFailCount: 1 },
        catalog: { version: '<catalog>', declaredCount: 15, laneCount: 15, repoPresent: true },
        manifestPortability: { fresh_clone_ready: true, ready: false, uncommitted_repo_count: 5 },
        expectedManifestState: { portability_status: '<fx-manifest>', porcelain: '<porcelain>' },
        mousseyLocal: {
          verdict: '<moussey>',
          localCiApi: { latest_lane_pass_count: 17, latest_lane_count: 18 },
          lanStatus: { healthy_peer_count: 3, peer_count: 3 },
        },
        peerExecutionBoundary: {
          status: 'yellow',
          summary: '<m4-boundary>',
          proofRule: '<m4-proof-rule>',
        },
        m4PeerProbe: {
          verdict: '<m4-peer>',
          executionReady: false,
          dashboardUrl: 'http://<m4>.local:4321',
        },
        m4FreshClonePacket: {
          available: true,
          latestCommands: '/tmp/<m4-commands>.sh',
          completionGates: ['<gate-one>'],
        },
        failedLanes: [],
        nextAction: '<readout-next>',
      },
      runnerControlPlane: {
        status: 'yellow',
        summary: '<runner-summary>',
        nextAction: '<runner-next>',
        aiLeoRepoDir: '/tmp/<ai-leo>',
        packageDir: '/tmp/<firstbite-package>',
        serverRelativePath: '<runner-server>',
        readmeRelativePath: '<runner-readme>',
        branch: '<runner-head>',
        originMainHead: '<runner-origin>',
        prBranchHead: '<runner-pr>',
        dirty: ['<runner-dirty>'],
        rows: [{
          id: '<runner-row>',
          label: '<runner-label>',
          ref: '<runner-ref>',
          source: '/tmp/<runner-source>',
          status: 'red',
          supports: false,
          missingTokens: ['<runner-token>'],
          summary: '<runner-row-summary>',
        }],
      },
      mcpCatalogDelta: {
        status: 'red',
        summary: '<catalog-delta>',
        loadedCheckedAt: '<loaded-checked>',
        repoBackedCheckedAt: '<repo-backed-checked>',
        loadedLaneCount: 12,
        repoBackedLaneCount: 15,
        loadedCatalogVersion: '<loaded-version>',
        repoBackedCatalogVersion: '<repo-version>',
        missingReposInLoaded: ['<missing-repo>'],
        missingExpectedLanesInLoaded: ['<missing-lane>'],
        missingGroupsInLoaded: ['<missing-group>'],
        missingLanesInLoaded: ['<missing-total-lane>'],
        nextAction: '<delta-next>',
      },
      sourcePromotionPacket: {
        status: 'red',
        summary: '<packet-summary>',
        generatedAt: '<packet-generated>',
        ageMinutes: 1,
        artifactPath: '/tmp/<packet>.json',
        markdownPath: '/tmp/<packet>.md',
        commands: {
          writePacket: '<write-packet>',
          inspectOriginDiff: '<origin-diff>',
        },
        promotionReview: {
          status: 'red',
          summary: '<review-summary>',
          rows: [{
            path: '<candidate-path>',
            status: 'red',
            classification: '<origin-drift>',
            currentHash: '<current-hash>',
            currentLines: 10,
            headHash: null,
            headLines: null,
            originHash: '<origin-hash>',
            originLines: 8,
            lineDeltaVsHead: null,
            lineDeltaVsOrigin: 2,
            reviewDecision: {
              status: 'accepted',
              decision: 'accept-current',
            },
            reviewCommand: '<review-command>',
            action: '<review-action>',
          }],
        },
        stagingGate: {
          status: 'red',
          fullStageBlocked: true,
          summary: '<stage-gate-summary>',
          fullStageCommand: 'BLOCKED: resolve 1 red candidate(s) before staging the full bundle',
          nonRedStageCommand: "git add -- '<non-red-path>'",
          nextAction: '<stage-gate-next>',
          blockedRows: [{
            path: '<candidate-path>',
            classification: '<origin-drift>',
            lineDeltaVsOrigin: 2,
            reviewCommand: '<review-command>',
            action: '<review-action>',
          }],
        },
        stagedBundle: {
          status: 'green',
          exactMatch: true,
          summary: '<staged-bundle-summary>',
          nextAction: '<staged-bundle-next>',
          stageableCount: 2,
          stagedStageableCount: 2,
          unstagedStageableCount: 0,
          unexpectedStagedCount: 0,
          dirtyAfterStagingCount: 0,
          stagedStageablePaths: ['<candidate-path>', '<non-red-path>'],
          unstagedStageablePaths: [],
          unexpectedStagedPaths: [],
          dirtyAfterStagingPaths: [],
        },
      },
    },
    telemetry: {
      status: 'red',
      summary: '<telemetry>',
      workerName: 'resplit-fx',
      observability: { enabled: false, scope: 'top-level', logsEnabled: false, tracesEnabled: false, sampling: { logs: null, traces: null }, destinationNames: [] },
      grafana: {
        tempoVerifierPresent: false,
        plan: '/plan',
        evidence: {
          status: 'yellow',
          latestPath: '/tmp/<otel>.json',
          checkedAt: 'now',
          ageMinutes: 0,
          tempoMatched: false,
          lokiMatched: false,
          traceId: null,
          summary: '<evidence>',
          checks: [{
            id: 'tempo-query',
            label: '<tempo>',
            status: 'yellow',
            proof: '<proof>',
            nextAction: '<next>',
          }],
        },
      },
    },
    gates: { required: [] },
    agentState: {
      nurseLog: { latestHeading: '<heading>', releaseReadiness: 'yellow', currentBlocker: '<blocker>', nextSlice: '<next>' },
      inbox: { activeItems: [], hasGrafanaItem: false, hasStaleGrafanaItem: false, hasReleaseHistoryItem: false },
      ledger: {
        status: 'parsed',
        health: {
          status: 'yellow',
          summary: '<ledger>',
          failureRows: [{ ts: 'now', summary: '<failure>' }],
          recoveryRows: [{ ts: 'later', summary: '<recovery>' }],
          repairRows: [],
        },
        repo: { status: 'empty', recentEntries: [] },
        shared: { status: 'parsed', recentEntries: [{ summary: '<shared>' }] },
        activityMatrix: [{
          status: 'red',
          ts: 'now',
          ageMinutes: 0,
          agent: '<agent>',
          lane: '<lane>',
          handoffStatus: '<handoff>',
          proof: '/tmp/<proof>.json',
          summary: '<agent-summary>',
        }],
      },
    },
    trustModel: {
      launchTrustAudit: {
        status: 'red',
        summary: '<launch-audit-summary>',
        rows: [{
          id: '<audit-id>',
          surface: '<audit-surface>',
          boundary: '<audit-boundary>',
          owner: '<audit-owner>',
          status: 'red',
          claimAllowed: false,
          allowedClaim: '<allowed-claim>',
          forbiddenClaim: '<forbidden-claim>',
          evidence: '/tmp/<audit-proof>.json',
          gap: '<audit-gap>',
          nextAction: '<audit-next>',
        }],
      },
      evidenceFreshness: {
        status: 'yellow',
        summary: '<freshness-summary>',
        freshnessLimitMinutes: 60,
        rows: [{
          id: '<proof-id>',
          surface: '<proof-surface>',
          freshnessStatus: 'yellow',
          freshnessSummary: '<freshness-row>',
          trustStatus: 'red',
          checkedAt: '<checked-at>',
          ageMinutes: 61,
          freshForMinutes: 60,
          artifact: '/tmp/<artifact>.json',
          secondaryArtifact: '/tmp/<artifact>.md',
          summary: '<proof-summary>',
          nextAction: '<proof-next>',
        }],
      },
      operatorRecoveryFlow: {
        status: 'red',
        summary: '<flow-summary>',
        nextLocalAction: {
          id: '<next-action-id>',
          priority: 1,
          status: 'red',
          owner: '<next-owner>',
          boundary: '<next-boundary>',
          command: '<next-command>',
          proof: '<next-proof>',
          blocker: '<next-blocker>',
          unblocks: '<next-unblocks>',
        },
        firstBlockedAction: {
          id: '<blocked-action-id>',
          blocker: '<blocked-action-text>',
        },
        runnableNow: [{
          id: '<next-action-id>',
          priority: 1,
          status: 'red',
          owner: '<next-owner>',
          boundary: '<next-boundary>',
          command: '<next-command>',
          proof: '<next-proof>',
          blocker: '<next-blocker>',
          unblocks: '<next-unblocks>',
        }],
        waitingOnDependency: [{
          id: '<blocked-action-id>',
          priority: 2,
          status: 'yellow',
          owner: '<blocked-owner>',
          boundary: '<blocked-boundary>',
          command: '<blocked-command>',
          proof: '<blocked-proof>',
          blocker: '<blocked-action-text>',
          unblocks: '<blocked-unblocks>',
        }],
        boundaries: [{
          boundary: '<next-boundary>',
          count: 1,
          red: 1,
          yellow: 0,
          actions: ['<next-action-id>'],
        }],
      },
      operatorActions: [{
        priority: 1,
        status: 'red',
        owner: '<owner>',
        gate: '<action-gate>',
        boundary: '<boundary>',
        canRunNow: false,
        command: '<command>',
        proof: '<proof>',
        nextAction: '<next-action>',
        evidenceRequired: '<evidence>',
        blockedBy: '',
        blocker: '<blocked>',
      }],
      contracts: [{ gate: '<gate>', status: 'yellow', current: '<current>', proof: '<proof>', nextAction: '<next>' }],
      risks: [{ status: 'yellow', label: '<risk>', detail: '<detail>' }],
    },
  })

  assert.match(html, /&lt;bad&gt;/)
  assert.match(html, /Proof Freshness Ledger/)
  assert.match(html, /Launch Trust Audit/)
  assert.match(html, /&lt;launch-audit-summary&gt;/)
  assert.match(html, /&lt;forbidden-claim&gt;/)
  assert.match(html, /&lt;audit-proof&gt;/)
  assert.match(html, /&lt;freshness-summary&gt;/)
  assert.match(html, /&lt;proof-id&gt;/)
  assert.match(html, /&lt;artifact&gt;/)
  assert.match(html, /Operator Recovery Flow/)
  assert.match(html, /&lt;flow-summary&gt;/)
  assert.match(html, /&lt;next-command&gt;/)
  assert.match(html, /Operator Action Queue/)
  assert.match(html, /Source Promotion Packet Reconciliation/)
  assert.match(html, /&lt;origin-drift&gt;/)
  assert.match(html, /&lt;origin-diff&gt;/)
  assert.match(html, /&lt;review-command&gt;/)
  assert.match(html, /Full stage gate/)
  assert.match(html, /&lt;stage-gate-summary&gt;/)
  assert.match(html, /BLOCKED: resolve 1 red candidate/)
  assert.match(html, /&lt;non-red-path&gt;/)
  assert.match(html, /Staged bundle attestation/)
  assert.match(html, /&lt;staged-bundle-summary&gt;/)
  assert.match(html, /Verify staged exact bundle/)
  assert.match(html, /Staged candidates/)
  assert.match(html, /accepted:accept-current/)
  assert.match(html, /\+2/)
  assert.match(html, /MCP Catalog Delta/)
  assert.match(html, /FirstBite Runner Control Plane/)
  assert.match(html, /&lt;runner-summary&gt;/)
  assert.match(html, /&lt;runner-token&gt;/)
  assert.match(html, /M4 peer boundary/)
  assert.match(html, /&lt;m4-boundary&gt;/)
  assert.match(html, /&lt;m4-commands&gt;/)
  assert.match(html, /&lt;catalog-delta&gt;/)
  assert.match(html, /&lt;missing-repo&gt;/)
  assert.match(html, /source-promotion-review|&lt;action-gate&gt;/)
  assert.match(html, /Trust Contracts/)
  assert.match(html, /Agent Activity Matrix/)
  assert.match(html, /OTEL Evidence Checklist/)
  assert.match(html, /&lt;gate&gt;/)
  assert.match(html, /&lt;action-gate&gt;/)
  assert.match(html, /&lt;blocked&gt;/)
  assert.match(html, /&lt;tempo&gt;/)
  assert.match(html, /&lt;agent-summary&gt;/)
  assert.doesNotMatch(html, /<bad>/)
})
