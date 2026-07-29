import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { handleOcr } from '../worker/src/ocr/router.mjs'

const require = createRequire(import.meta.url)
const { stripJsonComments } = require('../scripts/reliability-cockpit.js')
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const realFetch = globalThis.fetch

function makeKV() {
  const store = new Map()
  return {
    async get(key) { return store.get(key) ?? null },
    async put(key, value) { store.set(key, value) },
    async delete(key) { store.delete(key) },
  }
}

function makeEnv() {
  return {
    ATTEST_KV: makeKV(),
    AZURE_OCR_ENDPOINT: 'https://test.cognitiveservices.azure.com',
    AZURE_OCR_KEY: 'azure-test-key',
    ANTHROPIC_API_KEY: 'anthropic-test-key',
    LLM_SCAN_ALLOW_SOFT_FAIL: 'false',
    SENTRY_ENVIRONMENT: 'test',
  }
}

function jpegWithDimensions(width = 800, height = 600) {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0,
    0x00, 0x11,
    0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03,
    0x01, 0x22, 0x00,
    0x02, 0x11, 0x01,
    0x03, 0x11, 0x01,
  ])
}

function requestFor(pathname, headers = {}) {
  return new Request(`https://fx.resplit.app${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'image/jpeg', ...headers },
    body: jpegWithDimensions(),
  })
}

afterEach(() => {
  globalThis.fetch = realFetch
})

test('production config disables the unauthenticated OCR compatibility path', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'wrangler.jsonc'), 'utf8')
  const wrangler = JSON.parse(stripJsonComments(source))

  assert.equal(wrangler.vars.LLM_SCAN_ALLOW_SOFT_FAIL, 'false')
  assert.equal(wrangler.env.production.vars.LLM_SCAN_ALLOW_SOFT_FAIL, 'false')
})

test('missing or explicitly bypassed App Attest cannot reach any paid provider', async () => {
  let providerCalls = 0
  globalThis.fetch = async () => {
    providerCalls++
    throw new Error('unattested request reached a paid provider')
  }

  const cases = [
    ['missing headers', {}, 'REQUIRED'],
    ['explicit soft-fail', { 'x-resplit-attest-soft-fail': 'true' }, 'REQUIRED'],
    ['invalid assertion plus soft-fail', {
      'x-resplit-attest-soft-fail': 'true',
      'x-resplit-attest-key-id': 'forged-key',
      'x-resplit-attest-assertion': 'AA==',
    }, 'REQUIRED'],
    ['invalid assertion without soft-fail', {
      'x-resplit-attest-key-id': 'forged-key',
      'x-resplit-attest-assertion': 'AA==',
    }, 'UNKNOWN_KEY'],
  ]

  for (const pathname of ['/ocr/scan', '/ocr/dual-scan', '/ocr/analyze']) {
    for (const [label, headers, rejection] of cases) {
      const response = await handleOcr(requestFor(pathname, headers), makeEnv())
      const body = await response.json()
      assert.equal(response.status, 401, `${pathname} ${label}`)
      assert.equal(body.error, 'ATTEST_REJECTED', `${pathname} ${label}`)
      assert.equal(body.message, rejection, `${pathname} ${label}`)
    }
  }

  assert.equal(providerCalls, 0)
})
