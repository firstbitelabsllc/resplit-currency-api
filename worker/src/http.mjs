/**
 * @param {unknown} body
 * @param {{
 *   status?: number
 *   requestId?: string
 *   headers?: HeadersInit
 * }} [options]
 * @returns {Response}
 */
export function jsonResponse(body, { status = 200, requestId, headers = {} } = {}) {
  const response = Response.json(body, {
    status,
    headers,
  })
  if (requestId) {
    response.headers.set('x-request-id', requestId)
  }
  return response
}

/**
 * @param {string} error
 * @param {string} message
 * @param {number} status
 * @param {string} [requestId]
 * @param {HeadersInit} [headers]
 * @returns {Response}
 */
export function errorResponse(error, message, status, requestId, headers = {}) {
  return jsonResponse({ error, message }, { status, requestId, headers })
}
