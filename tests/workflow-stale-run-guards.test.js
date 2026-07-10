const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'run.yml')
const workflow = fs.readFileSync(workflowPath, 'utf8')
const continueGuard =
  "steps.commit_snapshot_archive.outputs.stale_run != 'true' || steps.commit_snapshot_archive.outputs.continue_stale_deploy == 'true'"

test('workflow keeps both the midnight publish pass and the 03:00 UTC refresh schedule', () => {
  assert.match(workflow, /schedule:\s*\n\s*-\s*cron:\s*'0 0 \* \* \*'\s*\n\s*-\s*cron:\s*'0 3 \* \* \*'/)
})

test('workflow records whether a stale rerun can safely continue deploy steps', () => {
  assert.match(workflow, /echo "continue_stale_deploy=false" >> "\$GITHUB_OUTPUT"/)
  assert.match(workflow, /echo "continue_stale_deploy=true" >> "\$GITHUB_OUTPUT"/)
  assert.match(workflow, /deploy inputs drifted on trunk\. Skipping deploy steps for this stale dispatch\./)
  assert.match(
    workflow,
    /git diff --name-only HEAD\.\.origin\/\$\{branch_name\} -- \.github\/workflows\/run\.yml country\.json currscript\.js package\.json package-lock\.json scripts skeleton-package\.json worker wrangler\.jsonc snapshot-archive/
  )
})

test('workflow syncs Azure OCR key onto the deployed root worker script', () => {
  assert.match(workflow, /AZURE_OCR_KEY: \$\{\{ secrets\.AZURE_OCR_KEY \}\}/)
  assert.match(workflow, /printf "%s" "\$AZURE_OCR_KEY" \| npx wrangler secret put AZURE_OCR_KEY --config wrangler\.jsonc/)
  assert.match(workflow, /npx wrangler secret list --config wrangler\.jsonc --env=""/)
  assert.match(workflow, /node scripts\/worker-secret-continuity\.js AZURE_OCR_KEY/)
  assert.doesNotMatch(workflow, /::warning::Missing AZURE_OCR_KEY for FX Worker OCR proxy\./)
  assert.match(workflow, /npx wrangler deploy --config wrangler\.jsonc --env=""/)
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
