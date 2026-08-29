// The env-gated seam between router.mjs and the paid vision-LLM transports.
// LLM_SCAN_PROVIDER selects `anthropic` (default, today's path byte-for-byte) or
// `zai`. Everything the router needs from a provider passes through here so a
// flip changes one var, not the router: which key gates the leg, the default
// model, the cache-key variant, and the scan call itself. Unknown values fail
// closed (provider_unavailable) rather than silently falling back to Anthropic.

import { scanReceiptWithAnthropic, LLM_PROVIDER as ANTHROPIC_PROVIDER, llmMaxEdge } from './anthropic.mjs'
import { scanReceiptWithZai, ZAI_PROVIDER, zaiModel } from './zai.mjs'

export const DEFAULT_LLM_SCAN_PROVIDER = ANTHROPIC_PROVIDER
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5'

export { llmMaxEdge }

export function llmProvider(env) {
  return String(env?.LLM_SCAN_PROVIDER || '').trim().toLowerCase() || DEFAULT_LLM_SCAN_PROVIDER
}

// True only when the SELECTED provider's secret is present. The router reads
// this ahead of caps, cache, and accounting so a missing key degrades the leg to
// provider_unavailable before any paid call, exactly as ANTHROPIC_API_KEY does.
export function llmProviderConfigured(env) {
  switch (llmProvider(env)) {
    case ANTHROPIC_PROVIDER: return Boolean(env.ANTHROPIC_API_KEY)
    case ZAI_PROVIDER: return Boolean(env.ZAI_API_KEY)
    default: return false
  }
}

export function llmModel(env) {
  if (llmProvider(env) === ZAI_PROVIDER) return zaiModel(env)
  return (env.LLM_SCAN_MODEL || DEFAULT_ANTHROPIC_MODEL).trim() || DEFAULT_ANTHROPIC_MODEL
}

// Cache-key suffix. Empty for the default configuration so every existing
// `cache:dualScan:v2core:*` entry keeps its exact key; any flip of provider or
// operator edge ceiling gets its own namespace so a stale result cannot replay.
export function llmCacheVariant(env) {
  const provider = llmProvider(env)
  const maxEdge = llmMaxEdge(env)
  if (provider === ANTHROPIC_PROVIDER && maxEdge === 0) return ''
  return `:${provider}:${maxEdge}`
}

/**
 * @returns {Promise<{ ok: boolean, httpStatus: number, scanned: unknown, latencyMs: number, model: string, errorBody: string | null, providerStarted: boolean, inputPx: number | null }>}
 */
export async function scanReceiptWithLlm(imageBytes, contentType, env) {
  switch (llmProvider(env)) {
    case ANTHROPIC_PROVIDER: return scanReceiptWithAnthropic(imageBytes, contentType, env)
    case ZAI_PROVIDER: return scanReceiptWithZai(imageBytes, contentType, env)
    default:
      return {
        ok: false,
        httpStatus: 503,
        scanned: null,
        latencyMs: 0,
        model: llmModel(env),
        errorBody: `LLM_SCAN_PROVIDER must be ${ANTHROPIC_PROVIDER} or ${ZAI_PROVIDER}`,
        providerStarted: false,
        inputPx: null,
      }
  }
}
