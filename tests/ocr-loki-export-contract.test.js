const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

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
    'X-Scope-OrgID',
    'application/json',
  ]) {
    assert.match(handler, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }

  assert.match(handler, /StatusNoContent/)
  assert.match(handler, /StatusServiceUnavailable/)
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

function assertDeployContract({ script, workflow }) {
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
    '--expiration-period=never',
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

  assert.match(script, /\/pubsub\/push/)
  assert.match(script, /--disabled/)
  assert.match(script, /enable.*ocr-loki-export|ocr-loki-export.*enable/s)
  assert.doesNotMatch(script, /logging sinks (?:update|delete) _(?:Default|Required)/)
  assert.doesNotMatch(script, /run deploy ocr(?:\s|["'])/)
  assert.doesNotMatch(script, /--allow-unauthenticated/)
  assert.doesNotMatch(script, /secret versions access/)

  assert.match(workflow, /group: resplit-fx-production-deploy/)
  assert.match(workflow, /bootstrap\/deploy-ocr-loki-forwarder\.sh/)
  assert.match(workflow, /refs\/heads\/main/)
  assert.doesNotMatch(workflow, /workflow_run|schedule:/)
}

test('OCR Loki export remains asynchronous, private, scoped, and loss-aware', () => {
  const sources = {
    handler: read('internal/ocrloki/handler.go'),
    dockerfile: read('infra/ocr-loki-forwarder/Dockerfile'),
    script: read('bootstrap/deploy-ocr-loki-forwarder.sh'),
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
    { key: 'dockerfile', value: sources.dockerfile.replace(/@sha256:[0-9a-f]{64}/, ':latest') },
    { key: 'workflow', value: sources.workflow.replace('group: resplit-fx-production-deploy', 'group: deploy-${{ github.ref }}') },
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

module.exports = { assertDeployContract, assertForwarderSource }
