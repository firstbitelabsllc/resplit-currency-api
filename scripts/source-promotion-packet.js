#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { buildReport } = require('./reliability-cockpit.js')

const DEFAULT_OUTPUT_DIR = 'reports'
const PACKET_BASENAME = 'resplit-fx-source-promotion-packet'
const REVIEW_DECISIONS_PATH = '.firstbite/source-promotion-decisions.json'

if (require.main === module) {
  main(process.argv.slice(2)).then(result => {
    if (result.options.printJson) {
      process.stdout.write(`${JSON.stringify(result.packet, null, 2)}\n`)
    } else if (!result.options.noWrite) {
      process.stdout.write(`source-promotion-packet: ${result.packet.summary.headline}\n`)
      process.stdout.write(`source-promotion-packet: wrote ${result.packet.outputPath}\n`)
      process.stdout.write(`source-promotion-packet: wrote ${result.packet.markdownPath}\n`)
    }
    process.exitCode = result.packet.status === 'red' ? 1 : 0
  }).catch(error => {
    console.error(`source-promotion-packet: FAILED\n${error.stack || error.message}`)
    process.exitCode = 1
  })
}

async function main(argv, deps = {}) {
  const options = parseArgs(argv)
  if (options.help) {
    process.stdout.write(helpText())
    return { options, packet: null }
  }

  const repoDir = path.resolve(options.repoDir || process.cwd())
  const generatedAt = deps.now ? deps.now() : new Date().toISOString()
  const report = deps.report || (deps.buildReport || buildReport)({ repoDir, generatedAt })
  const gitStatusRows = deps.gitStatusRows || readGitStatusRows(repoDir)
  const outputPath = path.resolve(repoDir, options.output)
  const markdownPath = path.resolve(repoDir, options.markdownOutput)
  const packet = buildPacket({
    repoDir,
    generatedAt,
    outputPath,
    markdownPath,
    report,
    gitStatusRows,
  })

  if (!options.noWrite) {
    writeJson(outputPath, packet)
    writeText(markdownPath, renderMarkdown(packet))
  }

  return { options, packet }
}

function parseArgs(argv) {
  const options = {
    repoDir: null,
    output: path.join(DEFAULT_OUTPUT_DIR, `${PACKET_BASENAME}.json`),
    markdownOutput: path.join(DEFAULT_OUTPUT_DIR, `${PACKET_BASENAME}.md`),
    noWrite: false,
    printJson: false,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
    case '--help':
    case '-h':
      options.help = true
      break
    case '--repo':
      options.repoDir = requireValue(argv, index, arg)
      index += 1
      break
    case '--output':
      options.output = requireValue(argv, index, arg)
      index += 1
      break
    case '--markdown-output':
      options.markdownOutput = requireValue(argv, index, arg)
      index += 1
      break
    case '--no-write':
      options.noWrite = true
      break
    case '--json':
      options.printJson = true
      break
    default:
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return options
}

function requireValue(argv, index, arg) {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${arg} requires a value`)
  }
  return value
}

function helpText() {
  return [
    'Usage: node scripts/source-promotion-packet.js [--json] [--no-write] [--output reports/resplit-fx-source-promotion-packet.json]',
    '',
    'Builds a read-only source-promotion packet from the reliability cockpit model.',
    'The packet separates exact stage candidates from dirty files that should be held by default.',
    '',
  ].join('\n')
}

function buildPacket({
  repoDir,
  generatedAt,
  outputPath = path.join(repoDir, DEFAULT_OUTPUT_DIR, `${PACKET_BASENAME}.json`),
  markdownPath = path.join(repoDir, DEFAULT_OUTPUT_DIR, `${PACKET_BASENAME}.md`),
  report,
  gitStatusRows = [],
  contentComparisons = null,
  reviewDecisions = null,
} = {}) {
  const decisions = reviewDecisions || loadReviewDecisions(repoDir)
  const bundle = report?.localCi?.sourcePromotionBundle || null
  const bundleFiles = bundle?.files || []
  const bundlePathSet = new Set(bundleFiles.map(row => row.path))
  const recommendedPathSet = new Set(bundle?.recommendedPaths || [])
  const dirtyRows = gitStatusRows.map(row => ({
    ...row,
    inPromotionBundle: bundlePathSet.has(row.path),
    recommended: recommendedPathSet.has(row.path),
    disposition: classifyDirtyPath(row.path, {
      inPromotionBundle: bundlePathSet.has(row.path),
      recommended: recommendedPathSet.has(row.path),
    }),
  }))
  const dirtyPathSet = new Set(dirtyRows.map(row => row.path))
  const stageCandidates = bundleFiles
    .filter(row => recommendedPathSet.has(row.path))
    .map(row => ({
      path: row.path,
      role: row.role || 'source input',
      action: row.action || '',
      currentExists: Boolean(row.currentExists),
      headExists: Boolean(row.headExists),
      originExists: Boolean(row.originExists),
      gitStatus: row.gitStatus || statusForDirtyPath(dirtyRows, row.path),
      stageable: Boolean(row.currentExists),
      stageReason: row.currentExists
        ? (row.headExists ? 'update tracked source' : 'add current source')
        : 'review missing current file before staging',
    }))
  const stageablePaths = stageCandidates
    .filter(row => row.stageable)
    .map(row => row.path)
  const holdByDefault = dirtyRows
    .filter(row => !recommendedPathSet.has(row.path))
    .map(row => ({
      path: row.path,
      status: row.status,
      index: row.index,
      worktree: row.worktree,
      disposition: row.disposition,
    }))
  const commandDrift = bundle?.commandDrift || []
  const promotionReview = buildPromotionReview({
    repoDir,
    stageCandidates,
    contentComparisons,
    reviewDecisions: decisions,
  })
  const stagingGate = buildStagingGate({
    stageablePaths,
    stageCandidates,
    promotionReview,
  })
  const stagedBundle = buildStagedBundleAttestation({
    gitStatusRows,
    stageablePaths,
    holdByDefault,
    stagingGate,
    promotionReview,
  })
  const status = bundle?.status || 'yellow'
  const commandCounts = {
    commandDrift: commandDrift.length,
    stageCandidates: stageCandidates.length,
    stageablePaths: stageablePaths.length,
    stageBlockedPaths: stagingGate.blockedPaths.length,
    stageNonRedPaths: stagingGate.nonRedStageablePaths.length,
    stagedPaths: stagedBundle.stagedPaths.length,
    stagedStageablePaths: stagedBundle.stagedStageablePaths.length,
    unstagedStageablePaths: stagedBundle.unstagedStageablePaths.length,
    unexpectedStagedPaths: stagedBundle.unexpectedStagedPaths.length,
    dirtyAfterStagingPaths: stagedBundle.dirtyAfterStagingPaths.length,
    holdByDefault: holdByDefault.length,
    dirtyFiles: dirtyRows.length,
    reconciliationRed: promotionReview.counts.red,
    reconciliationYellow: promotionReview.counts.yellow,
    upstreamPresent: promotionReview.counts.upstreamPresent,
  }
  const commands = {
    inspectStatus: bundle?.commands?.inspectStatus || 'git status --short',
    inspectDiff: bundle?.commands?.inspectDiff || 'git diff',
    inspectOriginDiff: stageablePaths.length > 0 ? `git diff origin/main -- ${shellQuotePaths(stageablePaths)}` : '',
    inspectUntracked: bundle?.commands?.inspectUntracked || 'git ls-files --others --exclude-standard',
    stageExactBundle: stagingGate.fullStageCommand,
    stageNonRedCandidates: stagingGate.nonRedStageCommand,
    reviewStaged: 'git diff --cached --stat && git diff --cached --check',
    verifyStagedExactBundle: 'npm run source:promotion-packet && git diff --cached --name-status && git diff --cached --check',
    unstageExactBundle: stageablePaths.length > 0 ? `git restore --staged -- ${shellQuotePaths(stageablePaths)}` : '',
    cleanProofAfterPromotion: bundle?.commands?.cleanProofAfterPromotion || '',
  }
  const blockers = buildBlockers({ report, bundle, stageCandidates, holdByDefault, dirtyPathSet, promotionReview, stagingGate, stagedBundle })
  const headline = [
    `status=${status}`,
    `stage candidates ${stageCandidates.length}`,
    `hold by default ${holdByDefault.length}`,
    `command drift ${commandDrift.length}`,
    `cockpit=${report?.verdict?.label || 'unknown'}`,
  ].join('; ')

  return {
    generatedAt,
    outputPath,
    markdownPath,
    status,
    repo: {
      name: report?.repo?.name || path.basename(repoDir || ''),
      path: repoDir || report?.repo?.path || null,
      git: report?.repo?.git || null,
    },
    summary: {
      headline,
      nextAction: status === 'green'
        ? 'Run the clean worktree FirstBite proof and attach the report.'
        : 'Review only the stage candidates, keep hold-by-default rows unstaged, then rerun clean worktree FirstBite proof after the bundle lands.',
      counts: commandCounts,
    },
    sourcePromotionBundle: bundle ? {
      status: bundle.status,
      summary: bundle.summary,
      nextAction: bundle.nextAction,
      counts: bundle.counts || {},
    } : null,
    stageCandidates,
    promotionReview,
    reviewDecisions: decisions ? {
      path: REVIEW_DECISIONS_PATH,
      version: decisions.version || null,
      count: normalizedReviewDecisions(decisions).length,
    } : null,
    stagingGate,
    stagedBundle,
    holdByDefault,
    commandDrift,
    commands,
    blockers,
    trustContracts: (report?.trustModel?.contracts || []).map(contract => ({
      gate: contract.gate,
      status: contract.status,
      current: contract.current,
      nextAction: contract.nextAction,
    })),
  }
}

function buildBlockers({ report, bundle, stageCandidates, holdByDefault, dirtyPathSet, promotionReview, stagingGate, stagedBundle }) {
  const blockers = []

  if (!bundle) {
    blockers.push({
      status: 'red',
      area: 'source promotion bundle',
      detail: 'The cockpit did not build a Source Promotion Bundle.',
    })
  } else if (bundle.status !== 'green') {
    blockers.push({
      status: bundle.status,
      area: 'source promotion bundle',
      detail: bundle.summary,
    })
  }

  const missingCurrent = stageCandidates.filter(row => !row.currentExists)
  if (missingCurrent.length > 0) {
    blockers.push({
      status: 'red',
      area: 'stage candidates',
      detail: `${missingCurrent.length} stage candidate(s) are missing from the current checkout.`,
    })
  }

  const nonBundleDirty = holdByDefault.filter(row => !row.path.startsWith('reports/'))
  if (nonBundleDirty.length > 0) {
    blockers.push({
      status: 'yellow',
      area: 'hold-by-default files',
      detail: `${nonBundleDirty.length} dirty file(s) are outside the source-promotion bundle and should stay out unless separately reviewed.`,
    })
  }

  if ((report?.repo?.git?.behindOriginMain || 0) > 0) {
    blockers.push({
      status: 'yellow',
      area: 'checkout freshness',
      detail: `Primary checkout is behind origin/main by ${report.repo.git.behindOriginMain} commit(s).`,
    })
  }

  if (report?.telemetry?.status && report.telemetry.status !== 'green') {
    blockers.push({
      status: report.telemetry.status,
      area: 'OTEL/Grafana',
      detail: report.telemetry.summary,
    })
  }

  if (report?.agentState?.nurseLog?.releaseReadiness === 'yellow') {
    blockers.push({
      status: 'yellow',
      area: 'release history',
      detail: report.agentState.nurseLog.releaseHistoryEvidence || 'Strict release-history readiness remains yellow.',
    })
  }

  if (dirtyPathSet.has('.gitignore')) {
    blockers.push({
      status: 'yellow',
      area: 'gitignore review',
      detail: '.gitignore is dirty and is not part of the default source-promotion bundle.',
    })
  }

  if (promotionReview?.status && promotionReview.status !== 'green') {
    blockers.push({
      status: promotionReview.status,
      area: 'candidate reconciliation',
      detail: promotionReview.summary,
    })
  }

  if (stagingGate?.fullStageBlocked) {
    blockers.push({
      status: 'red',
      area: 'staging gate',
      detail: stagingGate.summary,
    })
  }

  if (stagedBundle?.status === 'red') {
    blockers.push({
      status: 'red',
      area: 'staged bundle attestation',
      detail: stagedBundle.summary,
    })
  } else if (stagedBundle?.status === 'yellow') {
    blockers.push({
      status: 'yellow',
      area: 'staged bundle attestation',
      detail: stagedBundle.summary,
    })
  }

  return blockers
}

function buildStagingGate({ stageablePaths = [], stageCandidates = [], promotionReview = null } = {}) {
  const blockedRows = (promotionReview?.rows || []).filter(row => row.status === 'red')
  const blockedPathSet = new Set(blockedRows.map(row => row.path))
  const indexSourcedPathSet = new Set((promotionReview?.rows || [])
    .filter(row => row.status !== 'red' && row.comparisonSource === 'index')
    .map(row => row.path))
  const nonRedStageablePaths = stageCandidates
    .filter(row => row.stageable && !blockedPathSet.has(row.path))
    .map(row => row.path)
  const commandStageablePaths = nonRedStageablePaths
    .filter(relPath => !indexSourcedPathSet.has(relPath))
  const fullStageBlocked = blockedRows.length > 0
  const fullStageCommand = !fullStageBlocked && commandStageablePaths.length > 0
    ? `git add -- ${shellQuotePaths(commandStageablePaths)}`
    : fullStageBlocked
      ? `BLOCKED: resolve ${blockedRows.length} red candidate(s) before staging the full bundle`
      : ''
  const nonRedStageCommand = commandStageablePaths.length > 0
    ? `git add -- ${shellQuotePaths(commandStageablePaths)}`
    : ''
  const summary = fullStageBlocked
    ? `Full bundle staging is blocked by ${blockedRows.length} red upstream-drift candidate(s); ${nonRedStageablePaths.length} non-red candidate(s) remain available for separate review-only staging.`
    : stageablePaths.length > 0
      ? `Full bundle staging is available after reviewing ${stageablePaths.length} non-red candidate(s).`
      : 'No stageable source-promotion candidates are available.'

  return {
    status: fullStageBlocked ? 'red' : nonRedStageablePaths.length > 0 ? 'yellow' : 'green',
    fullStageBlocked,
    summary,
    nextAction: fullStageBlocked
      ? 'Run the red-row review commands, decide current-vs-origin content, then regenerate this packet before staging the full bundle.'
      : 'Review the candidate diffs, stage the bundle, then run cached diff checks and clean FirstBite proof.',
    fullStageCommand,
    nonRedStageCommand,
    blockedPaths: blockedRows.map(row => row.path),
    blockedRows: blockedRows.map(row => ({
      path: row.path,
      classification: row.classification,
      reviewCommand: row.reviewCommand,
      action: row.action,
      lineDeltaVsOrigin: row.lineDeltaVsOrigin,
    })),
    nonRedStageablePaths,
    commandStageablePaths,
    indexSourcedPaths: [...indexSourcedPathSet],
  }
}

function buildStagedBundleAttestation({
  gitStatusRows = [],
  stageablePaths = [],
  holdByDefault = [],
  stagingGate = null,
  promotionReview = null,
} = {}) {
  const stageableSet = new Set(stageablePaths)
  const holdByDefaultSet = new Set((holdByDefault || []).map(row => row.path))
  const indexSourcedPathSet = new Set((promotionReview?.rows || [])
    .filter(row => row.status !== 'red' && row.comparisonSource === 'index')
    .map(row => row.path))
  const stagedRows = (gitStatusRows || []).filter(row => isPathStaged(row))
  const stagedPaths = uniqueSorted(stagedRows.map(row => row.path))
  const stagedStageablePaths = stagedPaths.filter(relPath => stageableSet.has(relPath))
  const unstagedStageablePaths = stageablePaths.filter(relPath => !stagedPaths.includes(relPath))
  const unexpectedStagedPaths = stagedPaths.filter(relPath => !stageableSet.has(relPath))
  const stagedHoldByDefaultPaths = stagedPaths.filter(relPath => holdByDefaultSet.has(relPath))
  const dirtyAfterStagingRows = stagedRows
    .filter(row => stageableSet.has(row.path) && isWorktreeDirtyAfterStaging(row))
  const ignoredDirtyAfterStagingPaths = dirtyAfterStagingRows
    .filter(row => indexSourcedPathSet.has(row.path))
    .map(row => row.path)
  const dirtyAfterStagingPaths = dirtyAfterStagingRows
    .filter(row => !indexSourcedPathSet.has(row.path))
    .map(row => row.path)

  const fullStageBlocked = Boolean(stagingGate?.fullStageBlocked)
  const exactMatch = !fullStageBlocked
    && stagedStageablePaths.length === stageablePaths.length
    && unstagedStageablePaths.length === 0
    && unexpectedStagedPaths.length === 0
    && dirtyAfterStagingPaths.length === 0

  const status = fullStageBlocked || unexpectedStagedPaths.length > 0 || dirtyAfterStagingPaths.length > 0
    ? 'red'
    : exactMatch
      ? 'green'
      : stagedPaths.length > 0 || stageablePaths.length > 0
        ? 'yellow'
        : 'green'
  const summary = summarizeStagedBundle({
    exactMatch,
    fullStageBlocked,
    stageableCount: stageablePaths.length,
    stagedStageableCount: stagedStageablePaths.length,
    unstagedStageableCount: unstagedStageablePaths.length,
    unexpectedStagedCount: unexpectedStagedPaths.length,
    dirtyAfterStagingCount: dirtyAfterStagingPaths.length,
    ignoredDirtyAfterStagingCount: ignoredDirtyAfterStagingPaths.length,
  })
  const nextAction = exactMatch
    ? (stageablePaths.length > 0
      ? 'Run cached diff checks, commit or land this exact bundle, then run clean worktree FirstBite proof.'
      : 'No source-promotion staging is required; run clean worktree FirstBite proof.')
    : fullStageBlocked
      ? 'Resolve red staging-gate rows before trusting anything currently staged.'
      : unexpectedStagedPaths.length > 0 || dirtyAfterStagingPaths.length > 0
        ? 'Unstage unexpected paths or restage dirty-after-staging paths until the index exactly matches the reviewed bundle.'
        : 'Stage every stageable source-promotion candidate, then rerun this packet before clean proof.'

  return {
    status,
    exactMatch,
    summary,
    nextAction,
    stageableCount: stageablePaths.length,
    stagedCount: stagedPaths.length,
    stagedStageableCount: stagedStageablePaths.length,
    unstagedStageableCount: unstagedStageablePaths.length,
    unexpectedStagedCount: unexpectedStagedPaths.length,
    dirtyAfterStagingCount: dirtyAfterStagingPaths.length,
    ignoredDirtyAfterStagingCount: ignoredDirtyAfterStagingPaths.length,
    stagedPaths,
    stagedStageablePaths,
    unstagedStageablePaths,
    unexpectedStagedPaths,
    stagedHoldByDefaultPaths,
    dirtyAfterStagingPaths,
    ignoredDirtyAfterStagingPaths,
  }
}

function summarizeStagedBundle({
  exactMatch,
  fullStageBlocked,
  stageableCount,
  stagedStageableCount,
  unstagedStageableCount,
  unexpectedStagedCount,
  dirtyAfterStagingCount,
  ignoredDirtyAfterStagingCount = 0,
}) {
  if (fullStageBlocked) {
    return 'Index attestation is red because the full staging gate is blocked.'
  }
  if (exactMatch) {
    if (stageableCount === 0) {
      return 'No source-promotion stage candidates remain; no unexpected staged paths and no dirty-after-staging files.'
    }
    const ignored = ignoredDirtyAfterStagingCount > 0
      ? `; ${ignoredDirtyAfterStagingCount} unstaged path(s) intentionally held outside the staged bundle`
      : ''
    return `Exact source-promotion bundle is staged (${stagedStageableCount}/${stageableCount}); no unexpected staged paths and no dirty-after-staging files${ignored}.`
  }
  return [
    `${stagedStageableCount}/${stageableCount} stage candidate(s) staged`,
    `${unstagedStageableCount} unstaged candidate(s)`,
    `${unexpectedStagedCount} unexpected staged path(s)`,
    `${dirtyAfterStagingCount} dirty-after-staging path(s)`,
  ].join('; ')
}

function buildPromotionReview({ repoDir, stageCandidates = [], contentComparisons = null, reviewDecisions = null } = {}) {
  const decisionsByPath = new Map(normalizedReviewDecisions(reviewDecisions).map(decision => [decision.path, decision]))
  const rows = stageCandidates.map(candidate => {
    const comparison = contentComparisons && Object.prototype.hasOwnProperty.call(contentComparisons, candidate.path)
      ? contentComparisons[candidate.path]
      : compareCandidateContent(repoDir, candidate.path, {
        source: shouldCompareIndexContent(candidate) ? 'index' : 'worktree',
      })
    return classifyPromotionCandidate(candidate, comparison, {
      reviewDecision: decisionsByPath.get(candidate.path) || null,
    })
  })
  const counts = {
    total: rows.length,
    red: rows.filter(row => row.status === 'red').length,
    yellow: rows.filter(row => row.status === 'yellow').length,
    green: rows.filter(row => row.status === 'green').length,
    upstreamPresent: rows.filter(row => row.classification.startsWith('origin-present')).length,
    upstreamDrift: rows.filter(row => row.classification.includes('origin-drift')).length,
    newLocalOnly: rows.filter(row => row.classification === 'new-local-only').length,
    modifiedTracked: rows.filter(row => row.classification.startsWith('modified-tracked')).length,
  }
  const status = counts.red > 0 ? 'red' : counts.yellow > 0 ? 'yellow' : 'green'
  const summary = rows.length === 0
    ? 'No stage candidates require reconciliation.'
    : [
      `${counts.total} candidate(s) reviewed`,
      `${counts.upstreamPresent} already present on origin/main`,
      `${counts.upstreamDrift} origin drift row(s)`,
      `${counts.newLocalOnly} new local-only file(s)`,
      `${counts.modifiedTracked} modified tracked file(s)`,
    ].join('; ')

  return { status, summary, counts, rows }
}

function classifyPromotionCandidate(candidate, comparison = {}, { reviewDecision = null } = {}) {
  const currentHash = comparison?.currentHash || null
  const headHash = comparison?.headHash || null
  const originHash = comparison?.originHash || null
  const comparisonSource = comparison?.source || 'worktree'
  const currentMatchesHead = Boolean(currentHash && headHash && currentHash === headHash)
  const currentMatchesOrigin = Boolean(currentHash && originHash && currentHash === originHash)
  const headMatchesOrigin = Boolean(headHash && originHash && headHash === originHash)

  if (!candidate.currentExists) {
    return applyReviewDecision(promotionCandidateRow(candidate, comparison, {
      status: 'red',
      classification: 'missing-current',
      action: 'Do not stage; recreate the file or remove it from the bundle before clean proof.',
    }), reviewDecision)
  }

  if (isReviewDecisionManifestPath(candidate.path) && candidate.originExists && !currentMatchesOrigin) {
    return promotionCandidateRow(candidate, comparison, {
      status: 'yellow',
      classification: 'review-decision-manifest-update',
      action: 'Review decision manifest changed; keep it stageable but do not require a self-referential hash decision.',
    })
  }

  if (!candidate.headExists && candidate.originExists) {
    if (currentMatchesOrigin) {
      return applyReviewDecision(promotionCandidateRow(candidate, comparison, {
        status: 'yellow',
        classification: 'origin-present-match',
        action: 'Prefer reconciling the behind checkout with origin/main; current content matches upstream.',
      }), reviewDecision)
    }
    if (originHash) {
      return applyReviewDecision(promotionCandidateRow(candidate, comparison, {
        status: 'red',
        classification: 'origin-present-origin-drift',
        action: 'Review current content against origin/main before staging; upstream already has a different blob.',
      }), reviewDecision)
    }
    return applyReviewDecision(promotionCandidateRow(candidate, comparison, {
      status: 'yellow',
      classification: 'origin-present-unverified',
      action: 'Compare this current file against origin/main before staging.',
    }), reviewDecision)
  }

  if (!candidate.headExists && !candidate.originExists) {
    return applyReviewDecision(promotionCandidateRow(candidate, comparison, {
      status: 'yellow',
      classification: 'new-local-only',
      action: 'Review as an additive new control-plane path; stage only with the exact bundle.',
    }), reviewDecision)
  }

  if (candidate.headExists && candidate.originExists) {
    if (comparisonSource === 'index' && currentMatchesOrigin && candidate.gitStatus) {
      return applyReviewDecision(promotionCandidateRow(candidate, comparison, {
        status: 'yellow',
        classification: 'modified-tracked-index-origin-match',
        action: 'Staged package contract matches origin/main; keep unstaged worktree drift outside this source-promotion bundle.',
      }), reviewDecision)
    }
    if (!headMatchesOrigin && originHash && !currentMatchesOrigin) {
      return applyReviewDecision(promotionCandidateRow(candidate, comparison, {
        status: 'red',
        classification: 'modified-tracked-origin-drift',
        action: 'Diff against both HEAD and origin/main before staging; branch drift and local edits overlap.',
      }), reviewDecision)
    }
    if (candidate.gitStatus && !currentMatchesHead) {
      return applyReviewDecision(promotionCandidateRow(candidate, comparison, {
        status: 'yellow',
        classification: 'modified-tracked',
        action: 'Review the working-tree diff before staging this tracked file.',
      }), reviewDecision)
    }
    return applyReviewDecision(promotionCandidateRow(candidate, comparison, {
      status: 'green',
      classification: 'tracked-match',
      action: 'No reconciliation issue detected.',
    }), reviewDecision)
  }

  return applyReviewDecision(promotionCandidateRow(candidate, comparison, {
    status: 'yellow',
    classification: 'head-only-or-unverified',
    action: 'Review tracking state before staging.',
  }), reviewDecision)
}

function isReviewDecisionManifestPath(relPath) {
  return relPath === REVIEW_DECISIONS_PATH
}

function shouldCompareIndexContent(candidate) {
  return candidate?.path === 'package.json'
    && String(candidate?.gitStatus || '').startsWith('MM ')
}

function promotionCandidateRow(candidate, comparison, { status, classification, action }) {
  const currentLines = nullishNumber(comparison?.currentLines)
  const headLines = nullishNumber(comparison?.headLines)
  const originLines = nullishNumber(comparison?.originLines)

  return {
    path: candidate.path,
    status,
    classification,
    gitStatus: candidate.gitStatus || '',
    currentExists: Boolean(candidate.currentExists),
    headExists: Boolean(candidate.headExists),
    originExists: Boolean(candidate.originExists),
    currentHash: comparison?.currentHash || null,
    headHash: comparison?.headHash || null,
    originHash: comparison?.originHash || null,
    comparisonSource: comparison?.source || 'worktree',
    currentLines,
    headLines,
    originLines,
    lineDeltaVsHead: currentLines !== null && headLines !== null ? currentLines - headLines : null,
    lineDeltaVsOrigin: currentLines !== null && originLines !== null ? currentLines - originLines : null,
    reviewCommand: reviewCommandForCandidate(candidate, classification),
    reviewDecision: null,
    action,
  }
}

function applyReviewDecision(row, decision) {
  if (!decision) {
    return row
  }

  const decisionSummary = {
    status: 'mismatch',
    decision: decision.decision || 'unknown',
    reason: decision.reason || '',
    evidence: decision.evidence || [],
    currentHash: decision.currentHash || null,
    originHash: decision.originHash || null,
  }
  const hashMatches = decision.currentHash === row.currentHash && decision.originHash === row.originHash
  const acceptsCurrent = decision.decision === 'accept-current'

  if (hashMatches && acceptsCurrent && row.status === 'red' && row.classification.includes('origin-drift')) {
    return {
      ...row,
      status: 'yellow',
      classification: `${row.classification}-reviewed`,
      reviewDecision: {
        ...decisionSummary,
        status: 'accepted',
      },
      action: `Hash-locked review accepts current over origin/main: ${decision.reason || 'see review decision manifest'}`,
    }
  }

  return {
    ...row,
    reviewDecision: {
      ...decisionSummary,
      status: hashMatches ? 'unused' : 'mismatch',
    },
  }
}

function loadReviewDecisions(repoDir) {
  if (!repoDir) {
    return null
  }
  const filePath = path.join(repoDir, REVIEW_DECISIONS_PATH)
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function normalizedReviewDecisions(reviewDecisions) {
  const decisions = Array.isArray(reviewDecisions?.decisions)
    ? reviewDecisions.decisions
    : Array.isArray(reviewDecisions)
      ? reviewDecisions
      : []

  return decisions
    .filter(decision => decision && typeof decision.path === 'string')
    .map(decision => ({
      path: decision.path,
      decision: decision.decision || '',
      reason: decision.reason || '',
      evidence: Array.isArray(decision.evidence) ? decision.evidence : [],
      currentHash: decision.currentHash || null,
      originHash: decision.originHash || null,
    }))
}

function compareCandidateContent(repoDir, relPath, { source = 'worktree' } = {}) {
  const current = source === 'index'
    ? gitIndexBlobInfo(repoDir, relPath)
    : currentFileInfo(repoDir, relPath)
  const head = gitBlobInfo(repoDir, 'HEAD', relPath)
  const origin = gitBlobInfo(repoDir, 'origin/main', relPath)

  return {
    source,
    currentHash: current.hash,
    headHash: head.hash,
    originHash: origin.hash,
    currentLines: current.lines,
    headLines: head.lines,
    originLines: origin.lines,
    currentBytes: current.bytes,
    headBytes: head.bytes,
    originBytes: origin.bytes,
  }
}

function reviewCommandForCandidate(candidate, classification) {
  const quotedPath = shellQuotePath(candidate.path)
  if (classification === 'origin-present-origin-drift' || classification === 'origin-present-match') {
    return [
      'tmp=$(mktemp);',
      `git show ${shellQuotePath(`origin/main:${candidate.path}`)} > "$tmp" &&`,
      `git diff --no-index "$tmp" ${quotedPath};`,
      'rc=$?;',
      'rm -f "$tmp";',
      'exit $rc',
    ].join(' ')
  }
  if (classification === 'modified-tracked-origin-drift') {
    return `git diff -- ${quotedPath} && git diff origin/main -- ${quotedPath}`
  }
  if (classification === 'modified-tracked-index-origin-match') {
    return `git diff --cached -- ${quotedPath} && git diff -- ${quotedPath}`
  }
  if (classification === 'modified-tracked') {
    return `git diff -- ${quotedPath}`
  }
  if (classification === 'new-local-only') {
    return `git diff --no-index /dev/null ${quotedPath}`
  }
  return `git status --short -- ${quotedPath}`
}

function currentFileInfo(repoDir, relPath) {
  try {
    return contentInfo(fs.readFileSync(path.join(repoDir || '', relPath)))
  } catch {
    return emptyContentInfo()
  }
}

function gitBlobInfo(repoDir, ref, relPath) {
  try {
    return contentInfo(execFileSync('git', ['show', `${ref}:${relPath}`], {
      cwd: repoDir,
      stdio: ['ignore', 'pipe', 'ignore'],
    }))
  } catch {
    return emptyContentInfo()
  }
}

function gitIndexBlobInfo(repoDir, relPath) {
  try {
    return contentInfo(execFileSync('git', ['show', `:${relPath}`], {
      cwd: repoDir,
      stdio: ['ignore', 'pipe', 'ignore'],
    }))
  } catch {
    return currentFileInfo(repoDir, relPath)
  }
}

function contentInfo(buffer) {
  const text = buffer.toString('utf8')
  return {
    hash: crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 12),
    bytes: buffer.length,
    lines: countLines(text),
  }
}

function emptyContentInfo() {
  return {
    hash: null,
    bytes: null,
    lines: null,
  }
}

function countLines(text) {
  if (text.length === 0) {
    return 0
  }
  const breaks = text.match(/\n/g)
  const breakCount = breaks ? breaks.length : 0
  return text.endsWith('\n') ? breakCount : breakCount + 1
}

function nullishNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function classifyDirtyPath(relPath, { inPromotionBundle, recommended } = {}) {
  if (recommended) {
    return 'stage candidate'
  }
  if (inPromotionBundle) {
    return 'promotion bundle path, not recommended for staging'
  }
  if (relPath.startsWith('.agent-ledger/')) {
    return 'agent ledger evidence; hold by default'
  }
  if (relPath.startsWith('.agents/')) {
    return 'agent local state; hold by default'
  }
  if (relPath.startsWith('.cursor/plans/')) {
    return 'plan checkpoint; review separately'
  }
  if (relPath === 'INBOX.md' || relPath === 'RUNBOOK.md' || relPath === 'README.md') {
    return 'operator doc or queue file; review separately'
  }
  if (relPath === '.gitignore') {
    return 'ignore-rule change; review separately'
  }
  if (relPath === 'wrangler.jsonc') {
    return 'Cloudflare config; review separately'
  }
  if (relPath.startsWith('snapshot-archive/')) {
    return 'snapshot archive data; hold by default'
  }
  return 'outside source-promotion packet; hold by default'
}

function statusForDirtyPath(rows, relPath) {
  return rows.find(row => row.path === relPath)?.status || ''
}

function readGitStatusRows(repoDir) {
  try {
    return parseGitStatus(execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }))
  } catch {
    return []
  }
}

function parseGitStatus(text) {
  return String(text || '')
    .split('\n')
    .filter(Boolean)
    .map(parseGitStatusLine)
}

function parseGitStatusLine(line) {
  const index = line[0] === ' ' ? '.' : line[0]
  const worktree = line[1] === ' ' ? '.' : line[1]
  const rawPath = line.slice(3)
  const relPath = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop() : rawPath

  return {
    raw: line,
    status: line.slice(0, 2).trim() || 'clean',
    index,
    worktree,
    path: relPath,
  }
}

function isPathStaged(row) {
  return Boolean(row && row.index && row.index !== '.' && row.index !== '?' && row.index !== '!')
}

function isWorktreeDirtyAfterStaging(row) {
  return Boolean(row && row.worktree && row.worktree !== '.' && row.worktree !== '?' && row.worktree !== '!')
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort()
}

function renderMarkdown(packet) {
  const lines = [
    '# Resplit FX Source Promotion Packet',
    '',
    `- Generated: ${packet.generatedAt}`,
    `- Status: ${packet.status}`,
    `- Repo: ${packet.repo?.path || 'unknown'}`,
    `- Head: ${packet.repo?.git?.head || 'unknown'}`,
    `- origin/main: ${packet.repo?.git?.originMain || 'unknown'}`,
    `- Summary: ${packet.summary?.headline || ''}`,
    `- Next action: ${packet.summary?.nextAction || ''}`,
    '',
    '## Commands',
    '',
    '| Step | Command |',
    '|---|---|',
    ...Object.entries(packet.commands || {}).map(([name, command]) => `| ${escapeMarkdown(name)} | \`${escapeMarkdown(command || 'n/a')}\` |`),
    '',
    '## Staging Gate',
    '',
    `Status: ${packet.stagingGate?.status || 'unknown'} — ${packet.stagingGate?.summary || ''}`,
    '',
    '| Field | Value |',
    '|---|---|',
    `| fullStageBlocked | ${packet.stagingGate?.fullStageBlocked ? 'yes' : 'no'} |`,
    `| fullStageCommand | \`${escapeMarkdown(packet.stagingGate?.fullStageCommand || 'n/a')}\` |`,
    `| stageNonRedCandidates | \`${escapeMarkdown(packet.stagingGate?.nonRedStageCommand || 'n/a')}\` |`,
    `| nextAction | ${escapeMarkdown(packet.stagingGate?.nextAction || '')} |`,
    '',
    '## Staged Bundle Attestation',
    '',
    `Status: ${packet.stagedBundle?.status || 'unknown'} — ${packet.stagedBundle?.summary || ''}`,
    '',
    '| Field | Value |',
    '|---|---|',
    `| exactMatch | ${packet.stagedBundle?.exactMatch ? 'yes' : 'no'} |`,
    `| stagedStageable | ${escapeMarkdown(`${packet.stagedBundle?.stagedStageableCount ?? 0}/${packet.stagedBundle?.stageableCount ?? 0}`)} |`,
    `| unexpectedStaged | ${escapeMarkdown(String(packet.stagedBundle?.unexpectedStagedCount ?? 0))} |`,
    `| dirtyAfterStaging | ${escapeMarkdown(String(packet.stagedBundle?.dirtyAfterStagingCount ?? 0))} |`,
    `| nextAction | ${escapeMarkdown(packet.stagedBundle?.nextAction || '')} |`,
    '',
    '| Category | Paths |',
    '|---|---|',
    `| staged candidate paths | ${codeList(packet.stagedBundle?.stagedStageablePaths)} |`,
    `| unstaged candidate paths | ${codeList(packet.stagedBundle?.unstagedStageablePaths)} |`,
    `| unexpected staged paths | ${codeList(packet.stagedBundle?.unexpectedStagedPaths)} |`,
    `| dirty after staging paths | ${codeList(packet.stagedBundle?.dirtyAfterStagingPaths)} |`,
    '',
    '| Blocked path | Classification | Δ origin | Review command |',
    '|---|---|---:|---|',
    ...tableOrEmpty(packet.stagingGate?.blockedRows, 4, row => [
      code(row.path),
      code(row.classification),
      escapeMarkdown(formatDelta(row.lineDeltaVsOrigin)),
      code(row.reviewCommand || ''),
    ]),
    '',
    '## Stage Candidates',
    '',
    '| Path | Role | Git | Current | HEAD | origin/main | Action |',
    '|---|---|---:|---:|---:|---:|---|',
    ...tableOrEmpty(packet.stageCandidates, 7, row => [
      code(row.path),
      escapeMarkdown(row.role),
      code(row.gitStatus || 'clean'),
      row.currentExists ? 'present' : 'missing',
      row.headExists ? 'tracked' : 'missing',
      row.originExists ? 'tracked' : 'missing',
      escapeMarkdown(row.action),
    ]),
    '',
    '## Candidate Reconciliation',
    '',
    `Status: ${packet.promotionReview?.status || 'unknown'} — ${packet.promotionReview?.summary || ''}`,
    '',
    '| Path | Status | Classification | Current | HEAD | origin/main | Δ HEAD | Δ origin | Decision | Review command | Action |',
    '|---|---:|---|---:|---:|---:|---:|---:|---|---|---|',
    ...tableOrEmpty(packet.promotionReview?.rows, 11, row => [
      code(row.path),
      escapeMarkdown(row.status),
      code(row.classification),
      code(formatHashLines(row.currentHash, row.currentLines)),
      code(formatHashLines(row.headHash, row.headLines)),
      code(formatHashLines(row.originHash, row.originLines)),
      escapeMarkdown(formatDelta(row.lineDeltaVsHead)),
      escapeMarkdown(formatDelta(row.lineDeltaVsOrigin)),
      code(formatReviewDecision(row.reviewDecision)),
      code(row.reviewCommand || ''),
      escapeMarkdown(row.action),
    ]),
    '',
    '## Hold By Default',
    '',
    '| Path | Status | Disposition |',
    '|---|---:|---|',
    ...tableOrEmpty(packet.holdByDefault, 3, row => [
      code(row.path),
      code(row.status),
      escapeMarkdown(row.disposition),
    ]),
    '',
    '## Command Drift',
    '',
    '| Name | Kind | Status | Current | HEAD | origin/main |',
    '|---|---|---:|---|---|---|',
    ...tableOrEmpty(packet.commandDrift, 6, row => [
      code(row.name || 'unknown'),
      escapeMarkdown(row.kind || ''),
      escapeMarkdown(row.status || 'unknown'),
      code(row.current || 'missing'),
      code(row.head || 'missing'),
      code(row.origin || 'missing'),
    ]),
    '',
    '## Blockers',
    '',
    '| Area | Status | Detail |',
    '|---|---:|---|',
    ...tableOrEmpty(packet.blockers, 3, row => [
      escapeMarkdown(row.area),
      escapeMarkdown(row.status),
      escapeMarkdown(row.detail),
    ]),
    '',
  ]

  return `${lines.join('\n')}\n`
}

function tableOrEmpty(rows, colspan, mapper) {
  if (!rows || rows.length === 0) {
    return [`| ${Array.from({ length: colspan }, (_, index) => (index === 0 ? 'none' : '')).join(' | ')} |`]
  }
  return rows.map(row => `| ${mapper(row).join(' | ')} |`)
}

function code(value) {
  return `\`${escapeMarkdown(value || '')}\``
}

function codeList(values) {
  const rows = Array.isArray(values) ? values.filter(Boolean) : []
  return rows.length > 0 ? rows.map(value => code(value)).join(', ') : 'none'
}

function formatHashLines(hash, lines) {
  if (!hash) {
    return 'missing'
  }
  return `${hash} / ${lines === null || lines === undefined ? '?' : lines}l`
}

function formatDelta(delta) {
  if (delta === null || delta === undefined) {
    return 'n/a'
  }
  return delta > 0 ? `+${delta}` : String(delta)
}

function formatReviewDecision(decision) {
  if (!decision) {
    return 'none'
  }
  return `${decision.status || 'unknown'}:${decision.decision || 'unknown'}`
}

function escapeMarkdown(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function shellQuotePath(relPath) {
  return `'${String(relPath).replace(/'/g, "'\\''")}'`
}

function shellQuotePaths(paths) {
  return paths.map(shellQuotePath).join(' ')
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, value)
}

module.exports = {
  PACKET_BASENAME,
  REVIEW_DECISIONS_PATH,
  buildPacket,
  buildPromotionReview,
  classifyPromotionCandidate,
  classifyDirtyPath,
  main,
  parseArgs,
  parseGitStatus,
  renderMarkdown,
}
