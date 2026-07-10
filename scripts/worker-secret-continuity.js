#!/usr/bin/env node

'use strict'

const secretName = process.argv[2]

if (process.argv.length !== 3 || !secretName.trim()) {
  console.error('usage: worker-secret-continuity.js <SECRET_NAME>')
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

  const exists = entries.some(
    (entry) => entry && entry.name === secretName && entry.type === 'secret_text'
  )

  if (!exists) {
    console.error(`required Worker secret is absent: ${secretName}`)
    process.exit(1)
  }

  console.log(`continuity preserved: ${secretName} exists on the deployed Worker`)
})
