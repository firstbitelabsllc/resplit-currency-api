const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.join(__dirname, '..')
const requiredGoVersion = '1.26.5'
const requiredCryptoVersion = 'v0.52.0'
const dockerfileNames = [
  'Dockerfile.ocr',
  'Dockerfile.fx-publish',
  'Dockerfile.sideload',
]

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function occurrences(source, needle) {
  return source.split(needle).length - 1
}

function assertGoModule(source) {
  const goDirective = source.match(/^go\s+(\S+)$/m)
  assert.ok(goDirective, 'go.mod must declare a Go toolchain floor')
  assert.equal(
    goDirective[1],
    requiredGoVersion,
    `go.mod must pin Go ${requiredGoVersion}`
  )

  const crypto = source.match(/^\s*golang\.org\/x\/crypto\s+(v\S+)/m)
  assert.ok(crypto, 'go.mod must retain golang.org/x/crypto')
  assert.equal(
    crypto[1],
    requiredCryptoVersion,
    `go.mod must pin golang.org/x/crypto ${requiredCryptoVersion}`
  )
}

function assertDockerBuilder(source, name) {
  const exactBuilder = `FROM golang:${requiredGoVersion} AS build`
  assert.equal(
    occurrences(source, exactBuilder),
    1,
    `${name} must use exactly one ${exactBuilder} stage`
  )
  assert.equal(
    source.split('\n').filter((line) => /^FROM golang:/.test(line)).length,
    1,
    `${name} must not retain a second floating Go builder`
  )
}

function assertDeployWorkflow(source) {
  const requiredSnippets = [
    'REPO: resplit-fx',
    'OCR_SERVICE: ocr',
    'FX_PUBLISH_JOB: fx-publish',
    'id: build_ocr',
    'id: build_fx_publish',
    'file: Dockerfile.ocr',
    'file: Dockerfile.fx-publish',
    '${{ steps.build_ocr.outputs.digest }}',
    '${{ steps.build_fx_publish.outputs.digest }}',
    'id: immutable_images',
    'IMAGE: ${{ steps.immutable_images.outputs.ocr }}',
    'bootstrap/deploy-ocr.sh',
    'gcloud run jobs update "${FX_PUBLISH_JOB}"',
    '--image="${{ steps.immutable_images.outputs.fx_publish }}"',
  ]
  const forbiddenSnippets = [
    'resplit-fx-containers',
    'resplit-fx-ocr',
    'resplit-fx-sideload',
    'Dockerfile.sideload',
    'gcloud run deploy',
  ]

  for (const snippet of requiredSnippets) {
    assert.equal(
      occurrences(source, snippet),
      1,
      `deploy workflow must contain exactly one reviewed ${JSON.stringify(snippet)}`
    )
  }
  for (const snippet of forbiddenSnippets) {
    assert.equal(
      occurrences(source, snippet),
      0,
      `deploy workflow must not retain ${JSON.stringify(snippet)}`
    )
  }
}

function assertCanonicalOcrDeploy(source) {
  assert.match(
    source,
    /IMAGE="\$\{IMAGE:\?[^\n]*@sha256:/,
    'canonical OCR deploy must require an explicit immutable digest'
  )
  assert.match(
    source,
    /\[\[ "\$IMAGE" != \*@sha256:\* \]\]/,
    'canonical OCR deploy must reject mutable image references'
  )
  assert.doesNotMatch(
    source,
    /IMAGE="\$\{IMAGE:-[^\n]*:latest\}"/,
    'canonical OCR deploy must not default to a mutable latest tag'
  )
}

test('Go module pins the patched runtime and crypto floor, including mutations', () => {
  const source = read('go.mod')
  assertGoModule(source)

  for (const mutation of [
    source.replace(`go ${requiredGoVersion}`, 'go 1.26'),
    source.replace(requiredCryptoVersion, 'v0.51.0'),
    source.replace(/^\s*golang\.org\/x\/crypto.*\n/m, ''),
  ]) {
    assert.notEqual(mutation, source, 'module mutation must alter the fixture')
    assert.throws(() => assertGoModule(mutation))
  }
})

test('every shipped Go container pins the patched builder, including mutations', () => {
  for (const name of dockerfileNames) {
    const source = read(name)
    assertDockerBuilder(source, name)

    for (const mutation of [
      source.replace(`golang:${requiredGoVersion}`, 'golang:1.26'),
      source.replace(`golang:${requiredGoVersion}`, 'golang:latest'),
      `${source}\nFROM golang:${requiredGoVersion} AS stale-build\n`,
    ]) {
      assert.notEqual(mutation, source, `${name} mutation must alter the fixture`)
      assert.throws(() => assertDockerBuilder(mutation, name))
    }
  }
})

test('manual GCP deploy follows the real topology and immutable path, including mutations', () => {
  const source = read('.github/workflows/deploy.yml')
  assertDeployWorkflow(source)

  for (const mutation of [
    source.replace('REPO: resplit-fx', 'REPO: resplit-fx-containers'),
    source.replace('OCR_SERVICE: ocr', 'OCR_SERVICE: resplit-fx-ocr'),
    source.replace('FX_PUBLISH_JOB: fx-publish', 'FX_PUBLISH_JOB: other-job'),
    source.replace('bootstrap/deploy-ocr.sh', 'gcloud run deploy ocr'),
    source.replace('${{ steps.build_ocr.outputs.digest }}', 'latest'),
    `${source}\n# Dockerfile.sideload\n`,
  ]) {
    assert.notEqual(mutation, source, 'workflow mutation must alter the fixture')
    assert.throws(() => assertDeployWorkflow(mutation))
  }

  const deployScript = read('bootstrap/deploy-ocr.sh')
  assertCanonicalOcrDeploy(deployScript)
  assert.throws(() =>
    assertCanonicalOcrDeploy(
      deployScript.replace('@sha256:', ':latest').replace(
        '[[ "$IMAGE" != *@sha256:* ]]',
        '[[ -z "$IMAGE" ]]'
      )
    )
  )
})
