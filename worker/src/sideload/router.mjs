import { errorResponse, jsonResponse } from '../http.mjs'
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
import { CORS_HEADERS, handlePreflight } from './cors.mjs'

const RESPONSE_HEADERS = { ...CORS_HEADERS, 'Cache-Control': 'no-store' }

const AUTH_STATUS_BY_CODE = {
  [AUTH_MISSING]: 401,
  [AUTH_INVALID]: 401,
  [FORBIDDEN_NOT_WHITELISTED]: 403,
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
    return handlePreflight(request, requestId)
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
        RESPONSE_HEADERS,
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
        RESPONSE_HEADERS,
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
      RESPONSE_HEADERS,
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
      RESPONSE_HEADERS,
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

const MAX_PHOTO_BYTES = 25 * 1024 * 1024
const ALLOWED_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/webp',
])

function notImplemented(ctx, name) {
  return errorResponse(
    'NOT_IMPLEMENTED',
    `${name} handler pending Task 6`,
    501,
    ctx.requestId,
    RESPONSE_HEADERS,
  )
}

async function handleUploadInit(ctx, _params) {
  let body
  try {
    body = await ctx.request.json()
  } catch {
    return errorResponse('BAD_REQUEST', 'Invalid JSON body', 400, ctx.requestId, RESPONSE_HEADERS)
  }

  const { contentType, size, sha256, capturedAt, originalFilename } = body

  if (!contentType || !ALLOWED_CONTENT_TYPES.has(contentType)) {
    return errorResponse(
      'INVALID_CONTENT_TYPE',
      `Content type must be one of: ${[...ALLOWED_CONTENT_TYPES].join(', ')}`,
      400,
      ctx.requestId,
      RESPONSE_HEADERS,
    )
  }

  if (typeof size !== 'number' || size <= 0 || size > MAX_PHOTO_BYTES) {
    return errorResponse(
      'INVALID_SIZE',
      `Size must be between 1 and ${MAX_PHOTO_BYTES} bytes`,
      400,
      ctx.requestId,
      RESPONSE_HEADERS,
    )
  }

  if (typeof sha256 !== 'string' || sha256.length !== 64) {
    return errorResponse(
      'INVALID_HASH',
      'sha256 must be a 64-character hex string',
      400,
      ctx.requestId,
      RESPONSE_HEADERS,
    )
  }

  const photoId = crypto.randomUUID()
  const now = new Date().toISOString()

  const pending = {
    photoId,
    contentType,
    size,
    sha256,
    capturedAt: capturedAt || now,
    originalFilename: originalFilename || null,
    createdAt: now,
  }

  const pendingKey = `${ctx.prefix}/${photoId}/pending.json`
  await ctx.env.SIDELOAD_R2.put(pendingKey, JSON.stringify(pending), {
    httpMetadata: { contentType: 'application/json' },
  })

  const uploadUrl = `/sideload/photos/${photoId}/_bytes`

  return jsonResponse(
    { photoId, uploadUrl },
    { status: 200, requestId: ctx.requestId, headers: RESPONSE_HEADERS },
  )
}

async function handleUploadBytes(ctx, params) {
  const { id: photoId } = params
  const pendingKey = `${ctx.prefix}/${photoId}/pending.json`
  const pendingObj = await ctx.env.SIDELOAD_R2.get(pendingKey)

  if (!pendingObj) {
    return errorResponse(
      'NOT_FOUND',
      'No pending upload found — call POST /sideload/photos/upload first',
      404,
      ctx.requestId,
      RESPONSE_HEADERS,
    )
  }

  const pending = await pendingObj.json()
  const bodyBuffer = await ctx.request.arrayBuffer()

  if (bodyBuffer.byteLength !== pending.size) {
    return errorResponse(
      'SIZE_MISMATCH',
      `Expected ${pending.size} bytes, received ${bodyBuffer.byteLength}`,
      400,
      ctx.requestId,
      RESPONSE_HEADERS,
    )
  }

  const digest = await crypto.subtle.digest('SHA-256', bodyBuffer)
  const actualHash = Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')

  if (actualHash !== pending.sha256.toLowerCase()) {
    await ctx.env.SIDELOAD_R2.delete(pendingKey)
    return errorResponse(
      'HASH_MISMATCH',
      `SHA-256 mismatch: expected ${pending.sha256}, got ${actualHash}`,
      409,
      ctx.requestId,
      RESPONSE_HEADERS,
    )
  }

  const objectKey = `${ctx.prefix}/${photoId}/original`
  const now = new Date().toISOString()

  const r2Obj = await ctx.env.SIDELOAD_R2.put(objectKey, bodyBuffer, {
    httpMetadata: { contentType: pending.contentType },
    customMetadata: {
      originalFilename: pending.originalFilename || '',
      capturedAt: pending.capturedAt,
      sha256: pending.sha256,
      uploadedAt: now,
    },
  })

  const meta = {
    photoId,
    contentType: pending.contentType,
    size: bodyBuffer.byteLength,
    sha256: pending.sha256,
    capturedAt: pending.capturedAt,
    originalFilename: pending.originalFilename,
    uploadedAt: now,
    version: 1,
  }

  const metaKey = `${ctx.prefix}/${photoId}/meta.json`
  await ctx.env.SIDELOAD_R2.put(metaKey, JSON.stringify(meta), {
    httpMetadata: { contentType: 'application/json' },
  })

  await ctx.env.SIDELOAD_R2.delete(pendingKey)

  return jsonResponse(
    { photoId, etag: r2Obj.etag, size: bodyBuffer.byteLength },
    { status: 200, requestId: ctx.requestId, headers: RESPONSE_HEADERS },
  )
}

async function handleList(ctx, _params) {
  const limit = Math.min(Math.max(parseInt(ctx.url.searchParams.get('limit') || '50', 10) || 50, 1), 200)
  const cursor = ctx.url.searchParams.get('cursor') || undefined

  const listed = await ctx.env.SIDELOAD_R2.list({
    prefix: `${ctx.prefix}/`,
    delimiter: '/',
    limit,
    cursor,
  })

  const photoIds = (listed.delimitedPrefixes || [])
    .map(p => p.replace(`${ctx.prefix}/`, '').replace(/\/$/, ''))
    .filter(id => id.length > 0)

  const photos = await Promise.all(
    photoIds.map(async (id) => {
      const metaObj = await ctx.env.SIDELOAD_R2.get(`${ctx.prefix}/${id}/meta.json`)
      if (!metaObj) return null
      return metaObj.json()
    })
  )

  const result = { photos: photos.filter(Boolean) }
  if (listed.truncated && listed.cursor) {
    result.nextCursor = listed.cursor
  }

  return jsonResponse(result, { status: 200, requestId: ctx.requestId, headers: RESPONSE_HEADERS })
}

async function handleGet(ctx, params) {
  const { id: photoId } = params
  const mode = ctx.url.searchParams.get('mode') || 'meta'

  if (mode === 'download') {
    const obj = await ctx.env.SIDELOAD_R2.get(`${ctx.prefix}/${photoId}/original`)
    if (!obj) {
      return errorResponse('NOT_FOUND', 'Photo not found', 404, ctx.requestId, RESPONSE_HEADERS)
    }
    return new Response(obj.body, {
      status: 200,
      headers: {
        'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
        'Content-Length': String(obj.size),
        'x-request-id': ctx.requestId,
        ...RESPONSE_HEADERS,
      },
    })
  }

  const metaObj = await ctx.env.SIDELOAD_R2.get(`${ctx.prefix}/${photoId}/meta.json`)
  if (!metaObj) {
    return errorResponse('NOT_FOUND', 'Photo not found', 404, ctx.requestId, RESPONSE_HEADERS)
  }

  return jsonResponse(await metaObj.json(), { status: 200, requestId: ctx.requestId, headers: RESPONSE_HEADERS })
}

async function handleDelete(ctx, params) {
  const { id: photoId } = params
  const prefix = `${ctx.prefix}/${photoId}`

  await ctx.env.SIDELOAD_R2.delete([
    `${prefix}/original`,
    `${prefix}/meta.json`,
    `${prefix}/labels.json`,
    `${prefix}/pending.json`,
  ])

  return new Response(null, {
    status: 204,
    headers: { 'x-request-id': ctx.requestId, ...RESPONSE_HEADERS },
  })
}

async function handleSetLabels(ctx, params) {
  const { id: photoId } = params

  const original = await ctx.env.SIDELOAD_R2.head(`${ctx.prefix}/${photoId}/original`)
  if (!original) {
    return errorResponse('PHOTO_NOT_FOUND', 'Photo must exist before setting labels', 404, ctx.requestId, RESPONSE_HEADERS)
  }

  let body
  try {
    body = await ctx.request.json()
  } catch {
    return errorResponse('BAD_REQUEST', 'Invalid JSON body', 400, ctx.requestId, RESPONSE_HEADERS)
  }

  if (!body.labels || typeof body.labels !== 'object') {
    return errorResponse('BAD_REQUEST', 'Body must contain a labels object', 400, ctx.requestId, RESPONSE_HEADERS)
  }

  const serialized = JSON.stringify(body.labels)
  if (serialized.length > 16384) {
    return errorResponse('PAYLOAD_TOO_LARGE', 'Labels must be under 16KB serialized', 413, ctx.requestId, RESPONSE_HEADERS)
  }

  const now = new Date().toISOString()
  const labelsDoc = { labels: body.labels, updatedAt: now }

  await ctx.env.SIDELOAD_R2.put(
    `${ctx.prefix}/${photoId}/labels.json`,
    JSON.stringify(labelsDoc),
    {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { schemaVersion: '1' },
    }
  )

  return jsonResponse(labelsDoc, { status: 200, requestId: ctx.requestId, headers: RESPONSE_HEADERS })
}

async function handleGetLabels(ctx, params) {
  const { id: photoId } = params

  const labelsObj = await ctx.env.SIDELOAD_R2.get(`${ctx.prefix}/${photoId}/labels.json`)
  if (!labelsObj) {
    return errorResponse('NOT_FOUND', 'No labels set for this photo', 404, ctx.requestId, RESPONSE_HEADERS)
  }

  return jsonResponse(await labelsObj.json(), { status: 200, requestId: ctx.requestId, headers: RESPONSE_HEADERS })
}
