#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_OUTPUT = path.join('reports', 'cloudflare-otel-destinations.json')
const DEFAULT_WRANGLER = 'wrangler.jsonc'
const DEFAULT_API_BASE_URL = 'https://api.cloudflare.com/client/v4'
const DEFAULT_TIMEOUT_MS = 10000

if (require.main === module) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`verify-cloudflare-otel-destinations: FAILED\n${error.stack || error.message}`)
    process.exitCode = 1
  })
}

async function main(argv, deps = {}) {
  const options = parseArgs(argv, process.env)
  if (options.help) {
    process.stdout.write(helpText())
    return
  }

  const report = await buildCloudflareDestinationsReport(options, deps)
  writeJson(options.output, report)

  if (options.printJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(`verify-cloudflare-otel-destinations: ${report.status}: ${report.summary} output=${options.output}\n`)
  }

  process.exitCode = report.status === 'green' ? 0 : report.status === 'yellow' ? 2 : 1
}

function parseArgs(argv, env = process.env) {
  const options = {
    help: false,
    printJson: false,
    output: env.CLOUDFLARE_OTEL_DESTINATIONS_OUTPUT || DEFAULT_OUTPUT,
    wranglerPath: env.CLOUDFLARE_OTEL_WRANGLER || DEFAULT_WRANGLER,
    wranglerEnv: env.CLOUDFLARE_OTEL_WRANGLER_ENV || '',
    workerName: env.CLOUDFLARE_OTEL_WORKER || '',
    accountId: firstEnv(env, ['CLOUDFLARE_ACCOUNT_ID', 'CF_ACCOUNT_ID']),
    token: firstEnv(env, ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN']),
    apiBaseUrl: env.CLOUDFLARE_API_BASE_URL || DEFAULT_API_BASE_URL,
    timeoutMs: Number(env.CLOUDFLARE_OTEL_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
    case '--help':
    case '-h':
      options.help = true
      break
    case '--json':
      options.printJson = true
      break
    case '--output':
      options.output = requireValue(argv, index, arg)
      index += 1
      break
    case '--wrangler':
      options.wranglerPath = requireValue(argv, index, arg)
      index += 1
      break
    case '--wrangler-env':
      options.wranglerEnv = requireValue(argv, index, arg)
      index += 1
      break
    case '--worker':
      options.workerName = requireValue(argv, index, arg)
      index += 1
      break
    case '--account-id':
      options.accountId = requireValue(argv, index, arg)
      index += 1
      break
    case '--api-token':
      options.token = requireValue(argv, index, arg)
      index += 1
      break
    case '--api-base-url':
      options.apiBaseUrl = requireValue(argv, index, arg)
      index += 1
      break
    case '--timeout-ms':
      options.timeoutMs = Number(requireValue(argv, index, arg))
      index += 1
      break
    default:
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  options.apiBaseUrl = String(options.apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/+$/, '')
  options.timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS)
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
    'Usage: node scripts/verify-cloudflare-otel-destinations.js [options]',
    '',
    'Read-only Cloudflare Workers Observability destination proof for Resplit FX.',
    'Writes reports/cloudflare-otel-destinations.json, which the reliability cockpit reads.',
    '',
    'Required env for green proof:',
    '  CLOUDFLARE_ACCOUNT_ID',
    '  CLOUDFLARE_API_TOKEN with Workers Observability Read permission',
    '',
    'Useful env/options:',
    '  CLOUDFLARE_OTEL_DESTINATIONS_OUTPUT / --output',
    '  CLOUDFLARE_OTEL_WRANGLER / --wrangler',
    '  CLOUDFLARE_OTEL_WRANGLER_ENV / --wrangler-env',
    '  CLOUDFLARE_OTEL_WORKER / --worker',
    '',
  ].join('\n')
}

async function buildCloudflareDestinationsReport(options, deps = {}) {
  const now = deps.now ? new Date(deps.now()) : new Date()
  const fetchImpl = deps.fetch || global.fetch
  const wrangler = readWranglerExpectations(options.wranglerPath, options.wranglerEnv)
  const workerName = options.workerName || wrangler.workerName
  const expected = wrangler.expected
  const missingConfig = missingCloudflareConfig(options)
  const report = {
    checkedAt: now.toISOString(),
    status: 'yellow',
    worker: workerName || null,
    wrangler: {
      path: options.wranglerPath,
      env: options.wranglerEnv || 'top-level',
      observabilityScope: wrangler.scope,
      expected,
    },
    cloudflare: {
      apiBaseUrl: options.apiBaseUrl,
      accountIdConfigured: Boolean(options.accountId),
      tokenConfigured: Boolean(options.token),
      missingConfig,
      requestStatus: null,
      queryError: null,
      destinationCount: null,
    },
    destinations: [],
    checks: [],
    nextActions: [],
    summary: '',
  }

  if (wrangler.error) {
    report.status = 'red'
    report.summary = wrangler.error
    report.checks = buildCloudflareDestinationChecks(report, [])
    report.nextActions = summarizeNextActions(report.checks)
    return report
  }

  if (expected.length === 0) {
    report.status = 'red'
    report.summary = 'wrangler.jsonc does not declare any OTEL logs or traces destinations.'
    report.checks = buildCloudflareDestinationChecks(report, [])
    report.nextActions = summarizeNextActions(report.checks)
    return report
  }

  if (typeof fetchImpl !== 'function') {
    report.status = 'red'
    report.summary = 'Fetch API is unavailable in this Node runtime.'
    report.checks = buildCloudflareDestinationChecks(report, [])
    report.nextActions = summarizeNextActions(report.checks)
    return report
  }

  if (missingConfig.length > 0) {
    report.summary = `Missing Cloudflare read config: ${missingConfig.join(', ')}.`
    report.checks = buildCloudflareDestinationChecks(report, [])
    report.nextActions = summarizeNextActions(report.checks)
    return report
  }

  const response = await fetchDestinations(fetchImpl, options)
  report.cloudflare.requestStatus = response.status
  if (response.error) {
    report.cloudflare.queryError = response.error
    report.status = 'red'
    report.summary = `Cloudflare destination query failed${response.status ? ` with HTTP ${response.status}` : ''}: ${response.error}.`
    report.checks = buildCloudflareDestinationChecks(report, [])
    report.nextActions = summarizeNextActions(report.checks)
    return report
  }

  report.destinations = response.destinations.map(sanitizeDestination)
  report.cloudflare.destinationCount = report.destinations.length
  report.checks = buildCloudflareDestinationChecks(report, report.destinations)
  report.status = worstStatus(report.checks.map(check => check.status))
  report.summary = summarizeCloudflareDestinations(report)
  report.nextActions = summarizeNextActions(report.checks)
  return report
}

function readWranglerExpectations(wranglerPath, wranglerEnv) {
  try {
    const wrangler = JSON.parse(stripJsonComments(fs.readFileSync(wranglerPath, 'utf8')))
    const scoped = wranglerEnv ? wrangler?.env?.[wranglerEnv] : null
    const observability = scoped?.observability || wrangler?.observability || null
    const scope = scoped?.observability ? `env.${wranglerEnv}` : 'top-level'
    const expected = [
      ...destinationList(observability?.logs?.destinations).map(name => ({
        stream: 'logs',
        name,
        dataset: 'opentelemetry-logs',
      })),
      ...destinationList(observability?.traces?.destinations).map(name => ({
        stream: 'traces',
        name,
        dataset: 'opentelemetry-traces',
      })),
    ]
    return {
      scope,
      workerName: scoped?.name || wrangler?.name || null,
      expected,
      error: null,
    }
  } catch (error) {
    return {
      scope: wranglerEnv ? `env.${wranglerEnv}` : 'top-level',
      workerName: null,
      expected: [],
      error: `Could not read ${wranglerPath}: ${error.message}`,
    }
  }
}

function destinationList(value) {
  if (!value) return []
  if (Array.isArray(value)) return Array.from(new Set(value.filter(Boolean).map(String)))
  return [String(value)]
}

async function fetchDestinations(fetchImpl, options) {
  const url = new URL(`${options.apiBaseUrl}/accounts/${encodeURIComponent(options.accountId)}/workers/observability/destinations`)
  url.searchParams.set('perPage', '50')

  try {
    const response = await fetchWithTimeout(fetchImpl, url, {
      timeoutMs: options.timeoutMs,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${options.token}`,
      },
    })
    const text = await response.text()
    let body = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      return { status: response.status, destinations: [], error: `Invalid JSON response: ${text.slice(0, 120)}` }
    }
    if (!response.ok || body?.success === false) {
      const message = [...(body?.errors || []), ...(body?.messages || [])]
        .map(item => item?.message)
        .filter(Boolean)
        .join('; ')
      return { status: response.status, destinations: [], error: message || `HTTP ${response.status}` }
    }
    return {
      status: response.status,
      destinations: Array.isArray(body?.result) ? body.result : [],
      error: null,
    }
  } catch (error) {
    return { status: null, destinations: [], error: error.message }
  }
}

function sanitizeDestination(destination) {
  const configuration = destination?.configuration || {}
  const jobStatus = configuration.jobStatus || {}
  const urlValue = configuration.url || configuration.destination_conf || ''
  return {
    name: destination?.name || null,
    slug: destination?.slug || null,
    enabled: destination?.enabled === true,
    scripts: Array.isArray(destination?.scripts) ? destination.scripts.filter(Boolean).map(String) : [],
    configuration: {
      type: configuration.type || null,
      logpushDataset: configuration.logpushDataset || null,
      urlHost: extractHost(urlValue),
      headerNames: Object.keys(configuration.headers || {}).sort(),
      jobStatus: {
        lastComplete: jobStatus.last_complete || null,
        lastError: jobStatus.last_error || null,
        errorMessage: jobStatus.error_message || null,
      },
    },
  }
}

function extractHost(value) {
  if (!value) return null
  try {
    return new URL(String(value)).host
  } catch {
    return null
  }
}

function buildCloudflareDestinationChecks(report, destinations) {
  const checks = [
    {
      id: 'wrangler-otel-destinations',
      label: 'Wrangler OTEL destinations',
      status: report.wrangler.expected.length > 0 ? 'green' : 'red',
      proof: report.wrangler.expected.length > 0
        ? `wrangler declares ${report.wrangler.expected.map(item => `${item.stream}:${item.name}`).join(', ')}.`
        : 'wrangler does not declare logs/traces destinations.',
      nextAction: report.wrangler.expected.length > 0
        ? 'Keep destination names in source aligned with Cloudflare dashboard destination names.'
        : 'Add first-party observability logs/traces destinations to wrangler.jsonc.',
    },
    {
      id: 'cloudflare-read-config',
      label: 'Cloudflare read configuration',
      status: report.cloudflare.missingConfig.length > 0 ? 'yellow' : 'green',
      proof: report.cloudflare.missingConfig.length > 0
        ? `Missing ${report.cloudflare.missingConfig.join(', ')}.`
        : 'Cloudflare account id and API token are configured for this read-only check.',
      nextAction: report.cloudflare.missingConfig.length > 0
        ? 'Set CLOUDFLARE_ACCOUNT_ID and a Workers Observability Read token locally; keep the token out of reports and git.'
        : 'Keep this token read-only for dashboard destination proof.',
    },
  ]

  if (report.cloudflare.queryError) {
    checks.push({
      id: 'cloudflare-destination-query',
      label: 'Cloudflare destination query',
      status: 'red',
      proof: `Cloudflare API query failed${report.cloudflare.requestStatus ? ` with HTTP ${report.cloudflare.requestStatus}` : ''}: ${report.cloudflare.queryError}.`,
      nextAction: 'Confirm the token has Workers Observability Read permission and rerun the destination verifier.',
    })
    return checks
  }

  if (report.cloudflare.missingConfig.length > 0 || report.status === 'red' && destinations.length === 0) {
    return checks
  }

  for (const expected of report.wrangler.expected) {
    checks.push(checkExpectedDestination(expected, destinations, report.worker))
  }

  return checks
}

function checkExpectedDestination(expected, destinations, workerName) {
  const matches = destinations.filter(destination => destination.name === expected.name)
  if (matches.length === 0) {
    return {
      id: `${expected.stream}-destination`,
      label: `${expected.stream} destination ${expected.name}`,
      status: 'red',
      proof: `No Cloudflare destination named ${expected.name} was returned.`,
      nextAction: `Create or rename the Cloudflare Workers Observability ${expected.stream} destination to ${expected.name}.`,
    }
  }

  const match = matches.find(destination => destination.configuration.logpushDataset === expected.dataset) || matches[0]
  const problems = []
  if (match.configuration.logpushDataset !== expected.dataset) {
    problems.push(`dataset=${match.configuration.logpushDataset || 'missing'}, expected ${expected.dataset}`)
  }
  if (!match.enabled) {
    problems.push('destination disabled')
  }
  if (match.configuration.jobStatus.errorMessage) {
    problems.push(`job error: ${match.configuration.jobStatus.errorMessage}`)
  }

  const scriptWarning = workerName
    && Array.isArray(match.scripts)
    && match.scripts.length > 0
    && !match.scripts.includes(workerName)
  if (scriptWarning) {
    problems.push(`scripts do not include ${workerName}`)
  }

  const status = problems.some(problem => /dataset=|disabled|job error/.test(problem))
    ? 'red'
    : problems.length > 0 ? 'yellow' : 'green'

  return {
    id: `${expected.stream}-destination`,
    label: `${expected.stream} destination ${expected.name}`,
    status,
    proof: status === 'green'
      ? `Destination ${expected.name} is enabled for ${expected.dataset}${match.configuration.jobStatus.lastComplete ? `; last delivery ${match.configuration.jobStatus.lastComplete}` : ''}.`
      : `Destination ${expected.name} returned with ${problems.join('; ')}.`,
    nextAction: status === 'green'
      ? 'Keep this dashboard destination name pinned to wrangler.jsonc.'
      : `Fix the Cloudflare dashboard destination ${expected.name}, then rerun this proof.`,
  }
}

function summarizeCloudflareDestinations(report) {
  if (report.status === 'green') {
    return 'Cloudflare Workers Observability destinations match wrangler.jsonc.'
  }
  if (report.status === 'red') {
    const blockers = report.checks.filter(check => check.status === 'red').map(check => check.proof)
    return `Cloudflare destination proof failed: ${blockers.join(' ')}`
  }
  const blockers = report.checks.filter(check => check.status !== 'green').map(check => check.proof)
  return `Cloudflare destination proof incomplete: ${blockers.join(' ')}`
}

function missingCloudflareConfig(options) {
  const missing = []
  if (!options.accountId) missing.push('CLOUDFLARE_ACCOUNT_ID')
  if (!options.token) missing.push('CLOUDFLARE_API_TOKEN')
  return missing
}

async function fetchWithTimeout(fetchImpl, url, options = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS)
  try {
    return await fetchImpl(url, {
      headers: options.headers || {},
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }
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

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function firstEnv(env, names) {
  for (const name of names) {
    if (env[name]) return env[name]
  }
  return null
}

function positiveNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function worstStatus(statuses) {
  if (statuses.includes('red')) return 'red'
  if (statuses.includes('yellow') || statuses.includes('missing')) return 'yellow'
  if (statuses.length > 0 && statuses.every(status => status === 'green')) return 'green'
  return 'yellow'
}

function summarizeNextActions(checks) {
  return Array.from(new Set(
    checks
      .filter(check => check.status !== 'green')
      .map(check => check.nextAction)
      .filter(Boolean),
  ))
}

module.exports = {
  buildCloudflareDestinationChecks,
  buildCloudflareDestinationsReport,
  missingCloudflareConfig,
  parseArgs,
  readWranglerExpectations,
  sanitizeDestination,
}
