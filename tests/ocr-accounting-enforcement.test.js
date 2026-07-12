import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { handleOcr } from '../worker/src/ocr/router.mjs'

const VALID_HMAC_KEY = 'enforced-accounting-test-key-material-'.repeat(2)
const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

function makeBarrierKV(expectedCounterReads = 0) {
  const store = new Map()
  let counterReads = 0
  let releaseCounterReads
  const counterReadBarrier = new Promise((resolve) => { releaseCounterReads = resolve })
  return {
    store,
    async get(key) {
      if (String(key).startsWith('count:') && expectedCounterReads > 0) {
        counterReads += 1
        if (counterReads === expectedCounterReads) releaseCounterReads()
        await counterReadBarrier
      }
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

function makeAccountingBinding({
  azureGlobalCap = 1,
  anthropicGlobalCap = 1,
  reserveError = null,
  settlementError = null,
  mutateDecision = null,
} = {}) {
  const records = { names: [], reservations: [], commits: [], refunds: [] }
  let azureUsage = 0
  let anthropicUsage = 0
  const reservations = new Map()
  return {
    records,
    idFromName(name) {
      records.names.push(name)
      return { name }
    },
    get() {
      return {
        async reserve(input) {
          if (reserveError) throw reserveError
          const request = structuredClone(input)
          records.reservations.push(request)
          const azureAllowed = request.azureUnits <= azureGlobalCap - azureUsage
          const anthropicAllowed = request.anthropicUnits <= anthropicGlobalCap - anthropicUsage
          if (azureAllowed) azureUsage += request.azureUnits
          if (anthropicAllowed) anthropicUsage += request.anthropicUnits
          const decision = {
            ok: true,
            day: request.day,
            reservationId: request.reservationId,
            azure: {
              allowed: azureAllowed,
              requestedUnits: request.azureUnits,
              reason: azureAllowed ? 'reserved' : 'cap_exceeded',
            },
            anthropic: {
              allowed: anthropicAllowed,
              requestedUnits: request.anthropicUnits,
              reason: request.anthropicUnits === 0
                ? 'not_requested'
                : anthropicAllowed ? 'reserved' : 'cap_exceeded',
            },
            usage: {
              global: { azureUnits: azureUsage, anthropicUnits: anthropicUsage },
              subject: {
                azureUnits: azureAllowed ? request.azureUnits : 0,
                anthropicUnits: anthropicAllowed ? request.anthropicUnits : 0,
              },
            },
          }
          reservations.set(request.reservationId, { request, decision, settled: false })
          return mutateDecision ? mutateDecision(structuredClone(decision)) : decision
        },
        async commit(input) {
          if (settlementError) throw settlementError
          const request = structuredClone(input)
          records.commits.push(request)
          const reservation = reservations.get(request.reservationId)
          const reservedAzure = reservation?.decision.azure.allowed ? reservation.request.azureUnits : 0
          const reservedAnthropic = reservation?.decision.anthropic.allowed ? reservation.request.anthropicUnits : 0
          if (reservation && !reservation.settled) {
            azureUsage -= reservedAzure - request.azureUnits
            anthropicUsage -= reservedAnthropic - request.anthropicUnits
            reservation.settled = true
          }
          return {
            ok: true,
            status: 'committed',
            azure: { committedUnits: request.azureUnits, refundedUnits: reservedAzure - request.azureUnits },
            anthropic: {
              committedUnits: request.anthropicUnits,
              refundedUnits: reservedAnthropic - request.anthropicUnits,
            },
          }
        },
        async refund(input) {
          if (settlementError) throw settlementError
          const request = structuredClone(input)
          records.refunds.push(request)
          const reservation = reservations.get(request.reservationId)
          const reservedAzure = reservation?.decision.azure.allowed ? reservation.request.azureUnits : 0
          const reservedAnthropic = reservation?.decision.anthropic.allowed ? reservation.request.anthropicUnits : 0
          if (reservation && !reservation.settled) {
            azureUsage -= reservedAzure
            anthropicUsage -= reservedAnthropic
            reservation.settled = true
          }
          return {
            ok: true,
            status: 'refunded',
            azure: { committedUnits: 0, refundedUnits: reservedAzure },
            anthropic: { committedUnits: 0, refundedUnits: reservedAnthropic },
          }
        },
      }
    },
  }
}

function makeEnv({ accounting = makeAccountingBinding(), counterReads = 0, ...extra } = {}) {
  return {
    ATTEST_KV: makeBarrierKV(counterReads),
    AZURE_OCR_ENDPOINT: 'https://test.cognitiveservices.azure.com',
    AZURE_OCR_KEY: 'azure-test-key',
    SENTRY_ENVIRONMENT: 'test',
    SOFT_FAIL_DAILY_CAP: '100',
    OCR_ACCOUNTING_MODE: 'enforce',
    OCR_ACCOUNTING_HMAC_KEY: VALID_HMAC_KEY,
    OCR_AZURE_GLOBAL_DAILY_CAP: '1',
    OCR_ANTHROPIC_GLOBAL_DAILY_CAP: '1',
    OCR_ACCOUNTING: accounting,
    ...extra,
  }
}

function scanRequest(imageBytes) {
  return new Request('https://fx.resplit.app/ocr/scan', {
    method: 'POST',
    headers: {
      'content-type': 'image/jpeg',
      'x-resplit-attest-soft-fail': 'true',
      'cf-connecting-ip': '198.51.100.42',
    },
    body: imageBytes,
  })
}

function dualScanRequest(imageBytes) {
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

function stubAzure({ submitStatus = 202 } = {}) {
  const calls = { submit: 0, poll: 0, anthropic: 0 }
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url)
    if (target === 'https://api.anthropic.com/v1/messages') {
      calls.anthropic += 1
      return Response.json({
        model: 'claude-sonnet-5',
        stop_reason: 'tool_use',
        content: [{
          type: 'tool_use',
          name: 'emit_receipt',
          input: {
            merchantName: 'Atomic Cafe',
            merchantAddress: null,
            transactionDate: '2026-07-11',
            currencyCode: 'USD',
            currencySymbol: '$',
            lineItems: [{ name: 'Meal', amount: 9, quantity: 1 }],
            subtotal: 9,
            total: 10,
            extras: [{ label: 'Tax', amount: 1, kind: 'tax' }],
          },
        }],
      })
    }
    if (init.method === 'POST' && target.includes(':analyze')) {
      calls.submit += 1
      if (submitStatus !== 202) return new Response('provider rejected', { status: submitStatus })
      return new Response('', {
        status: 202,
        headers: {
          'operation-location': 'https://test.cognitiveservices.azure.com/documentintelligence/documentModels/prebuilt-receipt/analyzeResults/op-receipt?api-version=2024-11-30',
        },
      })
    }
    if (target.includes('/analyzeResults/')) {
      calls.poll += 1
      return Response.json({
        status: 'succeeded',
        analyzeResult: { documents: [{ docType: 'receipt' }] },
      })
    }
    throw new Error(`unexpected provider call ${init.method || 'GET'} ${target}`)
  }
  return calls
}

test('enforced accounting admits exactly one of twelve concurrent unique scans at a global cap of one', async () => {
  const calls = stubAzure()
  const accounting = makeAccountingBinding({ azureGlobalCap: 1 })
  // The barrier deterministically reproduces the legacy KV read/modify/write race:
  // all twelve requests read the old value before any write can land.
  const env = makeEnv({ accounting, counterReads: 12 })

  const responses = await Promise.all(
    Array.from({ length: 12 }, (_, index) => handleOcr(
      scanRequest(new Uint8Array([index + 1, 99, 42])),
      env,
    ))
  )

  assert.equal(responses.filter((response) => response.status === 200).length, 1)
  assert.equal(responses.filter((response) => response.status === 429).length, 11)
  assert.equal(calls.submit, 1, 'the global cap must bound paid Azure submissions, not just stored counters')
  assert.equal(accounting.records.reservations.length, 12, 'every cache miss must reach the one atomic admission point')
  assert.equal(accounting.records.commits.length, 1, 'the one admitted provider call must be committed')
})

test('enforced accounting fails closed before providers when the reservation store is unavailable', async () => {
  const calls = stubAzure()
  const accounting = makeAccountingBinding({ reserveError: new Error('durable object unavailable') })
  const env = makeEnv({ accounting })

  const response = await handleOcr(scanRequest(new Uint8Array([4, 4, 4])), env)

  assert.equal(response.status, 502)
  assert.equal(calls.submit, 0)
  assert.equal(accounting.records.reservations.length, 0)
})

test('enforced accounting fails closed before providers when a global cap is absent or malformed', async () => {
  for (const extra of [
    { OCR_AZURE_GLOBAL_DAILY_CAP: undefined },
    { OCR_ANTHROPIC_GLOBAL_DAILY_CAP: '3000oops' },
  ]) {
    const calls = stubAzure()
    const accounting = makeAccountingBinding()
    const env = makeEnv({ accounting, ...extra })

    const response = await handleOcr(scanRequest(new Uint8Array([6, 1, 6, 1])), env)

    assert.equal(response.status, 502)
    assert.equal(calls.submit, 0)
    assert.equal(accounting.records.reservations.length, 0)
  }
})

test('enforced accounting rejects a stale or malformed reservation RPC decision before providers', async () => {
  const calls = stubAzure()
  const accounting = makeAccountingBinding({
    mutateDecision: (decision) => ({ ...decision, reservationId: 'wrong-reservation' }),
  })
  const env = makeEnv({ accounting })

  const response = await handleOcr(scanRequest(new Uint8Array([3, 1, 4, 1])), env)

  assert.equal(response.status, 502)
  assert.equal(calls.submit, 0)
})

test('enforced accounting refunds a reservation when Azure rejects before starting analysis', async () => {
  const calls = stubAzure({ submitStatus: 500 })
  const accounting = makeAccountingBinding({ azureGlobalCap: 1 })
  const env = makeEnv({ accounting })

  const response = await handleOcr(scanRequest(new Uint8Array([5, 5, 5])), env)

  assert.equal(response.status, 502)
  assert.equal(calls.submit, 1)
  assert.equal(accounting.records.reservations.length, 1)
  assert.equal(accounting.records.commits.length, 0)
  assert.equal(accounting.records.refunds.length, 1)
})

test('enforced accounting remains cache-first and preserves the exact installed raw envelope', async () => {
  const calls = stubAzure()
  const accounting = makeAccountingBinding({ azureGlobalCap: 1 })
  const env = makeEnv({ accounting })
  const image = new Uint8Array([8, 6, 7, 5])

  const first = await handleOcr(scanRequest(image), env)
  const replay = await handleOcr(scanRequest(image), env)

  assert.equal(first.status, 200)
  assert.equal(replay.status, 200)
  assert.deepEqual(await replay.json(), await first.json())
  assert.equal(calls.submit, 1)
  assert.equal(accounting.records.reservations.length, 1)
  assert.equal(accounting.records.commits.length, 1)
})

test('enforced accounting treats a two-Azure-unit extras scan as all-or-nothing', async () => {
  const calls = stubAzure()
  const accounting = makeAccountingBinding({ azureGlobalCap: 1 })
  const env = makeEnv({ accounting, AZURE_OCR_KV_EXTRAS: 'true' })

  const response = await handleOcr(scanRequest(new Uint8Array([2, 4, 6, 8])), env)

  assert.equal(response.status, 429)
  assert.equal(calls.submit, 0)
  assert.equal(accounting.records.reservations[0].azureUnits, 2)
})

test('enforced dual scan preserves Azure when the independent Anthropic ceiling is exhausted', async () => {
  const calls = stubAzure()
  const accounting = makeAccountingBinding({ azureGlobalCap: 1, anthropicGlobalCap: 0 })
  const env = makeEnv({
    accounting,
    ANTHROPIC_API_KEY: 'anthropic-test-key',
    LLM_SCAN_ALLOW_SOFT_FAIL: 'true',
  })

  const response = await handleOcr(dualScanRequest(new Uint8Array([1, 3, 5, 7])), env)
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.status, 'partial')
  assert.equal(body.azure.status, 'succeeded')
  assert.equal(body.llm.status, 'rate_limited')
  assert.equal(calls.submit, 1)
  assert.equal(calls.anthropic, 0)
  assert.deepEqual(accounting.records.commits[0], {
    day: accounting.records.reservations[0].day,
    reservationId: accounting.records.reservations[0].reservationId,
    azureUnits: 1,
    anthropicUnits: 0,
  })
})

test('enforced dual scan commits both provider units after both paid operations start', async () => {
  const calls = stubAzure()
  const accounting = makeAccountingBinding({ azureGlobalCap: 1, anthropicGlobalCap: 1 })
  const env = makeEnv({
    accounting,
    ANTHROPIC_API_KEY: 'anthropic-test-key',
    LLM_SCAN_ALLOW_SOFT_FAIL: 'true',
  })

  const response = await handleOcr(dualScanRequest(new Uint8Array([
    0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08,
    0x02, 0x58, 0x03, 0x20, 0x03,
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    7,
  ])), env)

  assert.equal(response.status, 200)
  assert.equal(calls.submit, 1)
  assert.equal(calls.anthropic, 1)
  assert.deepEqual(accounting.records.commits[0], {
    day: accounting.records.reservations[0].day,
    reservationId: accounting.records.reservations[0].reservationId,
    azureUnits: 1,
    anthropicUnits: 1,
  })
})

test('enforced dual scan refunds Anthropic when local media validation skips the paid call', async () => {
  const calls = stubAzure()
  const accounting = makeAccountingBinding({ azureGlobalCap: 1, anthropicGlobalCap: 1 })
  const env = makeEnv({
    accounting,
    ANTHROPIC_API_KEY: 'anthropic-test-key',
    LLM_SCAN_ALLOW_SOFT_FAIL: 'true',
  })
  const heic = new Uint8Array([
    0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70,
    0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0,
  ])

  const response = await handleOcr(dualScanRequest(heic), env)

  assert.equal(response.status, 200)
  assert.equal(calls.submit, 1)
  assert.equal(calls.anthropic, 0)
  assert.deepEqual(accounting.records.commits[0], {
    day: accounting.records.reservations[0].day,
    reservationId: accounting.records.reservations[0].reservationId,
    azureUnits: 1,
    anthropicUnits: 0,
  })
})

test('settlement outage keeps the admitted provider result and leaves the reservation charged fail-safe', async () => {
  const calls = stubAzure()
  const accounting = makeAccountingBinding({ settlementError: new Error('settlement unavailable') })
  const env = makeEnv({ accounting })

  const response = await handleOcr(scanRequest(new Uint8Array([9, 9, 2, 2])), env)

  assert.equal(response.status, 200)
  assert.equal(calls.submit, 1)
  assert.equal(accounting.records.reservations.length, 1)
})
