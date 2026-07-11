const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.join(__dirname, '..')
const requiredGoVersion = '1.26.5'
const requiredCryptoVersion = 'v0.52.0'
const requiredGoImageDigest = 'sha256:079e59808d2d252516e27e3f3a9c003740dee7f75e55aa71528766d52bcfc16a'
const requiredRuntimeImageDigest = 'sha256:b7bb25d9f7c31d2bdd1982feb4dafcaf137703c7075dbe2febb41c24212b946f'
const commandNames = ['fx-publish', 'ocr', 'sideload']
const allCommandNames = [...commandNames, 'ocr-loki-forwarder'].sort()
const dockerfileNames = commandNames.map((name) => `Dockerfile.${name}`)

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
  const component = name.replace(/^Dockerfile\./, '')
  const exactBuilder = `FROM golang:${requiredGoVersion}@${requiredGoImageDigest} AS build`
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
  assert.equal(
    occurrences(source, `FROM gcr.io/distroless/static-debian12:nonroot@${requiredRuntimeImageDigest}`),
    1,
    `${name} must pin the reviewed distroless runtime manifest`
  )
  assert.equal(
    occurrences(source, 'go mod download && go mod verify'),
    1,
    `${name} must verify downloaded modules before building`
  )
  assert.equal(occurrences(source, 'COPY cmd ./cmd'), 1)
  assert.equal(occurrences(source, 'COPY internal ./internal'), 1)
  assert.doesNotMatch(source, /^COPY \. \.$/m, `${name} must not copy the whole repository`)
  const normalized = source.replace(/\\\n\s*/g, ' ')
  assert.equal(
    occurrences(
      normalized,
      `go build -mod=readonly -ldflags="-s -w" -o /out/${component} ./cmd/${component}`
    ),
    1,
    `${name} must build only cmd/${component} into its reviewed output`
  )
  assert.equal(
    occurrences(source, `COPY --from=build /out/${component} /${component}`),
    1,
    `${name} must copy only its reviewed binary`
  )
  assert.equal(
    occurrences(source, `ENTRYPOINT ["/${component}"]`),
    1,
    `${name} must start only its reviewed binary`
  )
}

function assertCloudBuild(source) {
  for (const component of commandNames) {
    const image = `us-central1-docker.pkg.dev/$PROJECT_ID/resplit-fx/${component}:$BUILD_ID`
    assert.equal(
      occurrences(
        source,
        `args: ['build','-f','Dockerfile.${component}','-t','${image}','.']`
      ),
      1,
      `Cloud Build must build ${component} once in the real repository`
    )
    assert.equal(
      occurrences(source, `  - '${image}'`),
      1,
      `Cloud Build must publish ${component} once by unique build id`
    )
  }
  assert.doesNotMatch(source, /:latest/, 'Cloud Build must not rewrite mutable latest tags')
  assert.doesNotMatch(source, /resplit-fx-containers/, 'Cloud Build must use the live repository')
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
    '\n          IMAGE: ${{ steps.immutable_images.outputs.ocr }}\n',
    'bootstrap/deploy-ocr.sh',
    '\n          IMAGE: ${{ steps.immutable_images.outputs.fx_publish }}\n',
    'bootstrap/update-fx-publish-image.sh',
    'group: resplit-fx-production-deploy',
    'DEPLOY_TRACE_ID: deploy-${{ github.run_id }}-${{ github.run_attempt }}',
    "if: github.ref == 'refs/heads/main'",
  ]
  const forbiddenSnippets = [
    'resplit-fx-containers',
    'resplit-fx-ocr',
    'resplit-fx-sideload',
    'Dockerfile.sideload',
    'gcloud run deploy',
    'gcloud run jobs execute',
    ':latest',
    'google-github-actions/auth@v2',
    'google-github-actions/setup-gcloud@v2',
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
  assert.equal(
    occurrences(source, "if: inputs.target == 'ocr'"),
    3,
    'OCR build, binary proof, and deploy must be independently selected'
  )
  assert.equal(
    occurrences(source, "if: inputs.target == 'fx-publish'"),
    3,
    'publisher build, binary proof, and image-only update must be independently selected'
  )
  assert.equal(
    occurrences(source, 'platforms: linux/amd64'),
    2,
    'both production images must build only for the Cloud Run architecture'
  )
  assert.equal(
    occurrences(source, 'awk \'NR == 1 { exit ($2 == "go1.26.5" ? 0 : 1) }\''),
    2,
    'both deployed binaries must expose exactly the patched runtime in build info'
  )
  for (const setting of ['CGO_ENABLED=0', 'GOOS=linux', 'GOARCH=amd64']) {
    assert.equal(occurrences(source, `build\\t${setting}`), 2)
  }
  assert.equal(
    occurrences(source, 'dep\\tgolang.org/x/crypto\\tv0.52.0\\t'),
    2,
    'both deployed binaries must link the patched crypto module'
  )
  assert.equal(
    occurrences(source, 'gcloud run jobs update'),
    0,
    'publisher workflow must delegate its transaction to the tested canonical script'
  )
}

function assertCanonicalFxUpdate(source) {
  assert.match(source, /IMAGE="\$\{IMAGE:\?[^\n]*@sha256:/)
  assert.match(
    source,
    /EXPECTED_PREFIX="\$\{REGION\}-docker\.pkg\.dev\/\$\{PROJECT\}\/\$\{REPO\}\/fx-publish@sha256:"/
  )
  assert.match(source, /\[\[ ! "\$TARGET_DIGEST" =~ \^\[0-9a-f\]\{64\}\$ \]\]/)
  assert.match(source, /select\(\.type == "Completed"\)/, 'rollback must come from a completed execution')
  assert.equal(
    occurrences(source, ".spec.template.spec | del(.template.spec.containers[0].image)"),
    1,
    'one normalizer must compare the complete job contract except image'
  )
  assert.equal(
    occurrences(source, '"$GCLOUD" run jobs update "$JOB"'),
    2,
    'publisher must have one update and one transactional rollback'
  )
  assert.equal(
    occurrences(source, '--image="$EXPECTED_RUNTIME_IMAGE"'),
    1,
    'publisher must pin the sole reviewed linux/amd64 child, not an OCI index'
  )
  assert.equal(
    occurrences(source, '--image="$IMAGE"'),
    0,
    'publisher must not leave future runtime selection to the reviewed parent index'
  )
  assert.match(source, /resolve_artifact_linux_amd64_image "\$GCLOUD" "\$IMAGE"/)
  assert.match(source, /trap rollback_fx_image EXIT/)
  assert.match(source, /rollback readback failed/)
  assert.match(source, /latestCreatedExecution\.name/)
  assert.doesNotMatch(source, /run jobs execute/, 'image update must never execute the dormant job')
}

function assertCanonicalOcrDeploy(source) {
  assert.match(
    source,
    /IMAGE="\$\{IMAGE:\?[^\n]*@sha256:/,
    'canonical OCR deploy must require an explicit immutable digest'
  )
  assert.match(
    source,
    /EXPECTED_IMAGE_PREFIX="\$\{REGION\}-docker\.pkg\.dev\/\$\{PROJECT\}\/resplit-fx\/ocr@sha256:"/,
    'canonical OCR deploy must require the live repository and component'
  )
  assert.match(
    source,
    /\[\[ ! "\$DIGEST" =~ \^\[0-9a-f\]\{64\}\$ \]\]/,
    'canonical OCR deploy must require a full lowercase SHA-256 digest'
  )
  assert.doesNotMatch(
    source,
    /IMAGE="\$\{IMAGE:-[^\n]*:latest\}"/,
    'canonical OCR deploy must not default to a mutable latest tag'
  )
  assert.match(source, /SERVICE="\$\{SERVICE:-ocr\}"/, 'canonical OCR service must be ocr')
  assert.match(source, /--no-traffic/, 'OCR candidate must start with zero traffic')
  assert.match(source, /--tag="\$CANDIDATE_TAG"/, 'OCR candidate must have a probe URL')
  assert.match(source, /CANDIDATE_IMAGE=/, 'candidate image digest must be read back')
  assert.match(source, /--to-revisions="\$\{CANDIDATE_REVISION\}=100"/, 'verified candidate must be promoted explicitly')
  assert.match(source, /--to-revisions="\$\{PREVIOUS_REVISION\}=100"/, 'failed promotion must roll back explicitly')
  assert.match(source, /trap cleanup_candidate_tag EXIT/, 'candidate tag cleanup must be armed for every exit')
  assert.match(source, /CANDIDATE_CLEANUP_ARMED=true/, 'candidate cleanup must arm before deploy')
  assert.match(source, /PROMOTION_ROLLBACK_ARMED=true/, 'traffic rollback must arm before promotion')
  assert.match(source, /--update-env-vars=/, 'deploy must preserve unknown operational environment config')
  assert.match(source, /--update-secrets=/, 'deploy must preserve unknown future secret bindings')
  assert.doesNotMatch(source, /--set-env-vars=/, 'deploy must not replace incident-time config')
  assert.doesNotMatch(source, /--set-secrets=/, 'deploy must not replace future secret bindings')
  assert.match(source, /select\(\.tag == \$tag\)/, 'candidate URL and revision must come from the same tag entry')
  assert.doesNotMatch(source, /latestCreatedRevisionName/, 'global latest revision is race-prone')
  assert.match(source, /CURRENT_PRODUCTION_REVISION/, 'promotion must recheck the production traffic owner')
  assert.match(source, /"\$\{CANDIDATE_URL\}\/ocr\/scan"/, 'candidate must perform a real OCR scan')
  assert.match(source, /printf '\\n%s\\n' "\$DEPLOY_TRACE_ID" >> "\$scan_file"/, 'deploy retries must use a unique canary hash')
  assert.match(source, /\.provider == "azure-di"/, 'candidate scan must prove the Azure provider')
  assert.match(source, /\.raw\.status == "succeeded"/, 'candidate scan must reject the stub provider')
  assert.match(source, /jsonPayload\.request_id/, 'candidate scan must correlate its production log')
  assert.match(source, /jsonPayload\.message=\\"otel telemetry enabled\\"/, 'candidate must prove telemetry startup')
  assert.match(source, /--connect-timeout 10 --max-time 30/, 'health probes must have a finite deadline')
  assert.match(source, /--connect-timeout 10 --max-time 95/, 'provider canary must have a finite deadline')
  assert.ok(
    source.indexOf('probe_provider_and_logs') < source.indexOf('candidate verified; promoting'),
    'provider and telemetry proof must run before traffic promotion'
  )
  assert.doesNotMatch(source, /\/healthz/, 'canonical Cloud Run probe must avoid reserved z suffixes')
}

function assertHealthContracts(sources) {
  for (const [name, source] of Object.entries(sources)) {
    assert.doesNotMatch(source, /\/healthz/, `${name} must not use a Cloud Run reserved z-suffix path`)
  }
  assert.match(sources.ocr, /mux\.Handle\("GET \/health"[\s\S]*WithRouteTag\("\/health"/)
  assert.match(sources.sideload, /mux\.HandleFunc\("GET \/health", s\.handleHealth\)/)
  assert.match(sources.ocrTest, /path:\s+"\/health"/)
  assert.match(sources.sideloadTest, /NewRequest\(http\.MethodGet, "\/health", nil\)/)
  assert.match(sources.openapi, /^  \/health:$/m)
  assert.match(sources.openapi, /^      operationId: getHealth$/m)
  assert.equal(occurrences(sources.terraform, 'path = "/health"'), 2)
  assert.match(sources.deploy, /"\$\{url\}\/health"/)
}

test('Go module pins the patched runtime and crypto floor, including mutations', () => {
  const source = read('go.mod')
  assertGoModule(source)
  const sum = read('go.sum')
  const cryptoSumLines = sum
    .split('\n')
    .filter((line) => line.startsWith('golang.org/x/crypto '))
  assert.deepEqual(cryptoSumLines.map((line) => line.split(' ')[1]), [
    requiredCryptoVersion,
    `${requiredCryptoVersion}/go.mod`,
  ])

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
  const discoveredCommands = fs
    .readdirSync(path.join(repoRoot, 'cmd'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => /^package main$/m.test(read(`cmd/${name}/main.go`)))
    .sort()
  assert.deepEqual(discoveredCommands, allCommandNames)
  const discoveredDockerfiles = fs
    .readdirSync(repoRoot)
    .filter((name) => name.startsWith('Dockerfile.'))
    .sort()
  assert.deepEqual(discoveredDockerfiles, [...dockerfileNames].sort())

  for (const name of dockerfileNames) {
    const source = read(name)
    const component = name.replace(/^Dockerfile\./, '')
    assertDockerBuilder(source, name)

    for (const mutation of [
      source.replace(`golang:${requiredGoVersion}`, 'golang:1.26'),
      source.replace(`golang:${requiredGoVersion}`, 'golang:latest'),
      source.replace(requiredGoImageDigest, 'sha256:' + '0'.repeat(64)),
      source.replace(requiredRuntimeImageDigest, 'sha256:' + '0'.repeat(64)),
      source.replace('go mod download && go mod verify', 'go mod download'),
      source.replace('COPY cmd ./cmd', 'COPY . .'),
      source.replace(`./cmd/${component}`, './cmd/wrong'),
      source.replace(`ENTRYPOINT ["/${component}"]`, 'ENTRYPOINT ["/wrong"]'),
      `${source}\nFROM golang:${requiredGoVersion} AS stale-build\n`,
    ]) {
      assert.notEqual(mutation, source, `${name} mutation must alter the fixture`)
      assert.throws(() => assertDockerBuilder(mutation, name))
    }
  }

  assert.equal(read('.dockerignore'), [
    '**',
    '!go.mod',
    '!go.sum',
    '!cmd/',
    '!cmd/**',
    '!internal/',
    '!internal/**',
    '!Dockerfile.*',
    '!infra/',
    '!infra/ocr-loki-forwarder/',
    '!infra/ocr-loki-forwarder/Dockerfile',
    '',
  ].join('\n'))
})

test('Cloud Build preserves the real component map without mutable tags, including mutations', () => {
  const source = read('cloudbuild.yaml')
  assertCloudBuild(source)

  for (const mutation of [
    source.replace('/resplit-fx/ocr:', '/resplit-fx-containers/ocr:'),
    source.replace('Dockerfile.sideload', 'Dockerfile.ocr'),
    source.replace(':$BUILD_ID', ':latest'),
    `${source}\n  - 'us-central1-docker.pkg.dev/$PROJECT_ID/resplit-fx/ocr:$BUILD_ID'\n`,
  ]) {
    assert.notEqual(mutation, source, 'Cloud Build mutation must alter the fixture')
    assert.throws(() => assertCloudBuild(mutation))
  }
})

test('Cloud Run health avoids reserved z-suffix paths everywhere, including mutations', () => {
  const sources = {
    ocr: read('cmd/ocr/main.go'),
    ocrTest: read('cmd/ocr/main_test.go'),
    sideload: read('cmd/sideload/main.go'),
    sideloadTest: read('cmd/sideload/main_test.go'),
    openapi: read('openapi/openapi.yaml'),
    terraform: read('terraform/modules/cloudrun/main.tf'),
    deploy: read('bootstrap/deploy-ocr.sh'),
  }
  assertHealthContracts(sources)

  for (const name of Object.keys(sources)) {
    const mutation = { ...sources, [name]: sources[name].replace('/health', '/healthz') }
    assert.notEqual(mutation[name], sources[name], `${name} health mutation must alter the fixture`)
    assert.throws(() => assertHealthContracts(mutation))
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
    source.replace('group: resplit-fx-production-deploy', 'group: deploy-${{ github.ref }}'),
    source.replace("if: github.ref == 'refs/heads/main'", "if: github.ref != ''"),
    source.replace('platforms: linux/amd64', 'platforms: linux/arm64'),
    `${source}\n# Dockerfile.sideload\n`,
  ]) {
    assert.notEqual(mutation, source, 'workflow mutation must alter the fixture')
    assert.throws(() => assertDeployWorkflow(mutation))
  }

  const deployScript = read('bootstrap/deploy-ocr.sh')
  assertCanonicalOcrDeploy(deployScript)
  for (const [label, mutation] of [
    ['image prefix', deployScript.replace(
      'EXPECTED_IMAGE_PREFIX="${REGION}-docker.pkg.dev/${PROJECT}/resplit-fx/ocr@sha256:"',
      'EXPECTED_IMAGE_PREFIX="${REGION}-docker.pkg.dev/${PROJECT}/wrong/ocr:latest"'
    )],
    ['zero traffic', deployScript.replace('--no-traffic', '--traffic')],
    ['cleanup trap', deployScript.replace('trap cleanup_candidate_tag EXIT', '# cleanup removed')],
    ['promotion rollback', deployScript.replace('PROMOTION_ROLLBACK_ARMED=true', 'PROMOTION_ROLLBACK_ARMED=false')],
    ['environment preservation', deployScript.replace('--update-env-vars=', '--set-env-vars=')],
    ['tag binding', deployScript.replace("'.status.traffic[] | select(.tag == $tag)'", "'.status.latestCreatedRevisionName'")],
    ['production owner', deployScript.split('CURRENT_PRODUCTION_REVISION').join('IGNORED_PRODUCTION_REVISION')],
  ]) {
    assert.notEqual(mutation, deployScript, `${label} mutation must alter the fixture`)
    assert.throws(() => assertCanonicalOcrDeploy(mutation), `${label} mutation must fail closed`)
  }

  const fxScript = read('bootstrap/update-fx-publish-image.sh')
  assertCanonicalFxUpdate(fxScript)
  assert.notEqual(
    fs.statSync(path.join(repoRoot, 'bootstrap/update-fx-publish-image.sh')).mode & 0o111,
    0,
    'canonical FX update script must be executable'
  )
  for (const [label, mutation] of [
    ['image prefix', fxScript.replace('/fx-publish@sha256:', '/wrong:latest')],
    ['completed execution', fxScript.replace('select(.type == "Completed")', 'select(.type == "Started")')],
    ['whole contract', fxScript.replace(
      '.spec.template.spec | del(.template.spec.containers[0].image)',
      '.spec.template.spec.template.spec.containers[0].env'
    )],
    ['rollback trap', fxScript.replace('trap rollback_fx_image EXIT', '# rollback removed')],
    ['runtime child pin', fxScript.replace('--image="$EXPECTED_RUNTIME_IMAGE"', '--image="$IMAGE"')],
    ['execution safety', `${fxScript}\n"$GCLOUD" run jobs execute "$JOB"\n`],
  ]) {
    assert.notEqual(mutation, fxScript, `${label} mutation must alter the FX fixture`)
    assert.throws(() => assertCanonicalFxUpdate(mutation), `${label} mutation must fail closed`)
  }
})
