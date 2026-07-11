const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.join(__dirname, '..')
const verifier = path.join(repoRoot, 'bootstrap/verify-ocr-loki-export.sh')

const project = 'test-project'
const region = 'us-central1'
const repository = 'resplit-fx'
const service = 'ocr-loki-forwarder'
const digest = 'a'.repeat(64)
const image = `${region}-docker.pkg.dev/${project}/${repository}/ocr-loki-forwarder@sha256:${digest}`
const serviceUrl = 'https://forwarder.run.app'
const candidateUrl = 'https://candidate---forwarder.run.app'
const previousRevision = 'forwarder-00001-old'
const candidateRevision = 'forwarder-00002-new'
const ownerId = '1'.repeat(32)
const directRequestId = '2'.repeat(32)

function writeExecutable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o755 })
}

function createHarness(t, {
  stickySinkDisable,
  injectSourceDriftAfterSinkEnable = true,
  leaseDeleteCommitsWithError = false,
  leaseAbsenceListFailures = 0,
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-loki-state-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const bin = path.join(root, 'bin')
  const stateFile = path.join(root, 'state.json')
  const callsFile = path.join(root, 'calls.jsonl')
  const opensslCounter = path.join(root, 'openssl-counter')
  fs.mkdirSync(bin)

  const sourceTopic = `projects/${project}/topics/ocr-loki-logs`
  const dlqTopic = `projects/${project}/topics/ocr-loki-logs-dlq`
  fs.writeFileSync(stateFile, JSON.stringify({
    serviceUrl,
    candidateUrl,
    previousRevision,
    candidateRevision,
    candidateTag: `candidate-${digest.slice(0, 12)}`,
    candidateImage: image,
    trafficRevision: previousRevision,
    ocrRevision: 'ocr-00042-ready',
    sink: {
      destination: `pubsub.googleapis.com/projects/${project}/topics/ocr-loki-logs`,
      filter: [
        'resource.type="cloud_run_revision"',
        'resource.labels.service_name="ocr"',
        'log_id("run.googleapis.com/stdout")',
      ].join('\n'),
      writerIdentity: 'serviceAccount:service-123456789@gcp-sa-logging.iam.gserviceaccount.com',
      disabled: true,
    },
    topics: {
      'ocr-loki-logs': { messageRetentionDuration: '604800s' },
      'ocr-loki-logs-dlq': { messageRetentionDuration: '1209600s' },
    },
    subscriptions: {
      'ocr-loki-logs-push': {
        topic: sourceTopic,
        pushConfig: {
          pushEndpoint: `${serviceUrl}/pubsub/push`,
          oidcToken: {
            serviceAccountEmail: `ocr-loki-push@${project}.iam.gserviceaccount.com`,
            audience: serviceUrl,
          },
        },
        ackDeadlineSeconds: 30,
        messageRetentionDuration: '604800s',
        expirationPolicy: {},
        retryPolicy: { minimumBackoff: '10s', maximumBackoff: '600s' },
        deadLetterPolicy: { deadLetterTopic: dlqTopic, maxDeliveryAttempts: 10 },
      },
      'ocr-loki-logs-dlq-inspect': {
        topic: dlqTopic,
        pushConfig: {},
        messageRetentionDuration: '1209600s',
        expirationPolicy: {},
      },
    },
    stickySinkDisable,
    injectSourceDriftAfterSinkEnable,
    leaseDeleteCommitsWithError,
    leaseAbsenceListFailures,
    leaseWasDeleted: false,
  }, null, 2))

  writeExecutable(path.join(bin, 'gcloud'), `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const stateFile = process.env.FAKE_STATE
const callsFile = process.env.FAKE_CALLS
const project = process.env.PROJECT
let state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
fs.appendFileSync(callsFile, JSON.stringify(args) + '\\n')

function save() {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2))
}

function fail(message, status = 64) {
  process.stderr.write('fake gcloud: ' + message + '\\n')
  process.exit(status)
}

function flag(name) {
  const prefix = '--' + name + '='
  const value = args.find((arg) => arg.startsWith(prefix))
  return value === undefined ? undefined : value.slice(prefix.length)
}

function has(value) {
  return args.includes(value)
}

function duration(value) {
  const match = /^(\\d+)(s|m|h|d)$/.exec(value || '')
  if (!match) fail('unsupported duration ' + value)
  const factors = { s: 1, m: 60, h: 3600, d: 86400 }
  return String(Number(match[1]) * factors[match[2]]) + 's'
}

function topicPath(value) {
  return value.startsWith('projects/') ? value : 'projects/' + project + '/topics/' + value
}

function serviceJson() {
  return {
    metadata: { annotations: { 'run.googleapis.com/ingress': 'internal' } },
    status: {
      url: state.serviceUrl,
      traffic: [
        { percent: 100, revisionName: state.trafficRevision },
        { tag: state.candidateTag, revisionName: state.candidateRevision, url: state.candidateUrl },
      ],
    },
  }
}

function subscriptionFromFlags() {
  const pushEndpoint = flag('push-endpoint')
  const labels = {}
  for (const entry of (flag('labels') || '').split(',')) {
    if (!entry) continue
    const index = entry.indexOf('=')
    labels[entry.slice(0, index)] = entry.slice(index + 1)
  }
  const result = {
    topic: topicPath(flag('topic')),
    labels,
    pushConfig: {},
    ackDeadlineSeconds: Number(flag('ack-deadline')),
    messageRetentionDuration: duration(flag('message-retention-duration')),
    expirationPolicy: { ttl: duration(flag('expiration-period')) },
  }
  if (pushEndpoint) {
    result.pushConfig = {
      pushEndpoint,
      oidcToken: {
        serviceAccountEmail: flag('push-auth-service-account'),
        audience: flag('push-auth-token-audience'),
      },
    }
    result.retryPolicy = {
      minimumBackoff: flag('min-retry-delay'),
      maximumBackoff: flag('max-retry-delay'),
    }
  }
  return result
}

if (args[0] === 'auth' && args[1] === 'print-access-token' && args.length === 2) {
  process.stdout.write('fake-access-token')
} else if (args[0] === 'projects' && args[1] === 'describe') {
  if (args[2] !== project || flag('format') !== 'value(projectNumber)') {
    fail('unexpected project describe ' + args.join(' '))
  }
  process.stdout.write('123456789')
} else if (args[0] === 'run' && args[1] === 'services' && args[2] === 'describe') {
  const name = args[3]
  const format = flag('format')
  if (name === process.env.SERVICE && format === 'json') {
    process.stdout.write(JSON.stringify(serviceJson()))
  } else if (name === 'ocr' && format === 'value(status.latestReadyRevisionName)') {
    process.stdout.write(state.ocrRevision)
  } else {
    fail('unexpected service describe ' + args.join(' '))
  }
} else if (args[0] === 'run' && args[1] === 'services' && args[2] === 'get-iam-policy') {
  if (args[3] !== process.env.SERVICE || flag('format') !== 'json') {
    fail('unexpected service IAM read ' + args.join(' '))
  }
  process.stdout.write(JSON.stringify({ bindings: [{
    role: 'roles/run.invoker',
    members: ['serviceAccount:ocr-loki-push@' + project + '.iam.gserviceaccount.com'],
  }] }))
} else if (args[0] === 'run' && args[1] === 'revisions' && args[2] === 'describe') {
  if (args[3] !== state.candidateRevision || flag('format') !== 'value(spec.containers[0].image)') {
    fail('unexpected revision describe ' + args.join(' '))
  }
  process.stdout.write(state.candidateImage)
} else if (args[0] === 'run' && args[1] === 'services' && args[2] === 'update-traffic') {
  if (args[3] !== process.env.SERVICE) {
    fail('unexpected traffic mutation ' + args.join(' '))
  }
  const target = flag('to-revisions')
  const removeTag = flag('remove-tags')
  if (target) {
    const [revision, percent] = target.split('=')
    if (percent !== '100' || ![state.previousRevision, state.candidateRevision].includes(revision)) {
      fail('invalid traffic target ' + target)
    }
    state.trafficRevision = revision
  } else if (removeTag === state.candidateTag) {
    state.candidateTag = null
  } else {
    fail('unexpected traffic mutation ' + args.join(' '))
  }
  save()
} else if (args[0] === 'logging' && args[1] === 'sinks' && args[2] === 'describe') {
  if (args[3] !== 'ocr-loki-export' || flag('format') !== 'json') {
    fail('unexpected sink describe ' + args.join(' '))
  }
  process.stdout.write(JSON.stringify(state.sink))
} else if (args[0] === 'logging' && args[1] === 'sinks' && args[2] === 'update') {
  if (args[3] !== 'ocr-loki-export') fail('unexpected sink update target')
  if (has('--no-disabled')) {
    state.sink.disabled = false
    if (state.injectSourceDriftAfterSinkEnable) {
      state.subscriptions['ocr-loki-logs-push'].retryPolicy.maximumBackoff = '601s'
      state.injectSourceDriftAfterSinkEnable = false
    }
  } else if (has('--disabled')) {
    if (!state.stickySinkDisable) state.sink.disabled = true
  } else {
    fail('sink update lacked reviewed enable/disable flag')
  }
  save()
} else if (args[0] === 'logging' && args[1] === 'write') {
  if (args[2] !== 'run.googleapis.com/stdout' || !args[3]) fail('unexpected logging write')
} else if (args[0] === 'pubsub' && args[1] === 'topics' && args[2] === 'describe') {
  const topic = state.topics[args[3]]
  if (!topic || flag('format') !== 'json') fail('unexpected topic describe ' + args.join(' '))
  process.stdout.write(JSON.stringify(topic))
} else if (args[0] === 'pubsub' && args[1] === 'topics' && args[2] === 'get-iam-policy') {
  if (flag('format') !== 'json') fail('topic IAM read must request JSON')
  const member = args[3] === 'ocr-loki-logs'
    ? 'serviceAccount:service-123456789@gcp-sa-logging.iam.gserviceaccount.com'
    : args[3] === 'ocr-loki-logs-dlq'
      ? 'serviceAccount:service-123456789@gcp-sa-pubsub.iam.gserviceaccount.com'
      : fail('unexpected topic IAM target ' + args[3])
  process.stdout.write(JSON.stringify({ bindings: [{ role: 'roles/pubsub.publisher', members: [member] }] }))
} else if (args[0] === 'pubsub' && args[1] === 'topics' && args[2] === 'publish') {
  if (args[3] !== 'ocr-loki-logs' || !flag('message')) fail('unexpected topic publish')
  process.stdout.write('messageIds: [fake-message]')
} else if (args[0] === 'pubsub' && args[1] === 'subscriptions' && args[2] === 'create') {
  const name = args[3]
  if (!['ocr-loki-export-lease', 'ocr-loki-proof-' + process.env.FAKE_OWNER.slice(0, 16)].includes(name)) {
    fail('unexpected subscription create ' + name)
  }
  if (state.subscriptions[name]) fail('subscription already exists ' + name, 1)
  state.subscriptions[name] = subscriptionFromFlags()
  save()
} else if (args[0] === 'pubsub' && args[1] === 'subscriptions' && args[2] === 'describe') {
  const name = args[3]
  const subscription = state.subscriptions[name]
  if (!subscription) process.exit(1)
  const format = flag('format')
  if (format === 'json') process.stdout.write(JSON.stringify(subscription))
  else if (format === 'value(labels.resplit_owner)') process.stdout.write(subscription.labels?.resplit_owner || '')
  else if (format !== undefined) fail('unexpected subscription format ' + format)
} else if (args[0] === 'pubsub' && args[1] === 'subscriptions' && args[2] === 'get-iam-policy') {
  if (args[3] !== 'ocr-loki-logs-push' || flag('format') !== 'json') {
    fail('unexpected subscription IAM read ' + args.join(' '))
  }
  process.stdout.write(JSON.stringify({ bindings: [{
    role: 'roles/pubsub.subscriber',
    members: ['serviceAccount:service-123456789@gcp-sa-pubsub.iam.gserviceaccount.com'],
  }] }))
} else if (args[0] === 'pubsub' && args[1] === 'subscriptions' && args[2] === 'list') {
  if (flag('format') !== 'json') fail('subscription list must request JSON')
  if (state.leaseWasDeleted && state.leaseAbsenceListFailures > 0) {
    state.leaseAbsenceListFailures -= 1
    save()
    process.exit(75)
  }
  process.stdout.write(JSON.stringify(Object.keys(state.subscriptions).map((name) => ({
    name: 'projects/' + project + '/subscriptions/' + name,
  }))))
} else if (args[0] === 'pubsub' && args[1] === 'subscriptions' && args[2] === 'delete') {
  const name = args[3]
  if (!['ocr-loki-export-lease', 'ocr-loki-proof-' + process.env.FAKE_OWNER.slice(0, 16)].includes(name)) {
    fail('refusing unexpected subscription delete ' + name)
  }
  if (!state.subscriptions[name]) process.exit(1)
  delete state.subscriptions[name]
  if (name === 'ocr-loki-export-lease') state.leaseWasDeleted = true
  save()
  if (name === 'ocr-loki-export-lease' && state.leaseDeleteCommitsWithError) process.exit(75)
} else if (args[0] === 'iam' && args[1] === 'service-accounts' && args[2] === 'get-iam-policy') {
  const expected = 'ocr-loki-push@' + project + '.iam.gserviceaccount.com'
  if (args[3] !== expected || flag('format') !== 'json') {
    fail('unexpected service-account IAM read ' + args.join(' '))
  }
  process.stdout.write(JSON.stringify({ bindings: [{
    role: 'roles/iam.serviceAccountTokenCreator',
    members: ['serviceAccount:service-123456789@gcp-sa-pubsub.iam.gserviceaccount.com'],
  }] }))
} else {
  fail('unknown command ' + args.join(' '))
}
`)

  writeExecutable(path.join(bin, 'curl'), `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
if (args.some((arg) => arg.includes('.pkg.dev/v2/'))) {
  process.stdout.write(JSON.stringify({ mediaType: 'application/vnd.oci.image.manifest.v1+json' }))
  process.exit(0)
}
const queryArg = args.find((arg) => arg.startsWith('query='))
if (!queryArg) {
  process.stderr.write('fake curl: unknown request ' + args.join(' ') + '\\n')
  process.exit(64)
}
const state = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, 'utf8'))
const expectedRequest = [process.env.FAKE_DIRECT_REQUEST, '3'.repeat(32)]
  .find((requestId) => queryArg.includes('request_id="' + requestId + '"'))
const expectedRevision = state.candidateRevision
if (!expectedRequest || !queryArg.includes('forwarder_revision="' + expectedRevision + '"')) {
  process.stderr.write('fake curl: query was not independently revision-bound\\n')
  process.exit(65)
}
process.stdout.write(JSON.stringify({
  data: {
    result: [{ values: [['0', JSON.stringify({
      request_id: expectedRequest,
      forwarder_revision: expectedRevision,
    })]] }],
  },
}))
`)

  writeExecutable(path.join(bin, 'openssl'), `#!/usr/bin/env node
const fs = require('node:fs')
if (process.argv.slice(2).join(' ') !== 'rand -hex 16') process.exit(64)
const file = process.env.FAKE_OPENSSL_COUNTER
const current = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0
const ids = [process.env.FAKE_OWNER, process.env.FAKE_DIRECT_REQUEST, '3'.repeat(32)]
if (current >= ids.length) process.exit(64)
fs.writeFileSync(file, String(current + 1))
process.stdout.write(ids[current])
`)
  writeExecutable(path.join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n')

  const result = spawnSync('bash', [verifier], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GCLOUD: path.join(bin, 'gcloud'),
      FAKE_STATE: stateFile,
      FAKE_CALLS: callsFile,
      FAKE_OPENSSL_COUNTER: opensslCounter,
      FAKE_OWNER: ownerId,
      FAKE_DIRECT_REQUEST: directRequestId,
      PROJECT: project,
      REGION: region,
      REPO: repository,
      SERVICE: service,
      IMAGE: image,
      ACTIVATE: '1',
      ENABLE_SINK: '1',
      GRAFANA_LOKI_USER: '123456',
      GRAFANA_TOKEN: 'fake-read-only-token',
    },
  })
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  const calls = fs.readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  return { result, state, calls }
}

function commandText(call) {
  return call.join(' ')
}

function findCall(calls, pattern, after = -1) {
  return calls.findIndex((call, index) => index > after && pattern.test(commandText(call)))
}

function assertSharedSafety(calls, state) {
  const stableMutations = calls.filter((call) =>
    call[0] === 'pubsub' && call[1] === 'subscriptions' &&
    ['create', 'update', 'delete'].includes(call[2]) && call[3] === 'ocr-loki-logs-push')
  assert.deepEqual(stableMutations, [], 'verifier must never mutate the stable source subscription')
  assert.equal(state.subscriptions['ocr-loki-logs-push'].retryPolicy.maximumBackoff, '601s')
  assert.equal(state.subscriptions[`ocr-loki-proof-${ownerId.slice(0, 16)}`], undefined)
  assert.equal(state.trafficRevision, previousRevision)

  const leaseCreate = findCall(calls, /^pubsub subscriptions create ocr-loki-export-lease /)
  const proofCreate = findCall(calls, /^pubsub subscriptions create ocr-loki-proof-/, leaseCreate)
  const proofDelete = findCall(calls, /^pubsub subscriptions delete ocr-loki-proof-/, proofCreate)
  const promote = findCall(calls, new RegExp(`^run services update-traffic ${service} .*--to-revisions=${candidateRevision}=100`), proofDelete)
  const enable = findCall(calls, /^logging sinks update ocr-loki-export .*--no-disabled/, promote)
  const driftRead = findCall(calls, /^pubsub subscriptions describe ocr-loki-logs-push /, enable)
  const disable = findCall(calls, /^logging sinks update ocr-loki-export .*--disabled/, driftRead)
  const restore = findCall(calls, new RegExp(`^run services update-traffic ${service} .*--to-revisions=${previousRevision}=100`), disable)
  for (const [name, index] of Object.entries({ leaseCreate, proofCreate, proofDelete, promote, enable, driftRead, disable, restore })) {
    assert.ok(index >= 0, `missing ordered ${name} call`)
  }

  const proofCall = calls[proofCreate]
  assert.ok(proofCall.includes(`--push-endpoint=${candidateUrl}/pubsub/push`))
  assert.ok(proofCall.includes(`--push-auth-token-audience=${serviceUrl}`))
  assert.equal(findCall(calls, /^logging write /), -1, 'topology drift must stop the sink fixture write')
}

test('post-enable topology drift rolls back sink and traffic before releasing the lease', (t) => {
  const { result, state, calls } = createHarness(t, { stickySinkDisable: false })

  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.doesNotMatch(result.stderr, /ROLLBACK_FAILURE/)
  assert.equal(state.sink.disabled, true)
  assert.equal(state.subscriptions['ocr-loki-export-lease'], undefined)
  assertSharedSafety(calls, state)

  const disable = findCall(calls, /^logging sinks update ocr-loki-export .*--disabled/)
  const restore = findCall(calls, new RegExp(`^run services update-traffic ${service} .*--to-revisions=${previousRevision}=100`), disable)
  const leaseDelete = findCall(calls, /^pubsub subscriptions delete ocr-loki-export-lease /, restore)
  assert.ok(leaseDelete > restore, 'lease must be released only after rollback readbacks')
})

test('an incomplete sink-disable rollback exits 70 and retains the expiring lease', (t) => {
  const { result, state, calls } = createHarness(t, { stickySinkDisable: true })

  assert.equal(result.status, 70, result.stdout + result.stderr)
  assert.match(result.stderr, /sink disable rollback readback failed/)
  assert.match(result.stderr, /ROLLBACK_FAILURE count=1/)
  assert.equal(state.sink.disabled, false)
  assert.equal(state.subscriptions['ocr-loki-export-lease'].labels.resplit_owner, ownerId)
  assertSharedSafety(calls, state)
  assert.equal(findCall(calls, /^pubsub subscriptions delete ocr-loki-export-lease /), -1)
})

test('a committed lease delete with transport and transient list failures completes without unlocked rollback', (t) => {
  const { result, state, calls } = createHarness(t, {
    stickySinkDisable: false,
    injectSourceDriftAfterSinkEnable: false,
    leaseDeleteCommitsWithError: true,
    leaseAbsenceListFailures: 2,
  })

  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /ocr-loki-export is enabled/)
  assert.doesNotMatch(result.stderr, /ROLLBACK_|lease state is uncertain/)
  assert.equal(state.sink.disabled, false)
  assert.equal(state.trafficRevision, candidateRevision)
  assert.equal(state.subscriptions['ocr-loki-export-lease'], undefined)
  assert.equal(state.subscriptions[`ocr-loki-proof-${ownerId.slice(0, 16)}`], undefined)
  assert.equal(state.subscriptions['ocr-loki-logs-push'].retryPolicy.maximumBackoff, '600s')

  const leaseDelete = findCall(calls, /^pubsub subscriptions delete ocr-loki-export-lease /)
  const absenceReadback = findCall(calls, /^pubsub subscriptions list /, leaseDelete)
  assert.ok(leaseDelete >= 0, 'success must release the lease')
  assert.ok(absenceReadback > leaseDelete, 'delete status must be reconciled through authoritative absence readback')
  assert.equal(findCall(calls, /^logging sinks update ocr-loki-export .*--disabled/), -1)
  assert.equal(
    findCall(calls, new RegExp(`^run services update-traffic ${service} .*--to-revisions=${previousRevision}=100`)),
    -1,
    'a proven release must not roll back live traffic'
  )
})

test('an unprovable post-delete lease state refuses shared rollback', (t) => {
  const { result, state, calls } = createHarness(t, {
    stickySinkDisable: false,
    injectSourceDriftAfterSinkEnable: false,
    leaseDeleteCommitsWithError: true,
    leaseAbsenceListFailures: 99,
  })

  assert.equal(result.status, 70, result.stdout + result.stderr)
  assert.match(result.stderr, /ROLLBACK_REFUSED: lease release is uncertain/)
  assert.equal(state.sink.disabled, false)
  assert.equal(state.trafficRevision, candidateRevision)
  assert.equal(state.subscriptions['ocr-loki-export-lease'], undefined)
  assert.equal(findCall(calls, /^logging sinks update ocr-loki-export .*--disabled/), -1)
  assert.equal(
    findCall(calls, new RegExp(`^run services update-traffic ${service} .*--to-revisions=${previousRevision}=100`)),
    -1,
    'the verifier must not mutate shared traffic after it can no longer prove the lease'
  )
})
