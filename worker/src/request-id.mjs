export const REQUEST_ID_HEADER = 'x-request-id'
export const RESPLIT_TRACE_ID_HEADER = 'x-resplit-trace-id'
export const CORRELATION_EXPOSE_HEADERS = `${REQUEST_ID_HEADER}, ${RESPLIT_TRACE_ID_HEADER}, cf-ray`

const MAX_CORRELATION_ID_LENGTH = 96
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isValidCorrelationId(value) {
  return (
    value.length > 0 &&
    value.length <= MAX_CORRELATION_ID_LENGTH &&
    CORRELATION_ID_PATTERN.test(value)
  )
}

/**
 * @param {Request} request
 * @returns {string}
 */
export function resolveRequestId(request) {
  return (
    validatedHeader(request, RESPLIT_TRACE_ID_HEADER) ??
    validatedHeader(request, REQUEST_ID_HEADER) ??
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
    'Access-Control-Expose-Headers': CORRELATION_EXPOSE_HEADERS,
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
function validatedHeader(request, header) {
  const value = request.headers.get(header)?.trim()
  if (
    !value ||
    !isValidCorrelationId(value)
  ) {
    return undefined
  }

  return value
}
