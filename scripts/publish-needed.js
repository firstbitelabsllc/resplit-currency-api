#!/usr/bin/env node

const { execFileSync } = require('node:child_process')
const { verifyDeployedRelease } = require('./smoke-check-deploy')
const { compareWorkerReleaseInputs } = require('./worker-release-inputs')

if (require.main === module) {
  main().catch((error) => {
    console.error(`publish-needed: FAILED\n${error.stack || error.message}`)
    process.exitCode = 1
  })
}

// A no-op archive is not enough evidence to skip publication: the preceding
// attempt might have committed the snapshot but failed on a downstream surface.
// This guard therefore fails closed unless the existing public verification
// passes and the healthy Worker either reports the exact source release or has
// no changed Worker/config/secret-sync inputs since that release.
async function decidePublication({
  archiveChanged,
  forcePublish,
  expectedDate,
  currentRelease,
  env = process.env,
  verifyDeployment = verifyDeployedRelease,
  releaseEquivalent = isWorkerReleaseEquivalent,
  readCommit,
} = {}) {
  if (isTrue(forcePublish)) {
    return { publishRequired: true, reason: 'force_publish' }
  }
  if (isTrue(archiveChanged)) {
    return { publishRequired: true, reason: 'archive_changed' }
  }
  if (!isISODate(expectedDate)) {
    return { publishRequired: true, reason: 'expected_date_invalid' }
  }
  if (!isCommitSha(currentRelease)) {
    return { publishRequired: true, reason: 'current_release_invalid' }
  }

  try {
    const verification = await verifyDeployment({
      env,
      requestedDate: expectedDate,
      postPublish: false,
      requireFreshGithubFallback: true,
      captureMissingDatedSnapshotIssue: false,
      // The workflow redirects this helper's stdout to GITHUB_OUTPUT. Keep
      // optional verification notices out of that machine-readable file.
      log: () => {},
    })
    const deployedRelease = verification?.workerHealth?.release
    if (!releaseEquivalent({ deployedRelease, currentRelease, expectedDate, readCommit })) {
      return {
        publishRequired: true,
        reason: 'worker_release_mismatch',
        detail: `worker=${safeValue(deployedRelease)}, current=${safeValue(currentRelease)}`,
      }
    }
    return { publishRequired: false, reason: 'verified_current' }
  } catch (error) {
    return {
      publishRequired: true,
      reason: 'deployment_verification_failed',
      detail: safeValue(error?.message || error),
    }
  }
}

// The midnight workflow commits archive retention changes only after it has
// checked out the source it deploys. At 03:00 GitHub schedules from that new
// archive commit, while Worker health truthfully reports the source SHA that
// was deployed at midnight. Treat only a bot-authored, archive-only child of
// that deployed SHA as equivalent. This permits the expected add/delete
// retention transition without letting a source or deployment-input change
// hide behind an archive-looking commit.
function isDeployedReleaseEquivalent({
  deployedRelease,
  currentRelease,
  expectedDate,
  readCommit = readCommitMetadata,
} = {}) {
  if (!isCommitSha(deployedRelease) || !isCommitSha(currentRelease) || !isISODate(expectedDate)) {
    return false
  }
  if (deployedRelease === currentRelease) {
    return true
  }

  try {
    const commit = readCommit(currentRelease)
    return commit?.hash === currentRelease &&
      commit.parents?.length === 1 &&
      commit.parents[0] === deployedRelease &&
      commit.authorName === 'github-actions[bot]' &&
      commit.authorEmail === 'github-actions[bot]@users.noreply.github.com' &&
      commit.committerName === 'github-actions[bot]' &&
      commit.committerEmail === 'github-actions[bot]@users.noreply.github.com' &&
      commit.subject === `chore: archive daily snapshot ${expectedDate}` &&
      Array.isArray(commit.changedPaths) &&
      commit.changedPaths.length > 0 &&
      commit.changedPaths.every((path) => path.startsWith('snapshot-archive/'))
  } catch {
    return false
  }
}

// Pages data is fetched dynamically by the Worker, so a source change outside
// its deployment inputs does not make a healthy Worker stale. The caller still
// has to pass the complete Pages, dated snapshot, GitHub Pages, and Worker
// behavior verification above before this can suppress a publication.
function isWorkerReleaseEquivalent({
  deployedRelease,
  currentRelease,
  expectedDate,
  readCommit = readCommitMetadata,
  compareInputs = compareWorkerReleaseInputs,
} = {}) {
  if (isDeployedReleaseEquivalent({ deployedRelease, currentRelease, expectedDate, readCommit })) {
    return true
  }
  return compareInputs({ deployedRelease, currentRelease }).equivalent === true
}

function readCommitMetadata(currentRelease, {
  cwd = process.cwd(),
  execFile = execFileSync,
} = {}) {
  if (!isCommitSha(currentRelease)) {
    throw new Error('current release must be a full commit SHA')
  }
  const output = execFile(
    'git',
    ['show', '-s', '--format=%H%n%P%n%an%n%ae%n%cn%n%ce%n%s', currentRelease],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  ).trimEnd().split('\n')
  const changedPaths = execFile(
    'git',
    ['diff-tree', '--no-commit-id', '--no-renames', '--name-only', '-z', '-r', currentRelease],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  ).split('\0').filter(Boolean)
  const [
    hash,
    parentLine = '',
    authorName = '',
    authorEmail = '',
    committerName = '',
    committerEmail = '',
    subject = '',
  ] = output
  return {
    hash,
    parents: parentLine.split(' ').filter(Boolean),
    authorName,
    authorEmail,
    committerName,
    committerEmail,
    subject,
    changedPaths,
  }
}

async function main({
  env = process.env,
  output = process.stdout,
  errorOutput = process.stderr,
  verifyDeployment,
} = {}) {
  const decision = await decidePublication({
    archiveChanged: env.ARCHIVE_CHANGED,
    forcePublish: env.FORCE_PUBLISH,
    expectedDate: env.EXPECTED_DATE,
    currentRelease: env.CURRENT_RELEASE || env.GITHUB_SHA,
    env,
    verifyDeployment,
  })

  output.write(`publish_required=${decision.publishRequired ? 'true' : 'false'}\n`)
  output.write(`publish_reason=${decision.reason}\n`)
  if (decision.detail) {
    errorOutput.write(`publish-needed: ${decision.detail}\n`)
  }
  return decision
}

function isTrue(value) {
  return value === true || String(value).trim().toLowerCase() === 'true'
}

function isISODate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function isCommitSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value)
}

function safeValue(value) {
  return String(value || 'missing').replace(/[\r\n]+/g, ' ').slice(0, 180)
}

module.exports = {
  decidePublication,
  isCommitSha,
  isDeployedReleaseEquivalent,
  isWorkerReleaseEquivalent,
  isISODate,
  isTrue,
  main,
  readCommitMetadata,
}
