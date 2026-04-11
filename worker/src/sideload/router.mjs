import { errorResponse } from '../http.mjs'
import { resolveRequestId } from '../request-id.mjs'
import {
  verifySIWAToken,
  enforceWhitelist,
  AuthError,
  AUTH_MISSING,
  AUTH_INVALID,
  AUTH_EXPIRED,
  AUTH_AUDIENCE,
  AUTH_ISSUER,
  FORBIDDEN_NOT_WHITELISTED,
} from './auth.mjs'

const NO_STORE = { 'Cache-Control': 'no-store' }

const AUTH_STATUS_BY_CODE = {
  [AUTH_MISSING]: 401,
  [AUTH_INVALID]: 401,
  [AUTH_EXPIRED]: 401,
  [AUTH_AUDIENCE]: 401,
  [AUTH_ISSUER]: 401,
  [FORBIDDEN_NOT_WHITELISTED]: 403,
}

/**
 * Dispatch router for all `/sideload/*` routes.
 *
 * Gates every request through SIWA JWT verification (Task 3 / commit
 * `2a8c462`) and single-user whitelist enforcement. Only once both
 * gates pass does the router fall through to the current NOT_FOUND
 * stub — real handlers (upload/list/get/delete/labels) land in
 * Tasks 4.3/5/6.
 *
 * @param {Request} request
 * @param {Record<string, string | undefined>} env
 * @param {ExecutionContext} [_ctx]
 * @returns {Promise<Response>}
 */
export async function handleSideload(request, env, _ctx) {
  const requestId = resolveRequestId(request)

  let claims
  try {
    claims = await verifySIWAToken(request, env)
  } catch (error) {
    if (error instanceof AuthError) {
      return errorResponse(
        error.code,
        error.message,
        AUTH_STATUS_BY_CODE[error.code] ?? 401,
        requestId,
        NO_STORE
      )
    }
    throw error
  }

  try {
    enforceWhitelist(claims.email)
  } catch (error) {
    if (error instanceof AuthError) {
      return errorResponse(
        error.code,
        error.message,
        AUTH_STATUS_BY_CODE[error.code] ?? 403,
        requestId,
        NO_STORE
      )
    }
    throw error
  }

  return errorResponse(
    'NOT_FOUND',
    'Sideload route not found',
    404,
    requestId,
    NO_STORE
  )
}
