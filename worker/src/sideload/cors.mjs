const ALLOWED_ORIGINS = new Set([
  'https://resplit.app',
  'https://staging.resplit.app',
])

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-request-id, CF-Access-Client-Id, CF-Access-Client-Secret',
  'Access-Control-Max-Age': '600',
}

export function handlePreflight(request, requestId) {
  return new Response(null, {
    status: 204,
    headers: { ...CORS_HEADERS, 'x-request-id': requestId },
  })
}
