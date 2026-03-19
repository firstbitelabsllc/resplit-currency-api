/**
 * @param {Request} request
 * @returns {string}
 */
export function resolveRequestId(request) {
  const incoming = request.headers.get('x-request-id')?.trim()
  return incoming || crypto.randomUUID()
}
