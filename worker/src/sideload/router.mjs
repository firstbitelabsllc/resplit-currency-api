import { errorResponse } from '../http.mjs'
import { resolveRequestId } from '../request-id.mjs'
import {
  captureFxRouteFailure,
  logFxMonitoringEvent,
} from '../monitoring.mjs'
import {
  readCFAccessIdentity,
  enforceWhitelist,
  derivePrefix,
  AuthError,
  AUTH_MISSING,
  AUTH_INVALID,
  FORBIDDEN_NOT_WHITELISTED,
} from './auth.mjs'

const NO_STORE = { 'Cache-Control': 'no-store' }

const AUTH_STATUS_BY_CODE = {
  [AUTH_MISSING]: 401,
  [AUTH_INVALID]: 401,
  [FORBIDDEN_NOT_WHITELISTED]: 403,
}

const PREFLIGHT_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-request-id',
  'Access-Control-Max-Age': '600',
}

/**
 * Dispatch router for all `/sideload/*` routes.
 *
 * Applies the Task 4.4 pattern in order:
 *   1. Resolve requestId
 *   2. Log entry
 *   3. OPTIONS preflight short-circuit (no auth)
 *   4. CF Access identity (header-based, edge-validated)
 *   5. Whitelist enforce
 *   6. Derive per-user R2 prefix
 *   7. Method+path match → named handler stub (Tasks 5/6 fill these in)
 *   8. Exceptions → Sentry capture + 502 SIDELOAD_FAILED
 *
 * @param {Request} request
 * @param {Record<string, string | undefined>} env
 * @param {ExecutionContext} [_ctx]
 * @returns {Promise<Response>}
 */
export async function handleSideload(request, env, _ctx) {
  const requestId = resolveRequestId(request)
  const url = new URL(request.url)
  const method = request.method

  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { ...PREFLIGHT_HEADERS, 'x-request-id': requestId },
    })
  }

  logFxMonitoringEvent('info', {
    signal: 'sideload_entry',
    route: 'sideload',
    method,
    path: url.pathname,
    requestId,
  }, env)

  let claims
  try {
    claims = readCFAccessIdentity(request)
  } catch (error) {
    if (error instanceof AuthError) {
      return errorResponse(
        error.code,
        error.message,
        AUTH_STATUS_BY_CODE[error.code] ?? 401,
        requestId,
        NO_STORE,
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
        NO_STORE,
      )
    }
    throw error
  }

  const prefix = await derivePrefix(claims.email)
  const ctx = { env, prefix, requestId, request, url }

  const route = matchRoute(method, url.pathname)
  if (!route) {
    return errorResponse(
      'NOT_FOUND',
      'Sideload route not found',
      404,
      requestId,
      NO_STORE,
    )
  }

  try {
    return await route.handler(ctx, route.params)
  } catch (error) {
    await captureFxRouteFailure(error, {
      route: 'sideload',
      signal: 'sideload_route_exception',
      requestId,
      method,
      path: url.pathname,
    }, env)
    return errorResponse(
      'SIDELOAD_FAILED',
      error instanceof Error ? error.message : String(error),
      502,
      requestId,
      NO_STORE,
    )
  }
}

/**
 * Match a `/sideload/*` method+path against the v1 contract.
 * Returns `{ handler, params }` or `null` for an unknown combination.
 *
 * @param {string} method
 * @param {string} pathname
 * @returns {{ handler: Function, params: Record<string, string> } | null}
 */
function matchRoute(method, pathname) {
  if (pathname === '/sideload/photos') {
    if (method === 'GET') return { handler: handleList, params: {} }
    return null
  }

  if (pathname === '/sideload/photos/upload') {
    if (method === 'POST') return { handler: handleUploadInit, params: {} }
    return null
  }

  const photoPrefix = '/sideload/photos/'
  if (!pathname.startsWith(photoPrefix)) {
    return null
  }

  const rest = pathname.slice(photoPrefix.length)
  if (rest.length === 0) return null

  const parts = rest.split('/')
  const id = parts[0]
  if (!id) return null

  if (parts.length === 1) {
    if (method === 'GET') return { handler: handleGet, params: { id } }
    if (method === 'DELETE') return { handler: handleDelete, params: { id } }
    return null
  }

  if (parts.length === 2) {
    const sub = parts[1]
    if (sub === '_bytes' && method === 'POST') {
      return { handler: handleUploadBytes, params: { id } }
    }
    if (sub === 'labels') {
      if (method === 'POST') return { handler: handleSetLabels, params: { id } }
      if (method === 'GET') return { handler: handleGetLabels, params: { id } }
    }
    return null
  }

  return null
}

function notImplemented(ctx, name) {
  return errorResponse(
    'NOT_IMPLEMENTED',
    `${name} handler pending Task 5/6`,
    501,
    ctx.requestId,
    NO_STORE,
  )
}

async function handleUploadInit(ctx, _params) {
  return notImplemented(ctx, 'handleUploadInit')
}

async function handleUploadBytes(ctx, _params) {
  return notImplemented(ctx, 'handleUploadBytes')
}

async function handleList(ctx, _params) {
  return notImplemented(ctx, 'handleList')
}

async function handleGet(ctx, _params) {
  return notImplemented(ctx, 'handleGet')
}

async function handleDelete(ctx, _params) {
  return notImplemented(ctx, 'handleDelete')
}

async function handleSetLabels(ctx, _params) {
  return notImplemented(ctx, 'handleSetLabels')
}

async function handleGetLabels(ctx, _params) {
  return notImplemented(ctx, 'handleGetLabels')
}
