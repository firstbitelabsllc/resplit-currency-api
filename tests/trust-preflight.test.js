const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  buildCommandPlan,
  buildTrustPreflightReport,
  classifyCommandResult,
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

test('buildCommandPlan treats Grafana missing-config smoke as yellow evidence', () => {
  const fast = buildCommandPlan({ full: false })
  const grafana = fast.find(command => command.id === 'grafana-missing-config-proof')

  assert.equal(fast.some(command => command.id === 'source-promotion-packet-syntax'), true)
  assert.equal(fast.some(command => command.id === 'source-promotion-packet-generate'), true)
  assert.ok(fast.find(command => command.id === 'targeted-tests').args.includes('tests/source-promotion-packet.test.js'))
  assert.deepEqual(grafana.expectedExitCodes, [0, 2])
  assert.deepEqual(grafana.yellowExitCodes, [2])
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
