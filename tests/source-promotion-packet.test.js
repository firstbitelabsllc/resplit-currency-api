const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  buildPacket,
  buildPromotionReview,
  classifyDirtyPath,
  classifyPromotionCandidate,
  main,
  parseGitStatus,
  renderMarkdown,
} = require('../scripts/source-promotion-packet.js')

function mockReport() {
  return {
    verdict: { status: 'red', label: 'RED - missing required trust contract' },
    repo: {
      name: 'resplit-currency-api',
      path: '/tmp/resplit-currency-api',
      git: {
        branch: 'main',
        head: 'abc123',
        originMain: 'def456',
        dirtyCount: 5,
        behindOriginMain: 10,
      },
    },
    localCi: {
      sourcePromotionBundle: {
        status: 'red',
        summary: '2 current-only file(s); 1 modified tracked file(s); 1 command drift row(s)',
        nextAction: 'Review this bundle and land the control-plane paths.',
        counts: {
          currentOnlyFiles: 2,
          modifiedFiles: 1,
          commandDrift: 1,
        },
        recommendedPaths: [
          '.firstbite/local-ci.json',
          'package.json',
        ],
        commands: {
          inspectStatus: "git status --short -- '.firstbite/local-ci.json' 'package.json'",
          inspectDiff: "git diff -- '.firstbite/local-ci.json' 'package.json'",
          inspectUntracked: "git ls-files --others --exclude-standard -- '.firstbite/local-ci.json' 'package.json'",
          cleanProofAfterPromotion: 'firstbite clean command',
        },
        commandDrift: [{
          kind: 'package script',
          name: 'check:publish',
          status: 'red',
          current: 'npm run generate && npm run validate && npm run test',
          head: 'missing',
          origin: 'missing',
        }],
        files: [
          {
            path: '.firstbite/local-ci.json',
            role: 'local-CI contract',
            action: 'add to tracked source and publish',
            currentExists: true,
            headExists: false,
            originExists: false,
            gitStatus: '?? .firstbite/local-ci.json',
          },
          {
            path: 'package.json',
            role: 'local-CI contract',
            action: 'include modified current source',
            currentExists: true,
            headExists: true,
            originExists: true,
            gitStatus: 'M package.json',
          },
          {
            path: 'scripts/reliability-cockpit.js',
            role: 'operator cockpit',
            action: 'already tracked',
            currentExists: true,
            headExists: true,
            originExists: true,
            gitStatus: '',
          },
        ],
      },
    },
    telemetry: {
      status: 'yellow',
      summary: 'Grafana Tempo/Loki evidence is missing.',
    },
    agentState: {
      nurseLog: {
        releaseReadiness: 'yellow',
        releaseHistoryEvidence: 'available 18/30, missing 2026-05-12..2026-05-23',
      },
    },
    trustModel: {
      contracts: [{
        gate: 'Source promotion bundle',
        status: 'red',
        current: '2 current-only files',
        nextAction: 'land bundle',
      }],
    },
  }
}

test('parseGitStatus captures status, untracked paths, deletes, and renames', () => {
  const rows = parseGitStatus([
    '?? .firstbite/local-ci.json',
    ' M package.json',
    'D  snapshot-archive/old.json',
    'R  old-name.js -> scripts/source-promotion-packet.js',
  ].join('\n'))

  assert.deepEqual(rows.map(row => row.path), [
    '.firstbite/local-ci.json',
    'package.json',
    'snapshot-archive/old.json',
    'scripts/source-promotion-packet.js',
  ])
  assert.equal(rows[0].index, '?')
  assert.equal(rows[1].worktree, 'M')
  assert.equal(rows[2].index, 'D')
})

test('buildPacket separates exact stage candidates from dirty hold-by-default rows', () => {
  const packet = buildPacket({
    repoDir: '/tmp/resplit-currency-api',
    generatedAt: '2026-05-25T08:00:00.000Z',
    report: mockReport(),
    gitStatusRows: parseGitStatus([
      '?? .firstbite/local-ci.json',
      ' M package.json',
      ' M README.md',
      ' M .gitignore',
      ' D snapshot-archive/2026-05-12.json',
      '?? .agents/local-state.json',
    ].join('\n')),
  })

  assert.equal(packet.status, 'red')
  assert.deepEqual(packet.stageCandidates.map(row => row.path), [
    '.firstbite/local-ci.json',
    'package.json',
  ])
  assert.deepEqual(packet.holdByDefault.map(row => row.path), [
    'README.md',
    '.gitignore',
    'snapshot-archive/2026-05-12.json',
    '.agents/local-state.json',
  ])
  assert.equal(packet.holdByDefault.find(row => row.path === '.agents/local-state.json').disposition, 'agent local state; hold by default')
  assert.equal(packet.commands.stageExactBundle, "git add -- '.firstbite/local-ci.json' 'package.json'")
  assert.equal(packet.stagingGate.fullStageBlocked, false)
  assert.equal(packet.stagingGate.nonRedStageCommand, "git add -- '.firstbite/local-ci.json' 'package.json'")
  assert.equal(packet.stagedBundle.status, 'yellow')
  assert.equal(packet.stagedBundle.exactMatch, false)
  assert.deepEqual(packet.stagedBundle.unstagedStageablePaths, [
    '.firstbite/local-ci.json',
    'package.json',
  ])
  assert.equal(packet.commands.inspectOriginDiff, "git diff origin/main -- '.firstbite/local-ci.json' 'package.json'")
  assert.equal(packet.commands.unstageExactBundle, "git restore --staged -- '.firstbite/local-ci.json' 'package.json'")
  assert.match(packet.commands.verifyStagedExactBundle, /git diff --cached --check/)
  assert.equal(packet.promotionReview.status, 'yellow')
  assert.deepEqual(packet.promotionReview.rows.map(row => row.classification), [
    'new-local-only',
    'modified-tracked',
  ])
  assert.match(packet.summary.headline, /stage candidates 2/)
  assert.match(packet.summary.headline, /hold by default 4/)
  assert.ok(packet.blockers.some(row => row.area === 'gitignore review'))
  assert.ok(packet.blockers.some(row => row.area === 'candidate reconciliation'))

  const markdown = renderMarkdown(packet)
  assert.match(markdown, /## Stage Candidates/)
  assert.match(markdown, /## Staging Gate/)
  assert.match(markdown, /## Staged Bundle Attestation/)
  assert.match(markdown, /unstaged candidate paths/)
  assert.match(markdown, /stageNonRedCandidates/)
  assert.match(markdown, /## Candidate Reconciliation/)
  assert.match(markdown, /new-local-only/)
  assert.match(markdown, /## Hold By Default/)
  assert.match(markdown, /firstbite clean command/)
  assert.doesNotMatch(packet.commands.stageExactBundle, /README|snapshot-archive|\.agents/)
})

test('buildPacket attests exact staged bundle and rejects staged hold-by-default paths', () => {
  const exactPacket = buildPacket({
    repoDir: '/tmp/resplit-currency-api',
    generatedAt: '2026-05-25T08:01:00.000Z',
    report: mockReport(),
    gitStatusRows: parseGitStatus([
      'A  .firstbite/local-ci.json',
      'M  package.json',
      ' M README.md',
    ].join('\n')),
  })

  assert.equal(exactPacket.stagedBundle.status, 'green')
  assert.equal(exactPacket.stagedBundle.exactMatch, true)
  assert.deepEqual(exactPacket.stagedBundle.stagedStageablePaths, [
    '.firstbite/local-ci.json',
    'package.json',
  ])
  assert.deepEqual(exactPacket.stagedBundle.unexpectedStagedPaths, [])
  assert.match(exactPacket.stagedBundle.summary, /Exact source-promotion bundle is staged/)

  const contaminatedPacket = buildPacket({
    repoDir: '/tmp/resplit-currency-api',
    generatedAt: '2026-05-25T08:01:30.000Z',
    report: mockReport(),
    gitStatusRows: parseGitStatus([
      'A  .firstbite/local-ci.json',
      'M  package.json',
      'M  README.md',
    ].join('\n')),
  })

  assert.equal(contaminatedPacket.stagedBundle.status, 'red')
  assert.equal(contaminatedPacket.stagedBundle.exactMatch, false)
  assert.deepEqual(contaminatedPacket.stagedBundle.unexpectedStagedPaths, ['README.md'])
  assert.deepEqual(contaminatedPacket.stagedBundle.stagedHoldByDefaultPaths, ['README.md'])
  assert.ok(contaminatedPacket.blockers.some(row => row.area === 'staged bundle attestation' && row.status === 'red'))
})

test('buildPacket treats a landed source-promotion bundle as exact with zero stage candidates', () => {
  const report = mockReport()
  const files = report.localCi.sourcePromotionBundle.files.map(row => ({
    ...row,
    action: 'already tracked',
    headExists: true,
    originExists: true,
    gitStatus: '',
  }))
  report.localCi.sourcePromotionBundle = {
    ...report.localCi.sourcePromotionBundle,
    status: 'green',
    summary: 'Source promotion bundle is tracked; clean worktree proof can target the current cockpit and local-CI contract.',
    nextAction: 'Run clean proof',
    counts: {
      currentOnlyFiles: 0,
      modifiedFiles: 0,
      commandDrift: 0,
    },
    recommendedPaths: [],
    commandDrift: [],
    files,
  }

  const packet = buildPacket({
    repoDir: '/tmp/resplit-currency-api',
    generatedAt: '2026-05-25T08:01:45.000Z',
    report,
    gitStatusRows: [],
  })

  assert.equal(packet.status, 'green')
  assert.equal(packet.stagingGate.status, 'green')
  assert.equal(packet.stagedBundle.status, 'green')
  assert.equal(packet.stagedBundle.exactMatch, true)
  assert.equal(packet.stagedBundle.stageableCount, 0)
  assert.equal(packet.stagedBundle.stagedStageableCount, 0)
  assert.deepEqual(packet.stageCandidates, [])
  assert.deepEqual(packet.stagedBundle.unexpectedStagedPaths, [])
  assert.match(packet.stagedBundle.summary, /No source-promotion stage candidates remain/)
  assert.match(packet.stagedBundle.nextAction, /No source-promotion staging is required/)
  assert.equal(packet.summary.counts.commandDrift, 0)
  assert.match(renderMarkdown(packet), /No source-promotion stage candidates remain/)
})

test('buildPacket blocks full staging when upstream drift rows are red', () => {
  const report = mockReport()
  report.localCi.sourcePromotionBundle.files[0].originExists = true
  report.localCi.sourcePromotionBundle.files[0].action = 'add to HEAD before clean proof'

  const packet = buildPacket({
    repoDir: '/tmp/resplit-currency-api',
    generatedAt: '2026-05-25T08:02:00.000Z',
    report,
    gitStatusRows: parseGitStatus([
      '?? .firstbite/local-ci.json',
      ' M package.json',
    ].join('\n')),
    contentComparisons: {
      '.firstbite/local-ci.json': {
        currentHash: 'local-manifest',
        originHash: 'origin-manifest',
        currentLines: 26,
        originLines: 26,
      },
      'package.json': {
        currentHash: 'local-package',
        headHash: 'head-package',
        originHash: 'head-package',
        currentLines: 32,
        headLines: 24,
        originLines: 24,
      },
    },
  })

  assert.equal(packet.promotionReview.status, 'red')
  assert.equal(packet.stagingGate.status, 'red')
  assert.equal(packet.stagingGate.fullStageBlocked, true)
  assert.deepEqual(packet.stagingGate.blockedPaths, ['.firstbite/local-ci.json'])
  assert.match(packet.commands.stageExactBundle, /^BLOCKED: resolve 1 red candidate/)
  assert.equal(packet.commands.stageNonRedCandidates, "git add -- 'package.json'")
  assert.ok(packet.blockers.some(row => row.area === 'staging gate' && row.status === 'red'))
  assert.match(renderMarkdown(packet), /Full bundle staging is blocked by 1 red upstream-drift candidate/)
})

test('buildPacket unblocks full staging for hash-locked reviewed origin drift', () => {
  const report = mockReport()
  report.localCi.sourcePromotionBundle.files[0].originExists = true
  report.localCi.sourcePromotionBundle.files[0].action = 'add to HEAD before clean proof'

  const packet = buildPacket({
    repoDir: '/tmp/resplit-currency-api',
    generatedAt: '2026-05-25T08:03:00.000Z',
    report,
    gitStatusRows: parseGitStatus([
      '?? .firstbite/local-ci.json',
      ' M package.json',
    ].join('\n')),
    contentComparisons: {
      '.firstbite/local-ci.json': {
        currentHash: 'local-manifest',
        originHash: 'origin-manifest',
        currentLines: 26,
        originLines: 26,
      },
      'package.json': {
        currentHash: 'local-package',
        headHash: 'head-package',
        originHash: 'origin-package',
        currentLines: 32,
        headLines: 24,
        originLines: 24,
      },
    },
    reviewDecisions: {
      version: 1,
      decisions: [{
        path: '.firstbite/local-ci.json',
        decision: 'accept-current',
        currentHash: 'local-manifest',
        originHash: 'origin-manifest',
        reason: 'repo manifest command intentionally supersedes origin',
        evidence: ['reviewed diff'],
      }, {
        path: 'package.json',
        decision: 'accept-current',
        currentHash: 'local-package',
        originHash: 'origin-package',
        reason: 'package scripts intentionally supersede origin',
        evidence: ['reviewed diff'],
      }],
    },
  })

  assert.equal(packet.promotionReview.status, 'yellow')
  assert.equal(packet.stagingGate.status, 'yellow')
  assert.equal(packet.stagingGate.fullStageBlocked, false)
  assert.deepEqual(packet.stagingGate.blockedPaths, [])
  assert.equal(packet.commands.stageExactBundle, "git add -- '.firstbite/local-ci.json' 'package.json'")
  assert.equal(packet.promotionReview.rows[0].classification, 'origin-present-origin-drift-reviewed')
  assert.equal(packet.promotionReview.rows[0].reviewDecision.status, 'accepted')
  assert.equal(packet.promotionReview.rows[1].classification, 'modified-tracked-origin-drift-reviewed')
  assert.match(renderMarkdown(packet), /accepted:accept-current/)
})

test('buildPacket accepts staged package contract while holding unstaged package drift', () => {
  const report = mockReport()

  const packet = buildPacket({
    repoDir: '/tmp/resplit-currency-api',
    generatedAt: '2026-05-25T08:03:30.000Z',
    report,
    gitStatusRows: parseGitStatus([
      'A  .firstbite/local-ci.json',
      'MM package.json',
    ].join('\n')),
    contentComparisons: {
      '.firstbite/local-ci.json': {
        currentHash: 'local-manifest',
        currentLines: 26,
      },
      'package.json': {
        source: 'index',
        currentHash: 'origin-package',
        headHash: 'head-package',
        originHash: 'origin-package',
        currentLines: 33,
        headLines: 24,
        originLines: 33,
      },
    },
  })

  const packageRow = packet.promotionReview.rows.find(row => row.path === 'package.json')

  assert.equal(packet.promotionReview.status, 'yellow')
  assert.equal(packet.stagingGate.status, 'yellow')
  assert.equal(packet.stagingGate.fullStageBlocked, false)
  assert.deepEqual(packet.stagingGate.blockedPaths, [])
  assert.ok(packet.stagingGate.nonRedStageablePaths.includes('package.json'))
  assert.ok(packet.stagingGate.indexSourcedPaths.includes('package.json'))
  assert.doesNotMatch(packet.stagingGate.fullStageCommand, /package\.json/)
  assert.doesNotMatch(packet.stagingGate.nonRedStageCommand, /package\.json/)
  assert.equal(packageRow.status, 'yellow')
  assert.equal(packageRow.classification, 'modified-tracked-index-origin-match')
  assert.equal(packageRow.comparisonSource, 'index')
  assert.match(packageRow.reviewCommand, /git diff --cached/)
  assert.equal(packet.stagedBundle.status, 'green')
  assert.equal(packet.stagedBundle.exactMatch, true)
  assert.deepEqual(packet.stagedBundle.dirtyAfterStagingPaths, [])
  assert.deepEqual(packet.stagedBundle.ignoredDirtyAfterStagingPaths, ['package.json'])
  assert.match(packet.stagedBundle.summary, /unstaged path\(s\) intentionally held/)
})

test('buildPromotionReview treats the review-decision manifest as non-self-blocking metadata', () => {
  const review = buildPromotionReview({
    repoDir: '/tmp/resplit-currency-api',
    stageCandidates: [{
      path: '.firstbite/source-promotion-decisions.json',
      currentExists: true,
      headExists: false,
      originExists: true,
      gitStatus: 'A  .firstbite/source-promotion-decisions.json',
    }],
    contentComparisons: {
      '.firstbite/source-promotion-decisions.json': {
        currentHash: 'local-decisions',
        originHash: 'origin-decisions',
        currentLines: 40,
        originLines: 10,
      },
    },
  })

  assert.equal(review.status, 'yellow')
  assert.equal(review.rows[0].classification, 'review-decision-manifest-update')
  assert.match(review.rows[0].action, /self-referential hash decision/)
})

test('buildPromotionReview separates upstream-present matches from origin drift', () => {
  const review = buildPromotionReview({
    repoDir: '/tmp/resplit-currency-api',
    stageCandidates: [
      {
        path: '.firstbite/local-ci.json',
        currentExists: true,
        headExists: false,
        originExists: true,
        gitStatus: '?? .firstbite/local-ci.json',
      },
      {
        path: 'scripts/reliability-cockpit.js',
        currentExists: true,
        headExists: false,
        originExists: false,
        gitStatus: '?? scripts/reliability-cockpit.js',
      },
      {
        path: 'package.json',
        currentExists: true,
        headExists: true,
        originExists: true,
        gitStatus: 'M package.json',
      },
    ],
    contentComparisons: {
      '.firstbite/local-ci.json': {
        currentHash: 'same',
        originHash: 'same',
        currentLines: 4,
        originLines: 4,
      },
      'scripts/reliability-cockpit.js': {
        currentHash: 'local',
        currentLines: 12,
      },
      'package.json': {
        currentHash: 'local',
        headHash: 'head',
        originHash: 'origin',
        currentLines: 10,
        headLines: 8,
        originLines: 9,
      },
    },
  })

  assert.equal(review.status, 'red')
  assert.equal(review.counts.upstreamPresent, 1)
  assert.equal(review.counts.upstreamDrift, 1)
  assert.equal(review.rows.find(row => row.path === '.firstbite/local-ci.json').classification, 'origin-present-match')
  assert.equal(review.rows.find(row => row.path === 'scripts/reliability-cockpit.js').classification, 'new-local-only')
  const packageRow = review.rows.find(row => row.path === 'package.json')
  assert.equal(packageRow.classification, 'modified-tracked-origin-drift')
  assert.equal(packageRow.lineDeltaVsHead, 2)
  assert.equal(packageRow.lineDeltaVsOrigin, 1)
  assert.match(packageRow.reviewCommand, /git diff -- 'package\.json'/)
  assert.match(review.rows.find(row => row.path === '.firstbite/local-ci.json').reviewCommand, /git show 'origin\/main:\.firstbite\/local-ci\.json'/)
})

test('classifyPromotionCandidate blocks staging when origin already has different content', () => {
  const row = classifyPromotionCandidate({
    path: '.firstbite/local-ci.json',
    currentExists: true,
    headExists: false,
    originExists: true,
    gitStatus: '?? .firstbite/local-ci.json',
  }, {
    currentHash: 'local',
    originHash: 'upstream',
  })

  assert.equal(row.status, 'red')
  assert.equal(row.classification, 'origin-present-origin-drift')
  assert.match(row.action, /origin\/main/)
  assert.match(row.reviewCommand, /git diff --no-index/)
})

test('main writes the packet artifacts without touching git state', async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-promotion-packet-'))
  const result = await main(['--repo', repoDir], {
    now: () => '2026-05-25T08:01:00.000Z',
    buildReport: () => mockReport(),
    gitStatusRows: parseGitStatus(' M README.md\n'),
  })

  assert.equal(result.packet.status, 'red')
  assert.equal(fs.existsSync(path.join(repoDir, 'reports', 'resplit-fx-source-promotion-packet.json')), true)
  assert.equal(fs.existsSync(path.join(repoDir, 'reports', 'resplit-fx-source-promotion-packet.md')), true)
})

test('classifyDirtyPath keeps generated and local state out of the default bundle', () => {
  assert.equal(classifyDirtyPath('snapshot-archive/2026-05-12.json'), 'snapshot archive data; hold by default')
  assert.equal(classifyDirtyPath('.agents/local-state.json'), 'agent local state; hold by default')
  assert.equal(classifyDirtyPath('package.json', { recommended: true }), 'stage candidate')
})
