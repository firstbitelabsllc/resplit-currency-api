// Azure Document Intelligence v4 forward. This is the ONLY place the Azure key is
// read (from `env.AZURE_OCR_KEY`, a wrangler secret) — it never reaches the client.
// Grain-agnostic transport: it submits the image + fetches the analyze result and
// returns Azure's raw shape + status. Response contract shaping (envelope vs
// ScannedReceipt) is the router's job, decided separately. Mirrors the exact model
// + api-version the iOS client used: prebuilt-receipt / 2024-11-30.

const RECEIPT_MODEL_ID = 'prebuilt-receipt'
const LAYOUT_MODEL_ID = 'prebuilt-layout'
const API_VERSION = '2024-11-30'

export const OCR_PROVIDER = 'azure-di'

class AzureConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AzureConfigError'
  }
}

/**
 * @param {{ AZURE_OCR_ENDPOINT?: string, AZURE_OCR_KEY?: string }} env
 * @returns {{ endpoint: string, key: string }}
 */
function readConfig(env) {
  const endpoint = (env.AZURE_OCR_ENDPOINT || '').trim().replace(/\/+$/, '')
  const key = env.AZURE_OCR_KEY || ''
  if (!endpoint || !key) {
    throw new AzureConfigError('AZURE_OCR_ENDPOINT and AZURE_OCR_KEY must be configured (wrangler secret)')
  }
  return { endpoint, key }
}

const analyzeUrl = (endpoint, { modelId = RECEIPT_MODEL_ID, features = [] } = {}) => {
  const params = new URLSearchParams({ 'api-version': API_VERSION, locale: 'en' })
  if (features.length > 0) params.set('features', features.join(','))
  return `${endpoint}/documentintelligence/documentModels/${modelId}:analyze?${params}`
}

const resultUrl = (endpoint, operationId, { modelId = RECEIPT_MODEL_ID } = {}) =>
  `${endpoint}/documentintelligence/documentModels/${modelId}/analyzeResults/${encodeURIComponent(operationId)}?api-version=${API_VERSION}`

/**
 * Pull the analyze-result id out of the Azure response. Azure returns the poll
 * URL in `Operation-Location`; its last path segment is the result id. Falls back
 * to `apim-request-id` (the id the legacy iOS client used).
 *
 * @param {Headers} headers
 * @returns {string | null}
 */
function extractOperationId(headers) {
  const loc = headers.get('operation-location') || headers.get('Operation-Location')
  if (loc) {
    try {
      const path = new URL(loc).pathname
      const seg = path.split('/').filter(Boolean).pop()
      if (seg) return seg
    } catch {
      // fall through to apim-request-id
    }
  }
  return headers.get('apim-request-id')
}

/**
 * Submit a receipt image to Azure DI for analysis (async — returns an operation id
 * the caller polls). Does NOT block on completion.
 *
 * @param {ArrayBuffer | Uint8Array} imageBytes
 * @param {string} contentType - e.g. 'image/jpeg'
 * @param {{ AZURE_OCR_ENDPOINT?: string, AZURE_OCR_KEY?: string }} env
 * @returns {Promise<{ ok: boolean, httpStatus: number, operationId: string | null, errorBody: string | null }>}
 */
async function submitAnalyze(imageBytes, contentType, env, options = {}) {
  const { endpoint, key } = readConfig(env)
  const res = await fetch(analyzeUrl(endpoint, options), {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': contentType || 'image/jpeg',
    },
    body: imageBytes,
  })

  if (res.status === 202 || res.status === 200) {
    return { ok: true, httpStatus: res.status, operationId: extractOperationId(res.headers), errorBody: null }
  }
  const errorBody = await res.text().catch(() => '')
  return { ok: false, httpStatus: res.status, operationId: null, errorBody: errorBody.slice(0, 500) }
}

export async function submitReceiptAnalyze(imageBytes, contentType, env) {
  return submitAnalyze(imageBytes, contentType, env, { modelId: RECEIPT_MODEL_ID })
}

export async function submitLayoutKeyValueAnalyze(imageBytes, contentType, env) {
  return submitAnalyze(imageBytes, contentType, env, {
    modelId: LAYOUT_MODEL_ID,
    features: ['keyValuePairs'],
  })
}

/**
 * Fetch the analyze result for a previously-submitted operation. Returns Azure's
 * raw JSON body + its `status` (notStarted | running | succeeded | failed).
 *
 * @param {string} operationId
 * @param {{ AZURE_OCR_ENDPOINT?: string, AZURE_OCR_KEY?: string }} env
 * @returns {Promise<{ ok: boolean, httpStatus: number, status: string | null, body: unknown, errorBody: string | null }>}
 */
async function getAnalyzeResult(operationId, env, options = {}) {
  const { endpoint, key } = readConfig(env)
  const res = await fetch(resultUrl(endpoint, operationId, options), {
    method: 'GET',
    headers: { 'Ocp-Apim-Subscription-Key': key },
  })

  if (res.status !== 200) {
    const errorBody = await res.text().catch(() => '')
    return { ok: false, httpStatus: res.status, status: null, body: null, errorBody: errorBody.slice(0, 500) }
  }

  const body = await res.json().catch(() => null)
  const status = body && typeof body === 'object' ? (body.status ?? null) : null
  return { ok: true, httpStatus: 200, status, body, errorBody: null }
}

export async function getReceiptAnalyzeResult(operationId, env) {
  return getAnalyzeResult(operationId, env, { modelId: RECEIPT_MODEL_ID })
}

export async function getLayoutKeyValueAnalyzeResult(operationId, env) {
  return getAnalyzeResult(operationId, env, { modelId: LAYOUT_MODEL_ID })
}
