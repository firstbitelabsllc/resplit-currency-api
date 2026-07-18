const { execFileSync } = require('node:child_process')

const WORKER_DEPLOYMENT_INPUT_PATHS = Object.freeze([
  '.github/workflows/run.yml',
  'package-lock.json',
  'package.json',
  'scripts/worker-secret-continuity.js',
  'worker/',
  'wrangler.jsonc',
])

// Worker releases are independent from the published FX data: the Worker
// fetches the canonical Pages asset host at request time. Keep this list
// intentionally conservative. A path not listed here can only suppress a
// Worker deployment after the full public Pages/Worker verification succeeds.
function isWorkerDeploymentInput(path) {
  return path === '.github/workflows/run.yml' ||
    path === 'package-lock.json' ||
    path === 'package.json' ||
    path === 'scripts/worker-secret-continuity.js' ||
    path === 'wrangler.jsonc' ||
    path.startsWith('worker/')
}

function compareWorkerReleaseInputs({
  deployedRelease,
  currentRelease,
  cwd = process.cwd(),
  execFile = execFileSync,
} = {}) {
  if (!isCommitSha(deployedRelease) || !isCommitSha(currentRelease)) {
    return comparison({ equivalent: false, reason: 'release_invalid' })
  }
  if (deployedRelease === currentRelease) {
    return comparison({ equivalent: true, reason: 'release_exact' })
  }

  try {
    execFile(
      'git',
      ['merge-base', '--is-ancestor', deployedRelease, currentRelease],
      { cwd, stdio: 'ignore' }
    )
  } catch {
    return comparison({ equivalent: false, reason: 'release_not_ancestor' })
  }

  let changedPaths
  try {
    changedPaths = execFile(
      'git',
      ['diff', '--name-only', '-z', '--no-renames', `${deployedRelease}..${currentRelease}`],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).split('\0').filter(Boolean)
  } catch {
    return comparison({ equivalent: false, reason: 'release_history_unavailable' })
  }

  const workerInputPaths = changedPaths.filter(isWorkerDeploymentInput)
  return comparison({
    equivalent: workerInputPaths.length === 0,
    reason: workerInputPaths.length === 0 ? 'worker_inputs_unchanged' : 'worker_inputs_changed',
    changedPaths,
    workerInputPaths,
  })
}

function comparison({ equivalent, reason, changedPaths = [], workerInputPaths = [] }) {
  return { equivalent, reason, changedPaths, workerInputPaths }
}

function isCommitSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value)
}

module.exports = {
  WORKER_DEPLOYMENT_INPUT_PATHS,
  compareWorkerReleaseInputs,
  isCommitSha,
  isWorkerDeploymentInput,
}
