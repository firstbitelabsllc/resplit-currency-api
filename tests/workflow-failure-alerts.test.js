const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'run.yml')
const workflow = fs.readFileSync(workflowPath, 'utf8')

// Every step that can fail a scheduled publish in a way an operator must act on
// needs a dedicated Sentry issue signal. The terminal check-in only says "the run
// went red"; these signals say WHERE.
const failureReportCoverage = [
  {
    stepId: 'retry_generate',
    stepName: 'Retry if failed',
    reportName: 'Report generation retry failure to Sentry',
    signal: 'generation_retry_failure'
  },
  {
    stepId: 'deploy_cloudflare',
    stepName: 'Deploy to Cloudflare Pages',
    reportName: 'Report Cloudflare deploy failure to Sentry',
    signal: 'cloudflare_deploy_failure'
  },
  {
    stepId: 'worker_release_test_gate',
    stepName: 'Gate the FX Worker release on its test suites',
    reportName: 'Report FX Worker test-gate failure to Sentry',
    signal: 'fx_worker_test_gate_failure'
  },
  {
    stepId: 'deploy_fx_worker',
    stepName: 'Deploy FX Worker',
    reportName: 'Report FX Worker deploy failure to Sentry',
    signal: 'fx_worker_deploy_failure'
  },
  {
    stepId: 'stamp_fx_worker_release',
    stepName: 'Stamp deployed FX Worker release',
    reportName: 'Report FX Worker release stamp failure to Sentry',
    signal: 'fx_worker_release_stamp_failure'
  },
  {
    stepId: 'deploy_github_pages',
    stepName: 'Deploy to GitHub Pages',
    reportName: 'Report GitHub Pages deploy failure to Sentry',
    signal: 'github_pages_deploy_failure'
  },
  {
    stepId: 'smoke_check',
    stepName: 'Smoke check deployed endpoints',
    reportName: 'Report smoke check failure to Sentry',
    signal: 'smoke_check_failure'
  }
]

function stepBlock(source, stepName) {
  const marker = `      - name: ${stepName}`
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, `missing workflow step: ${stepName}`)
  const next = source.indexOf('\n      - name: ', start + marker.length)
  return source.slice(start, next === -1 ? source.length : next)
}

function listSteps(source) {
  return source
    .split('\n      - name: ')
    .slice(1)
    .map((block) => ({
      name: block.slice(0, block.indexOf('\n')),
      id: block.match(/\n\s*id:\s*([A-Za-z0-9_]+)/)?.[1] || null,
      block
    }))
}

function assertFailureReportCoverage(source) {
  for (const { stepId, stepName, reportName, signal } of failureReportCoverage) {
    const guarded = stepBlock(source, stepName)
    assert.match(
      guarded,
      new RegExp(`\\n\\s*id: ${stepId}\\b`),
      `${stepName} must keep id ${stepId} so its failure report can target it`
    )

    const report = stepBlock(source, reportName)
    const condition = report.match(/if: \$\{\{ ([\s\S]*?) \}\}/)?.[1]
    assert.ok(condition, `${reportName} must be conditional`)
    assert.ok(
      condition.includes('failure()'),
      `${reportName} must only fire on a failing run (failure())`
    )
    assert.ok(
      condition.includes(`steps.${stepId}.outcome == 'failure'`),
      `${reportName} must bind to steps.${stepId}.outcome == 'failure'`
    )
    assert.match(
      report,
      new RegExp(`node scripts/sentry-checkin\\.js issue ${signal} `),
      `${reportName} must emit the ${signal} Sentry issue signal`
    )
    assert.match(
      report,
      new RegExp(`STEP_NAME: ${stepId}\\b`),
      `${reportName} must tag the failing step in STEP_NAME`
    )
    assert.ok(
      source.indexOf(`      - name: ${stepName}`) <
        source.indexOf(`      - name: ${reportName}`),
      `${reportName} must appear after ${stepName}`
    )
  }
}

test('every deploy/gate/smoke/retry step has a matching Sentry failure-report step', () => {
  assertFailureReportCoverage(workflow)
})

test('the failure-report coverage table itself covers every alertable step id in the workflow', () => {
  // Any step whose id marks a deploy, release gate, stamp, smoke check, or the
  // generation retry must appear in the coverage table above — adding a new one
  // without a failure report goes red here.
  const alertableIdPattern = /^(deploy_|smoke_|stamp_|retry_|.*_test_gate$)/
  const covered = new Set(failureReportCoverage.map((row) => row.stepId))
  const alertableIds = listSteps(workflow)
    .map((step) => step.id)
    .filter((id) => id && (alertableIdPattern.test(id) || /^.*_test_gate$/.test(id)))

  assert.ok(alertableIds.length >= 7, 'expected at least the seven known alertable steps')
  for (const id of alertableIds) {
    assert.ok(covered.has(id), `alertable step id ${id} has no failure-report row`)
  }
})

test('deploy failure reports can never be skipped while their deploy step ran', () => {
  // Each report's condition may only re-reference the SAME earlier-step outputs
  // its deploy step's condition used (plus failure()/outcome). Those outputs are
  // frozen once written, so if the deploy ran and failed, the report fires.
  for (const { stepName, reportName } of failureReportCoverage) {
    const guardedCondition = stepBlock(workflow, stepName).match(/if: \$\{\{ ([\s\S]*?) \}\}/)?.[1] || ''
    const reportCondition = stepBlock(workflow, reportName).match(/if: \$\{\{ ([\s\S]*?) \}\}/)?.[1]
    const reportOutputRefs = reportCondition.match(/steps\.[a-z_]+\.outputs\.[a-z_]+/g) || []
    for (const ref of reportOutputRefs) {
      assert.ok(
        guardedCondition.includes(ref),
        `${reportName} references ${ref}, which ${stepName} did not gate on — the report could be skipped while its step failed`
      )
    }
  }
})

test('generation retry failure report carries the attempt count', () => {
  const report = stepBlock(workflow, 'Report generation retry failure to Sentry')
  assert.match(report, /2\/2/, 'operator message must state both attempts failed (2/2)')
})

test('the generation retry starts from a clean package dir and its output is validated', () => {
  const retry = stepBlock(workflow, 'Retry if failed')
  assert.match(retry, /run: rm -rf package && node currscript\.js/)
  assert.match(retry, /if: \$\{\{ steps\.generate\.outcome == 'failure' \}\}/)

  // validate-package must run unconditionally (default success()) AFTER the
  // retry, so a retried run's artifacts are what gets validated and deployed.
  const validate = stepBlock(workflow, 'Validate generated artifacts')
  assert.doesNotMatch(validate, /\n\s*if:/, 'artifact validation must not be conditional')
  assert.ok(
    workflow.indexOf('      - name: Retry if failed') <
      workflow.indexOf('      - name: Validate generated artifacts'),
    'validation must run against the retry output'
  )
})

test('failure-report coverage checker rejects a report bound to the wrong step id', () => {
  const mutations = [
    // report watches a different step's outcome
    [
      "steps.smoke_check.outcome == 'failure'",
      "steps.deploy_github_pages.outcome == 'failure'"
    ],
    // report loses its failure() guard
    [
      "if: ${{ failure() && steps.retry_generate.outcome == 'failure' }}",
      "if: ${{ steps.retry_generate.outcome == 'success' }}"
    ],
    // report emits the wrong signal
    [
      'issue smoke_check_failure ',
      'issue smoke_check_ok '
    ],
    // guarded step loses the id its report targets
    [
      '\n        id: retry_generate',
      ''
    ]
  ]

  for (const [needle, replacement] of mutations) {
    const mutated = workflow.replace(needle, replacement)
    assert.notEqual(mutated, workflow, `mutation must alter the workflow fixture: ${needle}`)
    assert.throws(
      () => assertFailureReportCoverage(mutated),
      `coverage checker must reject mutation: ${needle} -> ${replacement}`
    )
  }
})

test('sentry-checkin issue verb formats the new failure signals', () => {
  for (const signal of ['generation_retry_failure', 'smoke_check_failure']) {
    const child = spawnSync(
      process.execPath,
      [
        path.join(__dirname, '..', 'scripts', 'sentry-checkin.js'),
        'issue',
        signal,
        'operator-facing message'
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          SENTRY_DSN: '',
          SENTRY_CURRENCY_API_DSN: '',
          STEP_NAME: 'unit_test_step'
        }
      }
    )
    assert.equal(child.status, 0, `issue verb must exit 0 for ${signal}: ${child.stderr}`)
    // captureIssue logs error-level lines through console.error, so read stderr too.
    const output = `${child.stdout}\n${child.stderr}`
    const line = output.split('\n').find((entry) => entry.startsWith('[FX_PUBLISH] '))
    assert.ok(line, `issue verb must log an [FX_PUBLISH] line for ${signal}`)
    const payload = JSON.parse(line.slice('[FX_PUBLISH] '.length))
    assert.equal(payload['monitoring.signal'], signal)
    assert.equal(payload.message, 'operator-facing message')
    assert.equal(payload.step, 'unit_test_step')
    assert.equal(payload.workflow, 'daily_publish')
  }
})
