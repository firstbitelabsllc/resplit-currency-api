#!/usr/bin/env node

const {
  captureIssue,
  finishWorkflowCheckIn,
  startWorkflowCheckIn
} = require('./sentry-monitoring')

main().catch((error) => {
  console.error(`sentry-checkin: FAILED\n${error.stack || error.message}`)
  process.exitCode = 1
})

async function main() {
  const command = process.argv[2]

  if (command === 'start') {
    const checkinId = startWorkflowCheckIn()
    console.log(`checkin_id=${checkinId || ''}`)
    console.log(`checkin_started_at=${Date.now()}`)
    return
  }

  if (command === 'finish') {
    const status = normalizeStatus(process.env.JOB_STATUS || process.argv[3])
    const checkInId = process.env.CHECKIN_ID || process.argv[4] || null
    const startedAt = Number(process.env.CHECKIN_STARTED_AT || process.argv[5] || Date.now())
    await finishWorkflowCheckIn(checkInId, status, startedAt)
    console.log(`finished_status=${status}`)
    return
  }

  if (command === 'issue') {
    const signal = process.argv[3]
    const message = process.argv.slice(4).join(' ') || signal
    if (!signal) {
      throw new Error('Usage: node scripts/sentry-checkin.js issue <signal> <message>')
    }

    await captureIssue({
      signal,
      message,
      context: {
        workflow: 'daily_publish',
        step: process.env.STEP_NAME,
        repository: process.env.GITHUB_REPOSITORY,
        run_id: process.env.GITHUB_RUN_ID,
        run_attempt: process.env.GITHUB_RUN_ATTEMPT
      }
    })
    return
  }

  throw new Error('Usage: node scripts/sentry-checkin.js <start|finish|issue>')
}

function normalizeStatus(value) {
  return value === 'success' || value === 'ok' ? 'ok' : 'error'
}
