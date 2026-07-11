import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

const DAY = '2026-07-10'
const SUBJECT_TOKEN = 'a'.repeat(64)

function accountingStub(label) {
  const id = env.OCR_ACCOUNTING.idFromName(`${label}-${crypto.randomUUID()}`)
  return env.OCR_ACCOUNTING.get(id)
}

function reservation(overrides = {}) {
  return {
    day: DAY,
    reservationId: crypto.randomUUID(),
    subjectToken: SUBJECT_TOKEN,
    azureUnits: 1,
    anthropicUnits: 0,
    caps: {
      azure: { globalDaily: 100, subjectDaily: 100 },
      anthropic: { globalDaily: 100, subjectDaily: 100 },
    },
    ...overrides,
  }
}

async function snapshot(stub) {
  return runInDurableObject(stub, (_instance, state) => ({
    global: state.storage.sql.exec(
      'SELECT day, azure_units, anthropic_units, azure_cap, anthropic_cap FROM ocr_global_daily ORDER BY day'
    ).toArray(),
    subjects: state.storage.sql.exec(
      'SELECT day, subject_token, azure_units, anthropic_units, azure_cap, anthropic_cap FROM ocr_subject_daily ORDER BY day, subject_token'
    ).toArray(),
    reservations: state.storage.sql.exec(
      'SELECT * FROM ocr_reservations ORDER BY day, reservation_id'
    ).toArray(),
  }))
}

describe('OcrAccounting SQLite Durable Object', () => {
  it('reserves exact units atomically and never overshoots a daily cap', async () => {
    const stub = accountingStub('atomic-cap')
    const caps = {
      azure: { globalDaily: 3, subjectDaily: 3 },
      anthropic: { globalDaily: 3, subjectDaily: 3 },
    }

    const first = await stub.reserve(reservation({ azureUnits: 2, caps }))
    const second = await stub.reserve(reservation({ azureUnits: 2, caps }))

    expect(first.azure).toMatchObject({ allowed: true, requestedUnits: 2, reason: 'reserved' })
    expect(second.azure).toMatchObject({ allowed: false, requestedUnits: 2, reason: 'cap_exceeded' })
    const stored = await snapshot(stub)
    expect(stored.global[0].azure_units).toBe(2)
    expect(stored.subjects[0].azure_units).toBe(2)
  })

  it('returns the original decision for a duplicate reservation without charging twice', async () => {
    const stub = accountingStub('duplicate')
    const request = reservation({ anthropicUnits: 1 })

    const first = await stub.reserve(request)
    const duplicate = await stub.reserve(request)

    expect(duplicate).toEqual(first)
    const stored = await snapshot(stub)
    expect(stored.global[0]).toMatchObject({ azure_units: 1, anthropic_units: 1 })
    expect(stored.subjects[0]).toMatchObject({ azure_units: 1, anthropic_units: 1 })
    expect(stored.reservations).toHaveLength(1)
  })

  it('refunds a failed provider reservation atomically so the released unit can be admitted again', async () => {
    const stub = accountingStub('refund')
    const caps = {
      azure: { globalDaily: 1, subjectDaily: 1 },
      anthropic: { globalDaily: 1, subjectDaily: 1 },
    }
    const failed = reservation({ caps })

    expect((await stub.reserve(failed)).azure.allowed).toBe(true)
    const refunded = await stub.refund({ day: failed.day, reservationId: failed.reservationId })
    expect(refunded).toMatchObject({
      ok: true,
      status: 'refunded',
      azure: { committedUnits: 0, refundedUnits: 1 },
      anthropic: { committedUnits: 0, refundedUnits: 0 },
    })

    const retry = await stub.reserve(reservation({ caps }))
    expect(retry.azure).toMatchObject({ allowed: true, requestedUnits: 1 })
    const stored = await snapshot(stub)
    expect(stored.global[0].azure_units).toBe(1)
    expect(stored.subjects[0].azure_units).toBe(1)
  })

  it('commits only provider units that actually started and refunds the unused reservation remainder', async () => {
    const stub = accountingStub('partial-commit')
    const request = reservation({
      azureUnits: 2,
      anthropicUnits: 1,
      caps: {
        azure: { globalDaily: 2, subjectDaily: 2 },
        anthropic: { globalDaily: 1, subjectDaily: 1 },
      },
    })

    const reserved = await stub.reserve(request)
    expect(reserved.azure.allowed).toBe(true)
    expect(reserved.anthropic.allowed).toBe(true)

    const committed = await stub.commit({
      day: request.day,
      reservationId: request.reservationId,
      azureUnits: 1,
      anthropicUnits: 0,
    })
    expect(committed).toMatchObject({
      ok: true,
      status: 'committed',
      azure: { committedUnits: 1, refundedUnits: 1 },
      anthropic: { committedUnits: 0, refundedUnits: 1 },
    })
    expect(await stub.commit({
      day: request.day,
      reservationId: request.reservationId,
      azureUnits: 1,
      anthropicUnits: 0,
    })).toEqual(committed)

    const stored = await snapshot(stub)
    expect(stored.global[0]).toMatchObject({ azure_units: 1, anthropic_units: 0 })
    expect(stored.subjects[0]).toMatchObject({ azure_units: 1, anthropic_units: 0 })
  })

  it('fails closed when a reservation ID is reused with different subject, units, or caps', async () => {
    const mutations = [
      (request) => ({ ...request, subjectToken: 'b'.repeat(64) }),
      (request) => ({ ...request, azureUnits: 2 }),
      (request) => ({
        ...request,
        caps: {
          azure: { globalDaily: 99, subjectDaily: 100 },
          anthropic: { globalDaily: 100, subjectDaily: 100 },
        },
      }),
    ]

    for (const [index, mutate] of mutations.entries()) {
      const stub = accountingStub(`idempotency-conflict-${index}`)
      const original = reservation()
      expect((await stub.reserve(original)).azure.allowed).toBe(true)

      const conflict = await stub.reserve(mutate(original))

      expect(conflict).toMatchObject({
        ok: false,
        error: 'IDEMPOTENCY_CONFLICT',
        azure: { allowed: false, reason: 'idempotency_conflict' },
        anthropic: { allowed: false, reason: 'idempotency_conflict' },
      })
      expect(conflict).not.toHaveProperty('usage')
      expect(conflict).not.toHaveProperty('day')
      expect(conflict).not.toHaveProperty('reservationId')
      const stored = await snapshot(stub)
      expect(stored.global[0]).toMatchObject({ azure_units: 1, anthropic_units: 0 })
      expect(stored.subjects).toHaveLength(1)
      expect(stored.reservations).toHaveLength(1)
    }
  })

  it('rejects a two-unit reservation below the boundary and admits it at the exact boundary', async () => {
    const rejectedStub = accountingStub('two-unit-rejected')
    const rejected = await rejectedStub.reserve(reservation({
      azureUnits: 2,
      caps: {
        azure: { globalDaily: 1, subjectDaily: 1 },
        anthropic: { globalDaily: 1, subjectDaily: 1 },
      },
    }))
    expect(rejected.azure.allowed).toBe(false)
    expect((await snapshot(rejectedStub)).global[0].azure_units).toBe(0)

    const admittedStub = accountingStub('two-unit-admitted')
    const admitted = await admittedStub.reserve(reservation({
      azureUnits: 2,
      caps: {
        azure: { globalDaily: 2, subjectDaily: 2 },
        anthropic: { globalDaily: 2, subjectDaily: 2 },
      },
    }))
    expect(admitted.azure.allowed).toBe(true)
    expect((await snapshot(admittedStub)).global[0].azure_units).toBe(2)
  })

  it('keeps Azure and Anthropic admission decisions separate', async () => {
    const stub = accountingStub('provider-decisions')
    const result = await stub.reserve(reservation({
      azureUnits: 1,
      anthropicUnits: 1,
      caps: {
        azure: { globalDaily: 1, subjectDaily: 1 },
        anthropic: { globalDaily: 0, subjectDaily: 0 },
      },
    }))

    expect(result.azure).toMatchObject({ allowed: true, reason: 'reserved' })
    expect(result.anthropic).toMatchObject({ allowed: false, reason: 'cap_exceeded' })
    expect((await snapshot(stub)).global[0]).toMatchObject({ azure_units: 1, anthropic_units: 0 })
  })

  it('serializes 64 concurrent reservations at a global cap of seven', async () => {
    const stub = accountingStub('concurrency')
    const caps = {
      azure: { globalDaily: 7, subjectDaily: 64 },
      anthropic: { globalDaily: 64, subjectDaily: 64 },
    }

    const decisions = await Promise.all(
      Array.from({ length: 64 }, () => stub.reserve(reservation({ caps })))
    )

    expect(decisions.filter((decision) => decision.azure.allowed)).toHaveLength(7)
    const stored = await snapshot(stub)
    expect(stored.global[0].azure_units).toBe(7)
    expect(stored.subjects[0].azure_units).toBe(7)
    expect(stored.reservations).toHaveLength(64)
  })

  it('persists only a lower-case HMAC-shaped subject token, never raw identity input', async () => {
    const stub = accountingStub('subject-token')
    const rawIdentity = 'raw-device-or-attestation-identity-must-not-persist'
    const subjectToken = '0123456789abcdef'.repeat(4)

    const result = await stub.reserve(reservation({ subjectToken, rawIdentity }))

    expect(result.ok).toBe(true)
    const stored = await snapshot(stub)
    expect(stored.subjects).toHaveLength(1)
    expect(stored.subjects[0].subject_token).toBe(subjectToken)
    expect(stored.subjects[0].subject_token).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(stored)).not.toContain(rawIdentity)
  })

  it('fails closed on invalid caps or malformed subject tokens without persisting usage', async () => {
    const invalidCases = [
      reservation({ caps: { azure: { globalDaily: -1, subjectDaily: 1 }, anthropic: { globalDaily: 1, subjectDaily: 1 } } }),
      reservation({ caps: { azure: { globalDaily: 1.5, subjectDaily: 1 }, anthropic: { globalDaily: 1, subjectDaily: 1 } } }),
      reservation({ caps: { azure: { globalDaily: '7', subjectDaily: 7 }, anthropic: { globalDaily: 7, subjectDaily: 7 } } }),
      reservation({ subjectToken: 'raw-device-id' }),
    ]

    for (const [index, request] of invalidCases.entries()) {
      const stub = accountingStub(`invalid-${index}`)
      const result = await stub.reserve(request)
      expect(result).toMatchObject({
        ok: false,
        azure: { allowed: false, reason: 'invalid_request' },
        anthropic: { allowed: false, reason: 'invalid_request' },
      })
      expect(await snapshot(stub)).toEqual({ global: [], subjects: [], reservations: [] })
    }
  })
})
