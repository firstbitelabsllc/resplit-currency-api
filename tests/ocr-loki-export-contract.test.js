const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.join(__dirname, '..')

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function occurrences(source, needle) {
  return source.split(needle).length - 1
}

function assertForwarderSource({ handler, dockerfile }) {
  for (const required of [
    'MaxBytesReader',
    'messageId',
    'request_id',
    'trace_id',
    'insert_id',
    'application/json',
  ]) {
    assert.match(handler, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }

  assert.match(handler, /StatusNoContent/)
  assert.match(handler, /StatusServiceUnavailable/)
  assert.match(handler, /response\.StatusCode != http\.StatusNoContent/)
  assert.match(handler, /CheckRedirect[\s\S]*http\.ErrUseLastResponse/)
  assert.match(handler, /logs-prod-\[0-9\]\{3\}\\\.grafana\\\.net/)
  assert.match(handler, /correlationID[\s\S]*\[0-9a-fA-F\]\{32\}/)
  assert.match(handler, /LOKI_AUTH_HEADER/)
  assert.match(handler, /Authorization=Basic%20/)
  assert.doesNotMatch(handler, /merchant|receipt(?:_text|_image)?|email|client_ip/i)

  assert.match(
    dockerfile,
    /^FROM golang:1\.26\.5@sha256:079e59808d2d252516e27e3f3a9c003740dee7f75e55aa71528766d52bcfc16a AS build$/m
  )
  assert.match(
    dockerfile,
    /^FROM gcr\.io\/distroless\/static-debian12:nonroot@sha256:b7bb25d9f7c31d2bdd1982feb4dafcaf137703c7075dbe2febb41c24212b946f$/m
  )
  assert.match(dockerfile, /ENTRYPOINT \["\/ocr-loki-forwarder"\]/)
  assert.doesNotMatch(dockerfile, /:latest/)
}

function assertDeployContract({ script, verifier, workflow }) {
  const exactFilter = [
    'resource.type="cloud_run_revision"',
    'resource.labels.service_name="ocr"',
    'log_id("run.googleapis.com/stdout")',
  ]
  for (const clause of exactFilter) {
    assert.equal(occurrences(script, clause), 1, `sink must contain exactly one ${clause}`)
  }

  for (const required of [
    'ocr-loki-forwarder',
    'ocr-loki-export',
    'ocr-loki-logs',
    'ocr-loki-logs-push',
    'ocr-loki-logs-dlq',
    'ocr-loki-logs-dlq-inspect',
    '--no-allow-unauthenticated',
    '--ingress=internal',
    '--push-auth-service-account',
    '--push-auth-token-audience',
    '--message-retention-duration=7d',
    '--max-delivery-attempts=10',
    '--min-retry-delay=10s',
    '--max-retry-delay=600s',
    'roles/run.invoker',
    'roles/pubsub.publisher',
    'roles/pubsub.subscriber',
    'roles/iam.serviceAccountTokenCreator',
    'grafana-otlp-auth-header',
    'ACTIVATE',
  ]) {
    assert.match(script, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }

  assert.equal(
    occurrences(script, '--expiration-period=never'),
    2,
    'source and dead-letter subscriptions must both be non-expiring'
  )

  assert.match(script, /\/pubsub\/push/)
  assert.match(script, /--disabled/)
  assert.match(script, /--no-traffic/)
  assert.match(script, /--startup-probe=/)
  assert.match(script, /--update-env-vars=/)
  assert.doesNotMatch(script, /--set-env-vars=/)
  assert.doesNotMatch(script, /--no-disabled|ENABLE_SINK|PROOF_REQUEST_ID/)
  assert.ok(
    script.indexOf('logging sinks describe') < script.indexOf('run deploy'),
    'sink state and shape must be checked before any candidate deploy'
  )
  assert.doesNotMatch(script, /logging sinks (?:update|delete) _(?:Default|Required)/)
  assert.doesNotMatch(script, /run deploy ocr(?:\s|["'])/)
  assert.doesNotMatch(script, /--allow-unauthenticated/)
  assert.doesNotMatch(script, /secret versions access/)

  assert.match(workflow, /group: resplit-fx-production-deploy/)
  assert.match(workflow, /bootstrap\/deploy-ocr-loki-forwarder\.sh/)
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main' && inputs\.activate/)
  assert.equal(occurrences(workflow, 'default: false'), 1)
  assert.equal(occurrences(workflow, "ACTIVATE: '1'"), 1)
  assert.doesNotMatch(workflow, /workflow_run|schedule:/)

  for (const [driftCheck, expectedCount] of [
    ['.pushConfig.pushEndpoint', 2],
    ['.pushConfig.oidcToken.serviceAccountEmail', 1],
    ['.pushConfig.oidcToken.audience', 1],
    ['.messageRetentionDuration == "604800s"', 1],
    ['.retryPolicy.minimumBackoff == "10s"', 1],
    ['.retryPolicy.maximumBackoff == "600s"', 1],
    ['.deadLetterPolicy.maxDeliveryAttempts == 10', 1],
    ['.messageRetentionDuration == "1209600s"', 1],
  ]) {
    assert.equal(occurrences(script, driftCheck), expectedCount, `missing exact drift check ${driftCheck}`)
  }

  for (const required of [
    'openssl rand -hex 16',
    'pubsub subscriptions update',
    'pubsub topics publish',
    'query_range',
    'wait_for_loki "$DIRECT_REQUEST_ID"',
    'logging sinks update "$SINK" --project="$PROJECT" --no-disabled',
    'logging write run.googleapis.com/stdout',
    'wait_for_loki "$SINK_REQUEST_ID"',
    '--to-revisions="${CANDIDATE_REVISION}=100"',
    '--to-revisions="${PREVIOUS_REVISION}=100"',
    'logging sinks update "$SINK" --project="$PROJECT" --disabled',
  ]) {
    assert.match(verifier, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.equal(occurrences(verifier, 'openssl rand -hex 16'), 2)
  assert.doesNotMatch(verifier, /PROOF_REQUEST_ID/)
  assert.ok(
    verifier.indexOf('wait_for_loki "$DIRECT_REQUEST_ID"') < verifier.indexOf('logging sinks update "$SINK" --project="$PROJECT" --no-disabled'),
    'candidate delivery proof must precede sink enablement'
  )
  assert.ok(
    verifier.indexOf('logging write run.googleapis.com/stdout') < verifier.indexOf('wait_for_loki "$SINK_REQUEST_ID"'),
    'Cloud Logging write must precede its exact Loki convergence proof'
  )
}

test('OCR Loki export remains asynchronous, private, scoped, and loss-aware', () => {
  const sources = {
    handler: read('internal/ocrloki/handler.go'),
    dockerfile: read('infra/ocr-loki-forwarder/Dockerfile'),
    script: read('bootstrap/deploy-ocr-loki-forwarder.sh'),
    verifier: read('bootstrap/verify-ocr-loki-export.sh'),
    workflow: read('.github/workflows/deploy-ocr-loki-forwarder.yml'),
  }

  assertForwarderSource(sources)
  assertDeployContract(sources)
})

test('OCR Loki contract rejects sink, auth, durability, and coupling mutations', () => {
  const sources = {
    handler: read('internal/ocrloki/handler.go'),
    dockerfile: read('infra/ocr-loki-forwarder/Dockerfile'),
    script: read('bootstrap/deploy-ocr-loki-forwarder.sh'),
    verifier: read('bootstrap/verify-ocr-loki-export.sh'),
    workflow: read('.github/workflows/deploy-ocr-loki-forwarder.yml'),
  }

  const mutations = [
    { key: 'script', value: sources.script.replace('resource.labels.service_name="ocr"', 'resource.labels.service_name:*') },
    { key: 'script', value: sources.script.replace('log_id("run.googleapis.com/stdout")', 'jsonPayload.message:"[OCR_MONITORING]"') },
    { key: 'script', value: sources.script.replace('--no-allow-unauthenticated', '--allow-unauthenticated') },
    { key: 'script', value: sources.script.replace('--push-auth-service-account', '--push-no-wrapper') },
    { key: 'script', value: sources.script.replace('--expiration-period=never', '--expiration-period=1d') },
    { key: 'script', value: sources.script.replace('--max-delivery-attempts=10', '--max-delivery-attempts=5') },
    { key: 'script', value: `${sources.script}\ngcloud logging sinks delete _Default\n` },
    { key: 'script', value: `${sources.script}\ngcloud run deploy ocr --image=bad\n` },
    { key: 'handler', value: sources.handler.replace('request_id', 'merchant') },
    { key: 'handler', value: sources.handler.replace('response.StatusCode != http.StatusNoContent', 'response.StatusCode < 200 || response.StatusCode >= 300') },
    { key: 'handler', value: sources.handler.replace('return http.ErrUseLastResponse', 'return nil') },
    { key: 'dockerfile', value: sources.dockerfile.replace(/@sha256:[0-9a-f]{64}/, ':latest') },
    { key: 'workflow', value: sources.workflow.replace('group: resplit-fx-production-deploy', 'group: deploy-${{ github.ref }}') },
    { key: 'workflow', value: sources.workflow.replace(' && inputs.activate', '') },
    { key: 'script', value: sources.script.replace('.deadLetterPolicy.maxDeliveryAttempts == 10', '.deadLetterPolicy.maxDeliveryAttempts >= 1') },
    { key: 'script', value: sources.script.replace('--no-traffic', '--to-latest') },
    { key: 'script', value: sources.script.replace('--update-env-vars=', '--set-env-vars=') },
    { key: 'verifier', value: sources.verifier.replace('openssl rand -hex 16', '${PROOF_REQUEST_ID}') },
    { key: 'verifier', value: sources.verifier.replace('logging write run.googleapis.com/stdout', 'echo skipped-cloud-logging-write') },
  ]

  for (const mutation of mutations) {
    const candidate = { ...sources, [mutation.key]: mutation.value }
    assert.notEqual(candidate[mutation.key], sources[mutation.key])
    assert.throws(() => {
      assertForwarderSource(candidate)
      assertDeployContract(candidate)
    })
  }
})

test('an enabled sink fails closed before any cloud mutation or candidate deploy', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-loki-preflight-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const bin = path.join(root, 'bin')
  const calls = path.join(root, 'gcloud-calls.txt')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'gcloud'), `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_CALLS, args.join(' ') + '\\n')
if (args[0] === 'auth' && args[1] === 'print-access-token') process.stdout.write('fake-token')
else if (args[0] === 'projects' && args[1] === 'describe') process.stdout.write('123456789')
else if (args[0] === 'secrets' && args[1] === 'versions' && args[2] === 'list') process.stdout.write('7')
else if (args[0] === 'logging' && args[1] === 'sinks' && args[2] === 'describe') {
  if (args.includes('--format=json')) process.stdout.write(JSON.stringify({
    destination: 'pubsub.googleapis.com/projects/test-project/topics/ocr-loki-logs',
    filter: 'resource.type="cloud_run_revision"\\nresource.labels.service_name="ocr"\\nlog_id("run.googleapis.com/stdout")',
    disabled: false,
    writerIdentity: 'serviceAccount:sink-writer@test-project.iam.gserviceaccount.com',
  }))
} else process.exit(64)
`, { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'curl'), `#!/usr/bin/env node
process.stdout.write(JSON.stringify({mediaType:'application/vnd.oci.image.manifest.v1+json'}))
`, { mode: 0o755 })

  const digest = 'a'.repeat(64)
  const result = spawnSync('bash', [path.join(repoRoot, 'bootstrap/deploy-ocr-loki-forwarder.sh')], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_CALLS: calls,
      GCLOUD: 'gcloud',
      PROJECT: 'test-project',
      REGION: 'us-central1',
      REPO: 'resplit-fx',
      IMAGE: `us-central1-docker.pkg.dev/test-project/resplit-fx/ocr-loki-forwarder@sha256:${digest}`,
      ACTIVATE: '1',
    },
  })
  assert.notEqual(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stderr, /disable ocr-loki-export before staging/)
  const invocations = fs.readFileSync(calls, 'utf8')
  for (const forbidden of [
    'run deploy',
    'logging sinks create',
    'logging sinks update',
    'iam service-accounts create',
    'pubsub topics create',
    'add-iam-policy-binding',
  ]) {
    assert.doesNotMatch(invocations, new RegExp(forbidden))
  }
})

module.exports = { assertDeployContract, assertForwarderSource }
