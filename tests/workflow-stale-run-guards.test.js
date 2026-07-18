const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'run.yml')
const workflow = fs.readFileSync(workflowPath, 'utf8')
const continueGuard =
  "steps.commit_snapshot_archive.outputs.stale_run != 'true' || steps.commit_snapshot_archive.outputs.continue_stale_deploy == 'true'"
const publishGuard =
  `(${continueGuard}) && steps.publish_needed.outputs.publish_required == 'true'`
const workerReleaseGuard =
  `(${continueGuard}) && steps.worker_release_needed.outputs.worker_release_required == 'true'`
const requiredOcrSecrets = ['AZURE_OCR_KEY', 'ANTHROPIC_API_KEY']
const rootWorkerSecretWrites = [
  'printf "%s" "$SENTRY_DSN" | npx wrangler secret put SENTRY_DSN --config wrangler.jsonc --env=""',
  'printf "%s" "$CRON_SECRET" | npx wrangler secret put CRON_SECRET --config wrangler.jsonc --env=""',
  'printf "%s" "$AZURE_OCR_KEY" | npx wrangler secret put AZURE_OCR_KEY --config wrangler.jsonc --env=""',
]
const publicationSteps = [
  'Deploy to Cloudflare Pages',
  'Deploy FX Worker',
  'Deploy to GitHub Pages',
]

function stepBlock(source, stepName) {
  const marker = `      - name: ${stepName}`
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, `missing workflow step: ${stepName}`)
  const next = source.indexOf('\n      - name: ', start + marker.length)
  return source.slice(start, next === -1 ? source.length : next)
}

function occurrences(source, needle) {
  return source.split(needle).length - 1
}

function assertRequiredOcrSecretGate(source) {
  const syncMarker = '      - name: Sync FX Worker runtime secrets'
  const syncStart = source.indexOf(syncMarker)
  assert.notEqual(syncStart, -1, 'missing runtime-secret sync step')

  const sync = stepBlock(source, 'Sync FX Worker runtime secrets')
  const inventoryCommand = 'npx wrangler secret list --config wrangler.jsonc --env=""'
  const verificationCommand =
    `node scripts/worker-secret-continuity.js ${requiredOcrSecrets.join(' ')}`

  assert.equal(
    occurrences(source, inventoryCommand),
    1,
    'workflow must read exactly one name/type-only Worker secret inventory'
  )
  assert.equal(
    occurrences(sync, verificationCommand),
    1,
    `workflow must verify exactly ${requiredOcrSecrets.join(', ')} in that order`
  )

  const lastSecretPut = sync.lastIndexOf('npx wrangler secret put')
  const inventory = sync.indexOf(inventoryCommand)
  const verification = sync.indexOf(verificationCommand)
  assert.ok(lastSecretPut >= 0, 'runtime-secret sync must retain its secret writes')
  assert.ok(
    lastSecretPut < inventory && inventory < verification,
    'required-secret inventory and verification must run after every secret write'
  )

  for (const stepName of publicationSteps) {
    const publishStart = source.indexOf(`      - name: ${stepName}`)
    assert.ok(syncStart < publishStart, `required-secret gate must precede ${stepName}`)
  }
}

function assertRootWorkerSecretTargets(source) {
  const sync = stepBlock(source, 'Sync FX Worker runtime secrets')
  const secretPutLines = sync
    .split('\n')
    .filter((line) => line.includes('npx wrangler secret put'))
    .map((line) => line.trim())

  assert.deepEqual(
    secretPutLines,
    rootWorkerSecretWrites,
    'runtime-secret sync must preserve the exact reviewed root Worker upserts'
  )
}

test('workflow keeps both the midnight publish pass and the 03:00 UTC refresh schedule', () => {
  assert.match(workflow, /schedule:\s*\n\s*-\s*cron:\s*'0 0 \* \* \*'\s*\n\s*-\s*cron:\s*'0 3 \* \* \*'/)
})

test('workflow serializes duplicate passes and retains an explicit manual recovery escape hatch', () => {
  assert.match(workflow, /concurrency:\s*\n\s*group: currency-rates-publish\s*\n\s*cancel-in-progress: false/)
  assert.match(workflow, /actions\/checkout@[\s\S]*?with:\s*\n\s*fetch-depth: 64/)
  assert.match(workflow, /workflow_dispatch:\s*\n\s*inputs:\s*\n\s*force_publish:/)
  assert.match(workflow, /force_worker_release:/)
  assert.match(workflow, /type: boolean/)
  assert.match(workflow, /FORCE_PUBLISH: \$\{\{ inputs\.force_publish && 'true' \|\| 'false' \}\}/)
  assert.match(workflow, /FORCE_WORKER_RELEASE: \$\{\{ inputs\.force_worker_release && 'true' \|\| 'false' \}\}/)
})

test('workflow skips publication only after the archive and deployed release guard agree', () => {
  const decision = stepBlock(workflow, 'Decide whether publication is needed')
  assert.match(decision, /id: publish_needed/)
  assert.match(decision, /ARCHIVE_CHANGED: \$\{\{ steps\.commit_snapshot_archive\.outputs\.archive_changed \}\}/)
  assert.match(decision, /EXPECTED_DATE: \$\{\{ env\.date_today \}\}/)
  assert.match(decision, /CURRENT_RELEASE: \$\{\{ github\.sha \}\}/)
  assert.match(decision, /node scripts\/publish-needed\.js >> "\$GITHUB_OUTPUT"/)
})

test('workflow independently decides when an FX Worker release and secret sync are needed', () => {
  const decision = stepBlock(workflow, 'Decide whether FX Worker release is needed')
  assert.match(decision, /id: worker_release_needed/)
  assert.match(decision, /CURRENT_RELEASE: \$\{\{ github\.sha \}\}/)
  assert.match(decision, /node scripts\/worker-release-needed\.js >> "\$GITHUB_OUTPUT"/)
})

test('workflow records whether a stale rerun can safely continue deploy steps', () => {
  assert.match(workflow, /echo "continue_stale_deploy=false" >> "\$GITHUB_OUTPUT"/)
  assert.match(workflow, /echo "continue_stale_deploy=true" >> "\$GITHUB_OUTPUT"/)
  assert.match(workflow, /deploy inputs drifted on trunk\. Skipping deploy steps for this stale dispatch\./)
  assert.match(
    workflow,
    /git diff --name-only "HEAD\.\.origin\/\$\{branch_name\}" -- \.github\/workflows\/run\.yml country\.json currscript\.js package\.json package-lock\.json scripts skeleton-package\.json worker wrangler\.jsonc snapshot-archive/
  )
})

test('workflow syncs Azure and then verifies both OCR provider secrets before a Worker release', () => {
  const sync = stepBlock(workflow, 'Sync FX Worker runtime secrets')
  assert.match(workflow, /AZURE_OCR_KEY: \$\{\{ secrets\.AZURE_OCR_KEY \}\}/)
  assert.match(workflow, /printf "%s" "\$AZURE_OCR_KEY" \| npx wrangler secret put AZURE_OCR_KEY --config wrangler\.jsonc/)
  assert.doesNotMatch(
    sync,
    /ANTHROPIC_API_KEY:\s*\$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/,
    'ANTHROPIC_API_KEY is Cloudflare-managed; this workflow verifies continuity but does not overwrite it'
  )
  assertRequiredOcrSecretGate(workflow)
  assert.doesNotMatch(workflow, /::warning::Missing AZURE_OCR_KEY for FX Worker OCR proxy\./)
  assert.match(workflow, /npx wrangler deploy --config wrangler\.jsonc --env=""/)
})

test('every runtime secret write targets only the root Worker, including mutations', () => {
  assertRootWorkerSecretTargets(workflow)

  for (const line of rootWorkerSecretWrites) {
    const inputName = line.match(/"\$([A-Z0-9_]+)"/)?.[1]
    assert.ok(inputName, 'reviewed secret write must retain an input variable')
    const mutations = [
      line.replace(' --env=""', ''),
      line.replace('--env=""', '--env=production'),
      line.replace('--env=""', '--env="" --env=production'),
      `${line} --name not-resplit-fx`,
      line.replace(`"$${inputName}"`, '"$WRONG_SECRET"'),
      `${line}; npx wrangler secret put EXTRA_SECRET --config wrangler.jsonc`,
    ]

    for (const mutatedLine of mutations) {
      const mutatedWorkflow = workflow.replace(line, mutatedLine)

      assert.notEqual(mutatedWorkflow, workflow, 'mutation must alter the workflow fixture')
      assert.throws(
        () => assertRootWorkerSecretTargets(mutatedWorkflow),
        /must preserve the exact reviewed root Worker upserts/
      )
    }
  }
})

test('workflow stamps the Worker release only after a successful Worker deploy', () => {
  const deployWorker = stepBlock(workflow, 'Deploy FX Worker')
  const releaseStamp = stepBlock(workflow, 'Stamp deployed FX Worker release')

  assert.match(deployWorker, new RegExp(`if: \\$\\{\\{ ${workerReleaseGuard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\}\\}`))
  assert.match(releaseStamp, /printf "%s" "\$SENTRY_RELEASE" \| npx wrangler secret put SENTRY_RELEASE --config wrangler\.jsonc --env=""/)
  assert.ok(
    workflow.indexOf('      - name: Deploy FX Worker') < workflow.indexOf('      - name: Stamp deployed FX Worker release'),
    'Worker release stamp must only run after the Worker deployment step'
  )
  assert.doesNotMatch(
    stepBlock(workflow, 'Sync FX Worker runtime secrets'),
    /secret put SENTRY_RELEASE/,
    'pre-deploy secret sync must not make health look current before a Worker deploy succeeds'
  )
})

test('required OCR secret gate rejects omission, substitution, and order mutations', () => {
  const exactCommand =
    `node scripts/worker-secret-continuity.js ${requiredOcrSecrets.join(' ')}`
  const mutations = [
    exactCommand.replace(' ANTHROPIC_API_KEY', ''),
    exactCommand.replace('ANTHROPIC_API_KEY', 'ANTHROPIC_API_TOKEN'),
    'node scripts/worker-secret-continuity.js ANTHROPIC_API_KEY AZURE_OCR_KEY',
  ]

  for (const mutatedCommand of mutations) {
    const mutatedWorkflow = workflow.replace(exactCommand, mutatedCommand)
    assert.notEqual(mutatedWorkflow, workflow, 'mutation must alter the workflow fixture')
    assert.throws(
      () => assertRequiredOcrSecretGate(mutatedWorkflow),
      /must verify exactly AZURE_OCR_KEY, ANTHROPIC_API_KEY in that order/
    )
  }
})

test('deploy credential validation remains on every non-stale run', () => {
  assert.match(
    workflow,
    new RegExp(`- name: Validate deploy secrets[\\s\\S]*?if: \\$\\{\\{ ${continueGuard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\}\\}`)
  )
})

test('runtime secret writes are skipped unless the Worker release gate requires them', () => {
  assert.match(
    workflow,
    new RegExp(`- name: Sync FX Worker runtime secrets[\\s\\S]*?if: \\$\\{\\{ ${workerReleaseGuard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\}\\}`)
  )
})

for (const stepName of [
  'Deploy to Cloudflare Pages',
  'Deploy to GitHub Pages',
  'Smoke check deployed endpoints',
]) {
  test(`${stepName} is guarded by the stale-run and verified-publish conditions`, () => {
    assert.match(
      workflow,
      new RegExp(`- name: ${stepName}[\\s\\S]*?if: \\$\\{\\{ ${publishGuard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\}\\}`)
    )
  })
}

for (const stepName of [
  'Deploy FX Worker',
  'Stamp deployed FX Worker release',
]) {
  test(`${stepName} is guarded by the independent Worker release decision`, () => {
    assert.match(
      workflow,
      new RegExp(`- name: ${stepName}[\\s\\S]*?if: \\$\\{\\{ ${workerReleaseGuard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\}\\}`)
    )
  })
}
