const WHITELISTED_EMAIL = 'leojkwan@gmail.com'

export const AUTH_MISSING = 'AUTH_MISSING'
export const AUTH_INVALID = 'AUTH_INVALID'
export const FORBIDDEN_NOT_WHITELISTED = 'FORBIDDEN_NOT_WHITELISTED'

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
 * Reads the authenticated user email from the Cloudflare Access
 * injected header. CF Access validates the JWT at the edge — the
 * Worker trusts the injected header unconditionally.
 *
 * @param {Request} request
 * @returns {{ email: string }}
 */
export function readCFAccessIdentity(request) {
  const email = request.headers.get('Cf-Access-Authenticated-User-Email')
  if (!email || email.trim().length === 0) {
    throw new AuthError(AUTH_MISSING, 'Missing Cf-Access-Authenticated-User-Email header')
  }
  return { email: email.trim().toLowerCase() }
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
