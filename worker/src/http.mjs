import { attachRequestCorrelationHeaders } from './request-id.mjs'

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
    attachRequestCorrelationHeaders(response, requestId)
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
  const body = requestId
    ? { error, message, requestId, traceId: requestId }
    : { error, message }
  return jsonResponse(body, { status, requestId, headers })
}
