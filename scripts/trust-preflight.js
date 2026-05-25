#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const {
  REPORT_BASENAME,
  TRUST_PREFLIGHT_BASENAME,
  main: generateCockpit,
} = require('./reliability-cockpit.js')

const DEFAULT_OUTPUT_DIR = 'reports'
const DEFAULT_MARKDOWN_BASENAME = 'resplit-fx-trust-preflight.md'
const OUTPUT_TAIL_LIMIT = 4000

if (require.main === module) {
  runTrustPreflight(process.argv.slice(2)).then(result => {
    if (result.options.printJson) {
      process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`)
    } else {
      process.stdout.write(`trust-preflight: ${result.report.summary.headline}\n`)
      process.stdout.write(`trust-preflight: wrote ${result.report.outputPath}\n`)
      process.stdout.write(`trust-preflight: wrote ${result.report.markdownPath}\n`)
    }
    process.exitCode = result.report.status === 'red' ? 1 : 0
  }).catch(error => {
    console.error(`trust-preflight: FAILED\n${error.stack || error.message}`)
    process.exitCode = 1
  })
}

async function runTrustPreflight(argv, deps = {}) {
  const options = parseArgs(argv)
  if (options.help) {
    process.stdout.write(helpText())
    return { options, report: null }
  }

  const repoDir = path.resolve(options.repoDir || process.cwd())
  const outputPath = path.resolve(repoDir, options.output)
  const markdownPath = path.resolve(repoDir, options.markdownOutput)
  const commandPlan = buildCommandPlan(options)
  const commandRunner = deps.runCommand || runCommand
  const commands = []

  for (const spec of commandPlan) {
    commands.push(commandRunner(spec, { repoDir }))
  }

  const cockpit = readCockpitSummary(repoDir)
  const report = buildTrustPreflightReport({
    repoDir,
    generatedAt: deps.now ? deps.now() : new Date().toISOString(),
    mode: options.full ? 'full' : 'fast',
    outputPath,
    markdownPath,
    commands,
    cockpit,
  })

  if (!options.noWrite) {
    writeJson(outputPath, report)
    writeText(markdownPath, renderMarkdown(report))
  }

  if (!options.skipCockpit && !options.noWrite) {
    await (deps.generateCockpit || generateCockpit)(['--repo', repoDir])
  }

  return { options, report }
}

function parseArgs(argv) {
  const options = {
    repoDir: null,
    output: path.join(DEFAULT_OUTPUT_DIR, TRUST_PREFLIGHT_BASENAME),
    markdownOutput: path.join(DEFAULT_OUTPUT_DIR, DEFAULT_MARKDOWN_BASENAME),
    full: false,
    skipCockpit: false,
    noWrite: false,
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
    case '--output':
      options.output = requireValue(argv, index, arg)
      index += 1
      break
    case '--markdown-output':
      options.markdownOutput = requireValue(argv, index, arg)
      index += 1
      break
    case '--full':
      options.full = true
      break
    case '--skip-cockpit':
      options.skipCockpit = true
      break
    case '--no-write':
      options.noWrite = true
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

function requireValue(argv, index, arg) {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${arg} requires a value`)
  }
  return value
}

function helpText() {
  return [
    'Usage: node scripts/trust-preflight.js [--full] [--json] [--output reports/resplit-fx-trust-preflight.json]',
    '',
    'Runs the local, non-destructive trust checks that feed the Resplit FX reliability cockpit.',
    'Default mode is fast: syntax, targeted cockpit/Grafana/preflight tests, yellow Grafana missing-config proof, and cockpit regeneration.',
    'Use --full to also run npm run test, npm run check:publish, npm run smoke:deploy, and the strict release validator.',
    '',
  ].join('\n')
}

function buildCommandPlan(options = {}) {
  const commands = [
    commandSpec('cockpit-syntax', 'Cockpit syntax', 'node', ['--check', 'scripts/reliability-cockpit.js']),
    commandSpec('preflight-syntax', 'Preflight syntax', 'node', ['--check', 'scripts/trust-preflight.js']),
    commandSpec('source-promotion-packet-syntax', 'Source promotion packet syntax', 'node', ['--check', 'scripts/source-promotion-packet.js']),
    commandSpec('grafana-verifier-syntax', 'Grafana verifier syntax', 'node', ['--check', 'scripts/verify-grafana-otel-smoke.js']),
    commandSpec('loaded-mcp-capture-syntax', 'Loaded MCP capture syntax', 'node', ['--check', 'scripts/capture-loaded-mcp-probe.js']),
    commandSpec('targeted-tests', 'Targeted cockpit tests', 'node', [
      '--test',
      'tests/capture-loaded-mcp-probe.test.js',
      'tests/reliability-cockpit.test.js',
      'tests/source-promotion-packet.test.js',
      'tests/verify-grafana-otel-smoke.test.js',
      'tests/trust-preflight.test.js',
    ]),
    commandSpec('grafana-missing-config-proof', 'Grafana missing-config proof', 'npm', [
      'run',
      'observability:otel-smoke',
      '--',
      '--skip-trigger',
      '--output',
      path.join(DEFAULT_OUTPUT_DIR, 'grafana-otel-smoke.json'),
    ], { expectedExitCodes: [0, 2], yellowExitCodes: [2] }),
    commandSpec('cockpit-generate', 'Cockpit regenerate', 'npm', ['run', 'reliability:cockpit']),
    commandSpec('source-promotion-packet-generate', 'Source promotion packet generate', 'npm', ['run', 'source:promotion-packet'], {
      expectedExitCodes: [0, 1],
      yellowExitCodes: [1],
    }),
  ]

  if (options.full) {
    commands.push(
      commandSpec('full-test-suite', 'Full test suite', 'npm', ['run', 'test']),
      commandSpec('publish-check', 'Publish recovery check', 'npm', ['run', 'check:publish']),
      commandSpec('deploy-smoke', 'Live deploy smoke', 'npm', ['run', 'smoke:deploy']),
      commandSpec('strict-release-validation', 'Strict release validation', 'npm', ['run', 'validate:release'], {
        expectedExitCodes: [0, 1],
        yellowExitCodes: [1],
      }),
    )
  }

  return commands
}

function commandSpec(id, label, bin, args, overrides = {}) {
  return {
    id,
    label,
    bin,
    args,
    command: [bin, ...args].join(' '),
    expectedExitCodes: overrides.expectedExitCodes || [0],
    yellowExitCodes: overrides.yellowExitCodes || [],
  }
}

function runCommand(spec, { repoDir }) {
  const startedAt = Date.now()
  const result = spawnSync(spec.bin, spec.args, {
    cwd: repoDir,
    encoding: 'utf8',
    env: process.env,
  })
  const durationMs = Date.now() - startedAt
  const rc = typeof result.status === 'number' ? result.status : 1
  return classifyCommandResult({
    ...spec,
    rc,
    durationMs,
    stdout: result.stdout || '',
    stderr: result.stderr || result.error?.message || '',
  })
}

function classifyCommandResult(result) {
  const expected = result.expectedExitCodes || [0]
  const yellow = result.yellowExitCodes || []
  const status = expected.includes(result.rc)
    ? (yellow.includes(result.rc) ? 'yellow' : 'green')
    : 'red'

  return {
    id: result.id,
    label: result.label,
    command: result.command,
    status,
    rc: result.rc,
    expectedExitCodes: expected,
    yellowExitCodes: yellow,
    durationMs: result.durationMs,
    stdoutTail: tail(result.stdout || ''),
    stderrTail: tail(result.stderr || ''),
  }
}

function buildTrustPreflightReport({
  repoDir,
  generatedAt,
  mode,
  outputPath,
  markdownPath,
  commands,
  cockpit,
}) {
  const commandCounts = countByStatus(commands)
  const status = commands.some(command => command.status === 'red') || cockpit?.verdict?.status === 'red'
    ? 'red'
    : commands.some(command => command.status === 'yellow') || cockpit?.verdict?.status === 'yellow'
      ? 'yellow'
      : 'green'
  const headline = `status=${status}; commands ${commandCounts.green || 0} green, ${commandCounts.yellow || 0} yellow, ${commandCounts.red || 0} red; cockpit=${cockpit?.verdict?.label || 'unknown'}`

  return {
    generatedAt,
    mode,
    status,
    repo: {
      name: path.basename(repoDir),
      path: repoDir,
    },
    outputPath,
    markdownPath,
    cockpit,
    summary: {
      headline,
      commandCounts,
    },
    commands,
  }
}

function readCockpitSummary(repoDir) {
  const reportPath = path.join(repoDir, DEFAULT_OUTPUT_DIR, `${REPORT_BASENAME}.json`)
  const report = readJsonIfExists(reportPath)
  if (!report) {
    return {
      path: reportPath,
      verdict: null,
      contracts: [],
    }
  }

  return {
    path: reportPath,
    generatedAt: report.generatedAt || null,
    verdict: report.verdict || null,
    contracts: (report.trustModel?.contracts || []).map(contract => ({
      gate: contract.gate,
      status: contract.status,
      current: contract.current,
      proof: contract.proof,
      nextAction: contract.nextAction,
    })),
  }
}

function renderMarkdown(report) {
  const lines = [
    '# Resplit FX Trust Preflight',
    '',
    `- Generated: ${report.generatedAt}`,
    `- Mode: ${report.mode}`,
    `- Status: ${report.status}`,
    `- Cockpit: ${report.cockpit?.verdict?.label || 'unknown'}`,
    '',
    '## Commands',
    '',
    '| Check | Status | Exit | Expected | Command |',
    '|---|---:|---:|---|---|',
    ...report.commands.map(command => `| ${escapeMarkdown(command.label)} | ${command.status} | ${command.rc} | ${(command.expectedExitCodes || []).join(', ')} | \`${escapeMarkdown(command.command)}\` |`),
    '',
    '## Trust Contracts',
    '',
    '| Gate | Status | Current truth | Next action |',
    '|---|---:|---|---|',
    ...((report.cockpit?.contracts || []).map(contract => `| ${escapeMarkdown(contract.gate)} | ${contract.status} | ${escapeMarkdown(contract.current)} | ${escapeMarkdown(contract.nextAction)} |`)),
    '',
  ]
  return `${lines.join('\n')}\n`
}

function countByStatus(commands) {
  return commands.reduce((counts, command) => {
    counts[command.status] = (counts[command.status] || 0) + 1
    return counts
  }, {})
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, value)
}

function tail(value) {
  const text = String(value || '')
  if (text.length <= OUTPUT_TAIL_LIMIT) {
    return text
  }
  return text.slice(-OUTPUT_TAIL_LIMIT)
}

function escapeMarkdown(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

module.exports = {
  buildCommandPlan,
  buildTrustPreflightReport,
  classifyCommandResult,
  parseArgs,
  renderMarkdown,
  runTrustPreflight,
}
