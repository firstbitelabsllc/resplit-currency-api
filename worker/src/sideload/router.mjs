import { errorResponse } from '../http.mjs'
import { resolveRequestId } from '../request-id.mjs'

/**
 * Dispatch router for all `/sideload/*` routes.
 *
 * v1 scaffold (Task 4.2): returns `NOT_FOUND` for every path under
 * `/sideload/`. Real handlers (upload/list/get/delete/labels) land in
 * Tasks 4.3/5/6 once the SIWA verification middleware (Task 3) is in.
 *
 * @param {Request} request
 * @param {Record<string, string | undefined>} env
 * @param {ExecutionContext} [_ctx]
 * @returns {Promise<Response>}
 */
export async function handleSideload(request, env, _ctx) {
  const requestId = resolveRequestId(request)

  return errorResponse(
    'NOT_FOUND',
    'Sideload route not found',
    404,
    requestId,
    { 'Cache-Control': 'no-store' }
  )
}
