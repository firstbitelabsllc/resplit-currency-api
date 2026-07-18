const test = require('node:test')
const assert = require('node:assert/strict')

const {
  decidePublication,
  isDeployedReleaseEquivalent,
  main,
  readCommitMetadata,
} = require('../scripts/publish-needed')

const expectedDate = '2026-07-18'
const currentRelease = 'a'.repeat(40)

function archiveCommit({
  hash = 'b'.repeat(40),
  parent = currentRelease,
  subject = `chore: archive daily snapshot ${expectedDate}`,
  authorName = 'github-actions[bot]',
  authorEmail = 'github-actions[bot]@users.noreply.github.com',
  committerName = authorName,
  committerEmail = authorEmail,
  changedPaths = [
    'snapshot-archive/2025-07-18.json',
    'snapshot-archive/2026-07-18.json',
  ],
} = {}) {
  return {
    hash,
    parents: [parent],
    subject,
    authorName,
    authorEmail,
    committerName,
    committerEmail,
    changedPaths,
  }
}

test('archive changes always require publication without a live probe', async () => {
  let probes = 0
  const decision = await decidePublication({
    archiveChanged: 'true',
    expectedDate,
    currentRelease,
    verifyDeployment: async () => {
      probes += 1
    },
  })

  assert.deepEqual(decision, { publishRequired: true, reason: 'archive_changed' })
  assert.equal(probes, 0)
})

test('manual force publish remains available for recovery', async () => {
  const decision = await decidePublication({
    archiveChanged: 'false',
    forcePublish: 'true',
    expectedDate,
    currentRelease,
    verifyDeployment: async () => assert.fail('manual force must not depend on a probe'),
  })

  assert.deepEqual(decision, { publishRequired: true, reason: 'force_publish' })
})

test('verified current data and the matching Worker release skip duplicate publication', async () => {
  let receivedOptions
  const decision = await decidePublication({
    archiveChanged: 'false',
    expectedDate,
    currentRelease,
    verifyDeployment: async (options) => {
      receivedOptions = options
      return { workerHealth: { release: currentRelease } }
    },
  })

  assert.deepEqual(decision, { publishRequired: false, reason: 'verified_current' })
  assert.equal(receivedOptions.requestedDate, expectedDate)
  assert.equal(receivedOptions.postPublish, false)
  assert.equal(receivedOptions.requireFreshGithubFallback, true)
  assert.equal(receivedOptions.captureMissingDatedSnapshotIssue, false)
  assert.equal(typeof receivedOptions.log, 'function')
})

test('an older Worker release keeps publication enabled even when static data is current', async () => {
  const decision = await decidePublication({
    archiveChanged: 'false',
    expectedDate,
    currentRelease,
    verifyDeployment: async () => ({ workerHealth: { release: 'b'.repeat(40) } }),
  })

  assert.equal(decision.publishRequired, true)
  assert.equal(decision.reason, 'worker_release_mismatch')
})

test('the 03:00 pass accepts only the bot-authored archive-only commit whose parent was deployed', () => {
  const deployedRelease = 'a'.repeat(40)
  const archiveCommit = 'b'.repeat(40)
  const readCommit = () => archiveCommitFixture({
    hash: archiveCommit,
    parent: deployedRelease,
  })

  assert.equal(
    isDeployedReleaseEquivalent({
      deployedRelease,
      currentRelease: archiveCommit,
      expectedDate,
      readCommit,
    }),
    true
  )
})

test('the 03:00 recovery equivalence fails closed for any non-archive provenance change', () => {
  const deployedRelease = 'a'.repeat(40)
  const archiveRelease = 'b'.repeat(40)
  const invalidCommits = [
    archiveCommitFixture({ hash: archiveRelease, parent: deployedRelease, subject: 'docs: unrelated change' }),
    archiveCommitFixture({ hash: archiveRelease, parent: 'c'.repeat(40) }),
    { ...archiveCommitFixture({ hash: archiveRelease, parent: deployedRelease }), parents: [deployedRelease, 'c'.repeat(40)] },
    archiveCommitFixture({ hash: archiveRelease, parent: deployedRelease, authorEmail: 'human@example.com' }),
    archiveCommitFixture({ hash: archiveRelease, parent: deployedRelease, committerName: 'Leo' }),
    archiveCommitFixture({
      hash: archiveRelease,
      parent: deployedRelease,
      changedPaths: ['snapshot-archive/2026-07-18.json', 'worker/src/index.mjs'],
    }),
    archiveCommitFixture({ hash: archiveRelease, parent: deployedRelease, changedPaths: [] }),
  ]

  for (const commit of invalidCommits) {
    assert.equal(
      isDeployedReleaseEquivalent({
        deployedRelease,
        currentRelease: archiveRelease,
        expectedDate,
        readCommit: () => commit,
      }),
      false
    )
  }

  assert.equal(
    isDeployedReleaseEquivalent({
      deployedRelease,
      currentRelease: archiveRelease,
      expectedDate,
      readCommit: () => {
        throw new Error('shallow checkout cannot read the parent tree')
      },
    }),
    false
  )
})

test('a verified midnight release can skip the archive-only 03:00 commit', async () => {
  const deployedRelease = 'a'.repeat(40)
  const archiveCommit = 'b'.repeat(40)
  const decision = await decidePublication({
    archiveChanged: 'false',
    expectedDate,
    currentRelease: archiveCommit,
    verifyDeployment: async () => ({ workerHealth: { release: deployedRelease } }),
    readCommit: () => archiveCommitFixture({ hash: archiveCommit, parent: deployedRelease }),
  })

  assert.deepEqual(decision, { publishRequired: false, reason: 'verified_current' })
})

test('a failed first publication cannot be hidden by a later archive-only commit', async () => {
  const failedRelease = 'c'.repeat(40)
  const archiveCommit = 'b'.repeat(40)
  const decision = await decidePublication({
    archiveChanged: 'false',
    expectedDate,
    currentRelease: archiveCommit,
    verifyDeployment: async () => ({ workerHealth: { release: failedRelease } }),
    readCommit: () => archiveCommitFixture({ hash: archiveCommit, parent: currentRelease }),
  })

  assert.equal(decision.publishRequired, true)
  assert.equal(decision.reason, 'worker_release_mismatch')
})

test('a failed deployment verification fails closed into the normal publish path', async () => {
  const decision = await decidePublication({
    archiveChanged: 'false',
    expectedDate,
    currentRelease,
    verifyDeployment: async () => {
      throw new Error('GitHub Pages fallback is stale')
    },
  })

  assert.equal(decision.publishRequired, true)
  assert.equal(decision.reason, 'deployment_verification_failed')
  assert.match(decision.detail, /GitHub Pages fallback is stale/)
})

test('workflow output is constrained to machine-readable decision fields', async () => {
  let output = ''
  let errorOutput = ''
  const decision = await main({
    env: {
      ARCHIVE_CHANGED: 'false',
      EXPECTED_DATE: expectedDate,
      CURRENT_RELEASE: currentRelease,
    },
    output: { write: (chunk) => { output += chunk } },
    errorOutput: { write: (chunk) => { errorOutput += chunk } },
    verifyDeployment: async ({ log }) => {
      log('this must not enter GITHUB_OUTPUT')
      return { workerHealth: { release: currentRelease } }
    },
  })

  assert.equal(decision.publishRequired, false)
  assert.equal(output, 'publish_required=false\npublish_reason=verified_current\n')
  assert.equal(errorOutput, '')
})

test('commit metadata reads the complete NUL-delimited parent diff', () => {
  const calls = []
  const metadata = readCommitMetadata(currentRelease, {
    execFile: (command, args) => {
      calls.push([command, args])
      if (args[0] === 'show') {
        return [
          currentRelease,
          'b'.repeat(40),
          'github-actions[bot]',
          'github-actions[bot]@users.noreply.github.com',
          'github-actions[bot]',
          'github-actions[bot]@users.noreply.github.com',
          `chore: archive daily snapshot ${expectedDate}`,
        ].join('\n')
      }
      return 'snapshot-archive/2025-07-18.json\0snapshot-archive/2026-07-18.json\0'
    },
  })

  assert.deepEqual(metadata.changedPaths, [
    'snapshot-archive/2025-07-18.json',
    'snapshot-archive/2026-07-18.json',
  ])
  assert.deepEqual(calls[1], [
    'git',
    ['diff-tree', '--no-commit-id', '--no-renames', '--name-only', '-z', '-r', currentRelease],
  ])
})

function archiveCommitFixture(options) {
  return archiveCommit(options)
}
