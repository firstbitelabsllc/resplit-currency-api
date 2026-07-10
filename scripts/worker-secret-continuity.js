#!/usr/bin/env node

'use strict'

const secretNames = process.argv.slice(2)

if (
  secretNames.length === 0 ||
  secretNames.some((secretName) => !secretName.trim()) ||
  new Set(secretNames).size !== secretNames.length
) {
  console.error('usage: worker-secret-continuity.js <SECRET_NAME> [SECRET_NAME ...]')
  process.exit(2)
}

let inventory = ''

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  inventory += chunk
})

process.stdin.on('end', () => {
  let entries

  try {
    entries = JSON.parse(inventory)
  } catch {
    console.error('unable to verify deployed Worker secret continuity')
    process.exit(1)
  }

  if (!Array.isArray(entries)) {
    console.error('unable to verify deployed Worker secret continuity')
    process.exit(1)
  }

  const missingSecret = secretNames.find(
    (secretName) =>
      !entries.some(
        (entry) => entry && entry.name === secretName && entry.type === 'secret_text'
      )
  )

  if (missingSecret) {
    console.error(`required Worker secret is absent: ${missingSecret}`)
    process.exit(1)
  }

  console.log(`continuity preserved: ${secretNames.join(', ')} exist on the deployed Worker`)
})
