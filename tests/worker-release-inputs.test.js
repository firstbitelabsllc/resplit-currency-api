const test = require('node:test')
const assert = require('node:assert/strict')

const {
  compareWorkerReleaseInputs,
  isWorkerDeploymentInput,
} = require('../scripts/worker-release-inputs')

const deployedRelease = 'a'.repeat(40)
const currentRelease = 'b'.repeat(40)

test('an exact healthy Worker release needs no deployment', () => {
  const result = compareWorkerReleaseInputs({
    deployedRelease,
    currentRelease: deployedRelease,
    execFile: () => assert.fail('exact release must not read Git history'),
  })

  assert.deepEqual(result, {
    equivalent: true,
    reason: 'release_exact',
    changedPaths: [],
    workerInputPaths: [],
  })
})

test('archive and publisher-only source changes preserve the Worker release', () => {
  const result = compareWorkerReleaseInputs({
    deployedRelease,
    currentRelease,
    execFile: gitHistory([
      'snapshot-archive/2026-07-18.json',
      'currscript.js',
      'scripts/validate-package.js',
    ]),
  })

  assert.equal(result.equivalent, true)
  assert.equal(result.reason, 'worker_inputs_unchanged')
  assert.deepEqual(result.workerInputPaths, [])
})

test('Worker source, config, dependency, workflow, and secret-sync changes require a release', () => {
  for (const path of [
    'worker/src/index.mjs',
    'wrangler.jsonc',
    'package.json',
    'package-lock.json',
    '.github/workflows/run.yml',
    'scripts/worker-secret-continuity.js',
  ]) {
    const result = compareWorkerReleaseInputs({
      deployedRelease,
      currentRelease,
      execFile: gitHistory([path]),
    })

    assert.equal(result.equivalent, false, path)
    assert.equal(result.reason, 'worker_inputs_changed', path)
    assert.deepEqual(result.workerInputPaths, [path], path)
  }
})

test('non-ancestry and unreadable shallow history fail closed into a Worker release', () => {
  const nonAncestor = compareWorkerReleaseInputs({
    deployedRelease,
    currentRelease,
    execFile: gitHistory([], { ancestor: false }),
  })
  assert.equal(nonAncestor.equivalent, false)
  assert.equal(nonAncestor.reason, 'release_not_ancestor')

  const unreadableHistory = compareWorkerReleaseInputs({
    deployedRelease,
    currentRelease,
    execFile: gitHistory([], { diffFails: true }),
  })
  assert.equal(unreadableHistory.equivalent, false)
  assert.equal(unreadableHistory.reason, 'release_history_unavailable')
})

test('only the reviewed Worker deployment inputs are classified as runtime inputs', () => {
  assert.equal(isWorkerDeploymentInput('worker/src/fx-contract.mjs'), true)
  assert.equal(isWorkerDeploymentInput('wrangler.jsonc'), true)
  assert.equal(isWorkerDeploymentInput('snapshot-archive/2026-07-18.json'), false)
  assert.equal(isWorkerDeploymentInput('currscript.js'), false)
  assert.equal(isWorkerDeploymentInput('scripts/publish-needed.js'), false)
})

function gitHistory(changedPaths, { ancestor = true, diffFails = false } = {}) {
  return (_command, args) => {
    if (args[0] === 'merge-base') {
      if (!ancestor) throw new Error('not an ancestor')
      return ''
    }
    if (args[0] === 'diff') {
      if (diffFails) throw new Error('missing shallow parent')
      return changedPaths.length > 0 ? `${changedPaths.join('\0')}\0` : ''
    }
    throw new Error(`unexpected git command: ${args.join(' ')}`)
  }
}
