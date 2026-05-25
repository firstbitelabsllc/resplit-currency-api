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
const DIAGNOSTIC_SIGNAL_LIMIT = 8
const DIAGNOSTIC_BLOCKER_SUMMARY_LIMIT = 4
const DIAGNOSTIC_LINE_LIMIT = 240

if (require.main === module) {
  runTrustPreflight(process.argv.slice(2)).then(result => {
    if (result.options.printJson) {
      process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`)
    } else {
      process.stdout.write(`trust-preflight: ${result.report.summary.headline}\n`)
      process.stdout.write(`trust-preflight: wrote ${result.report.outputPath}\n`)
      process.stdout.write(`trust-preflight: wrote ${result.report.markdownPath}\n`)
      for (const line of formatPreflightDiagnosticLines(result.report)) {
        process.stdout.write(`${line}\n`)
      }
    }
    process.exitCode = exitCodeForStatus(result.report.status)
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
    commandSpec('cloudflare-destinations-syntax', 'Cloudflare destinations verifier syntax', 'node', ['--check', 'scripts/verify-cloudflare-otel-destinations.js']),
    commandSpec('grafana-verifier-syntax', 'Grafana verifier syntax', 'node', ['--check', 'scripts/verify-grafana-otel-smoke.js']),
    commandSpec('loaded-mcp-capture-syntax', 'Loaded MCP capture syntax', 'node', ['--check', 'scripts/capture-loaded-mcp-probe.js']),
    commandSpec('cockpit-report-verifier-syntax', 'Cockpit report verifier syntax', 'node', ['--check', 'scripts/verify-reliability-cockpit-report.js']),
    commandSpec('completion-audit-syntax', 'Completion audit syntax', 'node', ['--check', 'scripts/reliability-completion-audit.js']),
    commandSpec('targeted-tests', 'Targeted cockpit tests', 'node', [
      '--test',
      'tests/capture-loaded-mcp-probe.test.js',
      'tests/reliability-cockpit.test.js',
      'tests/reliability-completion-audit.test.js',
      'tests/source-promotion-packet.test.js',
      'tests/verify-cloudflare-otel-destinations.test.js',
      'tests/verify-grafana-otel-smoke.test.js',
      'tests/verify-reliability-cockpit-report.test.js',
      'tests/trust-preflight.test.js',
    ]),
    commandSpec('cloudflare-destinations-proof', 'Cloudflare destinations proof', 'npm', [
      'run',
      'observability:cloudflare-destinations',
      '--',
      '--output',
      path.join(DEFAULT_OUTPUT_DIR, 'cloudflare-otel-destinations.json'),
    ], { expectedExitCodes: [0, 2], yellowExitCodes: [2] }),
    commandSpec('grafana-missing-config-proof', 'Grafana missing-config proof', 'npm', [
      'run',
      'observability:otel-smoke',
      '--',
      '--skip-trigger',
      '--output',
      path.join(DEFAULT_OUTPUT_DIR, 'grafana-missing-config-preflight.json'),
    ], { expectedExitCodes: [0, 2], yellowExitCodes: [2] }),
    commandSpec('cockpit-generate', 'Cockpit regenerate', 'npm', ['run', 'reliability:cockpit']),
    commandSpec('cockpit-report-contract', 'Cockpit report contract', 'npm', ['run', 'reliability:cockpit:verify']),
    commandSpec('completion-audit', 'Launch completion audit', 'npm', ['run', 'reliability:completion-audit'], {
      expectedExitCodes: [0, 2],
      redExitCodes: [2],
    }),
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
    redExitCodes: overrides.redExitCodes || [],
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
  const red = result.redExitCodes || []
  const status = expected.includes(result.rc)
    ? (red.includes(result.rc) ? 'red' : yellow.includes(result.rc) ? 'yellow' : 'green')
    : 'red'

  return {
    id: result.id,
    label: result.label,
    command: result.command,
    status,
    rc: result.rc,
    expectedExitCodes: expected,
    yellowExitCodes: yellow,
    redExitCodes: red,
    durationMs: result.durationMs,
    stdoutTail: tail(result.stdout || ''),
    stderrTail: tail(result.stderr || ''),
  }
}

function exitCodeForStatus(status) {
  if (status === 'red') {
    return 2
  }
  if (status === 'yellow') {
    return 1
  }
  return 0
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
  const commandDiagnostics = summarizeCommandDiagnostics(commands)
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
      commandDiagnostics,
      blockingCommands: commandDiagnostics.filter(command => command.status === 'red'),
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
  const commandDiagnostics = report.summary?.commandDiagnostics || []
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
    '| Check | Status | Exit | Expected | Yellow | Command |',
    '|---|---:|---:|---|---|---|',
    ...report.commands.map(command => `| ${escapeMarkdown(command.label)} | ${command.status} | ${command.rc} | ${(command.expectedExitCodes || []).join(', ')} | ${(command.yellowExitCodes || []).join(', ') || 'none'} | \`${escapeMarkdown(command.command)}\` |`),
    '',
    '## Non-Green Command Details',
    '',
    commandDiagnostics.length === 0
      ? 'All command exits were green.'
      : '| Check | Status | Exit | Summary | Blocking rows |\n|---|---:|---:|---|---|\n'
        + commandDiagnostics.map(command => {
          const blockers = (command.blockers || [])
            .map(blocker => `${blocker.id} [${blocker.status}] ${blocker.detail}`)
            .join('; ') || 'none'
          return `| ${escapeMarkdown(command.label || command.id)} | ${command.status} | ${command.rc} | ${escapeMarkdown(command.summary)} | ${escapeMarkdown(blockers)} |`
        }).join('\n'),
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

function summarizeCommandDiagnostics(commands) {
  return commands
    .filter(command => command.status && command.status !== 'green')
    .map(command => {
      const output = [command.stdoutTail, command.stderrTail].filter(Boolean).join('\n')
      const blockers = extractBlockingRows(output)
      const signals = extractDiagnosticSignals(output)
      const summary = signals[0]
        || summarizeBlockingRows(blockers)
        || `${command.label || command.id || 'Command'} exited ${command.rc ?? 'unknown'}.`
      return {
        id: command.id || 'unknown',
        label: command.label || command.id || 'unknown',
        command: command.command || '',
        status: command.status,
        rc: command.rc,
        summary,
        signals,
        blockers,
      }
    })
}

function summarizeBlockingRows(blockers) {
  const rows = (blockers || []).slice(0, DIAGNOSTIC_BLOCKER_SUMMARY_LIMIT)
  if (rows.length === 0) {
    return null
  }
  return `blocked by ${rows.map(row => `${row.id} [${row.status}]`).join(', ')}`
}

function extractBlockingRows(output) {
  return String(output || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .map(line => {
      const match = line.match(/^-\s+(.+?)\s+\[(red|yellow|green)\]\s+(.+)$/i)
      if (!match) {
        return null
      }
      return {
        id: truncateDiagnosticLine(match[1]),
        status: match[2].toLowerCase(),
        detail: truncateDiagnosticLine(match[3]),
      }
    })
    .filter(Boolean)
    .filter(row => row.status === 'red' || row.status === 'yellow')
    .slice(0, DIAGNOSTIC_SIGNAL_LIMIT)
}

function extractDiagnosticSignals(output) {
  const seen = new Set()
  const signals = []
  for (const rawLine of String(output || '').split(/\r?\n/)) {
    const line = truncateDiagnosticLine(rawLine)
    if (!line || seen.has(line)) {
      continue
    }
    if (isBlockingRowLine(line)) {
      continue
    }
    if (/^completion-audit:\s+cockpit\b/i.test(line)) {
      continue
    }
    if (/^>/.test(line) || /^npm\s+(ERR!|WARN)/i.test(line)) {
      continue
    }
    if (/^(completion-audit|trust-preflight|smoke-check-deploy):/i.test(line)
      || /^FAILED\b/i.test(line)
      || /^Error:/i.test(line)
      || /^Missing\b/i.test(line)
      || /\bblocked\b/i.test(line)) {
      seen.add(line)
      signals.push(line)
    }
    if (signals.length >= DIAGNOSTIC_SIGNAL_LIMIT) {
      break
    }
  }
  return signals
}

function isBlockingRowLine(line) {
  return /^-\s+.+?\s+\[(red|yellow|green)\]\s+.+$/i.test(String(line || '').trim())
}

function formatPreflightDiagnosticLines(report) {
  const diagnostics = report.summary?.commandDiagnostics || []
  const shouldPrintYellow = report.status === 'yellow'
  return diagnostics
    .filter(command => command.status === 'red' || shouldPrintYellow)
    .flatMap(command => {
      const lines = [
        `trust-preflight: ${command.status} command ${command.id} exited ${command.rc ?? 'unknown'}: ${command.summary}`,
      ]
      for (const blocker of (command.blockers || []).slice(0, DIAGNOSTIC_BLOCKER_SUMMARY_LIMIT)) {
        lines.push(`trust-preflight: blocker ${blocker.id} [${blocker.status}] ${blocker.detail}`)
      }
      return lines
    })
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
  const truncated = text.slice(-OUTPUT_TAIL_LIMIT)
  const firstNewline = truncated.indexOf('\n')
  return firstNewline === -1 ? truncated : truncated.slice(firstNewline + 1)
}

function truncateDiagnosticLine(value) {
  const line = String(value || '').trim().replace(/\s+/g, ' ')
  return line.length <= DIAGNOSTIC_LINE_LIMIT ? line : `${line.slice(0, DIAGNOSTIC_LINE_LIMIT - 3)}...`
}

function escapeMarkdown(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

module.exports = {
  buildCommandPlan,
  buildTrustPreflightReport,
  classifyCommandResult,
  exitCodeForStatus,
  formatPreflightDiagnosticLines,
  parseArgs,
  renderMarkdown,
  runTrustPreflight,
  summarizeCommandDiagnostics,
}
