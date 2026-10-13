#!/usr/bin/env node
// Local signed /ocr/analyze replay. Inference and admission remain in handleOcr;
// inventory, pairing, and scoring remain in the existing provider gauntlet.
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { handleOcr } from '../worker/src/ocr/router.mjs'
import { closedOcrFailureDiagnostic } from '../worker/src/ocr/monitoring.mjs'
import { inventoryReceiptSet, loadReceiptSet, percentile, runProviderMatrix, validateProviderCases } from './ocr-scan-gauntlet.mjs'

const { stripJsonComments } = createRequire(import.meta.url)('./reliability-cockpit.js')
const APP_ID = 'QSL6XFT438.com.superfit.Resplit'
const GLM_URL = 'https://api.z.ai/api/coding/paas/v4'
const GEMINI_URL = 'https://openrouter.ai/api/v1'
const GLM_MODEL = 'glm-5.3-flash'
const GEMINI_MODEL = 'google/gemini-2.5-flash-lite'
const STATUSES = new Set(['succeeded', 'partial', 'provider_error', 'provider_unavailable', 'not_allowed', 'not_started', 'rate_limited'])
const hash = (value) => createHash('sha256').update(value).digest()
const finite = (value) => Number.isFinite(value) && value >= 0 ? value : null
const tokens = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null
const status = (value) => STATUSES.has(value) ? value : null

function registeredRequest(bytes, mimeType, kv) {
  // Same ES256 nonce contract as ocr-dual-scan.test.js, with Node's native DER
  // signer. This is a fresh LOCAL registered public key, never Apple enrollment.
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const keyId = hash(spki).toString('base64')
  kv.put(`attest:${keyId}`, JSON.stringify({ publicKeyB64: spki.toString('base64'), signCount: 0 }))
  const authData = Buffer.alloc(37)
  hash(APP_ID).copy(authData)
  authData.writeUInt32BE(1, 33)
  const nonce = hash(Buffer.concat([authData, hash(bytes)]))
  const signature = sign('sha256', nonce, privateKey)
  const text = (value) => Buffer.concat([Buffer.from([0x60 | value.length]), Buffer.from(value)])
  const bstr = (value) => Buffer.concat([Buffer.from([0x58, value.length]), value])
  const assertion = Buffer.concat([
    Buffer.from([0xa2]), text('signature'), bstr(signature), text('authenticatorData'), bstr(authData),
  ])
  return new Request('https://ocr-gauntlet.invalid/ocr/analyze', {
    method: 'POST', body: bytes,
    headers: {
      'content-type': mimeType,
      'x-resplit-attest-key-id': keyId,
      'x-resplit-attest-assertion': assertion.toString('base64'),
    },
  })
}

function localState(budget) {
  const store = new Map() // New cache and independently signed principal per attempt.
  const counters = new Map()
  const kv = {
    async get(key) { return (key.startsWith('llmcount:') ? budget : store).get(key) ?? null },
    async put(key, value) { (key.startsWith('llmcount:') ? budget : store).set(key, value) },
  }
  const stub = {
    async advanceAppAttestSignCount({ keyToken, previousSignCount, signCount }) {
      const floor = Math.max(counters.get(keyToken) ?? 0, previousSignCount)
      if (signCount <= floor) return { ok: false, error: 'REPLAY', signCount: floor }
      counters.set(keyToken, signCount)
      return { ok: true, signCount }
    },
  }
  return { ATTEST_KV: kv, OCR_ACCOUNTING: { idFromName: (name) => name, get: () => stub } }
}

function productionOcrVars() {
  const config = JSON.parse(stripJsonComments(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')))
  const vars = config.env.production.vars
  if (vars.OCR_ACCOUNTING_MODE !== 'legacy' || vars.LLM_SCAN_ALLOW_SOFT_FAIL !== 'false'
    || vars.LLM_SCAN_ALLOWED_KEY_IDS !== '') throw new Error('unsupported_local_auth_or_accounting_configuration')
  // No Sentry/export credentials or bindings: monitoring is captured locally.
  return Object.fromEntries(Object.entries(vars).filter(([key]) => /^(?:OCR_|LLM_SCAN_|AZURE_OCR_)/.test(key)))
}

function pairedCases(cases) {
  const validated = validateProviderCases(cases)
  const keys = ['LLM_SCAN_PROVIDER', 'LLM_SCAN_MODEL', 'LLM_SCAN_BASE_URL', 'LLM_SCAN_MAX_EDGE']
  if (validated.length !== 2 || validated.some(({ env }) => Object.keys(env).some((key) => !keys.includes(key)))) {
    throw new Error('explicit_settled_pair_required')
  }
  for (const entry of validated) {
    const isGlm = entry.env.LLM_SCAN_BASE_URL === GLM_URL && entry.env.LLM_SCAN_MODEL === GLM_MODEL
    const isGemini = entry.env.LLM_SCAN_BASE_URL === GEMINI_URL && entry.env.LLM_SCAN_MODEL === GEMINI_MODEL
    const credential = isGlm ? 'ZAI_API_KEY' : 'OPENROUTER_API_KEY'
    if ((!isGlm && !isGemini) || entry.env.LLM_SCAN_PROVIDER !== 'zai' || entry.env.LLM_SCAN_MAX_EDGE !== '1280'
      || (entry.credential_env && entry.credential_env !== credential)) throw new Error('explicit_settled_pair_required')
    entry.credential_env = credential
  }
  if (validated[0].env.LLM_SCAN_MODEL === validated[1].env.LLM_SCAN_MODEL) throw new Error('explicit_settled_pair_required')
  return validated
}

function verifyCommittedCorpus(set, root, setPath) {
  const tracked = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\0'))
  const files = [relative(root, resolve(setPath))]
  for (const receipt of set) {
    const path = receipt.image_path ?? receipt.path
    if (typeof path !== 'string' || !path) continue
    const absolute = isAbsolute(path) ? path : resolve(root, path)
    if (existsSync(absolute) && statSync(absolute).isFile()) files.push(relative(root, absolute))
  }
  if (files.some((path) => !tracked.has(path))) throw new Error('corpus_and_eligible_images_must_be_committed')
  execFileSync('git', ['diff', '--quiet', 'HEAD', '--', ...files], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
}

function monitoring(line) {
  if (typeof line !== 'string' || !line.startsWith('[OCR_MONITORING] ')) return null
  try {
    const row = JSON.parse(line.slice('[OCR_MONITORING] '.length))
    if (row.signal !== 'dual_scan') return null
    const served = row.llm_served_model
    return {
      route: row.route === 'analyze' ? 'analyze' : 'unexpected',
      cache: ['hit', 'miss'].includes(row.cache) ? row.cache : null,
      attest: row.attest === 'pass' ? 'local_signature_pass' : 'unexpected',
      azure_status: status(row.azure_status), llm_status: status(row.llm_status),
      llm_diagnostic: row.llm_diagnostic == null ? null : closedOcrFailureDiagnostic(row.llm_diagnostic),
      azure_ms: finite(row.azure_ms), llm_ms: finite(row.llm_ms), total_ms: finite(row.total_ms),
      // Unknown echoed models are hashed to keep provider-controlled text out.
      served_model: served == null ? null : [GLM_MODEL, GEMINI_MODEL].includes(served)
        ? served : `sha256:${hash(String(served)).toString('hex')}`,
      served_model_matches: typeof row.llm_served_model_matches === 'boolean' ? row.llm_served_model_matches : null,
      input_tokens: tokens(row.llm_input_tokens), cached_input_tokens: tokens(row.llm_cached_input_tokens),
      output_tokens: tokens(row.llm_output_tokens),
    }
  } catch { return null }
}

// Far-I/O stubs are supplied by focused tests through global fetch. The actual
// CLI always forwards to native fetch and to the unmodified handleOcr router.
export async function runDualScanGauntlet({
  set, sourceFormat = 'injected', root, env = process.env, cases,
  rowsPath, readImage, timeoutMs = 120_000,
} = {}) {
  if (env.OCR_GAUNTLET_CASE_ORDER !== 'rotating' || (env.OCR_GAUNTLET_CONCURRENCY ?? '1') !== '1') {
    throw new Error('rotating_order_and_concurrency_one_required')
  }
  if (!rowsPath || !Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('rows_path_and_positive_timeout_required')
  const pair = pairedCases(cases)
  const vars = productionOcrVars()
  for (const key of ['AZURE_OCR_ENDPOINT', 'AZURE_OCR_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY']) {
    if (typeof env[key] !== 'string' || !env[key]) throw new Error('parent_injected_credentials_required')
  }
  const azureUrl = new URL(env.AZURE_OCR_ENDPOINT)
  if (azureUrl.protocol !== 'https:' || azureUrl.username || azureUrl.password || azureUrl.search || azureUrl.hash) {
    throw new Error('invalid_azure_endpoint')
  }
  if (!set) {
    if (!env.OCR_GAUNTLET_SET || !root) throw new Error('explicit_corpus_and_root_required')
    const loaded = await loadReceiptSet({ env })
    set = loaded.receipts
    sourceFormat = loaded.sourceFormat
    verifyCommittedCorpus(set, root, env.OCR_GAUNTLET_SET)
  }
  // Keep source order and truth; give id-less fixtures their original ordinal.
  set = set.map((receipt, index) => ({ ...receipt, id: receipt.id || `fixture-${index + 1}` }))
  const ids = set.map((receipt) => receipt.id)
  if (new Set(ids).size !== ids.length) throw new Error('duplicate_fixture_ids')
  const inventory = await inventoryReceiptSet(set, { root, sourceFormat })
  const fd = openSync(rowsPath, 'wx', 0o600) // Never overwrite an earlier replay.
  const append = (row) => { appendFileSync(fd, `${JSON.stringify(row)}\n`); fsyncSync(fd) }
  const budgets = new Map(pair.map((entry) => [entry.env.LLM_SCAN_MODEL, new Map()]))
  const originalFetch = globalThis.fetch
  const originals = Object.fromEntries(['log', 'warn', 'error', 'info', 'debug'].map((method) => [method, console[method]]))
  let active = null
  let timedOut = false
  let stopReason = null
  let last = null
  for (const method of Object.keys(originals)) console[method] = (line) => {
    const row = monitoring(line)
    if (active && row) active.monitor = row
  }
  globalThis.fetch = async (url, init = {}) => {
    const address = new URL(typeof url === 'string' || url instanceof URL ? url : url.url)
    const llm = active && address.href === `${active.baseUrl}/chat/completions`
    const azure = address.origin === azureUrl.origin && address.pathname.includes('/documentModels/prebuilt-receipt')
    if (!active || (!llm && !azure)) throw new Error('unexpected_transport_boundary')
    // Drain the current Azure operation, but never submit another paid leg
    // after the first rejection/error, including a late-starting paired leg.
    if (stopReason && (llm || init.method === 'POST')) throw new Error('provider_replay_stopped')
    if (llm || (azure && init.method === 'POST')) {
      const key = llm ? 'llm' : 'azure'
      active[`${key}_provider_calls`]++
      active[`${key}_start_ms`] ??= performance.now() - active.started
    }
    const signal = init.signal ? AbortSignal.any([init.signal, active.controller.signal]) : active.controller.signal
    const provider = azure ? 'azure' : active.baseUrl === GLM_URL ? 'zai' : 'openrouter'
    try {
      const response = await originalFetch(url, { ...init, signal })
      if (response.status >= 400) stopReason ??= Object.freeze({ provider, category: 'http_error', http_status: response.status })
      return response
    } catch (error) {
      // Only closed categories survive. Never retain a message, body, URL,
      // credential, or provider-controlled error code in stop evidence.
      const category = signal.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError'
        ? 'transport_timeout' : 'transport_error'
      stopReason ??= Object.freeze({ provider, category, http_status: null })
      throw error
    }
  }
  try {
    append({ event: 'inventory', inventory, expected_attempts: inventory.eligible_image_count * 2 })
    const report = await runProviderMatrix({
      set, sourceFormat, root, env, cases: pair, concurrency: 1, readImage,
      scan: async (bytes, mimeType, caseEnv) => {
        const evidence = {
          azure_provider_calls: 0, llm_provider_calls: 0, azure_start_ms: null, llm_start_ms: null,
          wall_ms: null, scoring_output: 'none', runner_failure: null,
        }
        last = evidence
        if (stopReason) {
          evidence.runner_failure = timedOut ? 'not_attempted_after_timeout' : 'not_attempted_after_provider_stop'
          evidence.stop_reason = stopReason
          return { ok: false, scanned: null, providerStarted: false, failureCode: 'runner_error' }
        }
        const local = localState(budgets.get(caseEnv.LLM_SCAN_MODEL))
        const request = registeredRequest(bytes, mimeType, local.ATTEST_KV)
        const controller = new AbortController()
        active = { ...evidence, controller, baseUrl: caseEnv.LLM_SCAN_BASE_URL, started: performance.now(), monitor: null }
        const timer = setTimeout(() => {
          timedOut = true
          stopReason ??= Object.freeze({ provider: null, category: 'runner_timeout', http_status: null })
          controller.abort()
        }, timeoutMs)
        let body = null
        let httpStatus = null
        try {
          const response = await handleOcr(request, {
            ...vars, ...local, ...caseEnv, AZURE_OCR_ENDPOINT: env.AZURE_OCR_ENDPOINT, AZURE_OCR_KEY: env.AZURE_OCR_KEY,
          })
          httpStatus = response.status
          body = await response.json()
        } catch { evidence.runner_failure = 'runner_error' }
        finally { clearTimeout(timer) }
        evidence.wall_ms = performance.now() - active.started
        evidence.azure_provider_calls = active.azure_provider_calls
        evidence.llm_provider_calls = active.llm_provider_calls
        evidence.azure_start_ms = active.azure_start_ms
        evidence.llm_start_ms = active.llm_start_ms
        const mon = active.monitor
        Object.assign(evidence, mon)
        active = null
        const validEnvelope = body?.v === 2 && Array.isArray(body.engines)
          && body.engines.filter((engine) => engine.id === 'llm').length === 1
          && body.engines.filter((engine) => engine.id === 'azure').length === 1
        const llm = validEnvelope ? body.engines.find((engine) => engine.id === 'llm') : null
        const azure = validEnvelope ? body.engines.find((engine) => engine.id === 'azure') : null
        evidence.status = status(body?.status)
        evidence.azure_status ??= status(azure?.status)
        evidence.llm_status ??= status(llm?.status)
        evidence.azure_ms ??= finite(azure?.latencyMs)
        evidence.llm_ms ??= finite(llm?.latencyMs)
        // Azure can also fail an accepted operation with HTTP200. Its closed
        // engine status is sufficient; malformed LLM output never stops here.
        if (!stopReason && evidence.azure_provider_calls > 0 && evidence.azure_status === 'provider_error') {
          stopReason = Object.freeze({ provider: 'azure', category: 'provider_error', http_status: null })
        }
        evidence.stop_reason = stopReason
        if (timedOut) evidence.runner_failure = 'runner_timeout'
        else if (mon?.cache === 'hit') evidence.runner_failure = 'cache_hit'
        else if (mon && (mon.route !== 'analyze' || mon.attest !== 'local_signature_pass')) evidence.runner_failure = 'route_or_auth_mismatch'
        else if (!validEnvelope && !evidence.runner_failure) evidence.runner_failure = httpStatus === 413 ? 'input_too_large' : 'malformed_envelope'
        else if (validEnvelope && !mon) evidence.runner_failure = 'missing_monitoring'
        const scanned = !evidence.runner_failure && httpStatus === 200 && llm?.status === 'succeeded' ? llm.scanned : null
        evidence.scoring_output = scanned ? 'returned_llm' : azure?.status === 'succeeded' ? 'azure_fallback_ungraded' : 'none'
        return {
          ok: Boolean(scanned), scanned, httpStatus, latencyMs: evidence.wall_ms,
          providerStarted: evidence.azure_provider_calls + evidence.llm_provider_calls > 0,
          failureCode: evidence.runner_failure === 'input_too_large' ? 'input_too_large'
            : evidence.runner_failure ? 'runner_error' : mon?.llm_diagnostic,
          structuredOutputValid: scanned ? true : mon?.llm_diagnostic === 'malformed_output' ? false : null,
          usage: { inputTokens: mon?.input_tokens, cachedInputTokens: mon?.cached_input_tokens, outputTokens: mon?.output_tokens },
        }
      },
      onAttempt: (name, row) => {
        Object.assign(row, {
          wall_ms: null, total_ms: null, azure_ms: null, llm_ms: null,
          azure_status: null, llm_status: null, llm_diagnostic: null, status: null,
          cache: null, azure_provider_calls: 0, llm_provider_calls: 0,
          azure_start_ms: null, llm_start_ms: null, scoring_output: 'none',
        }, last ?? { runner_failure: 'fixture_read_error' })
        row.served_model = last?.served_model ?? null
        row.served_model_matches = last?.served_model_matches ?? null
        append({ event: 'attempt', case: name, ...row })
        last = null
      },
    })
    for (const entry of report.cases) {
      entry.report.model = pair.find((item) => item.name === entry.name).env.LLM_SCAN_MODEL
      // The inherited summary starts sums at zero even with no known usage.
      // Keep reported zero, but make an empty sample explicitly unknown.
      for (const [key, field] of Object.entries({ input: 'input_tokens', cached_input: 'cached_input_tokens', output: 'output_tokens', total: 'total_tokens' })) {
        const countKey = `attempts_with_${key}_usage`
        const usage = entry.report.usage_tokens
        const known = usage[countKey] ?? entry.report.rows.filter((row) => tokens(row[field]) !== null).length
        usage[countKey] = known
        if (known === 0) usage[key] = null
      }
      entry.report.route_latency_ms = Object.fromEntries(['wall_ms', 'total_ms', 'azure_ms', 'llm_ms'].map((key) => {
        const values = entry.report.rows.filter((row) => row.provider_started).map((row) => row[key]).filter(Number.isFinite)
        return [key, { p50: percentile(values, 50), p95: percentile(values, 95), known_attempts: values.length }]
      }))
    }
    const invalidArms = report.cases.filter(({ report: arm }) => !arm.rows.some((row) => row.azure_provider_calls > 0)
      || !arm.rows.some((row) => row.llm_provider_calls > 0)).map(({ name }) => name)
    const instrumentationFailures = report.cases.flatMap(({ report: arm }) => arm.rows)
      .filter((row) => ['runner_error', 'cache_hit', 'route_or_auth_mismatch', 'malformed_envelope', 'missing_monitoring'].includes(row.runner_failure)).length
    Object.assign(report, {
      schema_version: 1, route: '/ocr/analyze', auth: 'local_registered_es256_not_apple_enrollment',
      runtime: 'local_node_not_production_latency', inventory,
      complete: !stopReason && report.cases.every(({ report: arm }) => arm.n === inventory.eligible_image_count),
      valid_provider_replay: !stopReason && invalidArms.length === 0 && instrumentationFailures === 0 && inventory.eligible_image_count > 0,
      stop_reason: stopReason,
      invalid_provider_arms: invalidArms,
      instrumentation_failures: instrumentationFailures,
      scoring_contract: 'Returned LLM only. Azure fallback has no client-equivalent grader; absent LLM remains incorrect in all reference denominators.',
    })
    append({ event: 'complete', complete: report.complete, valid_provider_replay: report.valid_provider_replay, stop_reason: stopReason })
    return report
  } finally {
    globalThis.fetch = originalFetch
    for (const [method, original] of Object.entries(originals)) console[method] = original
    closeSync(fd)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let reportFd = null
  try {
    if (!process.env.OCR_DUAL_GAUNTLET_REPORT || !process.env.OCR_DUAL_GAUNTLET_ROWS
      || resolve(process.env.OCR_DUAL_GAUNTLET_REPORT) === resolve(process.env.OCR_DUAL_GAUNTLET_ROWS)) throw new Error('distinct_output_paths_required')
    const cases = JSON.parse(process.env.OCR_GAUNTLET_CASES_JSON || 'null')
    reportFd = openSync(process.env.OCR_DUAL_GAUNTLET_REPORT, 'wx', 0o600)
    const report = await runDualScanGauntlet({
      cases, root: process.env.OCR_GAUNTLET_ROOT, rowsPath: process.env.OCR_DUAL_GAUNTLET_ROWS,
      timeoutMs: Number(process.env.OCR_DUAL_GAUNTLET_TIMEOUT_MS || 120_000),
    })
    writeFileSync(reportFd, `${JSON.stringify(report, null, 2)}\n`)
    fsyncSync(reportFd)
    console.log(JSON.stringify({ complete: report.complete, valid_provider_replay: report.valid_provider_replay,
      stop_reason: report.stop_reason,
      eligible_images: report.inventory.eligible_image_count, attempts: report.cases.reduce((n, entry) => n + entry.report.n, 0) }))
    if (!report.complete || !report.valid_provider_replay) process.exitCode = 1
  } catch {
    console.error('dual_scan_gauntlet_failed; inspect sanitized rows and local configuration')
    process.exitCode = 1
  } finally {
    if (reportFd !== null) closeSync(reportFd)
  }
}
