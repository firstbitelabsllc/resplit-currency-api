import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleRequest } from '../worker/src/index.mjs'

const url = 'https://fx.resplit.app/health'

async function health(method, env) {
  return handleRequest(new Request(url, { method }), env)
}

test('GET health identifies actual release and configured OCR model without credentials', async () => {
  const release = 'e2d088153bebfae2697e77aa30f071ef3e94e87c'
  for (const [env, model] of [
    [{ LLM_SCAN_PROVIDER: 'zai', LLM_SCAN_MODEL: 'glm-5.3-flash', LLM_SCAN_BASE_URL: 'https://api.z.ai/api/coding/paas/v4' }, 'glm-5.3-flash'],
    [{ LLM_SCAN_PROVIDER: 'zai', LLM_SCAN_MODEL: 'google/gemini-2.5-flash-lite', LLM_SCAN_BASE_URL: 'https://openrouter.ai/api/v1' }, 'google/gemini-2.5-flash-lite'],
    [{}, 'claude-sonnet-5'],
  ]) {
    const res = await health('GET', {
      ...env, SENTRY_ENVIRONMENT: 'test', SENTRY_RELEASE: release,
      ZAI_API_KEY: 'zai-secret-must-not-leak', OPENROUTER_API_KEY: 'or-secret-must-not-leak',
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    const text = await res.text()
    const body = JSON.parse(text)
    assert.equal(body.release, release)
    assert.deepEqual(body.ocr, { model })
    assert.equal(text.includes('zai-secret-must-not-leak'), false)
    assert.equal(text.includes('or-secret-must-not-leak'), false)
  }
})

test('HEAD health has no body, and POST remains method-not-allowed', async () => {
  const env = { SENTRY_RELEASE: 'test-release', LLM_SCAN_PROVIDER: 'zai', LLM_SCAN_MODEL: 'google/gemini-2.5-flash-lite' }
  const head = await health('HEAD', env)
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
  const post = await health('POST', env)
  assert.equal(post.status, 405)
  assert.equal(post.headers.get('allow'), 'GET, HEAD')
})
