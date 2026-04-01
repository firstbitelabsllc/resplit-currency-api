const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'run.yml')
const workflow = fs.readFileSync(workflowPath, 'utf8')
const continueGuard =
  "steps.commit_snapshot_archive.outputs.stale_run != 'true' || steps.commit_snapshot_archive.outputs.continue_stale_deploy == 'true'"

test('workflow records whether a stale rerun can safely continue deploy steps', () => {
  assert.match(workflow, /echo "continue_stale_deploy=false" >> "\$GITHUB_OUTPUT"/)
  assert.match(workflow, /echo "continue_stale_deploy=true" >> "\$GITHUB_OUTPUT"/)
  assert.match(workflow, /deploy inputs drifted on trunk\. Skipping deploy steps for this stale dispatch\./)
  assert.match(workflow, /git diff --name-only HEAD\.\.origin\/\$\{branch_name\} -- currscript\.js package\.json package-lock\.json scripts worker wrangler\.jsonc snapshot-archive/)
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
