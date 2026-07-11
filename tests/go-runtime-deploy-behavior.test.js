const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.join(__dirname, '..')
const ocrScript = path.join(repoRoot, 'bootstrap', 'deploy-ocr.sh')
const fxScript = path.join(repoRoot, 'bootstrap', 'update-fx-publish-image.sh')
const project = 'test-project'
const region = 'us-central1'
const repo = 'resplit-fx'
const ocrPrefix = `${region}-docker.pkg.dev/${project}/${repo}/ocr@sha256:`
const fxPrefix = `${region}-docker.pkg.dev/${project}/${repo}/fx-publish@sha256:`

function writeExecutable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o755 })
}

function makeHarness(mode, scenario) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `resplit-${mode}-deploy-`))
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  const stateFile = path.join(root, 'state.json')
  const fixture = path.join(root, 'receipt.jpg')
  fs.writeFileSync(fixture, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
  const initial = mode === 'ocr'
    ? { mode, scenario, current: 'ocr-prev', candidateCreated: false, candidateTag: null, events: [] }
    : { mode, scenario, image: `${fxPrefix}${'a'.repeat(64)}`, drift: false, describeCount: 0, events: [] }
  fs.writeFileSync(stateFile, JSON.stringify(initial))
  writeExecutable(path.join(bin, 'gcloud'), fakeGcloudSource())
  writeExecutable(path.join(bin, 'curl'), fakeCurlSource())
  return { root, bin, stateFile, fixture }
}

function runScript(script, harness, extraEnv) {
  return spawnSync('bash', [script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${harness.bin}:${process.env.PATH}`,
      FAKE_STATE: harness.stateFile,
      PROJECT: project,
      REGION: region,
      REPO: repo,
      GCLOUD: 'gcloud',
      ...extraEnv,
    },
  })
}

function readState(harness) {
  return JSON.parse(fs.readFileSync(harness.stateFile, 'utf8'))
}

test('OCR candidate failure removes its public tag without moving production traffic', (t) => {
  const harness = makeHarness('ocr', 'candidate_fail')
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }))
  const result = runScript(ocrScript, harness, {
    IMAGE: `${ocrPrefix}${'b'.repeat(64)}`,
    SERVICE: 'ocr',
    SCAN_FIXTURE: harness.fixture,
    DEPLOY_TRACE_ID: 'deploy-candidate-fail',
  })
  assert.notEqual(result.status, 0, result.stdout + result.stderr)
  const state = readState(harness)
  assert.equal(state.current, 'ocr-prev')
  assert.equal(state.candidateCreated, false)
  assert.deepEqual(state.events, ['deploy-candidate', 'remove-candidate-tag'])
})

test('OCR failure after promotion restores the previous 100% revision and removes the tag', (t) => {
  const harness = makeHarness('ocr', 'post_promote_fail')
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }))
  const result = runScript(ocrScript, harness, {
    IMAGE: `${ocrPrefix}${'b'.repeat(64)}`,
    SERVICE: 'ocr',
    SCAN_FIXTURE: harness.fixture,
    DEPLOY_TRACE_ID: 'deploy-post-promote-fail',
  })
  assert.notEqual(result.status, 0, result.stdout + result.stderr)
  const state = readState(harness)
  assert.equal(state.current, 'ocr-prev')
  assert.equal(state.candidateCreated, false)
  assert.deepEqual(state.events, [
    'deploy-candidate',
    'promote-candidate',
    'rollback-previous',
    'remove-candidate-tag',
  ])
})

test('OCR success leaves only the proven candidate at 100% with no public candidate tag', (t) => {
  const harness = makeHarness('ocr', 'success')
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }))
  const result = runScript(ocrScript, harness, {
    IMAGE: `${ocrPrefix}${'b'.repeat(64)}`,
    SERVICE: 'ocr',
    SCAN_FIXTURE: harness.fixture,
    DEPLOY_TRACE_ID: 'deploy-success',
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const state = readState(harness)
  assert.equal(state.current, 'ocr-candidate')
  assert.equal(state.candidateCreated, false)
  assert.deepEqual(state.events, ['deploy-candidate', 'promote-candidate', 'remove-candidate-tag'])
})

test('OCR accepts the exact linux/amd64 child of a reviewed OCI index', (t) => {
  const harness = makeHarness('ocr', 'manifest_index_success')
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }))
  const result = runScript(ocrScript, harness, {
    IMAGE: `${ocrPrefix}${'b'.repeat(64)}`,
    SERVICE: 'ocr',
    SCAN_FIXTURE: harness.fixture,
    DEPLOY_TRACE_ID: 'deploy-manifest-index-success',
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const state = readState(harness)
  assert.equal(state.current, 'ocr-candidate')
  assert.equal(state.candidateCreated, false)
  assert.deepEqual(state.events, ['deploy-candidate', 'promote-candidate', 'remove-candidate-tag'])
})

test('OCR rejects an ambiguous OCI index before creating a candidate', (t) => {
  const harness = makeHarness('ocr', 'manifest_index_ambiguous')
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }))
  const result = runScript(ocrScript, harness, {
    IMAGE: `${ocrPrefix}${'b'.repeat(64)}`,
    SERVICE: 'ocr',
    SCAN_FIXTURE: harness.fixture,
    DEPLOY_TRACE_ID: 'deploy-manifest-index-ambiguous',
  })
  assert.notEqual(result.status, 0, result.stdout + result.stderr)
  const state = readState(harness)
  assert.equal(state.current, 'ocr-prev')
  assert.equal(state.candidateCreated, false)
  assert.deepEqual(state.events, [])
})

test('OCR rejects a parseable manifest delivered by a failed registry transport', (t) => {
  const harness = makeHarness('ocr', 'manifest_transport_fail')
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }))
  const result = runScript(ocrScript, harness, {
    IMAGE: `${ocrPrefix}${'b'.repeat(64)}`,
    SERVICE: 'ocr',
    SCAN_FIXTURE: harness.fixture,
    DEPLOY_TRACE_ID: 'deploy-manifest-transport-fail',
  })
  assert.notEqual(result.status, 0, result.stdout + result.stderr)
  const state = readState(harness)
  assert.equal(state.current, 'ocr-prev')
  assert.equal(state.candidateCreated, false)
  assert.deepEqual(state.events, [])
})

for (const scenario of ['contract_fail', 'readback_mismatch']) {
  test(`FX ${scenario} restores the last completed digest and the whole non-image contract`, (t) => {
    const harness = makeHarness('fx', scenario)
    t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }))
    const result = runScript(fxScript, harness, {
      IMAGE: `${fxPrefix}${'b'.repeat(64)}`,
      JOB: 'fx-publish',
    })
    assert.notEqual(result.status, 0, result.stdout + result.stderr)
    const state = readState(harness)
    assert.equal(state.image, `${fxPrefix}${'a'.repeat(64)}`)
    assert.equal(state.drift, false)
    assert.deepEqual(state.events, ['update-target', 'rollback-image'])
  })
}

test('FX success updates only the image and never executes the dormant job', (t) => {
  const harness = makeHarness('fx', 'success')
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }))
  const result = runScript(fxScript, harness, {
    IMAGE: `${fxPrefix}${'b'.repeat(64)}`,
    JOB: 'fx-publish',
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const state = readState(harness)
  assert.equal(state.image, `${fxPrefix}${'b'.repeat(64)}`)
  assert.equal(state.drift, false)
  assert.deepEqual(state.events, ['update-target'])
})

test('FX accepts the exact linux/amd64 child of a reviewed OCI index', (t) => {
  const harness = makeHarness('fx', 'manifest_index_success')
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }))
  const result = runScript(fxScript, harness, {
    IMAGE: `${fxPrefix}${'b'.repeat(64)}`,
    JOB: 'fx-publish',
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const state = readState(harness)
  assert.equal(state.image, `${fxPrefix}${'c'.repeat(64)}`)
  assert.equal(state.drift, false)
  assert.deepEqual(state.events, ['update-target'])
})

test('FX rejects an ambiguous OCI index before mutating the dormant job', (t) => {
  const harness = makeHarness('fx', 'manifest_index_ambiguous')
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }))
  const result = runScript(fxScript, harness, {
    IMAGE: `${fxPrefix}${'b'.repeat(64)}`,
    JOB: 'fx-publish',
  })
  assert.notEqual(result.status, 0, result.stdout + result.stderr)
  const state = readState(harness)
  assert.equal(state.image, `${fxPrefix}${'a'.repeat(64)}`)
  assert.equal(state.drift, false)
  assert.deepEqual(state.events, [])
})

test('FX rejects a parseable manifest delivered by a failed registry transport', (t) => {
  const harness = makeHarness('fx', 'manifest_transport_fail')
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }))
  const result = runScript(fxScript, harness, {
    IMAGE: `${fxPrefix}${'b'.repeat(64)}`,
    JOB: 'fx-publish',
  })
  assert.notEqual(result.status, 0, result.stdout + result.stderr)
  const state = readState(harness)
  assert.equal(state.image, `${fxPrefix}${'a'.repeat(64)}`)
  assert.equal(state.drift, false)
  assert.deepEqual(state.events, [])
})

function fakeGcloudSource() {
  return `#!/usr/bin/env node
const fs = require('node:fs')
const stateFile = process.env.FAKE_STATE
const args = process.argv.slice(2)
let state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state))
const arg = prefix => args.find(value => value.startsWith(prefix))
const output = value => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value))

if (args[0] === 'auth' && args[1] === 'print-access-token') {
  output('fake-artifact-registry-token')
  process.exit(0)
}

if (state.mode === 'ocr') {
  if (args[0] === 'run' && args[1] === 'deploy') {
    state.candidateCreated = true
    state.candidateTag = arg('--tag=').slice('--tag='.length)
    state.events.push('deploy-candidate')
    save()
    process.exit(0)
  }
  if (args[0] === 'run' && args[1] === 'services' && args[2] === 'describe') {
    if (arg('--format=') === '--format=value(status.url)') {
      output('https://ocr.example')
      process.exit(0)
    }
    const traffic = [{ revisionName: state.current, percent: 100 }]
    if (state.candidateCreated) {
      if (state.current === 'ocr-candidate') {
        traffic[0].tag = state.candidateTag
        traffic[0].url = 'https://candidate.example'
      } else {
        traffic.push({
          revisionName: 'ocr-candidate', percent: 0,
          tag: state.candidateTag, url: 'https://candidate.example',
        })
      }
    }
    output({ status: { traffic, url: 'https://ocr.example' } })
    process.exit(0)
  }
  if (args[0] === 'run' && args[1] === 'revisions' && args[2] === 'describe') {
    const revision = args[3]
    output(revision === 'ocr-candidate'
      ? (state.scenario === 'manifest_index_success'
        ? 'us-central1-docker.pkg.dev/test-project/resplit-fx/ocr@sha256:' + 'c'.repeat(64)
        : process.env.IMAGE)
      : 'us-central1-docker.pkg.dev/test-project/resplit-fx/ocr@sha256:' + 'a'.repeat(64))
    process.exit(0)
  }
  if (args[0] === 'run' && args[1] === 'services' && args[2] === 'update-traffic') {
    const target = arg('--to-revisions=')
    const remove = arg('--remove-tags=')
    if (target) {
      const revision = target.slice('--to-revisions='.length).split('=')[0]
      state.current = revision
      state.events.push(revision === 'ocr-candidate' ? 'promote-candidate' : 'rollback-previous')
    }
    if (remove) {
      state.candidateCreated = false
      state.candidateTag = null
      state.events.push('remove-candidate-tag')
    }
    save()
    process.exit(0)
  }
  if (args[0] === 'logging' && args[1] === 'read') {
    output(args.join(' ').includes('otel telemetry enabled') ? 'ocr' : 'azure-di ok')
    process.exit(0)
  }
}

if (state.mode === 'fx') {
  const jobJson = () => {
    state.describeCount += 1
    let reportedImage = state.image
    if (state.scenario === 'readback_mismatch' && state.events.includes('update-target') &&
        !state.events.includes('rollback-image') && state.describeCount === 2) {
      reportedImage = 'us-central1-docker.pkg.dev/test-project/resplit-fx/fx-publish@sha256:' + 'c'.repeat(64)
    }
    const spec = {
      taskCount: 1,
      template: { spec: {
        serviceAccountName: 'runtime@test-project.iam.gserviceaccount.com',
        maxRetries: 1,
        timeoutSeconds: '300',
        containers: [{ image: reportedImage, env: [{ name: 'SAFE', value: '1' }], resources: { limits: { cpu: '1' } } }],
      } },
    }
    if (state.drift) spec.parallelism = 2
    save()
    return { spec: { template: { spec } }, status: { latestCreatedExecution: { name: 'fx-good' } } }
  }
  if (args[0] === 'run' && args[1] === 'jobs' && args[2] === 'describe') {
    output(jobJson())
    process.exit(0)
  }
  if (args[0] === 'run' && args[1] === 'jobs' && args[2] === 'executions' && args[3] === 'describe') {
    output({
      spec: { template: { spec: { containers: [{ image: 'us-central1-docker.pkg.dev/test-project/resplit-fx/fx-publish@sha256:' + 'a'.repeat(64) }] } } },
      status: { conditions: [{ type: 'Completed', status: 'True' }] },
    })
    process.exit(0)
  }
  if (args[0] === 'run' && args[1] === 'jobs' && args[2] === 'update') {
    const image = arg('--image=').slice('--image='.length)
    const rollback = image.endsWith('a'.repeat(64))
    state.image = image
    state.drift = rollback ? false : state.scenario === 'contract_fail'
    state.events.push(rollback ? 'rollback-image' : 'update-target')
    save()
    process.exit(0)
  }
}

console.error('unexpected fake gcloud invocation:', args.join(' '))
process.exit(64)
`
}

function fakeCurlSource() {
  return `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const state = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, 'utf8'))
const url = args[args.length - 1]
if (args.some(value => value.includes('fake-artifact-registry-token'))) {
  console.error('Artifact Registry bearer leaked into curl argv')
  process.exit(65)
}
const valueAfter = flag => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : null
}
if (url.includes('.pkg.dev/v2/test-project/resplit-fx/ocr/manifests/sha256:')) {
  if (state.scenario === 'manifest_index_success' || state.scenario === 'manifest_index_ambiguous') {
    const manifests = [
      {
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        digest: 'sha256:' + 'c'.repeat(64),
        platform: { architecture: 'amd64', os: 'linux' },
      },
      {
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        digest: 'sha256:' + 'd'.repeat(64),
        platform: { architecture: 'unknown', os: 'unknown' },
        annotations: { 'vnd.docker.reference.type': 'attestation-manifest' },
      },
    ]
    if (state.scenario === 'manifest_index_ambiguous') {
      manifests.push({
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        digest: 'sha256:' + 'e'.repeat(64),
        platform: { architecture: 'amd64', os: 'linux' },
      })
    }
    process.stdout.write(JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests,
    }))
  } else {
    process.stdout.write(JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
    }))
    if (state.scenario === 'manifest_transport_fail') process.exit(18)
  }
  process.exit(0)
}
if (url.includes('.pkg.dev/v2/test-project/resplit-fx/fx-publish/manifests/sha256:')) {
  if (state.scenario === 'manifest_index_success' || state.scenario === 'manifest_index_ambiguous') {
    const manifests = [
      {
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        digest: 'sha256:' + 'c'.repeat(64),
        platform: { architecture: 'amd64', os: 'linux' },
      },
      {
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        digest: 'sha256:' + 'd'.repeat(64),
        platform: { architecture: 'unknown', os: 'unknown' },
        annotations: { 'vnd.docker.reference.type': 'attestation-manifest' },
      },
    ]
    if (state.scenario === 'manifest_index_ambiguous') {
      manifests.push({
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        digest: 'sha256:' + 'e'.repeat(64),
        platform: { architecture: 'amd64', os: 'linux' },
      })
    }
    process.stdout.write(JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests,
    }))
  } else {
    process.stdout.write(JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
    }))
    if (state.scenario === 'manifest_transport_fail') process.exit(18)
  }
  process.exit(0)
}
if (url === 'https://candidate.example/health' && state.scenario === 'candidate_fail') process.exit(22)
if (url === 'https://ocr.example/health' && state.scenario === 'post_promote_fail' && state.current === 'ocr-candidate') process.exit(22)
if (url.endsWith('/health')) {
  process.stdout.write('{"status":"ok","service":"ocr"}')
  process.exit(0)
}
if (url.endsWith('/ocr/challenge')) {
  process.stdout.write('{"challenge":"test-challenge"}')
  process.exit(0)
}
if (url.endsWith('/ocr/scan')) {
  fs.writeFileSync(valueAfter('--output'), JSON.stringify({
    provider: 'azure-di', status: 'ok', raw: { status: 'succeeded', analyzeResult: {} },
  }))
  fs.writeFileSync(valueAfter('--dump-header'), 'HTTP/2 200\\r\\nX-Request-Id: ' + process.env.DEPLOY_TRACE_ID + '\\r\\n')
  process.stdout.write('200')
  process.exit(0)
}
console.error('unexpected fake curl URL:', url)
process.exit(64)
`
}
