const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const repoRoot = path.join(__dirname, '..')
const packageJson = readJson('package.json')
const packageLock = readJson('package-lock.json')

const REQUIRED = Object.freeze({
  sentryNode: '10.54.0',
  braceExpansion: '5.0.6',
  vitestPoolWorkers: '0.18.4',
  wrangler: '4.110.0'
})

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'))
}

function parseVersion(value, label) {
  const match = String(value || '').match(/(\d+)\.(\d+)\.(\d+)/)
  assert.ok(match, `${label} must contain a semantic version, got ${JSON.stringify(value)}`)
  return match.slice(1).map(Number)
}

function assertAtLeast(value, floor, label) {
  const actual = parseVersion(value, label)
  const minimum = parseVersion(floor, `${label} floor`)
  const comparison = actual.findIndex((part, index) => part !== minimum[index])
  assert.ok(
    comparison === -1 || actual[comparison] > minimum[comparison],
    `${label} must be >= ${floor}, got ${value}`
  )
}

function assertDependencySecurityFloor(manifest, lockfile) {
  const rootLock = lockfile.packages?.['']
  const sentryLock = lockfile.packages?.['node_modules/@sentry/node']
  const braceLock = lockfile.packages?.['node_modules/brace-expansion']
  const poolLock = lockfile.packages?.['node_modules/@cloudflare/vitest-pool-workers']
  const wranglerLock = lockfile.packages?.['node_modules/wrangler']

  assertAtLeast(manifest.dependencies?.['@sentry/node'], REQUIRED.sentryNode, 'package @sentry/node')
  assertAtLeast(rootLock?.dependencies?.['@sentry/node'], REQUIRED.sentryNode, 'lock root @sentry/node')
  assertAtLeast(sentryLock?.version, REQUIRED.sentryNode, 'lock resolved @sentry/node')

  assert.equal(manifest.overrides?.['brace-expansion'], REQUIRED.braceExpansion, 'package brace-expansion override')
  assert.equal(lockfile.overrides?.['brace-expansion'], REQUIRED.braceExpansion, 'lock brace-expansion override')
  assert.equal(braceLock?.version, REQUIRED.braceExpansion, 'lock resolved brace-expansion')

  assert.equal(
    manifest.devDependencies?.['@cloudflare/vitest-pool-workers'],
    REQUIRED.vitestPoolWorkers,
    'package @cloudflare/vitest-pool-workers'
  )
  assert.equal(rootLock?.devDependencies?.['@cloudflare/vitest-pool-workers'], REQUIRED.vitestPoolWorkers, 'lock root worker pool')
  assert.equal(poolLock?.version, REQUIRED.vitestPoolWorkers, 'lock resolved worker pool')
  assert.equal(poolLock?.dependencies?.wrangler, REQUIRED.wrangler, 'worker pool matched wrangler dependency')

  assert.equal(manifest.devDependencies?.wrangler, REQUIRED.wrangler, 'package wrangler')
  assert.equal(rootLock?.devDependencies?.wrangler, REQUIRED.wrangler, 'lock root wrangler')
  assert.equal(wranglerLock?.version, REQUIRED.wrangler, 'lock resolved wrangler')
}

function greenFixture() {
  return {
    manifest: {
      dependencies: { '@sentry/node': '^10.54.0' },
      devDependencies: {
        '@cloudflare/vitest-pool-workers': '0.18.4',
        wrangler: '4.110.0'
      },
      overrides: { 'brace-expansion': '5.0.6' }
    },
    lockfile: {
      overrides: { 'brace-expansion': '5.0.6' },
      packages: {
        '': {
          dependencies: { '@sentry/node': '^10.54.0' },
          devDependencies: {
            '@cloudflare/vitest-pool-workers': '0.18.4',
            wrangler: '4.110.0'
          }
        },
        'node_modules/@sentry/node': { version: '10.54.0' },
        'node_modules/brace-expansion': { version: '5.0.6' },
        'node_modules/@cloudflare/vitest-pool-workers': {
          version: '0.18.4',
          dependencies: { wrangler: '4.110.0' }
        },
        'node_modules/wrangler': { version: '4.110.0' }
      }
    }
  }
}

test('package and lockfile hold the audited dependency security floor', () => {
  assertDependencySecurityFloor(packageJson, packageLock)
})

test('dependency security floor rejects package, lockfile, and matched-tooling regressions', () => {
  const mutations = [
    fixture => { fixture.manifest.dependencies['@sentry/node'] = '^10.53.1' },
    fixture => { fixture.lockfile.packages['node_modules/@sentry/node'].version = '10.53.1' },
    fixture => { fixture.manifest.overrides['brace-expansion'] = '5.0.5' },
    fixture => { fixture.lockfile.packages['node_modules/brace-expansion'].version = '5.0.5' },
    fixture => { fixture.manifest.devDependencies['@cloudflare/vitest-pool-workers'] = '0.18.3' },
    fixture => { fixture.manifest.devDependencies.wrangler = '4.109.0' },
    fixture => { fixture.lockfile.packages['node_modules/@cloudflare/vitest-pool-workers'].dependencies.wrangler = '4.109.0' }
  ]

  for (const mutate of mutations) {
    const fixture = greenFixture()
    mutate(fixture)
    assert.throws(() => assertDependencySecurityFloor(fixture.manifest, fixture.lockfile))
  }
})
