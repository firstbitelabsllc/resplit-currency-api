#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const {
  REPORT_BASENAME,
} = require('./reliability-cockpit.js')

const DEFAULT_OUTPUT_DIR = 'reports'
const EXPECTED_LAUNCH_AUDIT_IDS = [
  'overall-launch-trust',
  'source-contract',
  'clean-firstbite-local-ci',
  'loaded-agent-mcp',
  'repo-backed-mcp-source',
  'firstbite-runner-durability',
  'review-scout-producer-durability',
  'peer-execution',
  'otel-cloudflare-destinations',
  'otel-grafana-proof',
  'release-history-quality',
  'agent-ledger-fleet',
]

if (require.main === module) {
  try {
    const result = auditCockpitCompletion(process.argv.slice(2))
    if (result.help) {
      process.stdout.write(helpText())
    } else if (result.options.printJson) {
      process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`)
    } else {
      process.stdout.write(`completion-audit: ${result.report.status} ${result.report.summary}\n`)
      process.stdout.write(`completion-audit: cockpit ${result.report.cockpitPath}\n`)
      for (const blocker of result.report.blockers.slice(0, 8)) {
        process.stdout.write(`- ${blocker.id} [${blocker.status}] ${blocker.nextAction}\n`)
      }
    }
    if (!result.help) {
      process.exitCode = result.report.status === 'green' ? 0 : 2
    }
  } catch (error) {
    console.error(`completion-audit: FAILED\n${error.stack || error.message}`)
    process.exitCode = 1
  }
}

function auditCockpitCompletion(argv, deps = {}) {
  const options = parseArgs(argv)
  if (options.help) {
    return { options, help: true }
  }

  const repoDir = path.resolve(options.repoDir || process.cwd())
  const cockpitPath = path.resolve(repoDir, options.json)
  const readFile = deps.readFile || fs.readFileSync
  const cockpit = JSON.parse(readRequiredText(cockpitPath, readFile))
  const report = buildCompletionAudit({
    cockpit,
    cockpitPath,
    checkedAt: deps.now ? deps.now() : new Date().toISOString(),
  })

  return { options, report }
}

function parseArgs(argv) {
  const options = {
    repoDir: null,
    json: path.join(DEFAULT_OUTPUT_DIR, `${REPORT_BASENAME}.json`),
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
    case '--json':
      options.printJson = true
      break
    default:
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return options
}

function buildCompletionAudit({ cockpit, cockpitPath, checkedAt }) {
  const launchAudit = cockpit?.trustModel?.launchTrustAudit || {}
  const rows = Array.isArray(launchAudit.rows) ? launchAudit.rows : []
  const contracts = Array.isArray(cockpit?.trustModel?.contracts) ? cockpit.trustModel.contracts : []
  const rowById = new Map(rows.map(row => [row.id, row]))
  const missingRows = EXPECTED_LAUNCH_AUDIT_IDS.filter(id => !rowById.has(id))
  const incompleteRows = rows.filter(row => row.status !== 'green' || row.claimAllowed !== true)
  const nonGreenContracts = contracts.filter(contract => contract.status !== 'green')
  const failures = [
    ...missingRows.map(id => `missing launch audit row: ${id}`),
    ...incompleteRows.map(row => `${row.id}: ${row.status || 'missing'} (${row.surface || 'unknown surface'})`),
    ...nonGreenContracts.map(contract => `${contract.gate}: ${contract.status || 'missing'}`),
  ]
  const status = cockpit?.verdict?.status === 'green'
    && launchAudit.status === 'green'
    && missingRows.length === 0
    && incompleteRows.length === 0
    && nonGreenContracts.length === 0
    ? 'green'
    : 'red'

  return {
    checkedAt,
    status,
    summary: status === 'green'
      ? `Launch completion audit is green: ${rows.length} launch boundary(s) and ${contracts.length} trust contract(s) are claim-allowed.`
      : `Launch completion blocked: ${incompleteRows.length + missingRows.length} non-green/missing launch boundary(s), ${nonGreenContracts.length} non-green trust contract(s).`,
    cockpitPath,
    cockpitVerdict: cockpit?.verdict || null,
    launchTrustAudit: {
      status: launchAudit.status || 'missing',
      summary: launchAudit.summary || 'Launch Trust Audit section is missing or incomplete.',
      expectedRowIds: EXPECTED_LAUNCH_AUDIT_IDS,
      missingRows,
    },
    blockers: incompleteRows.map(row => ({
      id: row.id,
      surface: row.surface,
      boundary: row.boundary,
      owner: row.owner,
      status: row.status || 'missing',
      claimAllowed: row.claimAllowed === true,
      evidence: row.evidence || 'missing',
      gap: row.gap || '',
      nextAction: row.nextAction || '',
    })),
    nonGreenContracts: nonGreenContracts.map(contract => ({
      gate: contract.gate,
      status: contract.status || 'missing',
      current: contract.current || '',
      proof: contract.proof || '',
      nextAction: contract.nextAction || '',
    })),
    failures,
  }
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

function helpText() {
  return [
    'Usage: node scripts/reliability-completion-audit.js [--json] [--json-file reports/resplit-fx-reliability-cockpit.json]',
    '',
    'Reads the generated reliability cockpit JSON and fails until every launch-trust boundary and trust contract is green.',
    '',
  ].join('\n')
}

module.exports = {
  EXPECTED_LAUNCH_AUDIT_IDS,
  auditCockpitCompletion,
  buildCompletionAudit,
  parseArgs,
}
