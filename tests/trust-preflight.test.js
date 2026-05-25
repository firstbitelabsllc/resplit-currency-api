const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  buildCommandPlan,
  buildTrustPreflightReport,
  classifyCommandResult,
  exitCodeForStatus,
  formatPreflightDiagnosticLines,
  parseArgs,
  renderMarkdown,
  runTrustPreflight,
} = require('../scripts/trust-preflight.js')

test('parseArgs keeps fast preflight local and read-only by default', () => {
  const options = parseArgs([])

  assert.equal(options.full, false)
  assert.equal(options.skipCockpit, false)
  assert.equal(options.output, path.join('reports', 'resplit-fx-trust-preflight.json'))
  assert.equal(options.markdownOutput, path.join('reports', 'resplit-fx-trust-preflight.md'))
})

test('buildCommandPlan treats Cloudflare and Grafana missing-config proof as yellow evidence', () => {
  const fast = buildCommandPlan({ full: false })
  const cloudflare = fast.find(command => command.id === 'cloudflare-destinations-proof')
  const grafana = fast.find(command => command.id === 'grafana-missing-config-proof')

  assert.equal(fast.some(command => command.id === 'source-promotion-packet-syntax'), true)
  assert.equal(fast.some(command => command.id === 'completion-audit-syntax'), true)
  assert.equal(fast.some(command => command.id === 'source-promotion-packet-generate'), true)
  assert.ok(fast.find(command => command.id === 'targeted-tests').args.includes('tests/source-promotion-packet.test.js'))
  assert.ok(fast.find(command => command.id === 'targeted-tests').args.includes('tests/reliability-completion-audit.test.js'))
  assert.ok(fast.find(command => command.id === 'targeted-tests').args.includes('tests/verify-cloudflare-otel-destinations.test.js'))
  assert.deepEqual(cloudflare.expectedExitCodes, [0, 2])
  assert.deepEqual(cloudflare.yellowExitCodes, [2])
  assert.deepEqual(grafana.expectedExitCodes, [0, 2])
  assert.deepEqual(grafana.yellowExitCodes, [2])
  assert.deepEqual(fast.find(command => command.id === 'completion-audit').expectedExitCodes, [0, 2])
  assert.deepEqual(fast.find(command => command.id === 'completion-audit').redExitCodes, [2])
  assert.deepEqual(grafana.args.slice(-2), ['--output', path.join('reports', 'grafana-missing-config-preflight.json')])
  assert.deepEqual(fast.find(command => command.id === 'source-promotion-packet-generate').yellowExitCodes, [1])
  assert.equal(fast.some(command => command.id === 'full-test-suite'), false)

  const full = buildCommandPlan({ full: true })
  assert.equal(full.some(command => command.id === 'full-test-suite'), true)
  assert.deepEqual(full.find(command => command.id === 'strict-release-validation').yellowExitCodes, [1])
})

test('classifyCommandResult separates expected yellow exits from red failures', () => {
  assert.equal(classifyCommandResult({
    id: 'grafana',
    label: 'Grafana',
    command: 'npm run observability:otel-smoke',
    rc: 2,
    expectedExitCodes: [0, 2],
    yellowExitCodes: [2],
    durationMs: 10,
    stdout: 'yellow',
  }).status, 'yellow')

  assert.equal(classifyCommandResult({
    id: 'test',
    label: 'Test',
    command: 'npm run test',
    rc: 1,
    expectedExitCodes: [0],
    yellowExitCodes: [],
    durationMs: 10,
    stderr: 'failed',
  }).status, 'red')

  assert.equal(classifyCommandResult({
    id: 'completion-audit',
    label: 'Completion audit',
    command: 'npm run reliability:completion-audit',
    rc: 2,
    expectedExitCodes: [0, 2],
    redExitCodes: [2],
    durationMs: 10,
    stdout: 'launch completion blocked',
  }).status, 'red')
})

test('exitCodeForStatus preserves top-level yellow versus red trust state', () => {
  assert.equal(exitCodeForStatus('green'), 0)
  assert.equal(exitCodeForStatus('yellow'), 1)
  assert.equal(exitCodeForStatus('red'), 2)
})

test('buildTrustPreflightReport keeps cockpit red as the overall result', () => {
  const report = buildTrustPreflightReport({
    repoDir: '/tmp/resplit-currency-api',
    generatedAt: '2026-05-25T06:00:00.000Z',
    mode: 'fast',
    outputPath: '/tmp/report.json',
    markdownPath: '/tmp/report.md',
    commands: [
      { id: 'syntax', label: 'Syntax', command: 'node --check', status: 'green', rc: 0, expectedExitCodes: [0] },
      { id: 'grafana', label: 'Grafana', command: 'npm run observability:otel-smoke', status: 'yellow', rc: 2, expectedExitCodes: [0, 2] },
    ],
    cockpit: {
      verdict: { status: 'red', label: 'RED - missing required trust contract' },
      contracts: [{ gate: 'Loaded MCP host catalog', status: 'red', current: 'stale', nextAction: 'restart host' }],
    },
  })

  assert.equal(report.status, 'red')
  assert.match(report.summary.headline, /cockpit=RED/)
  assert.match(renderMarkdown(report), /Loaded MCP host catalog/)
})

test('buildTrustPreflightReport promotes red command output into actionable diagnostics', () => {
  const completionAudit = classifyCommandResult({
    id: 'completion-audit',
    label: 'Launch completion audit',
    command: 'npm run reliability:completion-audit',
    rc: 2,
    expectedExitCodes: [0, 2],
    redExitCodes: [2],
    durationMs: 10,
    stdout: [
      'completion-audit: red Launch completion blocked: 0 stale/missing cockpit report(s), 2 non-green trust contract(s).',
      '- source-contract [red] Source bundle has not landed on origin/main.',
      '- proof:otel-grafana-proof [yellow] Tempo and Loki proof are still missing.',
    ].join('\n'),
  })
  const report = buildTrustPreflightReport({
    repoDir: '/tmp/resplit-currency-api',
    generatedAt: '2026-05-25T06:00:00.000Z',
    mode: 'fast',
    outputPath: '/tmp/report.json',
    markdownPath: '/tmp/report.md',
    commands: [completionAudit],
    cockpit: {
      verdict: { status: 'red', label: 'RED - missing required trust contract' },
      contracts: [],
    },
  })
  const diagnostic = report.summary.commandDiagnostics[0]
  const printed = formatPreflightDiagnosticLines(report).join('\n')
  const markdown = renderMarkdown(report)

  assert.equal(diagnostic.id, 'completion-audit')
  assert.match(diagnostic.summary, /Launch completion blocked/)
  assert.equal(diagnostic.blockers[0].id, 'source-contract')
  assert.equal(diagnostic.blockers[0].status, 'red')
  assert.match(printed, /trust-preflight: red command completion-audit exited 2/)
  assert.match(printed, /trust-preflight: blocker source-contract \[red\]/)
  assert.match(markdown, /Non-Green Command Details/)
  assert.match(markdown, /proof:otel-grafana-proof/)
})

test('runTrustPreflight writes JSON and Markdown, then refreshes cockpit', async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-preflight-'))
  fs.mkdirSync(path.join(repoDir, 'reports'), { recursive: true })
  fs.writeFileSync(path.join(repoDir, 'reports', 'resplit-fx-reliability-cockpit.json'), JSON.stringify({
    generatedAt: '2026-05-25T06:00:00.000Z',
    verdict: { status: 'yellow', label: 'YELLOW - control surface exists, proof still split' },
    trustModel: {
      contracts: [{ gate: 'OTEL/Grafana evidence', status: 'yellow', current: 'missing Tempo/Loki', nextAction: 'run verifier' }],
    },
  }))

  const seen = []
  const result = await runTrustPreflight(['--repo', repoDir], {
    now: () => '2026-05-25T06:01:00.000Z',
    runCommand: spec => {
      seen.push(spec.id)
      return classifyCommandResult({
        ...spec,
        rc: spec.yellowExitCodes?.[0] || 0,
        durationMs: 5,
        stdout: 'ok',
      })
    },
    generateCockpit: async argv => {
      seen.push(`cockpit:${argv.join(' ')}`)
    },
  })

  assert.equal(result.report.status, 'yellow')
  assert.equal(fs.existsSync(path.join(repoDir, 'reports', 'resplit-fx-trust-preflight.json')), true)
  assert.equal(fs.existsSync(path.join(repoDir, 'reports', 'resplit-fx-trust-preflight.md')), true)
  assert.equal(seen.includes('targeted-tests'), true)
  assert.equal(seen.includes(`cockpit:--repo ${repoDir}`), true)
})
