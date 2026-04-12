const test = require('node:test')
const assert = require('node:assert/strict')

test('enforceWhitelist passes for the configured email', async () => {
  const { enforceWhitelist } = await import('../worker/src/sideload/auth.mjs')
  assert.doesNotThrow(() => enforceWhitelist('leojkwan@gmail.com'))
})

test('enforceWhitelist is case-insensitive', async () => {
  const { enforceWhitelist } = await import('../worker/src/sideload/auth.mjs')
  assert.doesNotThrow(() => enforceWhitelist('LeoJKwan@Gmail.com'))
})

test('enforceWhitelist rejects other emails with FORBIDDEN_NOT_WHITELISTED', async () => {
  const { enforceWhitelist, FORBIDDEN_NOT_WHITELISTED } = await import('../worker/src/sideload/auth.mjs')
  try {
    enforceWhitelist('someone.else@example.com')
    assert.fail('should have thrown')
  } catch (error) {
    assert.equal(error.code, FORBIDDEN_NOT_WHITELISTED)
  }
})

test('enforceWhitelist rejects empty string', async () => {
  const { enforceWhitelist, FORBIDDEN_NOT_WHITELISTED } = await import('../worker/src/sideload/auth.mjs')
  try {
    enforceWhitelist('')
    assert.fail('should have thrown')
  } catch (error) {
    assert.equal(error.code, FORBIDDEN_NOT_WHITELISTED)
  }
})

test('enforceWhitelist rejects non-string input', async () => {
  const { enforceWhitelist, FORBIDDEN_NOT_WHITELISTED } = await import('../worker/src/sideload/auth.mjs')
  try {
    enforceWhitelist(null)
    assert.fail('should have thrown')
  } catch (error) {
    assert.equal(error.code, FORBIDDEN_NOT_WHITELISTED)
  }
})

test('derivePrefix returns a stable users/<sha256hex>/photos shape', async () => {
  const { derivePrefix } = await import('../worker/src/sideload/auth.mjs')
  const prefix = await derivePrefix('leojkwan@gmail.com')
  assert.match(prefix, /^users\/[0-9a-f]{64}\/photos$/)
})

test('derivePrefix is deterministic for the same email', async () => {
  const { derivePrefix } = await import('../worker/src/sideload/auth.mjs')
  const a = await derivePrefix('leojkwan@gmail.com')
  const b = await derivePrefix('leojkwan@gmail.com')
  assert.equal(a, b)
})

test('derivePrefix normalizes casing and whitespace', async () => {
  const { derivePrefix } = await import('../worker/src/sideload/auth.mjs')
  const a = await derivePrefix('leojkwan@gmail.com')
  const b = await derivePrefix('  LeoJKwan@Gmail.com  ')
  assert.equal(a, b)
})

test('derivePrefix produces different prefixes for different emails', async () => {
  const { derivePrefix } = await import('../worker/src/sideload/auth.mjs')
  const a = await derivePrefix('leojkwan@gmail.com')
  const b = await derivePrefix('someone.else@example.com')
  assert.notEqual(a, b)
})

test('derivePrefix rejects empty email with AUTH_INVALID', async () => {
  const { derivePrefix, AUTH_INVALID } = await import('../worker/src/sideload/auth.mjs')
  try {
    await derivePrefix('')
    assert.fail('should have thrown')
  } catch (error) {
    assert.equal(error.code, AUTH_INVALID)
  }
})

test('readCFAccessIdentity returns email from Cf-Access-Authenticated-User-Email header', async () => {
  const { readCFAccessIdentity } = await import('../worker/src/sideload/auth.mjs')
  const request = new Request('https://example.workers.dev/sideload/photos', {
    headers: { 'Cf-Access-Authenticated-User-Email': 'leojkwan@gmail.com' },
  })
  const identity = readCFAccessIdentity(request)
  assert.equal(identity.email, 'leojkwan@gmail.com')
})

test('readCFAccessIdentity normalizes email to lowercase and trims whitespace', async () => {
  const { readCFAccessIdentity } = await import('../worker/src/sideload/auth.mjs')
  const request = new Request('https://example.workers.dev/sideload/photos', {
    headers: { 'Cf-Access-Authenticated-User-Email': '  LeoJKwan@Gmail.com  ' },
  })
  const identity = readCFAccessIdentity(request)
  assert.equal(identity.email, 'leojkwan@gmail.com')
})

test('readCFAccessIdentity rejects missing header with AUTH_MISSING', async () => {
  const { readCFAccessIdentity, AUTH_MISSING } = await import('../worker/src/sideload/auth.mjs')
  try {
    readCFAccessIdentity(new Request('https://example.workers.dev/sideload/photos'))
    assert.fail('should have thrown')
  } catch (error) {
    assert.equal(error.code, AUTH_MISSING)
  }
})

test('readCFAccessIdentity rejects empty header with AUTH_MISSING', async () => {
  const { readCFAccessIdentity, AUTH_MISSING } = await import('../worker/src/sideload/auth.mjs')
  try {
    readCFAccessIdentity(new Request('https://example.workers.dev/sideload/photos', {
      headers: { 'Cf-Access-Authenticated-User-Email': '   ' },
    }))
    assert.fail('should have thrown')
  } catch (error) {
    assert.equal(error.code, AUTH_MISSING)
  }
})
