#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const {
  LOADED_MCP_PROBE_BASENAME,
  inspectLoadedMcpProbe,
  normalizeLoadedMcpPayload,
} = require('./reliability-cockpit.js')

const DEFAULT_OUTPUT_DIR = 'reports'
const DEFAULT_EXPECTED_REPO = 'resplit_currency_api'
const DEFAULT_SOURCE = 'codex-mcp-tool:mcp__firstbite_local_ci.list_lanes'
const DEFAULT_NOTE = 'Captured live loaded-host FirstBite local-CI MCP list_lanes output. This artifact records what the already-loaded Codex/Cursor MCP process exposes, not the repo-backed package source.'
const REUSE_EXISTING_NOTE = 'Reused the previous loaded-host probe payload to refresh artifact freshness only. This does not prove a Codex/Cursor MCP host restart, reload, or new live list_lanes result; capture live MCP output for catalog trust.'
const DEFAULT_EXPECTED_LANE_IDS = [
  'resplit_currency_api_unit',
  'resplit_currency_api_integration',
  'resplit_currency_api_ui',
]

if (require.main === module) {
  try {
    const result = captureLoadedMcpProbe(process.argv.slice(2))
    if (result.help) {
      process.stdout.write(helpText())
    } else {
      process.stdout.write(`loaded-mcp-probe: wrote ${result.outputPath}\n`)
      process.stdout.write(`loaded-mcp-probe: ${result.probe.status} ${result.probe.summary}\n`)
      process.stdout.write(`loaded-mcp-probe: freshness ${result.probe.freshnessStatus} ${result.probe.freshnessSummary}\n`)
    }
  } catch (error) {
    console.error(`loaded-mcp-probe: FAILED\n${error.stack || error.message}`)
    process.exitCode = 1
  }
}

function captureLoadedMcpProbe(argv, deps = {}) {
  const options = parseArgs(argv)
  if (options.help) {
    return { options, help: true }
  }

  const repoDir = path.resolve(options.repoDir || process.cwd())
  const outputPath = path.resolve(repoDir, options.output)
  const input = resolveInputText({ options, repoDir, outputPath, deps })
  const parsed = parsePayloadText(input.text)
  const payload = normalizeLoadedMcpPayload(wrapMcpToolResult(parsed))
  if (!payload) {
    throw new Error('input did not contain a firstbite list_lanes payload')
  }
  const source = input.reusedExisting && options.source === DEFAULT_SOURCE
    ? `previous-loaded-mcp-artifact:${path.relative(repoDir, outputPath)}`
    : options.source
  const note = input.reusedExisting && options.note === DEFAULT_NOTE
    ? REUSE_EXISTING_NOTE
    : options.note

  const artifact = {
    checkedAt: deps.now ? deps.now() : new Date().toISOString(),
    source,
    note,
    payload,
  }

  writeJson(outputPath, artifact)
  const probe = inspectLoadedMcpProbe({
    probePath: outputPath,
    expectedRepo: options.expectedRepo,
    expectedLaneIds: options.expectedLaneIds,
    generatedAt: artifact.checkedAt,
  })

  return { options, outputPath, artifact, probe }
}

function parseArgs(argv) {
  const options = {
    repoDir: null,
    input: null,
    output: path.join(DEFAULT_OUTPUT_DIR, LOADED_MCP_PROBE_BASENAME),
    reuseExisting: false,
    source: DEFAULT_SOURCE,
    note: DEFAULT_NOTE,
    expectedRepo: DEFAULT_EXPECTED_REPO,
    expectedLaneIds: DEFAULT_EXPECTED_LANE_IDS,
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
    case '--input':
      options.input = requireValue(argv, index, arg)
      index += 1
      break
    case '--reuse-existing':
      options.reuseExisting = true
      break
    case '--output':
      options.output = requireValue(argv, index, arg)
      index += 1
      break
    case '--source':
      options.source = requireValue(argv, index, arg)
      index += 1
      break
    case '--note':
      options.note = requireValue(argv, index, arg)
      index += 1
      break
    case '--expected-repo':
      options.expectedRepo = requireValue(argv, index, arg)
      index += 1
      break
    case '--expected-lanes':
      options.expectedLaneIds = requireValue(argv, index, arg)
        .split(',')
        .map(value => value.trim())
        .filter(Boolean)
      index += 1
      break
    default:
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return options
}

function resolveInputText({ options, repoDir, outputPath, deps = {} }) {
  if (options.input) {
    return {
      text: fs.readFileSync(path.resolve(repoDir, options.input), 'utf8'),
      reusedExisting: false,
    }
  }

  if (options.reuseExisting) {
    if (!fs.existsSync(outputPath)) {
      throw new Error(`No existing loaded MCP probe artifact found at ${outputPath}. Pipe live MCP JSON or pass --input <file> first.`)
    }
    return {
      text: fs.readFileSync(outputPath, 'utf8'),
      reusedExisting: true,
    }
  }

  if (deps.stdin !== undefined) {
    return {
      text: deps.stdin,
      reusedExisting: false,
    }
  }

  if (process.stdin.isTTY) {
    throw new Error('Pass --input <file>, --reuse-existing, or pipe the MCP list_lanes JSON into stdin.')
  }

  const text = fs.readFileSync(0, 'utf8')
  if (!String(text || '').trim()) {
    throw new Error('empty MCP list_lanes input. Pipe live mcp__firstbite_local_ci.list_lanes JSON, pass --input <file>, or use --reuse-existing to refresh the previous artifact without proving a host restart.')
  }
  return {
    text,
    reusedExisting: false,
  }
}

function parsePayloadText(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed) {
    throw new Error('empty MCP list_lanes input. Pipe live mcp__firstbite_local_ci.list_lanes JSON, pass --input <file>, or use --reuse-existing to refresh the previous artifact without proving a host restart.')
  }

  try {
    return JSON.parse(trimmed)
  } catch {
    return parseJsonFromMixedOutput(trimmed)
  }
}

function parseJsonFromMixedOutput(text) {
  const candidates = [
    [text.indexOf('{'), text.lastIndexOf('}')],
    [text.indexOf('['), text.lastIndexOf(']')],
  ]

  for (const [start, end] of candidates) {
    if (start === -1 || end === -1 || end < start) {
      continue
    }
    try {
      return JSON.parse(text.slice(start, end + 1))
    } catch {
      // Try the next likely JSON envelope.
    }
  }

  throw new Error('no JSON object or array found in MCP list_lanes input')
}

function wrapMcpToolResult(parsed) {
  if (Array.isArray(parsed)) {
    return { content: parsed }
  }

  if (parsed?.type === 'text' && typeof parsed.text === 'string') {
    return { content: [parsed] }
  }

  return parsed
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
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
    'Usage: node scripts/capture-loaded-mcp-probe.js [--input file] [--reuse-existing] [--output reports/firstbite-loaded-mcp-lanes.json]',
    '',
    'Captures the live loaded-host mcp__firstbite_local_ci.list_lanes output into a durable probe artifact for the reliability cockpit.',
    'Pipe the JSON object or text-content array returned by the MCP tool into stdin, or pass --input with a saved payload.',
    '',
    'Examples:',
    '  mcp__firstbite_local_ci.list_lanes > /tmp/firstbite-loaded-mcp.json',
    '  npm run mcp:loaded-probe -- --input /tmp/firstbite-loaded-mcp.json',
    '  npm run mcp:loaded-probe -- --reuse-existing',
    '',
    '--reuse-existing refreshes the previous artifact timestamp only; it does not prove the host MCP process restarted or saw a new live catalog.',
    '',
  ].join('\n')
}

module.exports = {
  captureLoadedMcpProbe,
  parseArgs,
  parsePayloadText,
  wrapMcpToolResult,
}
