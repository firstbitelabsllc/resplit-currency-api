const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.join(__dirname, '..')
const workflows = {
  deploy: fs.readFileSync(path.join(repoRoot, '.github/workflows/deploy.yml'), 'utf8'),
  loki: fs.readFileSync(
    path.join(repoRoot, '.github/workflows/deploy-ocr-loki-forwarder.yml'),
    'utf8'
  ),
}

const node24Actions = [
  {
    name: 'actions/setup-go',
    pin: 'actions/setup-go@924ae3a1cded613372ab5595356fb5720e22ba16 # v6.5.0',
    workflows: ['deploy'],
  },
  {
    name: 'google-github-actions/auth',
    pin: 'google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093 # v3',
    workflows: ['deploy', 'loki'],
  },
  {
    name: 'google-github-actions/setup-gcloud',
    pin: 'google-github-actions/setup-gcloud@aa5489c8933f4cc7a4f7d45035b3b1440c9c10db # v3.0.1',
    workflows: ['deploy', 'loki'],
  },
  {
    name: 'docker/setup-buildx-action',
    pin: 'docker/setup-buildx-action@bb05f3f5519dd87d3ba754cc423b652a5edd6d2c # v4.2.0',
    workflows: ['deploy', 'loki'],
  },
  {
    name: 'docker/build-push-action',
    pin: 'docker/build-push-action@53b7df96c91f9c12dcc8a07bcb9ccacbed38856a # v7.3.0',
    workflows: ['deploy', 'loki'],
  },
]

function occurrences(source, needle) {
  return source.split(needle).length - 1
}

test('deploy workflows pin the reviewed Node 24 action releases by immutable SHA', () => {
  for (const action of node24Actions) {
    for (const workflowName of action.workflows) {
      const source = workflows[workflowName]
      assert.ok(
        source.includes(action.pin),
        `${workflowName} must pin reviewed ${action.name}`
      )
      assert.equal(
        occurrences(source, `${action.name}@`),
        occurrences(source, action.pin),
        `${workflowName} must not retain another ${action.name} pin`
      )
    }
  }
})

test('the historical Node 20-era action SHAs cannot return', () => {
  const combined = Object.values(workflows).join('\n')
  for (const staleSha of [
    'd35c59abb061a4a6fb18e82ac0862c26744d6ab5',
    'c200f3691d83b41bf9bbd8638997a462592937ed',
    'e427ad8a34f8676edf47cf7d7925499adf3eb74f',
    'b5ca514318bd6ebac0fb2aedd5d36ec1b5c232a2',
    '471d1dc4e07e5cdedd4c2171150001c434f0b7a4',
  ]) {
    assert.doesNotMatch(combined, new RegExp(staleSha))
  }
})
