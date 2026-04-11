const APPLE_ISSUER = 'https://appleid.apple.com'
const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys'
const JWKS_TTL_MS = 60 * 60 * 1000
const WHITELISTED_EMAIL = 'leojkwan@gmail.com'

export const AUTH_MISSING = 'AUTH_MISSING'
export const AUTH_INVALID = 'AUTH_INVALID'
export const AUTH_EXPIRED = 'AUTH_EXPIRED'
export const AUTH_AUDIENCE = 'AUTH_AUDIENCE'
export const AUTH_ISSUER = 'AUTH_ISSUER'
export const FORBIDDEN_NOT_WHITELISTED = 'FORBIDDEN_NOT_WHITELISTED'

/** @type {Map<string, {jwk: JsonWebKey, fetchedAt: number}>} */
const jwkCache = new Map()

/**
 * Apple Sign-in-with-Apple JWT shape we care about after verification.
 * @typedef {Object} SIWAClaims
 * @property {string} sub
 * @property {string} email
 * @property {boolean} emailVerified
 */

export class AuthError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.code = code
    this.name = 'AuthError'
  }
}

/**
 * Throws `FORBIDDEN_NOT_WHITELISTED` unless the email matches the
 * single-user v1 whitelist exactly (case-insensitive).
 *
 * @param {string} email
 * @returns {void}
 */
export function enforceWhitelist(email) {
  if (typeof email !== 'string' || email.toLowerCase() !== WHITELISTED_EMAIL) {
    throw new AuthError(FORBIDDEN_NOT_WHITELISTED, 'Email not whitelisted')
  }
}

/**
 * Deterministic R2 key prefix derived from the verified email.
 * Uses SHA-256 via Web Crypto — available in Workers and Node 20+.
 *
 * @param {string} email
 * @returns {Promise<string>}
 */
export async function derivePrefix(email) {
  if (typeof email !== 'string' || email.length === 0) {
    throw new AuthError(AUTH_INVALID, 'Cannot derive prefix from empty email')
  }
  const normalized = email.trim().toLowerCase()
  const bytes = new TextEncoder().encode(normalized)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const hex = Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
  return `users/${hex}/photos`
}

/**
 * Extracts and verifies an Apple Sign-in-with-Apple JWT from the
 * request `Authorization: Bearer <jwt>` header. Returns the claims
 * or throws a typed `AuthError`. Fail-closed: any verification or
 * parse error becomes `AUTH_INVALID` unless it matches a more
 * specific category (missing header, expired, wrong audience,
 * wrong issuer).
 *
 * Apple issues RS256-signed tokens; see
 * `evidence/2026-04-11-task1-siwa-research.md` for the codex
 * research that pinned the algorithm + JWKs shape.
 *
 * @param {Request} request
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<SIWAClaims>}
 */
export async function verifySIWAToken(request, env) {
  const auth = request.headers.get('authorization') || request.headers.get('Authorization')
  if (!auth || !auth.toLowerCase().startsWith('bearer ')) {
    throw new AuthError(AUTH_MISSING, 'Missing or malformed Authorization header')
  }
  const token = auth.slice('bearer '.length).trim()
  if (token.length === 0) {
    throw new AuthError(AUTH_MISSING, 'Empty bearer token')
  }

  const parts = token.split('.')
  if (parts.length !== 3) {
    throw new AuthError(AUTH_INVALID, 'JWT must have three segments')
  }
  const [headerB64, payloadB64, signatureB64] = parts

  let header
  let payload
  try {
    header = JSON.parse(new TextDecoder().decode(base64urlToBytes(headerB64)))
    payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(payloadB64)))
  } catch {
    throw new AuthError(AUTH_INVALID, 'JWT header or payload is not valid JSON')
  }

  if (header?.alg !== 'RS256') {
    throw new AuthError(AUTH_INVALID, `Unsupported alg: ${header?.alg}`)
  }
  if (typeof header?.kid !== 'string' || header.kid.length === 0) {
    throw new AuthError(AUTH_INVALID, 'JWT header missing kid')
  }

  const expectedAudience = env.SIWA_EXPECTED_AUDIENCE
  if (!expectedAudience) {
    throw new AuthError(AUTH_AUDIENCE, 'SIWA_EXPECTED_AUDIENCE not configured')
  }
  if (payload?.iss !== APPLE_ISSUER) {
    throw new AuthError(AUTH_ISSUER, `Unexpected issuer: ${payload?.iss}`)
  }
  if (payload?.aud !== expectedAudience) {
    throw new AuthError(AUTH_AUDIENCE, `Unexpected audience: ${payload?.aud}`)
  }
  const nowSec = Math.floor(Date.now() / 1000)
  if (typeof payload?.exp !== 'number' || payload.exp < nowSec) {
    throw new AuthError(AUTH_EXPIRED, 'JWT expired')
  }
  if (typeof payload?.sub !== 'string' || payload.sub.length === 0) {
    throw new AuthError(AUTH_INVALID, 'JWT missing sub')
  }
  if (typeof payload?.email !== 'string' || payload.email.length === 0) {
    throw new AuthError(AUTH_INVALID, 'JWT missing email')
  }

  const jwk = await getCachedJwk(header.kid, env)
  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  )

  const signedMessage = new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  const signatureBytes = base64urlToBytes(signatureB64)
  const verified = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    signatureBytes,
    signedMessage,
  )
  if (!verified) {
    throw new AuthError(AUTH_INVALID, 'JWT signature verification failed')
  }

  return {
    sub: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified === true || payload.email_verified === 'true',
  }
}

/**
 * Best-effort module-scoped JWKs cache. Lazily fetches
 * `https://appleid.apple.com/auth/keys` on first use, caches by `kid`
 * with a 1-hour TTL. On a `kid` miss (or stale entry) refetches once
 * and retries; if still missing throws `AUTH_INVALID`.
 *
 * Isolates get recycled so the cache is not load-bearing — cold-start
 * misses are the expected happy path, not a degraded path.
 *
 * @param {string} kid
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<JsonWebKey>}
 */
async function getCachedJwk(kid, env) {
  const now = Date.now()
  const cached = jwkCache.get(kid)
  if (cached && (now - cached.fetchedAt) < JWKS_TTL_MS) {
    return cached.jwk
  }

  const url = env.SIWA_JWKS_URL || APPLE_JWKS_URL
  let response
  try {
    response = await fetch(url)
  } catch (error) {
    throw new AuthError(AUTH_INVALID, 'Failed to fetch Apple JWKs')
  }
  if (!response.ok) {
    throw new AuthError(AUTH_INVALID, `Apple JWKs fetch returned ${response.status}`)
  }
  let body
  try {
    body = await response.json()
  } catch {
    throw new AuthError(AUTH_INVALID, 'Apple JWKs response is not JSON')
  }
  if (!body || !Array.isArray(body.keys)) {
    throw new AuthError(AUTH_INVALID, 'Apple JWKs response missing keys array')
  }

  for (const jwk of body.keys) {
    if (jwk && typeof jwk.kid === 'string') {
      jwkCache.set(jwk.kid, { jwk, fetchedAt: now })
    }
  }

  const refreshed = jwkCache.get(kid)
  if (!refreshed) {
    throw new AuthError(AUTH_INVALID, `No JWK matches kid ${kid}`)
  }
  return refreshed.jwk
}

/**
 * base64url → Uint8Array. Handles the `-`/`_` substitution and missing
 * padding; matches the JWT spec (RFC 7515 §2).
 *
 * @param {string} s
 * @returns {Uint8Array}
 */
function base64urlToBytes(s) {
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4)
  const base64 = padded.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/**
 * Test helper: clear the module-scoped JWKs cache. Not exported for
 * production use — only the test harness imports this via the internal
 * module path.
 *
 * @returns {void}
 */
export function _resetJwkCacheForTests() {
  jwkCache.clear()
}
