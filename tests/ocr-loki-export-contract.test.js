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
    'forwarder_revision',
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
  assert.match(handler, /K_REVISION/)
  assert.match(handler, /X-Resplit-Forwarder-Revision/)
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
  for (const required of [
    'LEASE_SUBSCRIPTION="ocr-loki-export-lease"',
    'lease_mutate "$GCLOUD" run deploy',
    '--labels="resplit_owner=${LEASE_OWNER}"',
    'assert_deploy_lease',
    'DEPLOY_LEASE_RELEASE_FAILURE',
    'pubsub subscriptions list',
    'logging sinks list',
    'run services list',
    'run.googleapis.com/ingress',
    'get-iam-policy',
    'allAuthenticatedUsers',
  ]) {
    assert.match(script, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.doesNotMatch(script, /^\s*"\$GCLOUD" run deploy/m)
  const deployLeaseCreateIndex = script.indexOf('pubsub subscriptions create "$LEASE_SUBSCRIPTION"')
  assert.ok(
    deployLeaseCreateIndex >= 0 && deployLeaseCreateIndex < script.indexOf('logging sinks list'),
    'deploy lease must precede the authoritative sink/service traffic snapshot'
  )
  const releaseStart = script.indexOf('release_deploy_lease()')
  const releaseEnd = script.indexOf('\n}\n\nlease_mutate()', releaseStart)
  const release = script.slice(releaseStart, releaseEnd)
  const releaseDeleteIndex = release.indexOf('pubsub subscriptions delete "$LEASE_SUBSCRIPTION"')
  const releaseAbsentIndex = release.indexOf('if subscription_absent "$LEASE_SUBSCRIPTION"; then')
  const releaseReproofIndex = release.indexOf('if ! assert_deploy_lease; then', releaseAbsentIndex)
  assert.ok(
    releaseDeleteIndex >= 0 &&
      releaseDeleteIndex < releaseAbsentIndex &&
      releaseAbsentIndex < releaseReproofIndex,
    'every deploy lease delete attempt must prove absence before ownership-gated retry'
  )
  assert.equal(occurrences(release, 'assert_deploy_lease'), 2)
  assert.match(release, /subscription_absent[\s\S]*LEASE_HELD=0/)
  assert.match(release, /neither lease absence nor ownership could be proven/)
  assert.equal(
    occurrences(script, '((.exclusions // []) | length == 0)'),
    2,
    'both the pre-deploy and post-create sink snapshots must reject exclusions'
  )

  assert.match(workflow, /group: resplit-fx-production-deploy/)
  assert.match(workflow, /bootstrap\/deploy-ocr-loki-forwarder\.sh/)
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main' && inputs\.activate/)
  assert.equal(occurrences(workflow, 'default: false'), 1)
  assert.equal(occurrences(workflow, "ACTIVATE: '1'"), 1)
  assert.doesNotMatch(workflow, /workflow_run|schedule:/)

  for (const [driftCheck, expectedCount] of [
    ['.pushConfig.pushEndpoint', 3],
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
    'LEASE_SUBSCRIPTION="ocr-loki-export-lease"',
    'PROOF_SUBSCRIPTION="ocr-loki-proof-${OWNER_ID:0:16}"',
    'pubsub subscriptions create "$LEASE_SUBSCRIPTION"',
    'pubsub subscriptions create "$PROOF_SUBSCRIPTION"',
    '--push-endpoint="${CANDIDATE_URL}/pubsub/push"',
    '--push-auth-token-audience="$SERVICE_URL"',
    '--labels="resplit_owner=${OWNER_ID}"',
    'pubsub topics publish',
    'query_range',
    'forwarder_revision',
    'wait_for_loki "$DIRECT_REQUEST_ID" "$CANDIDATE_REVISION"',
    'logging sinks update "$SINK" --project="$PROJECT" --no-disabled',
    'logging write run.googleapis.com/stdout',
    'wait_for_loki "$SINK_REQUEST_ID" "$CANDIDATE_REVISION"',
    '--to-revisions="${CANDIDATE_REVISION}=100"',
    '--to-revisions="${PREVIOUS_REVISION}=100"',
    'disable_sink()',
    '--disabled',
    'assert_topology true',
    'assert_topology false',
    'assert_lease_owner',
    'retry_command',
    'ROLLBACK_FAILURE',
    'exit 70',
    'subscription_absent',
    'LEASE_RELEASE_UNCERTAIN',
    'ROLLBACK_REFUSED',
    'SINK_ENABLED_BY_RUN',
    'run.googleapis.com/ingress',
    'get-iam-policy',
    'allAuthenticatedUsers',
    '--connect-timeout 3 --max-time 8',
  ]) {
    assert.match(verifier, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.equal(occurrences(verifier, 'openssl rand -hex 16'), 3)
  assert.equal(occurrences(verifier, '.labels.resplit_owner == $owner'), 2)
  assert.equal(occurrences(verifier, 'assert_topology false'), 2)
  assert.doesNotMatch(verifier, /PROOF_REQUEST_ID/)
  assert.doesNotMatch(verifier, /pubsub subscriptions update/)
  assert.doesNotMatch(verifier, /--push-auth-token-audience="\$CANDIDATE_URL"/)
  assert.doesNotMatch(verifier, /LEASE_SUBSCRIPTION=.*OWNER_ID/)
  assert.match(verifier, /if \[\[ "\$\{ACTIVATE:-0\}" != "1" \]\]/)
  assert.ok(
    verifier.indexOf('${ACTIVATE:-0}') < verifier.indexOf('EXPECTED_RUNTIME_IMAGE='),
    'verifier activation gate must precede every cloud read'
  )
  assert.ok(
    verifier.indexOf('${ACTIVATE:-0}') < verifier.indexOf('GRAFANA_LOKI_USER="${GRAFANA_LOKI_USER:?'),
    'verifier dry run must not require Grafana credentials'
  )
  assert.match(verifier, /\| forwarder_revision=\\"\$\{expected_revision\}\\"/)
  assert.match(verifier, /select\(\.request_id == \$request_id and \.forwarder_revision == \$revision\)/)
  assert.match(verifier, /\.deadLetterPolicy\.maxDeliveryAttempts == 10/)
  assert.match(verifier, /\[\[ "\$current_traffic" == "\$expected_traffic" \]\]/)
  assert.equal(occurrences(verifier, 'for _ in 1 2 3'), 2)
  assert.equal(
    occurrences(verifier, '((.exclusions // []) | length == 0)'),
    1,
    'the verifier must reject any sink exclusion'
  )
  assert.ok(
    verifier.indexOf('trap rollback EXIT') < verifier.indexOf('\nacquire_lease\n'),
    'rollback trap must exist before the verifier creates its lease'
  )
  assert.ok(
    verifier.indexOf('assert_lease_owner', verifier.indexOf('disable_sink()')) <
      verifier.indexOf('logging sinks update "$SINK" --project="$PROJECT"', verifier.indexOf('disable_sink()')),
    'sink rollback must prove lease ownership before mutation'
  )
  assert.match(
    verifier,
    /\[\[ "\$SINK_ENABLED_BY_RUN" == "1" \]\] \|\| return 0/,
    'rollback may disable the shared sink only when this verifier enabled it'
  )
  for (const rollbackStep of [
    'disable_sink || failures=$((failures + 1))',
    'cleanup_proof_subscription || failures=$((failures + 1))',
    'restore_traffic || failures=$((failures + 1))',
    'release_lease || failures=$((failures + 1))',
  ]) {
    assert.match(verifier, new RegExp(rollbackStep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.match(verifier, /"\$current" != "\$CANDIDATE_REVISION"/)
  assert.match(verifier, /refusing to clobber a newer owner/)
  const releaseIndex = verifier.indexOf('release_lease()')
  const leaseDeleteIndex = verifier.indexOf('pubsub subscriptions delete "$LEASE_SUBSCRIPTION"', releaseIndex)
  const releaseReadbackIndex = verifier.indexOf('subscription_absent "$LEASE_SUBSCRIPTION"', leaseDeleteIndex)
  assert.ok(
    releaseIndex >= 0 && leaseDeleteIndex > releaseIndex && releaseReadbackIndex > leaseDeleteIndex,
    'lease deletion must reconcile command ambiguity through authoritative absence readback'
  )

  const directProofIndex = verifier.indexOf('wait_for_loki "$DIRECT_REQUEST_ID" "$CANDIDATE_REVISION"')
  const enableIndex = verifier.indexOf('logging sinks update "$SINK" --project="$PROJECT" --no-disabled')
  const topologyBeforeEnableIndex = verifier.lastIndexOf('assert_topology true', enableIndex)
  const topologyAfterEnableIndex = verifier.indexOf('assert_topology false', enableIndex)
  const cloudLoggingWriteIndex = verifier.indexOf('logging write run.googleapis.com/stdout')
  assert.ok(
    directProofIndex < topologyBeforeEnableIndex && topologyBeforeEnableIndex < enableIndex,
    'candidate delivery proof must precede sink enablement'
  )
  assert.ok(
    enableIndex < topologyAfterEnableIndex && topologyAfterEnableIndex < cloudLoggingWriteIndex,
    'full topology must be re-read after enablement and before its fixture'
  )
  assert.ok(
    cloudLoggingWriteIndex < verifier.indexOf('wait_for_loki "$SINK_REQUEST_ID" "$CANDIDATE_REVISION"'),
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
    { key: 'script', value: sources.script.replace('LEASE_SUBSCRIPTION="ocr-loki-export-lease"', 'LEASE_SUBSCRIPTION="ocr-loki-export-lease-${LEASE_OWNER}"') },
    { key: 'script', value: sources.script.replace('lease_mutate "$GCLOUD" run deploy', '"$GCLOUD" run deploy') },
    { key: 'script', value: sources.script.replace('--labels="resplit_owner=${LEASE_OWNER}"', '--labels="owner=unknown"') },
    { key: 'script', value: sources.script.replace('if subscription_absent "$LEASE_SUBSCRIPTION"; then', 'if false; then') },
    { key: 'verifier', value: sources.verifier.replace('openssl rand -hex 16', '${PROOF_REQUEST_ID}') },
    { key: 'verifier', value: sources.verifier.replace('logging write run.googleapis.com/stdout', 'echo skipped-cloud-logging-write') },
    { key: 'verifier', value: sources.verifier.replace('--push-auth-token-audience="$SERVICE_URL"', '--push-auth-token-audience="$CANDIDATE_URL"') },
    { key: 'verifier', value: sources.verifier.replace('forwarder_revision=\\"${expected_revision}\\"', 'status=\\"ok\\"') },
    { key: 'verifier', value: sources.verifier.replace('LEASE_SUBSCRIPTION="ocr-loki-export-lease"', 'LEASE_SUBSCRIPTION="ocr-loki-export-lease-${OWNER_ID}"') },
    { key: 'verifier', value: sources.verifier.replace('.labels.resplit_owner == $owner', 'true') },
    { key: 'verifier', value: sources.verifier.replace('.deadLetterPolicy.maxDeliveryAttempts == 10', '.deadLetterPolicy.maxDeliveryAttempts >= 1') },
    { key: 'verifier', value: sources.verifier.replace('assert_topology false', 'assert_sink_shape false') },
    { key: 'verifier', value: sources.verifier.replace('[[ "$current_traffic" == "$expected_traffic" ]]', '[[ -n "$current_traffic" ]]') },
    { key: 'verifier', value: sources.verifier.replace('for _ in 1 2 3', 'for _ in 1') },
    { key: 'verifier', value: sources.verifier.replace('if [[ "${ACTIVATE:-0}" != "1" ]]', 'if false') },
    { key: 'verifier', value: sources.verifier.replace('disable_sink || failures=$((failures + 1))', 'true') },
    { key: 'verifier', value: sources.verifier.replace('cleanup_proof_subscription || failures=$((failures + 1))', 'true') },
    { key: 'verifier', value: sources.verifier.replace('restore_traffic || failures=$((failures + 1))', 'true') },
    { key: 'verifier', value: sources.verifier.replace('release_lease || failures=$((failures + 1))', 'true') },
    { key: 'verifier', value: sources.verifier.replace('--connect-timeout 3 --max-time 8', '') },
    { key: 'verifier', value: sources.verifier.replace('[[ "$SINK_ENABLED_BY_RUN" == "1" ]] || return 0', 'true') },
    { key: 'verifier', value: sources.verifier.replace('((.exclusions // []) | length == 0)', 'true') },
    { key: 'script', value: sources.script.replace('((.exclusions // []) | length == 0)', 'true') },
    { key: 'script', value: sources.script.replace('pubsub subscriptions create "$LEASE_SUBSCRIPTION"', 'echo skipped-lease') },
  ]

  for (const [index, mutation] of mutations.entries()) {
    const candidate = { ...sources, [mutation.key]: mutation.value }
    assert.notEqual(candidate[mutation.key], sources[mutation.key])
    assert.throws(() => {
      assertForwarderSource(candidate)
      assertDeployContract(candidate)
    }, `mutation ${index} must be rejected`)
  }
})

function runEnabledSinkPreflight(t, leaseDeleteMode = 'success') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-loki-preflight-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const bin = path.join(root, 'bin')
  const calls = path.join(root, 'gcloud-calls.txt')
  const statePath = path.join(root, 'gcloud-state.json')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'gcloud'), `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_CALLS, args.join(' ') + '\\n')
const statePath = process.env.FAKE_STATE
const state = fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
  : { leaseOwner: null, deleteAttempts: 0 }
const save = () => fs.writeFileSync(statePath, JSON.stringify(state))
const value = prefix => (args.find(arg => arg.startsWith(prefix)) || '').slice(prefix.length)
const deleteMode = process.env.FAKE_LEASE_DELETE_MODE
if (args[0] === 'auth' && args[1] === 'print-access-token') process.stdout.write('fake-token')
else if (args[0] === 'projects' && args[1] === 'describe') process.stdout.write('123456789')
else if (args[0] === 'secrets' && args[1] === 'versions' && args[2] === 'list') process.stdout.write('7')
else if (args[0] === 'iam' && args[1] === 'service-accounts' && args[2] === 'describe') process.exit(0)
else if (args[0] === 'pubsub' && args[1] === 'topics' && args[2] === 'describe') {
  if (args.includes('--format=json')) process.stdout.write(JSON.stringify({
    messageRetentionDuration: args[3] === 'ocr-loki-logs' ? '604800s' : '1209600s',
  }))
} else if (args[0] === 'pubsub' && args[1] === 'subscriptions' && args[2] === 'list') {
  if (deleteMode === 'readback-unavailable' && state.deleteAttempts > 0) process.exit(76)
  process.stdout.write(JSON.stringify(state.leaseOwner ? [{ name: 'projects/test-project/subscriptions/ocr-loki-export-lease' }] : []))
} else if (args[0] === 'pubsub' && args[1] === 'subscriptions' && args[2] === 'create') {
  state.leaseOwner = value('--labels=resplit_owner=')
  save()
} else if (args[0] === 'pubsub' && args[1] === 'subscriptions' && args[2] === 'describe') {
  if (deleteMode === 'readback-unavailable' && state.deleteAttempts > 0) process.exit(76)
  if (!state.leaseOwner) process.exit(1)
  if (args.includes('--format=json')) process.stdout.write(JSON.stringify({
    topic: 'projects/test-project/topics/ocr-loki-logs-dlq',
    labels: { resplit_owner: state.leaseOwner },
    ackDeadlineSeconds: 10,
    messageRetentionDuration: '600s',
    expirationPolicy: { ttl: '86400s' },
    pushConfig: {},
  }))
  else process.stdout.write(state.leaseOwner)
} else if (args[0] === 'pubsub' && args[1] === 'subscriptions' && args[2] === 'delete') {
  state.deleteAttempts += 1
  if (deleteMode === 'retain-once-then-commit-error' && state.deleteAttempts === 1) {
    save()
    process.exit(75)
  }
  if (deleteMode === 'readback-unavailable') {
    save()
    process.exit(75)
  }
  state.leaseOwner = null
  save()
  if (deleteMode === 'commit-error' || deleteMode === 'retain-once-then-commit-error') process.exit(75)
} else if (args[0] === 'logging' && args[1] === 'sinks' && args[2] === 'list') {
  process.stdout.write(JSON.stringify([{ name: 'ocr-loki-export' }]))
} else if (args[0] === 'logging' && args[1] === 'sinks' && args[2] === 'describe') {
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
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })

  const digest = 'a'.repeat(64)
  const result = spawnSync('bash', [path.join(repoRoot, 'bootstrap/deploy-ocr-loki-forwarder.sh')], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_CALLS: calls,
      FAKE_STATE: statePath,
      FAKE_LEASE_DELETE_MODE: leaseDeleteMode,
      GCLOUD: 'gcloud',
      PROJECT: 'test-project',
      REGION: 'us-central1',
      REPO: 'resplit-fx',
      IMAGE: `us-central1-docker.pkg.dev/test-project/resplit-fx/ocr-loki-forwarder@sha256:${digest}`,
      ACTIVATE: '1',
    },
  })
  return {
    result,
    invocations: fs.readFileSync(calls, 'utf8'),
    state: JSON.parse(fs.readFileSync(statePath, 'utf8')),
  }
}

test('an enabled sink fails closed before any cloud mutation or candidate deploy', (t) => {
  const { result, invocations } = runEnabledSinkPreflight(t)
  assert.notEqual(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stderr, /disable ocr-loki-export before staging/)
  for (const forbidden of [
    'run deploy',
    'logging sinks create',
    'logging sinks update',
    'add-iam-policy-binding',
  ]) {
    assert.doesNotMatch(invocations, new RegExp(forbidden))
  }
})

test('deploy lease release accepts committed deletion after a transport error', (t) => {
  const { result, invocations, state } = runEnabledSinkPreflight(t, 'commit-error')
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.equal(state.leaseOwner, null)
  assert.equal(state.deleteAttempts, 1)
  assert.doesNotMatch(result.stderr, /DEPLOY_LEASE_RELEASE_(?:FAILURE|UNCERTAIN)/)
  assert.match(
    invocations,
    /pubsub subscriptions delete ocr-loki-export-lease[^\n]*\npubsub subscriptions list /,
    'lease absence must be read after the failed delete transport'
  )
})

test('deploy lease release re-proves ownership before retrying an ambiguous delete', (t) => {
  const { result, invocations, state } = runEnabledSinkPreflight(t, 'retain-once-then-commit-error')
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.equal(state.leaseOwner, null)
  assert.equal(state.deleteAttempts, 2)
  const firstDelete = invocations.indexOf('pubsub subscriptions delete ocr-loki-export-lease')
  const ownershipReproof = invocations.indexOf('pubsub subscriptions describe ocr-loki-export-lease', firstDelete)
  const secondDelete = invocations.indexOf('pubsub subscriptions delete ocr-loki-export-lease', firstDelete + 1)
  assert.ok(firstDelete < ownershipReproof && ownershipReproof < secondDelete)
})

test('deploy lease release fails closed when neither absence nor ownership is readable', (t) => {
  const { result, invocations, state } = runEnabledSinkPreflight(t, 'readback-unavailable')
  assert.equal(result.status, 70, result.stdout + result.stderr)
  assert.notEqual(state.leaseOwner, null)
  assert.equal(state.deleteAttempts, 1)
  assert.match(
    result.stderr,
    /DEPLOY_LEASE_RELEASE_UNCERTAIN; neither lease absence nor ownership could be proven; manual recovery required/
  )
  assert.equal(
    invocations.split('pubsub subscriptions delete ocr-loki-export-lease').length - 1,
    1,
    'an unowned or unreadable lease must not be deleted again'
  )
})

test('source-only dry runs require neither cloud access nor Grafana credentials', () => {
  const digest = 'a'.repeat(64)
  const env = {
    ...process.env,
    GCLOUD: 'false',
    IMAGE: `us-central1-docker.pkg.dev/resplit-fx-prod/resplit-fx/ocr-loki-forwarder@sha256:${digest}`,
  }
  delete env.ACTIVATE
  delete env.GRAFANA_LOKI_USER
  delete env.GRAFANA_TOKEN

  for (const script of [
    'bootstrap/deploy-ocr-loki-forwarder.sh',
    'bootstrap/verify-ocr-loki-export.sh',
  ]) {
    const result = spawnSync('bash', [path.join(repoRoot, script)], {
      cwd: repoRoot,
      encoding: 'utf8',
      env,
    })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /dry run:/)
    assert.match(result.stdout, /no cloud (?:read or )?mutation attempted/)
  }
})

module.exports = { assertDeployContract, assertForwarderSource }
