const test = require('node:test')
const assert = require('node:assert/strict')

const {
  decideWorkerRelease,
  main,
} = require('../scripts/worker-release-needed')

const currentRelease = 'a'.repeat(40)
const deployedRelease = 'b'.repeat(40)

test('full and Worker-only recovery inputs force the Worker path without a health request', async () => {
  for (const input of ['forcePublish', 'forceWorkerRelease']) {
    const decision = await decideWorkerRelease({
      [input]: 'true',
      currentRelease,
      fetchWorkerRelease: async () => assert.fail('forced recovery must not depend on health'),
    })

    assert.equal(decision.workerReleaseRequired, true)
    assert.equal(decision.reason, input === 'forcePublish' ? 'force_publish' : 'force_worker_release')
  }
})

test('a healthy Worker with unchanged deployment inputs skips secrets and deployment', async () => {
  const decision = await decideWorkerRelease({
    currentRelease,
    fetchWorkerRelease: async () => deployedRelease,
    compareInputs: () => ({ equivalent: true, reason: 'worker_inputs_unchanged' }),
  })

  assert.deepEqual(decision, {
    workerReleaseRequired: false,
    reason: 'worker_inputs_unchanged',
  })
})

test('changed Worker inputs and unavailable health both fail closed into a release', async () => {
  const changedInputs = await decideWorkerRelease({
    currentRelease,
    fetchWorkerRelease: async () => deployedRelease,
    compareInputs: () => ({
      equivalent: false,
      reason: 'worker_inputs_changed',
      workerInputPaths: ['worker/src/index.mjs'],
    }),
  })
  assert.equal(changedInputs.workerReleaseRequired, true)
  assert.equal(changedInputs.reason, 'worker_inputs_changed')
  assert.match(changedInputs.detail, /worker\/src\/index\.mjs/)

  const unavailableHealth = await decideWorkerRelease({
    currentRelease,
    fetchWorkerRelease: async () => {
      throw new Error('HTTP 503')
    },
  })
  assert.equal(unavailableHealth.workerReleaseRequired, true)
  assert.equal(unavailableHealth.reason, 'worker_health_unavailable')
  assert.match(unavailableHealth.detail, /HTTP 503/)
})

test('workflow output remains machine-readable while details stay out of GITHUB_OUTPUT', async () => {
  let output = ''
  let errorOutput = ''
  const decision = await main({
    env: { CURRENT_RELEASE: currentRelease },
    output: { write: (chunk) => { output += chunk } },
    errorOutput: { write: (chunk) => { errorOutput += chunk } },
    fetchWorkerRelease: async () => deployedRelease,
    compareInputs: () => ({
      equivalent: false,
      reason: 'worker_inputs_changed',
      workerInputPaths: ['wrangler.jsonc'],
    }),
  })

  assert.equal(decision.workerReleaseRequired, true)
  assert.equal(output, 'worker_release_required=true\nworker_release_reason=worker_inputs_changed\n')
  assert.match(errorOutput, /wrangler\.jsonc/)
})
