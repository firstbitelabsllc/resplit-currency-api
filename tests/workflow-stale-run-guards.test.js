const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'run.yml')
const workflow = fs.readFileSync(workflowPath, 'utf8')
const continueGuard =
  "steps.commit_snapshot_archive.outputs.stale_run != 'true' || steps.commit_snapshot_archive.outputs.continue_stale_deploy == 'true'"
const requiredOcrSecrets = ['AZURE_OCR_KEY', 'ANTHROPIC_API_KEY']
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

test('workflow keeps both the midnight publish pass and the 03:00 UTC refresh schedule', () => {
  assert.match(workflow, /schedule:\s*\n\s*-\s*cron:\s*'0 0 \* \* \*'\s*\n\s*-\s*cron:\s*'0 3 \* \* \*'/)
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

test('workflow syncs Azure and then verifies both OCR provider secrets before publication', () => {
  assert.match(workflow, /AZURE_OCR_KEY: \$\{\{ secrets\.AZURE_OCR_KEY \}\}/)
  assert.match(workflow, /printf "%s" "\$AZURE_OCR_KEY" \| npx wrangler secret put AZURE_OCR_KEY --config wrangler\.jsonc/)
  assertRequiredOcrSecretGate(workflow)
  assert.doesNotMatch(workflow, /::warning::Missing AZURE_OCR_KEY for FX Worker OCR proxy\./)
  assert.match(workflow, /npx wrangler deploy --config wrangler\.jsonc --env=""/)
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

for (const stepName of [
  'Validate deploy secrets',
  'Sync FX Worker runtime secrets',
  'Deploy to Cloudflare Pages',
  'Deploy FX Worker',
  'Deploy to GitHub Pages',
  'Smoke check deployed endpoints',
]) {
  test(`${stepName} is guarded by the stale-run deploy condition`, () => {
    assert.match(
      workflow,
      new RegExp(`- name: ${stepName}[\\s\\S]*?if: \\$\\{\\{ ${continueGuard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\}\\}`)
    )
  })
}
