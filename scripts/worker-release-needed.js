#!/usr/bin/env node

const {
  defaultWorkerBase,
  fetchJSONWithRetry,
} = require('./smoke-check-deploy')
const {
  compareWorkerReleaseInputs,
  isCommitSha,
} = require('./worker-release-inputs')

if (require.main === module) {
  main().catch((error) => {
    console.error(`worker-release-needed: FAILED\n${error.stack || error.message}`)
    process.exitCode = 1
  })
}

// GitHub Actions deliberately does not expose secret values or versions. A
// normal data pass can therefore skip secret writes only after the Worker
// source/config inputs match its healthy release. Operators force this path
// after a secret rotation with force_worker_release=true.
async function decideWorkerRelease({
  forcePublish,
  forceWorkerRelease,
  currentRelease,
  env = process.env,
  fetchWorkerRelease = fetchDeployedWorkerRelease,
  compareInputs = compareWorkerReleaseInputs,
} = {}) {
  if (isTrue(forcePublish)) {
    return { workerReleaseRequired: true, reason: 'force_publish' }
  }
  if (isTrue(forceWorkerRelease)) {
    return { workerReleaseRequired: true, reason: 'force_worker_release' }
  }
  if (!isCommitSha(currentRelease)) {
    return { workerReleaseRequired: true, reason: 'current_release_invalid' }
  }

  let deployedRelease
  try {
    deployedRelease = await fetchWorkerRelease({ env })
  } catch (error) {
    return {
      workerReleaseRequired: true,
      reason: 'worker_health_unavailable',
      detail: safeValue(error?.message || error),
    }
  }

  const inputComparison = compareInputs({ deployedRelease, currentRelease })
  if (!inputComparison?.equivalent) {
    return {
      workerReleaseRequired: true,
      reason: inputComparison?.reason || 'worker_input_comparison_failed',
      detail: formatChangedInputs(inputComparison?.workerInputPaths),
    }
  }

  return { workerReleaseRequired: false, reason: inputComparison.reason }
}

async function fetchDeployedWorkerRelease({
  env = process.env,
  fetchJson = fetchJSONWithRetry,
} = {}) {
  const workerBase = (env.FX_WORKER_BASE_URL || defaultWorkerBase).replace(/\/+$/, '')
  const health = await fetchJson(`${workerBase}/health`)
  if (health?.ok !== true || health?.service !== 'resplit-currency-api' || !isCommitSha(health?.release)) {
    throw new Error(`Worker health release is invalid at ${workerBase}`)
  }
  return health.release
}

async function main({
  env = process.env,
  output = process.stdout,
  errorOutput = process.stderr,
  fetchWorkerRelease,
  compareInputs,
} = {}) {
  const decision = await decideWorkerRelease({
    forcePublish: env.FORCE_PUBLISH,
    forceWorkerRelease: env.FORCE_WORKER_RELEASE,
    currentRelease: env.CURRENT_RELEASE || env.GITHUB_SHA,
    env,
    fetchWorkerRelease,
    compareInputs,
  })

  output.write(`worker_release_required=${decision.workerReleaseRequired ? 'true' : 'false'}\n`)
  output.write(`worker_release_reason=${decision.reason}\n`)
  if (decision.detail) {
    errorOutput.write(`worker-release-needed: ${decision.detail}\n`)
  }
  return decision
}

function formatChangedInputs(paths) {
  return Array.isArray(paths) && paths.length > 0
    ? `worker deployment inputs changed: ${paths.join(', ')}`
    : undefined
}

function isTrue(value) {
  return value === true || String(value).trim().toLowerCase() === 'true'
}

function safeValue(value) {
  return String(value || 'missing').replace(/[\r\n]+/g, ' ').slice(0, 180)
}

module.exports = {
  decideWorkerRelease,
  fetchDeployedWorkerRelease,
  isTrue,
  main,
}
