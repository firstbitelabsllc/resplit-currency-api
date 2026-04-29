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

function resolveFxOtelEndpointSource(env) {
  if (trimEnvValue(env?.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT)) {
    return 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'
  }

  if (trimEnvValue(env?.OTEL_EXPORTER_OTLP_ENDPOINT)) {
    return 'OTEL_EXPORTER_OTLP_ENDPOINT'
  }

  if (trimEnvValue(env?.OTEL_ENDPOINT)) {
    return 'OTEL_ENDPOINT'
  }

  return 'missing'
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

function resolveFxOtelAuthSource(env) {
  if (trimEnvValue(env?.OTEL_EXPORTER_OTLP_HEADERS)) {
    return 'OTEL_EXPORTER_OTLP_HEADERS'
  }

  if (trimEnvValue(env?.OTEL_AUTH_HEADER)) {
    return 'OTEL_AUTH_HEADER'
  }

  return 'missing'
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

export function describeFxOtelTraceConfig(env) {
  const config = resolveFxOtelTraceConfig(env)

  return {
    authSource: resolveFxOtelAuthSource(env),
    configured: Boolean(config),
    endpointSource: resolveFxOtelEndpointSource(env),
    traceEndpoint: config?.exporter.url ?? null,
  }
}

export function buildFxOtelDiagnosticHeaders(env) {
  const diagnostics = describeFxOtelTraceConfig(env)
  const headers = {
    'x-resplit-otel-auth-source': diagnostics.authSource,
    'x-resplit-otel-configured': diagnostics.configured ? '1' : '0',
    'x-resplit-otel-endpoint-source': diagnostics.endpointSource,
  }

  if (diagnostics.traceEndpoint) {
    try {
      const traceUrl = new URL(diagnostics.traceEndpoint)
      headers['x-resplit-otel-exporter-host'] = traceUrl.host
      headers['x-resplit-otel-exporter-path'] = traceUrl.pathname
    } catch {
      headers['x-resplit-otel-exporter-path'] = diagnostics.traceEndpoint
    }
  }

  return headers
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
