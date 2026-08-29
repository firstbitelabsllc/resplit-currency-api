import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { handleOcr } from '../worker/src/ocr/router.mjs'

const realFetch = globalThis.fetch
const realConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
}

beforeEach(() => {
  globalThis.testLogs = []
  console.log = (line) => { globalThis.testLogs.push(String(line)) }
  console.warn = () => {}
  console.error = () => {}
})

afterEach(() => {
  globalThis.fetch = realFetch
  console.log = realConsole.log
  console.warn = realConsole.warn
  console.error = realConsole.error
})

function makeKV() {
  const store = new Map()
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null },
    async put(key, value) { store.set(key, value) },
    async delete(key) { store.delete(key) },
  }
}

function makeAccountingBinding() {
  const records = { reservations: [], commits: [], refunds: [] }
  const reservations = new Map()
  return {
    records,
    idFromName() { return { name: 'ocr-accounting-test' } },
    get() {
      return {
        async reserve(input) {
          const request = structuredClone(input)
          records.reservations.push(request)
          const decision = {
            ok: true,
            day: request.day,
            reservationId: request.reservationId,
            azure: { allowed: true, requestedUnits: request.azureUnits, reason: 'reserved' },
            anthropic: {
              allowed: true,
              requestedUnits: request.anthropicUnits,
              reason: request.anthropicUnits ? 'reserved' : 'not_requested',
            },
          }
          reservations.set(request.reservationId, { request, decision, settled: false })
          return decision
        },
        async commit(input) {
          const request = structuredClone(input)
          records.commits.push(request)
          const reservation = reservations.get(request.reservationId)
          const reserved = reservation.request
          assert.equal(reservation.settled, false, 'a scan must settle its reservation exactly once')
          reservation.settled = true
          return {
            ok: true,
            status: 'committed',
            azure: { committedUnits: request.azureUnits, refundedUnits: reserved.azureUnits - request.azureUnits },
            anthropic: {
              committedUnits: request.anthropicUnits,
              refundedUnits: reserved.anthropicUnits - request.anthropicUnits,
            },
          }
        },
        async refund(input) {
          const request = structuredClone(input)
          records.refunds.push(request)
          const reservation = reservations.get(request.reservationId)
          reservation.settled = true
          return {
            ok: true,
            status: 'refunded',
            azure: { committedUnits: 0, refundedUnits: reservation.request.azureUnits },
            anthropic: { committedUnits: 0, refundedUnits: reservation.request.anthropicUnits },
          }
        },
      }
    },
  }
}

function makeCtx() {
  return {
    tasks: [],
    waitUntil(task) { this.tasks.push(task) },
  }
}

function jpegWithDimensions(width, height) {
  return new Uint8Array([
    0xFF, 0xD8,
    0xFF, 0xC0,
    0x00, 0x11,
    0x08,
    (height >> 8) & 0xFF, height & 0xFF,
    (width >> 8) & 0xFF,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ])
}

function azureReceipt(total = 10) {
  return {
    status: 'succeeded',
    analyzeResult: {
      documents: [{
        docType: 'receipt',
        fields: {
          Total: { type: 'currency', valueCurrency: { amount: total, currencyCode: 'USD' } },
        },
      }],
    },
  }
}

function scannedReceipt(total = 10) {
  return {
    merchantName: 'Fast Response Cafe',
    merchantAddress: null,
    transactionDate: '2026-08-29',
    currencyCode: 'USD',
    currencySymbol: '$',
    lineItems: [{ name: 'Coffee', amount: total - 1, quantity: 1 }],
    subtotal: total - 1,
    total,
    extras: [{ label: 'Tax', amount: 1, kind: 'tax' }],
  }
}

function anthropicToolResponse(scanned) {
  return {
    id: 'msg_fast_response',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    content: [{ type: 'tool_use', id: 'toolu_fast_response', name: 'emit_receipt', input: scanned }],
    stop_reason: 'tool_use',
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function stubProviders({ azure = azureReceipt(), azureStatus = 202, llm } = {}) {
  const calls = { azureSubmit: 0, azurePoll: 0, anthropic: 0 }
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url)
    if (target === 'https://api.anthropic.com/v1/messages') {
      calls.anthropic += 1
      return llm.promise.then(() => Response.json(anthropicToolResponse(scannedReceipt())))
    }
    if (init.method === 'POST' && target.includes(':analyze')) {
      calls.azureSubmit += 1
      if (azureStatus !== 202) return new Response('azure rejected', { status: azureStatus })
      return new Response('', {
        status: 202,
        headers: {
          'operation-location': 'https://test.cognitiveservices.azure.com/documentintelligence/documentModels/prebuilt-receipt/analyzeResults/op-receipt?api-version=2024-11-30',
        },
      })
    }
    if (target.includes('/analyzeResults/')) {
      calls.azurePoll += 1
      return Response.json(azure, { status: 200 })
    }
    throw new Error(`unexpected fetch ${init.method || 'GET'} ${target}`)
  }
  return calls
}

function makeEnv(accounting, extra = {}) {
  return {
    ATTEST_KV: makeKV(),
    AZURE_OCR_ENDPOINT: 'https://test.cognitiveservices.azure.com',
    AZURE_OCR_KEY: 'azure-test-key',
    ANTHROPIC_API_KEY: 'anthropic-test-key',
    SENTRY_ENVIRONMENT: 'test',
    LLM_SCAN_ALLOW_SOFT_FAIL: 'true',
    LLM_SCAN_AZURE_GRACE_MS: '20',
    OCR_ACCOUNTING_MODE: 'enforce',
    OCR_ACCOUNTING_HMAC_KEY: 'fast-response-accounting-hmac-key',
    OCR_AZURE_GLOBAL_DAILY_CAP: '1',
    OCR_ANTHROPIC_GLOBAL_DAILY_CAP: '1',
    OCR_ACCOUNTING: accounting,
    ...extra,
  }
}

function scanRequest(imageBytes) {
  return new Request('https://fx.resplit.app/ocr/dual-scan', {
    method: 'POST',
    headers: {
      'content-type': 'image/jpeg',
      'x-resplit-attest-soft-fail': 'true',
      'cf-connecting-ip': '198.51.100.42',
    },
    body: imageBytes,
  })
}

async function settleTasks(ctx) {
  await Promise.allSettled(ctx.tasks)
}

test('OCR returns the combined result when the LLM wins the Azure grace race', async () => {
  const llm = deferred()
  const calls = stubProviders({ llm })
  const accounting = makeAccountingBinding()
  const ctx = makeCtx()
  const started = Date.now()

  llm.resolve()
  const response = await handleOcr(scanRequest(jpegWithDimensions(810, 610)), makeEnv(accounting), ctx)
  assert.ok(Date.now() - started < 1_000)
  assert.equal(response.status, 200)

  const body = await response.json()
  assert.equal(body.status, 'succeeded')
  assert.equal(body.azure.status, 'succeeded')
  assert.equal(body.llm.status, 'succeeded')
  assert.equal(calls.anthropic, 1)
  assert.deepEqual(ctx.tasks, [])
  assert.equal(accounting.records.commits.length, 1)
  assert.equal(accounting.records.commits[0].anthropicUnits, 1)
})

test('OCR releases Azure success after the grace window and finishes the LLM in the background', async () => {
  const llm = deferred()
  const calls = stubProviders({ llm })
  const accounting = makeAccountingBinding()
  const ctx = makeCtx()
  const started = Date.now()

  const env = makeEnv(accounting)
  const response = await handleOcr(scanRequest(jpegWithDimensions(811, 611)), env, ctx)
  assert.ok(Date.now() - started < 1_000, 'grace expiry must release the caller without waiting for the LLM')
  assert.equal(response.status, 200)

  const body = await response.json()
  assert.equal(body.status, 'partial')
  assert.equal(body.azure.status, 'succeeded')
  assert.equal(body.llm.status, 'provider_error')
  assert.equal(body.divergence, null)
  assert.equal(calls.anthropic, 1, 'the late leg must remain started and observable')
  assert.equal(ctx.tasks.length, 1)
  assert.equal(accounting.records.commits.length, 0, 'accounting waits for the real late provider outcome')

  llm.resolve()
  await settleTasks(ctx)

  assert.equal(accounting.records.commits.length, 1)
  assert.equal(accounting.records.commits[0].azureUnits, 1)
  assert.equal(accounting.records.commits[0].anthropicUnits, 1)
  const cacheKeys = [...env.ATTEST_KV.store.keys()].filter((key) => key.startsWith('cache:'))
  assert.equal(cacheKeys.length, 1)
  const lateEvents = globalThis.testLogs
    .filter((line) => line.includes('[OCR_MONITORING]'))
    .map((line) => JSON.parse(line.split('[OCR_MONITORING] ')[1]))
  assert.equal(lateEvents.at(-1)?.signal, 'ocr_llm_late_result')
})

test('A late failed LLM is not cached and still settles only the Azure unit', async () => {
  const llm = deferred()
  stubProviders({ llm })
  const accounting = makeAccountingBinding()
  const ctx = makeCtx()
  const env = makeEnv(accounting)

  const response = await handleOcr(scanRequest(jpegWithDimensions(812, 612)), env, ctx)
  const body = await response.json()
  assert.equal(body.status, 'partial')
  assert.equal(body.llm.status, 'provider_error')
  assert.deepEqual([...env.ATTEST_KV.store.keys()].filter((key) => key.startsWith('cache:')), [])

  llm.reject(new Error('late provider failed'))
  await settleTasks(ctx)

  assert.equal(accounting.records.commits.length, 1)
  assert.equal(accounting.records.commits[0].azureUnits, 1)
  assert.equal(accounting.records.commits[0].anthropicUnits, 1, 'a started late provider call remains chargeable')
  assert.deepEqual([...env.ATTEST_KV.store.keys()].filter((key) => key.startsWith('cache:')), [])
})

test('OCR does not release early when Azure fails, even if the grace timer expires', async () => {
  const llm = deferred()
  stubProviders({ azureStatus: 500, llm })
  const accounting = makeAccountingBinding()
  const ctx = makeCtx()

  const pending = handleOcr(scanRequest(jpegWithDimensions(813, 613)), makeEnv(accounting), ctx)
  let settled = false
  void pending.then(() => { settled = true })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(settled, false, 'Azure failure still needs the potentially useful LLM result')

  llm.resolve()
  const response = await pending
  const body = await response.json()
  assert.equal(body.status, 'partial', 'the surviving LLM parse is useful even without Azure')
  assert.equal(body.azure.status, 'provider_error')
  assert.equal(body.llm.status, 'succeeded')
  assert.deepEqual(ctx.tasks, [])
})
