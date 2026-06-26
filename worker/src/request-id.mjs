export const REQUEST_ID_HEADER = 'x-request-id'
export const RESPLIT_TRACE_ID_HEADER = 'x-resplit-trace-id'

/**
 * @param {Request} request
 * @returns {string}
 */
export function resolveRequestId(request) {
  return (
    trimmedHeader(request, RESPLIT_TRACE_ID_HEADER) ??
    trimmedHeader(request, REQUEST_ID_HEADER) ??
    crypto.randomUUID()
  )
}

/**
 * @param {string} requestId
 * @returns {Record<string, string>}
 */
export function requestCorrelationHeaders(requestId) {
  return {
    [REQUEST_ID_HEADER]: requestId,
    [RESPLIT_TRACE_ID_HEADER]: requestId,
  }
}

/**
 * @param {Response} response
 * @param {string} requestId
 * @returns {Response}
 */
export function attachRequestCorrelationHeaders(response, requestId) {
  for (const [header, value] of Object.entries(requestCorrelationHeaders(requestId))) {
    response.headers.set(header, value)
  }
  return response
}

/**
 * @param {Request} request
 * @param {string} header
 * @returns {string | undefined}
 */
function trimmedHeader(request, header) {
  const value = request.headers.get(header)?.trim()
  return value || undefined
}
