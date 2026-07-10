import { DurableObject } from 'cloudflare:workers'

const SUBJECT_TOKEN_PATTERN = /^[0-9a-f]{64}$/
const RESERVATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/**
 * Dormant SQLite accounting primitive for future OCR admission control.
 *
 * The production OCR router deliberately cannot reach this class while
 * OCR_ACCOUNTING_MODE remains "legacy". A separate adapter may call reserve()
 * in non-enforcing shadow mode after cache misses; the legacy spend gates and
 * every client response remain authoritative until a later reviewed rollout.
 */
export class OcrAccounting extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    this.ctx = ctx
    initializeSchema(ctx.storage.sql)
  }

  /**
   * Atomically reserves independent Azure and Anthropic daily units.
   * Invalid requests fail closed and do not create accounting rows.
   *
   * @param {unknown} input
   * @returns {object}
   */
  reserve(input) {
    const request = validateReservation(input)
    if (!request) return invalidDecision()

    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql
      const requestSemantics = canonicalRequestSemantics(request)
      const duplicate = firstRow(sql.exec(
        `SELECT request_semantics, decision_json
           FROM ocr_reservations
          WHERE day = ? AND reservation_id = ?`,
        request.day,
        request.reservationId
      ))
      if (duplicate) {
        if (duplicate.request_semantics !== requestSemantics) return idempotencyConflictDecision()
        return JSON.parse(duplicate.decision_json)
      }

      sql.exec(
        `INSERT OR IGNORE INTO ocr_global_daily (
           day, azure_units, anthropic_units, azure_cap, anthropic_cap
         ) VALUES (?, 0, 0, ?, ?)`,
        request.day,
        request.caps.azure.globalDaily,
        request.caps.anthropic.globalDaily
      )
      sql.exec(
        `UPDATE ocr_global_daily
            SET azure_cap = MIN(azure_cap, ?),
                anthropic_cap = MIN(anthropic_cap, ?)
          WHERE day = ?`,
        request.caps.azure.globalDaily,
        request.caps.anthropic.globalDaily,
        request.day
      )

      sql.exec(
        `INSERT OR IGNORE INTO ocr_subject_daily (
           day, subject_token, azure_units, anthropic_units, azure_cap, anthropic_cap
         ) VALUES (?, ?, 0, 0, ?, ?)`,
        request.day,
        request.subjectToken,
        request.caps.azure.subjectDaily,
        request.caps.anthropic.subjectDaily
      )
      sql.exec(
        `UPDATE ocr_subject_daily
            SET azure_cap = MIN(azure_cap, ?),
                anthropic_cap = MIN(anthropic_cap, ?)
          WHERE day = ? AND subject_token = ?`,
        request.caps.azure.subjectDaily,
        request.caps.anthropic.subjectDaily,
        request.day,
        request.subjectToken
      )

      const globalUsage = firstRow(sql.exec(
        `SELECT azure_units, anthropic_units, azure_cap, anthropic_cap
           FROM ocr_global_daily
          WHERE day = ?`,
        request.day
      ))
      const subjectUsage = firstRow(sql.exec(
        `SELECT azure_units, anthropic_units, azure_cap, anthropic_cap
           FROM ocr_subject_daily
          WHERE day = ? AND subject_token = ?`,
        request.day,
        request.subjectToken
      ))

      const azureAllowed = fitsWithinBothCaps(
        request.azureUnits,
        globalUsage.azure_units,
        globalUsage.azure_cap,
        subjectUsage.azure_units,
        subjectUsage.azure_cap
      )
      const anthropicAllowed = fitsWithinBothCaps(
        request.anthropicUnits,
        globalUsage.anthropic_units,
        globalUsage.anthropic_cap,
        subjectUsage.anthropic_units,
        subjectUsage.anthropic_cap
      )
      const chargedAzureUnits = azureAllowed ? request.azureUnits : 0
      const chargedAnthropicUnits = anthropicAllowed ? request.anthropicUnits : 0

      sql.exec(
        `UPDATE ocr_global_daily
            SET azure_units = azure_units + ?,
                anthropic_units = anthropic_units + ?
          WHERE day = ?`,
        chargedAzureUnits,
        chargedAnthropicUnits,
        request.day
      )
      sql.exec(
        `UPDATE ocr_subject_daily
            SET azure_units = azure_units + ?,
                anthropic_units = anthropic_units + ?
          WHERE day = ? AND subject_token = ?`,
        chargedAzureUnits,
        chargedAnthropicUnits,
        request.day,
        request.subjectToken
      )

      const finalGlobalUsage = firstRow(sql.exec(
        `SELECT azure_units, anthropic_units, azure_cap, anthropic_cap
           FROM ocr_global_daily
          WHERE day = ?`,
        request.day
      ))
      const finalSubjectUsage = firstRow(sql.exec(
        `SELECT azure_units, anthropic_units, azure_cap, anthropic_cap
           FROM ocr_subject_daily
          WHERE day = ? AND subject_token = ?`,
        request.day,
        request.subjectToken
      ))
      const decision = {
        ok: true,
        day: request.day,
        reservationId: request.reservationId,
        azure: providerDecision(request.azureUnits, azureAllowed),
        anthropic: providerDecision(request.anthropicUnits, anthropicAllowed),
        usage: {
          global: normalizeUsage(finalGlobalUsage),
          subject: normalizeUsage(finalSubjectUsage),
        },
      }

      sql.exec(
        `INSERT INTO ocr_reservations (
           day, reservation_id, subject_token, azure_units, anthropic_units,
           azure_allowed, anthropic_allowed, request_semantics, decision_json,
           created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        request.day,
        request.reservationId,
        request.subjectToken,
        request.azureUnits,
        request.anthropicUnits,
        azureAllowed ? 1 : 0,
        anthropicAllowed ? 1 : 0,
        requestSemantics,
        JSON.stringify(decision),
        Date.now()
      )

      return decision
    })
  }
}

function initializeSchema(sql) {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS ocr_global_daily (
       day TEXT PRIMARY KEY,
       azure_units INTEGER NOT NULL CHECK (azure_units >= 0),
       anthropic_units INTEGER NOT NULL CHECK (anthropic_units >= 0),
       azure_cap INTEGER NOT NULL CHECK (azure_cap >= 0),
       anthropic_cap INTEGER NOT NULL CHECK (anthropic_cap >= 0),
       CHECK (length(day) = 10)
     ) STRICT`
  )
  sql.exec(
    `CREATE TABLE IF NOT EXISTS ocr_subject_daily (
       day TEXT NOT NULL,
       subject_token TEXT NOT NULL,
       azure_units INTEGER NOT NULL CHECK (azure_units >= 0),
       anthropic_units INTEGER NOT NULL CHECK (anthropic_units >= 0),
       azure_cap INTEGER NOT NULL CHECK (azure_cap >= 0),
       anthropic_cap INTEGER NOT NULL CHECK (anthropic_cap >= 0),
       PRIMARY KEY (day, subject_token),
       CHECK (length(day) = 10),
       CHECK (length(subject_token) = 64),
       CHECK (subject_token NOT GLOB '*[^0-9a-f]*')
     ) STRICT`
  )
  sql.exec(
    `CREATE TABLE IF NOT EXISTS ocr_reservations (
       day TEXT NOT NULL,
       reservation_id TEXT NOT NULL,
       subject_token TEXT NOT NULL,
       azure_units INTEGER NOT NULL CHECK (azure_units >= 0),
       anthropic_units INTEGER NOT NULL CHECK (anthropic_units >= 0),
       azure_allowed INTEGER NOT NULL CHECK (azure_allowed IN (0, 1)),
       anthropic_allowed INTEGER NOT NULL CHECK (anthropic_allowed IN (0, 1)),
       request_semantics TEXT NOT NULL,
       decision_json TEXT NOT NULL,
       created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
       PRIMARY KEY (day, reservation_id),
       CHECK (length(day) = 10),
       CHECK (length(subject_token) = 64),
       CHECK (subject_token NOT GLOB '*[^0-9a-f]*')
     ) STRICT`
  )
}

function validateReservation(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const { day, reservationId, subjectToken, azureUnits, anthropicUnits, caps } = input
  if (!isCalendarDay(day)) return null
  if (typeof reservationId !== 'string' || !RESERVATION_ID_PATTERN.test(reservationId)) return null
  if (typeof subjectToken !== 'string' || !SUBJECT_TOKEN_PATTERN.test(subjectToken)) return null
  if (!isNonNegativeInteger(azureUnits) || !isNonNegativeInteger(anthropicUnits)) return null
  if (!validCaps(caps)) return null

  return {
    day,
    reservationId,
    subjectToken,
    azureUnits,
    anthropicUnits,
    caps,
  }
}

function validCaps(caps) {
  if (!caps || typeof caps !== 'object' || Array.isArray(caps)) return false
  for (const provider of ['azure', 'anthropic']) {
    const limit = caps[provider]
    if (!limit || typeof limit !== 'object' || Array.isArray(limit)) return false
    if (!isNonNegativeInteger(limit.globalDaily) || !isNonNegativeInteger(limit.subjectDaily)) return false
  }
  return true
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function isCalendarDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function fitsWithinBothCaps(units, globalUsed, globalCap, subjectUsed, subjectCap) {
  if (units === 0) return true
  // Subtraction keeps the comparison exact even near Number.MAX_SAFE_INTEGER;
  // adding two individually safe integers can itself produce an unsafe value.
  return units <= globalCap - globalUsed && units <= subjectCap - subjectUsed
}

function providerDecision(requestedUnits, allowed) {
  return {
    allowed,
    requestedUnits,
    reason: requestedUnits === 0 ? 'not_requested' : allowed ? 'reserved' : 'cap_exceeded',
  }
}

function invalidDecision() {
  return {
    ok: false,
    error: 'INVALID_REQUEST',
    azure: { allowed: false, requestedUnits: 0, reason: 'invalid_request' },
    anthropic: { allowed: false, requestedUnits: 0, reason: 'invalid_request' },
  }
}

function idempotencyConflictDecision() {
  return {
    ok: false,
    error: 'IDEMPOTENCY_CONFLICT',
    azure: { allowed: false, requestedUnits: 0, reason: 'idempotency_conflict' },
    anthropic: { allowed: false, requestedUnits: 0, reason: 'idempotency_conflict' },
  }
}

function canonicalRequestSemantics(request) {
  return JSON.stringify({
    subjectToken: request.subjectToken,
    azureUnits: request.azureUnits,
    anthropicUnits: request.anthropicUnits,
    caps: {
      azure: {
        globalDaily: request.caps.azure.globalDaily,
        subjectDaily: request.caps.azure.subjectDaily,
      },
      anthropic: {
        globalDaily: request.caps.anthropic.globalDaily,
        subjectDaily: request.caps.anthropic.subjectDaily,
      },
    },
  })
}

function firstRow(cursor) {
  return cursor.toArray()[0]
}

function normalizeUsage(row) {
  return {
    azureUnits: row.azure_units,
    anthropicUnits: row.anthropic_units,
    azureCap: row.azure_cap,
    anthropicCap: row.anthropic_cap,
  }
}
