import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { handleOcr } from '../worker/src/ocr/router.mjs'
import { handleRequest } from '../worker/src/index.mjs'

const VALID_HMAC_KEY = 'shadow-accounting-test-key-material-'.repeat(2)
const RAW_PRINCIPAL = '198.51.100.88'
const TRACE_ID = 'trace-shadow-accounting-test'
const FIXED_SCAN_ID = '018f47a3-67e2-7cc1-b9b4-21d5d9a87f31'

const realFetch = globalThis.fetch
const realDate = globalThis.Date
const realRandomUUID = globalThis.crypto.randomUUID
const realWarn = console.warn

afterEach(() => {
  globalThis.fetch = realFetch
  globalThis.Date = realDate
  globalThis.crypto.randomUUID = realRandomUUID
  console.warn = realWarn
})

function makeKV(events = []) {
  const store = new Map()
  return {
    store,
    async get(key) {
      if (String(key).startsWith('cache:')) events.push({ type: 'cache:get', key })
      return store.has(key) ? store.get(key) : null
    },
    async put(key, value) {
      store.set(key, value)
    },
    async delete(key) {
      store.delete(key)
    },
  }
}

function allowedDecision(reservation) {
  return {
    ok: true,
    day: reservation.day,
    reservationId: reservation.reservationId,
    azure: {
      allowed: true,
      requestedUnits: reservation.azureUnits,
      reason: reservation.azureUnits === 0 ? 'not_requested' : 'reserved',
    },
    anthropic: {
      allowed: true,
      requestedUnits: reservation.anthropicUnits,
      reason: reservation.anthropicUnits === 0 ? 'not_requested' : 'reserved',
    },
    usage: {
      global: { azureUnits: reservation.azureUnits, anthropicUnits: reservation.anthropicUnits },
      subject: { azureUnits: reservation.azureUnits, anthropicUnits: reservation.anthropicUnits },
    },
  }
}

function makeAccountingBinding({ events = [], reserveError = null } = {}) {
  const records = { names: [], ids: [], reservations: [] }
  return {
    records,
    idFromName(name) {
      records.names.push(name)
      events.push({ type: 'accounting:id', name })
      return { name }
    },
    get(id) {
      records.ids.push(id)
      return {
        async reserve(input) {
          const reservation = structuredClone(input)
          records.reservations.push(reservation)
          events.push({ type: 'accounting:reserve', reservation })
          if (reserveError) throw reserveError
          return allowedDecision(reservation)
        },
      }
    },
  }
}

function makeExecutionContext() {
  const tasks = []
  return {
    tasks,
    waitUntil(task) {
      tasks.push(Promise.resolve(task))
    },
    passThroughOnException() {},
    async drain() {
      for (let index = 0; index < tasks.length; index += 1) {
        await tasks[index]
      }
    },
  }
}

function makeEnv({ events = [], accounting = makeAccountingBinding({ events }), ...extra } = {}) {
  return {
    ATTEST_KV: makeKV(events),
    AZURE_OCR_ENDPOINT: 'https://test.cognitiveservices.azure.com',
    AZURE_OCR_KEY: 'azure-test-key',
    ANTHROPIC_API_KEY: 'anthropic-test-key',
    SENTRY_ENVIRONMENT: 'test',
    LLM_SCAN_MODEL: 'claude-sonnet-5',
    LLM_SCAN_ALLOW_SOFT_FAIL: 'true',
    LLM_SCAN_DAILY_CAP: '50',
    OCR_ACCOUNTING_MODE: 'shadow',
    OCR_ACCOUNTING_HMAC_KEY: VALID_HMAC_KEY,
    OCR_ACCOUNTING: accounting,
    ...extra,
  }
}

function ocrRequest(path, imageBytes, headers = {}) {
  return new Request(`https://fx.resplit.app${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'image/jpeg',
      'x-resplit-attest-soft-fail': 'true',
      'x-resplit-trace-id': TRACE_ID,
      'cf-connecting-ip': RAW_PRINCIPAL,
      ...headers,
    },
    body: imageBytes,
  })
}

function azureRaw() {
  return {
    status: 'succeeded',
    analyzeResult: {
      documents: [{
        docType: 'receipt',
        fields: {
          Total: { type: 'currency', valueCurrency: { amount: 10, currencyCode: 'USD' } },
        },
      }],
    },
  }
}

function anthropicToolResponse() {
  return {
    id: 'msg_shadow_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    content: [{
      type: 'tool_use',
      id: 'toolu_shadow_test',
      name: 'emit_receipt',
      input: {
        merchantName: 'Accounting Test Cafe',
        merchantAddress: null,
        transactionDate: '2026-07-10',
        currencyCode: 'USD',
        currencySymbol: '$',
        lineItems: [{ name: 'Meal', amount: 9, quantity: 1 }],
        subtotal: 9,
        total: 10,
        extras: [{ label: 'Tax', amount: 1, kind: 'tax' }],
      },
    }],
    stop_reason: 'tool_use',
  }
}

function stubProviders() {
  const calls = { azureReceiptSubmit: 0, azureLayoutSubmit: 0, azurePoll: 0, anthropic: 0 }
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url)
    if (target === 'https://api.anthropic.com/v1/messages') {
      calls.anthropic += 1
      return Response.json(anthropicToolResponse(), { status: 200 })
    }
    if (init.method === 'POST' && target.includes(':analyze')) {
      const layout = target.includes('/documentModels/prebuilt-layout:analyze')
      if (layout) calls.azureLayoutSubmit += 1
      else calls.azureReceiptSubmit += 1
      const model = layout ? 'prebuilt-layout' : 'prebuilt-receipt'
      return new Response('', {
        status: 202,
        headers: {
          'operation-location': `https://test.cognitiveservices.azure.com/documentintelligence/documentModels/${model}/analyzeResults/op-${model}?api-version=2024-11-30`,
        },
      })
    }
    if (target.includes('/analyzeResults/')) {
      calls.azurePoll += 1
      if (target.includes('/documentModels/prebuilt-layout/')) {
        return Response.json({
          status: 'succeeded',
          analyzeResult: { keyValuePairs: [{ key: { content: 'Tip' }, value: { content: '$2.00' } }] },
        }, { status: 200 })
      }
      return Response.json(azureRaw(), { status: 200 })
    }
    throw new Error(`unexpected provider call ${init.method || 'GET'} ${target}`)
  }
  return calls
}

async function runRequest({ path = '/ocr/scan', bytes, env, ctx = makeExecutionContext(), headers = {} }) {
  const response = await handleOcr(ocrRequest(path, bytes, headers), env, ctx)
  await ctx.drain()
  return { response, body: await response.clone().json(), ctx }
}

async function withFrozenTime(iso, operation) {
  class FrozenDate extends realDate {
    constructor(...args) {
      super(...(args.length > 0 ? args : [iso]))
    }

    static now() {
      return realDate.parse(iso)
    }
  }
  globalThis.Date = FrozenDate
  try {
    return await operation()
  } finally {
    globalThis.Date = realDate
  }
}

function jpegFixture(seed) {
  return new Uint8Array([
    0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08,
    0x02, 0x58, 0x03, 0x20, 0x03,
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    seed,
  ])
}

function shadowFailureEvents(lines) {
  return lines
    .filter((line) => typeof line === 'string' && line.startsWith('[OCR_MONITORING] '))
    .map((line) => JSON.parse(line.slice('[OCR_MONITORING] '.length)))
    .filter((event) => event.signal === 'ocr_accounting_shadow_failure')
}

test('legacy accounting mode performs zero shadow work', async () => {
  const calls = stubProviders()
  const events = []
  const accounting = makeAccountingBinding({ events })
  const ctx = makeExecutionContext()
  const env = makeEnv({
    events,
    accounting,
    OCR_ACCOUNTING_MODE: 'legacy',
  })

  const { response } = await runRequest({ bytes: jpegFixture(123), env, ctx })

  assert.equal(response.status, 200)
  assert.equal(calls.azureReceiptSubmit, 1)
  assert.equal(ctx.tasks.length, 0, 'legacy mode must not hand work to waitUntil')
  assert.deepEqual(accounting.records, { names: [], ids: [], reservations: [] })
})

test('the real Worker request entrypoint retains shadow work with ExecutionContext', async () => {
  stubProviders()
  const accounting = makeAccountingBinding()
  const env = makeEnv({ accounting })
  const ctx = makeExecutionContext()

  const response = await handleRequest(
    ocrRequest('/ocr/scan', jpegFixture(124)),
    env,
    ctx,
  )
  await ctx.drain()

  assert.equal(response.status, 200)
  assert.equal(ctx.tasks.length, 1)
  assert.equal(accounting.records.reservations.length, 1)
})

test('shadow accounting starts only after a cache miss and never reserves a cache hit', async () => {
  const calls = stubProviders()
  const events = []
  const accounting = makeAccountingBinding({ events })
  const env = makeEnv({ events, accounting })
  const image = jpegFixture(98)

  await runRequest({ bytes: image, env })
  assert.equal(accounting.records.reservations.length, 1, 'one fresh provider scan must reserve once')
  const cacheReadIndex = events.findIndex((event) => event.type === 'cache:get')
  const reserveIndex = events.findIndex((event) => event.type === 'accounting:reserve')
  assert.ok(cacheReadIndex >= 0, 'the idempotency cache must be read')
  assert.ok(reserveIndex > cacheReadIndex, 'shadow reservation must be scheduled only after cache miss is known')

  await runRequest({ bytes: image, env })

  assert.equal(accounting.records.reservations.length, 1, 'cache replay must not create a second reservation')
  assert.equal(calls.azureReceiptSubmit, 1, 'cache replay must not call Azure again')
})

test('raw shadow reservations charge one Azure unit, or two when key-value extras are enabled', async () => {
  stubProviders()
  const normalAccounting = makeAccountingBinding()
  const normalEnv = makeEnv({ accounting: normalAccounting })
  await runRequest({ bytes: jpegFixture(111), env: normalEnv })

  assert.equal(normalAccounting.records.reservations.length, 1)
  assert.equal(normalAccounting.records.reservations[0].azureUnits, 1)
  assert.equal(normalAccounting.records.reservations[0].anthropicUnits, 0)

  const extrasAccounting = makeAccountingBinding()
  const extrasEnv = makeEnv({
    accounting: extrasAccounting,
    AZURE_OCR_KV_EXTRAS: 'enabled',
  })
  await runRequest({ bytes: jpegFixture(222), env: extrasEnv })

  assert.equal(extrasAccounting.records.reservations.length, 1)
  assert.equal(extrasAccounting.records.reservations[0].azureUnits, 2)
  assert.equal(extrasAccounting.records.reservations[0].anthropicUnits, 0)
})

test('dual-scan shadow reservations charge one Azure and one Anthropic unit', async () => {
  const calls = stubProviders()
  const accounting = makeAccountingBinding()
  const env = makeEnv({ accounting })

  const { response, body } = await runRequest({
    path: '/ocr/dual-scan',
    bytes: jpegFixture(33),
    env,
  })

  assert.equal(response.status, 200)
  assert.equal(body.status, 'succeeded')
  assert.equal(calls.azureReceiptSubmit, 1)
  assert.equal(calls.anthropic, 1)
  assert.equal(accounting.records.reservations.length, 1)
  assert.equal(accounting.records.reservations[0].azureUnits, 1)
  assert.equal(accounting.records.reservations[0].anthropicUnits, 1)
})

test('one stable Durable Object carries rotating UTC-day HMAC subjects without exposing raw identity', async () => {
  stubProviders()
  const accounting = makeAccountingBinding()
  const env = makeEnv({ accounting })

  const first = await withFrozenTime('2026-07-10T12:00:00.000Z', () => runRequest({
    bytes: jpegFixture(41),
    env,
  }))
  const second = await withFrozenTime('2026-07-10T23:59:59.000Z', () => runRequest({
    bytes: jpegFixture(42),
    env,
  }))
  const nextDay = await withFrozenTime('2026-07-11T00:00:01.000Z', () => runRequest({
    bytes: jpegFixture(43),
    env,
  }))

  assert.deepEqual(accounting.records.names, [
    'ocr-accounting-global-v1',
    'ocr-accounting-global-v1',
    'ocr-accounting-global-v1',
  ])

  const [r1, r2, r3] = accounting.records.reservations
  assert.equal(r1.day, '2026-07-10')
  assert.equal(r2.day, '2026-07-10')
  assert.equal(r3.day, '2026-07-11')
  assert.match(r1.subjectToken, /^[0-9a-f]{64}$/)
  assert.equal(r2.subjectToken, r1.subjectToken, 'same subject and UTC day must map to one token')
  assert.notEqual(r3.subjectToken, r1.subjectToken, 'the pseudonym must rotate at the UTC day boundary')

  assert.equal(r1.reservationId, first.body.scanId)
  assert.equal(r2.reservationId, second.body.scanId)
  assert.equal(r3.reservationId, nextDay.body.scanId)
  for (const reservation of [r1, r2, r3]) {
    assert.match(reservation.reservationId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  }
  assert.equal(new Set([r1.reservationId, r2.reservationId, r3.reservationId]).size, 3)

  const durableObjectPayload = JSON.stringify(accounting.records)
  assert.doesNotMatch(durableObjectPayload, /198\.51\.100\.88|shadow-accounting-test-key-material/)
})

async function captureRawResult(options) {
  const { accounting, mode = 'shadow' } = options
  const hmacKey = Object.hasOwn(options, 'hmacKey') ? options.hmacKey : VALID_HMAC_KEY
  const calls = stubProviders()
  const warnings = []
  console.warn = (line) => warnings.push(line)
  globalThis.crypto.randomUUID = () => FIXED_SCAN_ID
  const env = makeEnv({
    accounting,
    OCR_ACCOUNTING_MODE: mode,
    OCR_ACCOUNTING_HMAC_KEY: hmacKey,
  })
  const ctx = makeExecutionContext()
  const response = await withFrozenTime('2026-07-10T15:00:00.000Z', () => handleOcr(
    ocrRequest('/ocr/scan', jpegFixture(77)),
    env,
    ctx,
  ))
  await ctx.drain()
  return {
    status: response.status,
    body: await response.text(),
    contentType: response.headers.get('content-type'),
    requestId: response.headers.get('x-request-id'),
    calls,
    warnings,
  }
}

function assertSafeShadowFailure(event, reason) {
  assert.deepEqual(Object.keys(event).sort(), [
    'domain',
    'enforced',
    'environment',
    'phase',
    'reason',
    'release',
    'route',
    'runtime',
    'signal',
    'status',
    'surface',
    'timestamp',
  ].sort())
  assert.equal(event.signal, 'ocr_accounting_shadow_failure')
  assert.equal(event.phase, 'accounting')
  assert.equal(event.route, 'scan')
  assert.equal(event.status, 'degraded')
  assert.equal(event.reason, reason)
  assert.equal(event.enforced, false)
  assert.equal(event.domain, 'ocr')
  assert.equal(event.runtime, 'worker')
}

test('shadow configuration and RPC failures preserve the exact legacy result with safe enum-only warnings', async () => {
  const baseline = await captureRawResult({
    mode: 'legacy',
    accounting: makeAccountingBinding(),
  })

  for (const hmacKey of [undefined, 'too-short']) {
    const accounting = makeAccountingBinding()
    const degraded = await captureRawResult({ hmacKey, accounting })

    assert.deepEqual(
      { status: degraded.status, body: degraded.body, contentType: degraded.contentType, requestId: degraded.requestId },
      { status: baseline.status, body: baseline.body, contentType: baseline.contentType, requestId: baseline.requestId },
    )
    assert.deepEqual(degraded.calls, baseline.calls)
    assert.deepEqual(accounting.records, { names: [], ids: [], reservations: [] })
    const failures = shadowFailureEvents(degraded.warnings)
    assert.equal(failures.length, 1)
    assertSafeShadowFailure(failures[0], 'hmac_key_unavailable')
    assert.doesNotMatch(
      JSON.stringify(failures[0]),
      /198\.51\.100\.88|too-short|shadow-accounting-test-key-material|trace-shadow|018f47a3/,
    )
  }

  const rawError = 'RAW_DURABLE_OBJECT_ERROR_MUST_NOT_LEAK'
  const accounting = makeAccountingBinding({ reserveError: new Error(rawError) })
  const degraded = await captureRawResult({ accounting })

  assert.deepEqual(
    { status: degraded.status, body: degraded.body, contentType: degraded.contentType, requestId: degraded.requestId },
    { status: baseline.status, body: baseline.body, contentType: baseline.contentType, requestId: baseline.requestId },
  )
  assert.deepEqual(degraded.calls, baseline.calls)
  assert.equal(accounting.records.reservations.length, 1)
  const failures = shadowFailureEvents(degraded.warnings)
  assert.equal(failures.length, 1)
  assertSafeShadowFailure(failures[0], 'reservation_failed')
  assert.doesNotMatch(
    JSON.stringify(failures[0]),
    /RAW_DURABLE_OBJECT_ERROR_MUST_NOT_LEAK|198\.51\.100\.88|shadow-accounting-test-key-material|trace-shadow|018f47a3/,
  )
})
