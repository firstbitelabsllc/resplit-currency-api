import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runDualScanGauntlet } from '../scripts/ocr-dual-scan-gauntlet.mjs'

const secret = 'PRIVATE_KEY_OR_PROVIDER_BODY_SENTINEL'
const merchant = 'PRIVATE_RECEIPT_MERCHANT_SENTINEL'
const image = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 2, 88, 3, 32, 3, 1, 34, 0, 2, 17, 1, 3, 17, 1])
const cases = [
  { name: 'incumbent', env: { LLM_SCAN_PROVIDER: 'zai', LLM_SCAN_MODEL: 'glm-5.3-flash', LLM_SCAN_BASE_URL: 'https://api.z.ai/api/coding/paas/v4', LLM_SCAN_MAX_EDGE: '1280' } },
  { name: 'candidate', env: { LLM_SCAN_PROVIDER: 'zai', LLM_SCAN_MODEL: 'google/gemini-2.5-flash-lite', LLM_SCAN_BASE_URL: 'https://openrouter.ai/api/v1', LLM_SCAN_MAX_EDGE: '1280' } },
]
const env = {
  AZURE_OCR_ENDPOINT: 'https://fixture.cognitiveservices.azure.com', AZURE_OCR_KEY: secret,
  ZAI_API_KEY: secret, OPENROUTER_API_KEY: secret,
  OCR_GAUNTLET_CASE_ORDER: 'rotating', OCR_GAUNTLET_CONCURRENCY: '1',
}
const expected = {
  merchantName: merchant, merchantAddress: null, transactionDate: '2026-09-30',
  currencyCode: 'USD', currencySymbol: '$',
  lineItems: [{ name: 'PRIVATE_COFFEE_SENTINEL', amount: 4.50, quantity: 1 }, { name: 'PRIVATE_CAKE_SENTINEL', amount: 7.80, quantity: 1 }],
  subtotal: 12.30, total: 12.30, extras: [],
}
const azureResult = () => Response.json({ status: 'succeeded', analyzeResult: { documents: [{ fields: {
  MerchantName: { valueString: merchant }, Total: { type: 'currency', valueCurrency: { amount: 12.30, currencyCode: 'USD' } },
} }] } })
const llmResult = (scanned, model, usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 30 } }) => Response.json({
  model, choices: [{ message: { content: typeof scanned === 'string' ? scanned : JSON.stringify(scanned) }, finish_reason: 'stop' }],
  usage,
})

async function fixture(t, n = 2) {
  const root = await mkdtemp(join(tmpdir(), 'ocr-dual-gauntlet-'))
  const path = join(root, `${merchant}.jpg`)
  await writeFile(path, image)
  const rowsPath = join(root, 'rows.jsonl')
  const set = Array.from({ length: n }, (_, index) => ({ id: `${merchant}-${index}`, path, expected, locale: 'en-US' }))
  const originalFetch = globalThis.fetch
  t.after(async () => { globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }) })
  return { root, rowsPath, set }
}

test('real signed analyze route starts both providers, pairs identical bytes, rejects better Azure truth, and fsyncs private rows before continuing', async (t) => {
  const options = await fixture(t)
  let azureSubmits = 0
  let polls = 0
  const order = []
  const azureBytes = []
  const llmBytes = []
  let releaseAzure = null
  globalThis.fetch = async (url, init) => {
    const address = String(url)
    if (address.includes('prebuilt-receipt:analyze')) {
      assert.equal(init.method, 'POST')
      assert.equal(new Headers(init.headers).get('Ocp-Apim-Subscription-Key'), secret)
      const gate = new Promise((resolve, reject) => {
        releaseAzure = () => resolve(new Response(null, { status: 202, headers: { 'operation-location': `${env.AZURE_OCR_ENDPOINT}/analyzeResults/local` } }))
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
      const persisted = (await readFile(options.rowsPath, 'utf8')).trim().split('\n').map(JSON.parse)
      assert.equal(persisted.filter((row) => row.event === 'attempt').length, azureSubmits, 'last completed row is on disk before another provider starts')
      azureSubmits++
      azureBytes.push(Buffer.from(init.body))
      // Azure cannot finish until the LLM starts. Sequential provider launch
      // trips the runner deadline and fails the complete/accuracy assertions.
      return gate
    }
    if (address.includes('/analyzeResults/')) { polls++; return azureResult() }
    if (address.endsWith('/chat/completions')) {
      const request = JSON.parse(init.body)
      assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${secret}`)
      order.push(request.model)
      const imagePart = request.messages.flatMap((message) => Array.isArray(message.content) ? message.content : []).find((part) => part.type === 'image_url')
      llmBytes.push(Buffer.from(imagePart.image_url.url.split(',')[1], 'base64'))
      assert.ok(releaseAzure, 'Azure has launched before LLM response')
      releaseAzure()
      releaseAzure = null
      // Correct Azure total must never overwrite the wrong returned LLM total.
      // Same item count, reordered names/amounts, and excess USD precision.
      return llmResult({ ...expected, total: 12.304, lineItems: [...expected.lineItems].reverse() }, secret)
    }
    assert.fail('unexpected provider route')
  }
  let reads = 0
  const printed = []
  for (const method of ['log', 'warn', 'error', 'info', 'debug']) {
    const original = console[method]
    console[method] = (...args) => printed.push(args)
    t.after(() => { console[method] = original })
  }
  const report = await runDualScanGauntlet({ ...options, env, cases, timeoutMs: 500,
    readImage: async () => { reads++; return image },
  })
  assert.equal(report.complete, true)
  assert.equal(report.valid_provider_replay, true)
  assert.equal(reads, 2)
  assert.equal(azureSubmits, 4)
  assert.equal(polls, 4)
  assert.deepEqual(order, ['glm-5.3-flash', 'google/gemini-2.5-flash-lite', 'google/gemini-2.5-flash-lite', 'glm-5.3-flash'])
  for (const bytes of [...azureBytes, ...llmBytes]) assert.deepEqual(bytes, Buffer.from(image))
  for (const { report: arm } of report.cases) {
    assert.equal(arm.total_exact, 0)
    assert.deepEqual(arm.usage_tokens, {
      input: 200, cached_input: 60, output: 40, total: null,
      attempts_with_input_usage: 2, attempts_with_output_usage: 2,
      attempts_with_cached_input_usage: 2, attempts_with_total_usage: 0,
    })
    assert.equal(arm.total_exact_denominator, 2)
    assert.equal(arm.items_exact, 2)
    for (const row of arm.rows) {
      assert.equal(row.route, 'analyze')
      assert.equal(row.attest, 'local_signature_pass')
      assert.equal(row.cache, 'miss', 'duplicate bytes cannot reuse cached results')
      assert.equal(row.scoring_output, 'returned_llm')
      assert.equal(row.status, 'succeeded')
      assert.equal(row.azure_status, 'succeeded')
      assert.equal(row.llm_status, 'succeeded')
      assert.equal(row.azure_provider_calls, 1)
      assert.equal(row.llm_provider_calls, 1)
      assert.ok(row.wall_ms + 1 >= row.total_ms, 'monotonic wall and rounded route clock agree')
      assert.ok(row.llm_start_ms >= 0 && row.azure_start_ms >= 0)
      assert.ok(row.name_sequence_edit_distance > 0)
      assert.ok(row.amount_sequence_edit_distance > 0)
      assert.equal(row.served_model_matches, false)
      assert.match(row.served_model, /^sha256:/)
      assert.equal(row.input_tokens, 100)
      assert.equal(row.cached_input_tokens, 30)
      assert.equal(row.output_tokens, 20)
    }
  }
  const disk = await readFile(options.rowsPath, 'utf8')
  assert.deepEqual(printed, [], 'raw monitoring and provider bodies never reach the console')
  for (const serialized of [disk, JSON.stringify(report)]) {
    for (const privateValue of [secret, merchant, 'PRIVATE_COFFEE_SENTINEL', 'PRIVATE_CAKE_SENTINEL', options.root, '"amount":', '"azure_total":', '"llm_total":', 'choices', 'analyzeResult']) {
      assert.equal(serialized.includes(privateValue), false, `private field omitted: ${privateValue}`)
    }
  }
  const persisted = disk.trim().split('\n').map(JSON.parse)
  assert.equal(persisted.filter((row) => row.event === 'attempt').length, 4)
  await assert.rejects(runDualScanGauntlet({ ...options, env, cases }), /EEXIST/, 'cannot overwrite evidence')
})

test('malformed HTTP200 LLM output retains all truth denominators without stopping replay or grading Azure fallback', async (t) => {
  const options = await fixture(t, 3)
  let calls = 0
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('prebuilt-receipt:analyze')) return new Response(null, { status: 202, headers: { 'operation-location': `${env.AZURE_OCR_ENDPOINT}/analyzeResults/local` } })
    if (String(url).includes('/analyzeResults/')) return azureResult()
    if (String(url).endsWith('/chat/completions')) {
      calls++
      return llmResult('malformed JSON', null)
    }
    assert.fail('unexpected provider route')
  }
  const report = await runDualScanGauntlet({ ...options, env, cases })
  assert.equal(report.complete, true)
  assert.equal(report.valid_provider_replay, true)
  assert.equal(calls, 6)
  for (const { report: arm } of report.cases) {
    assert.equal(arm.n, 3)
    assert.deepEqual(arm.usage_tokens, {
      input: null, cached_input: null, output: null, total: null,
      attempts_with_input_usage: 0, attempts_with_output_usage: 0,
      attempts_with_cached_input_usage: 0, attempts_with_total_usage: 0,
    })
    assert.ok(arm.rows.every((row) => row.input_tokens === null), 'malformed-output usage is absent at the monitoring seam')
    assert.equal(arm.errors, 3)
    assert.equal(arm.total_exact_denominator, 3)
    assert.equal(arm.items_exact_denominator, 3)
    assert.equal(arm.total_exact, 0)
    assert.equal(arm.items_exact, 0)
    assert.deepEqual(new Set(arm.rows.map((row) => row.llm_diagnostic)), new Set(['malformed_output']))
    for (const row of arm.rows) {
      assert.equal(row.scoring_output, 'azure_fallback_ungraded')
      assert.equal(row.azure_status, 'succeeded')
      assert.equal(row.llm_status, 'provider_error')
      assert.equal(row.served_model, null)
      assert.equal(row.served_model_matches, null)
      assert.equal(row.provider_started, true)
      assert.equal(row.ok, false)
    }
  }
  const disk = await readFile(options.rowsPath, 'utf8')
  assert.equal(disk.trim().split('\n').map(JSON.parse).filter((row) => row.event === 'attempt').length, 6)
  assert.equal(disk.includes(secret), false)
})

test('HTTP429 stops both arms after the simultaneous pair drains, keeps unattempted denominators, and never leaks the private error body', async (t) => {
  const options = await fixture(t, 3)
  let submits = 0
  let llmCalls = 0
  let polls = 0
  let releaseAzure
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('prebuilt-receipt:analyze')) {
      submits++
      return new Promise((resolve) => { releaseAzure = () => resolve(new Response(null, { status: 202,
        headers: { 'operation-location': `${env.AZURE_OCR_ENDPOINT}/analyzeResults/local` } })) })
    }
    if (String(url).includes('/analyzeResults/')) { polls++; return azureResult() }
    if (String(url).endsWith('/chat/completions')) {
      llmCalls++
      assert.ok(releaseAzure, 'Azure is already in flight when the LLM rejects')
      // Release only after the rejection has crossed the wrapper. Azure's
      // existing operation may still be polled; another paid submit may not.
      setImmediate(releaseAzure)
      return new Response(JSON.stringify({ error: { message: `${secret} ${merchant} ${options.root}`, code: secret } }), { status: 429 })
    }
    assert.fail('unexpected provider route')
  }
  const report = await runDualScanGauntlet({ ...options, env, cases })
  assert.equal(submits, 1)
  assert.equal(llmCalls, 1, 'neither the other arm nor another fixture calls the model')
  assert.equal(polls, 1, 'the already submitted Azure operation drains')
  assert.equal(report.complete, false)
  assert.equal(report.valid_provider_replay, false)
  assert.deepEqual(report.stop_reason, { provider: 'zai', category: 'http_error', http_status: 429 })
  const rows = report.cases.flatMap(({ report: arm }) => arm.rows)
  assert.equal(rows.filter((row) => row.provider_started).length, 1)
  assert.equal(rows.filter((row) => row.runner_failure === 'not_attempted_after_provider_stop').length, 5)
  for (const { report: arm } of report.cases) {
    assert.equal(arm.n, 3)
    assert.equal(arm.errors, 3)
    assert.deepEqual(arm.usage_tokens, {
      input: null, cached_input: null, output: null, total: null,
      attempts_with_input_usage: 0, attempts_with_output_usage: 0,
      attempts_with_cached_input_usage: 0, attempts_with_total_usage: 0,
    })
    assert.equal(arm.total_exact_denominator, 3)
    assert.equal(arm.items_exact_denominator, 3)
    assert.equal(arm.total_exact, 0)
    assert.equal(arm.items_exact, 0)
    for (const row of arm.rows.filter((row) => !row.provider_started)) {
      assert.equal(row.ok, false)
      assert.equal(row.azure_provider_calls + row.llm_provider_calls, 0)
    }
  }
  const disk = await readFile(options.rowsPath, 'utf8')
  assert.equal(disk.trim().split('\n').map(JSON.parse).filter((row) => row.event === 'attempt').length, 6)
  for (const serialized of [disk, JSON.stringify(report)]) {
    for (const value of [secret, merchant, options.root]) assert.equal(serialized.includes(value), false)
  }
})

test('Azure failures and model transport errors stop replay, and a rejection in the other arm retains its own provider', async (t) => {
  for (const mode of ['azure_http', 'azure_failed_operation', 'model_timeout', 'model_transport', 'openrouter_http']) {
    await t.test(mode, async (t) => {
      const options = await fixture(t, 2)
      let submits = 0
      let llmCalls = 0
      globalThis.fetch = async (url, init) => {
        if (String(url).includes('prebuilt-receipt:analyze')) {
          submits++
          if (mode === 'azure_http') return new Response(secret, { status: 403 })
          return new Response(null, { status: 202, headers: { 'operation-location': `${env.AZURE_OCR_ENDPOINT}/analyzeResults/local` } })
        }
        if (String(url).includes('/analyzeResults/')) {
          return mode === 'azure_failed_operation' ? Response.json({ status: 'failed', error: { message: secret } }) : azureResult()
        }
        if (String(url).endsWith('/chat/completions')) {
          llmCalls++
          if (mode === 'model_timeout') throw new DOMException(secret, 'TimeoutError')
          if (mode === 'model_transport') throw new TypeError(secret)
          const model = JSON.parse(init.body).model
          if (mode === 'openrouter_http' && model === cases[1].env.LLM_SCAN_MODEL) return new Response(secret, { status: 401 })
          return llmResult(expected, model)
        }
        assert.fail('unexpected provider route')
      }
      const report = await runDualScanGauntlet({ ...options, env, cases })
      assert.equal(report.complete, false)
      assert.equal(report.valid_provider_replay, false)
      const secondArm = mode === 'openrouter_http'
      assert.equal(submits, secondArm ? 2 : 1, 'no later fixture is submitted')
      assert.ok(llmCalls <= (secondArm ? 2 : 1), 'a not-yet-launched leg is blocked after the stop')
      assert.deepEqual(report.stop_reason, {
        provider: mode.startsWith('azure') ? 'azure' : secondArm ? 'openrouter' : 'zai',
        category: mode === 'azure_failed_operation' ? 'provider_error' : mode === 'model_timeout'
          ? 'transport_timeout' : mode === 'model_transport' ? 'transport_error' : 'http_error',
        http_status: mode === 'azure_http' ? 403 : secondArm ? 401 : null,
      })
      const rows = report.cases.flatMap(({ report: arm }) => arm.rows)
      assert.equal(rows.filter((row) => row.runner_failure === 'not_attempted_after_provider_stop').length, secondArm ? 2 : 3)
      for (const { report: arm } of report.cases) {
        assert.equal(arm.n, 2)
        assert.equal(arm.total_exact_denominator, 2)
        assert.equal(arm.items_exact_denominator, 2)
      }
      for (const serialized of [JSON.stringify(report), await readFile(options.rowsPath, 'utf8')]) assert.equal(serialized.includes(secret), false)
    })
  }
})

test('CLI exits incomplete with the exact sanitized HTTP stop reason instead of a generic error', async (t) => {
  const options = await fixture(t, 2)
  const corpus = join(options.root, 'corpus.json')
  const reportPath = join(options.root, 'report.json')
  await writeFile(corpus, JSON.stringify(options.set))
  const runner = new URL('../scripts/ocr-dual-scan-gauntlet.mjs', import.meta.url)
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import { createRequire, syncBuiltinESMExports } from 'node:module'
    import { fileURLToPath } from 'node:url'
    const require = createRequire(import.meta.url)
    // Only the external corpus Git check is stubbed; no Git metadata is made.
    require('node:child_process').execFileSync = (command, args) => {
      assert.equal(command, 'git')
      if (args[0] === 'ls-files') return ${JSON.stringify(`corpus.json\0${merchant}.jpg\0`)}
      assert.equal(args[0], 'diff')
      return ''
    }
    syncBuiltinESMExports()
    globalThis.fetch = async (url) => {
      if (String(url).includes('prebuilt-receipt:analyze')) return new Response(null, { status: 202,
        headers: { 'operation-location': process.env.AZURE_OCR_ENDPOINT + '/analyzeResults/local' } })
      if (String(url).includes('/analyzeResults/')) return Response.json({ status: 'succeeded', analyzeResult: { documents: [] } })
      assert.ok(String(url).endsWith('/chat/completions'))
      return new Response(${JSON.stringify(secret)}, { status: 429 })
    }
    process.argv[1] = fileURLToPath(${JSON.stringify(runner.href)})
    await import(${JSON.stringify(runner.href)})
  `], { encoding: 'utf8', timeout: 5000, env: { ...env,
    OCR_GAUNTLET_SET: corpus, OCR_GAUNTLET_ROOT: options.root, OCR_GAUNTLET_CASES_JSON: JSON.stringify(cases),
    OCR_DUAL_GAUNTLET_ROWS: options.rowsPath, OCR_DUAL_GAUNTLET_REPORT: reportPath,
  } })
  assert.equal(child.error, undefined)
  assert.equal(child.status, 1)
  const summary = JSON.parse(child.stdout.trim())
  assert.equal(summary.complete, false)
  assert.equal(summary.valid_provider_replay, false)
  assert.deepEqual(summary.stop_reason, { provider: 'zai', category: 'http_error', http_status: 429 })
  assert.equal(summary.attempts, 4)
  const report = await readFile(reportPath, 'utf8')
  assert.deepEqual(JSON.parse(report).stop_reason, summary.stop_reason)
  for (const serialized of [child.stdout, child.stderr, report, await readFile(options.rowsPath, 'utf8')]) {
    assert.equal(serialized.includes(secret), false)
    assert.equal(serialized.includes('dual_scan_gauntlet_failed'), false)
  }
})

test('runner deadline aborts real handler transports, records failure, and preserves skipped rows without starting another paid attempt', async (t) => {
  const options = await fixture(t, 2)
  let calls = 0
  globalThis.fetch = async (url, init) => {
    calls++
    return new Promise((resolve, reject) => {
      if (init.signal.aborted) reject(new DOMException(secret, 'AbortError'))
      else init.signal.addEventListener('abort', () => reject(new DOMException(secret, 'AbortError')), { once: true })
    })
  }
  const report = await runDualScanGauntlet({ ...options, env, cases, timeoutMs: 50 })
  assert.equal(calls, 2, 'both legs launch, and no next attempt starts after the deadline')
  assert.equal(report.complete, false)
  assert.equal(report.valid_provider_replay, false)
  const rows = report.cases.flatMap(({ report: arm }) => arm.rows)
  assert.equal(rows.filter((row) => row.runner_failure === 'runner_timeout').length, 1)
  assert.equal(rows.filter((row) => row.runner_failure === 'not_attempted_after_timeout').length, 3)
  for (const { report: arm } of report.cases) {
    assert.equal(arm.n, 2)
    assert.equal(arm.total_exact_denominator, 2)
    assert.equal(arm.items_exact_denominator, 2)
    assert.equal(arm.total_exact, 0)
  }
  assert.equal((await readFile(options.rowsPath, 'utf8')).trim().split('\n').map(JSON.parse).filter((row) => row.event === 'attempt').length, 4)
})

test('oversize input cannot produce a zero-provider faux pass, and explicit paired order cannot be omitted or caps overridden', async (t) => {
  const options = await fixture(t, 1)
  let calls = 0
  globalThis.fetch = async () => { calls++; assert.fail('oversize image reached provider') }
  const report = await runDualScanGauntlet({ ...options, env, cases, readImage: async () => new Uint8Array(10 * 1024 * 1024 + 1) })
  assert.equal(calls, 0)
  assert.equal(report.complete, true)
  assert.equal(report.valid_provider_replay, false)
  assert.equal(report.inventory.eligible_image_count, 1)
  for (const { report: arm } of report.cases) {
    assert.equal(arm.total_exact_denominator, 1)
    assert.equal(arm.usage_tokens.input, null)
    assert.equal(arm.usage_tokens.attempts_with_input_usage, 0)
    assert.equal(arm.rows[0].failure_code, 'input_too_large')
    assert.equal(arm.rows[0].provider_started, false)
  }
  await assert.rejects(runDualScanGauntlet({ ...options, env: { ...env, OCR_GAUNTLET_CASE_ORDER: '' }, cases }), /rotating_order/)
  await assert.rejects(runDualScanGauntlet({ ...options, env, cases: [{ ...cases[0], env: { ...cases[0].env, LLM_SCAN_DAILY_CAP: '999999' } }, cases[1]] }), /explicit_settled_pair/)
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('prebuilt-receipt:analyze')) return new Response(null, { status: 202,
      headers: { 'operation-location': `${env.AZURE_OCR_ENDPOINT}/analyzeResults/local` } })
    if (String(url).includes('/analyzeResults/')) return azureResult()
    assert.ok(String(url).endsWith('/chat/completions'))
    const model = JSON.parse(init.body).model
    return llmResult(expected, model, model === cases[0].env.LLM_SCAN_MODEL ? null
      : { prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } })
  }
  const usageReport = await runDualScanGauntlet({ ...options, rowsPath: join(options.root, 'usage.rows.jsonl'), env, cases })
  for (const { name, report: arm } of usageReport.cases) {
    const known = name === 'candidate' ? 1 : 0
    assert.deepEqual(arm.usage_tokens, {
      input: known ? 0 : null, cached_input: known ? 0 : null, output: known ? 0 : null, total: null,
      attempts_with_input_usage: known, attempts_with_output_usage: known,
      attempts_with_cached_input_usage: known, attempts_with_total_usage: 0,
    })
  }
})
