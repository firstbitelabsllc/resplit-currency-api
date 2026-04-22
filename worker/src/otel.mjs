export const FX_OTEL_SERVICE_NAME = 'resplit-currency-api-worker'

function trimEnvValue(value) {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

export function normalizeFxTraceEndpoint(rawEndpoint) {
  const endpoint = trimEnvValue(rawEndpoint)
  if (!endpoint) {
    return null
  }

  const normalized = endpoint.replace(/\/+$/, '')

  if (normalized.endsWith('/v1/traces')) {
    return normalized
  }

  if (normalized.endsWith('/v1')) {
    return `${normalized}/traces`
  }

  return `${normalized}/v1/traces`
}

export function parseFxOtelHeaders(rawHeaders) {
  const headerString = trimEnvValue(rawHeaders)
  if (!headerString) {
    return null
  }

  const headers = {}

  for (const segment of headerString.split(',')) {
    const entry = segment.trim()
    if (!entry) {
      continue
    }

    const separatorIndex = entry.indexOf('=')
    if (separatorIndex <= 0) {
      return null
    }

    const key = entry.slice(0, separatorIndex).trim()
    const value = entry.slice(separatorIndex + 1).trim()

    if (!key || !value) {
      return null
    }

    headers[key] = value
  }

  return Object.keys(headers).length > 0 ? headers : null
}

export function resolveFxOtelHeaders(env) {
  const explicitHeaders = parseFxOtelHeaders(env?.OTEL_EXPORTER_OTLP_HEADERS)
  if (explicitHeaders) {
    return explicitHeaders
  }

  const authHeader = trimEnvValue(env?.OTEL_AUTH_HEADER)
  if (!authHeader) {
    return null
  }

  const headerAssignments = parseFxOtelHeaders(authHeader)
  if (headerAssignments) {
    return headerAssignments
  }

  return {
    Authorization: authHeader,
  }
}

export function resolveFxOtelTraceConfig(env) {
  const endpoint = normalizeFxTraceEndpoint(
    env?.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
      ?? env?.OTEL_EXPORTER_OTLP_ENDPOINT
      ?? env?.OTEL_ENDPOINT
  )
  const headers = resolveFxOtelHeaders(env)

  if (!endpoint || !headers) {
    return null
  }

  return {
    exporter: {
      url: endpoint,
      headers,
    },
    service: {
      name: FX_OTEL_SERVICE_NAME,
      namespace: 'resplit',
      version: trimEnvValue(env?.SENTRY_RELEASE) || undefined,
    },
  }
}

let cachedInstrumentedWorker = null

export async function resolveFxWorkerExport(baseWorker, env) {
  const initialConfig = resolveFxOtelTraceConfig(env)
  if (!initialConfig) {
    return baseWorker
  }

  if (cachedInstrumentedWorker) {
    return cachedInstrumentedWorker
  }

  const { instrument } = await import('@microlabs/otel-cf-workers')

  cachedInstrumentedWorker = instrument(
    baseWorker,
    currentEnv => resolveFxOtelTraceConfig(currentEnv) || initialConfig
  )

  return cachedInstrumentedWorker
}
