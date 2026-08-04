import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../config.js'
import type { Actor, Role } from '../query/policies.js'

/**
 * Short-lived signed download URLs.
 *
 * Sign-in runs as a Server Action on the portal, which re-issues the session as
 * a cookie on the PORTAL's hostname -- the browser never holds a cookie for the
 * API's hostname. Ordinary XHR works because it is proxied through the portal's
 * own origin, but a URL the browser fetches on its own -- `<iframe src>`,
 * `<img src>`, a download anchor, a new tab -- goes straight to the API with no
 * credentials and no way to carry an Authorization header, so it comes back
 * 401.
 *
 * A signed URL moves the proof of access into the URL itself. The frontend asks
 * for one over the authenticated channel, then hands the result to the browser.
 * The signature is minted only after the same access check the download route
 * performs, and covers the bucket and key, so a token issued for one file
 * cannot be replayed against another. Tokens are minutes-lived: a leaked one
 * exposes a single file briefly rather than the whole session.
 */

const TOKEN_VERSION = 'v1'

/** Default lifetime. Long enough to open a document, short enough to be dull if it leaks. */
export const DEFAULT_DOWNLOAD_TTL_SECONDS = 15 * 60

/** Ceiling on a caller-supplied `expiresIn`, so a client cannot mint a lasting URL. */
export const MAX_DOWNLOAD_TTL_SECONDS = 60 * 60

export interface DownloadGrant {
  readonly userId: string
  readonly role: Role
  /** Unix seconds. */
  readonly expiresAt: number
}

/**
 * The signature covers every field the token asserts, newline-joined so no
 * value can be shifted into another field's position.
 */
function sign(parts: readonly string[]): string {
  return createHmac('sha256', config.JWT_SECRET).update(parts.join('\n')).digest('base64url')
}

function signaturesMatch(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied)
  const b = Buffer.from(expected)
  // timingSafeEqual throws on a length mismatch, and comparing lengths first
  // leaks nothing an attacker cannot see from the token format anyway.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Mint a download token for one file. Call only after the caller's access to
 * that file has been checked -- this function trusts its arguments.
 */
export function signDownloadToken(
  bucket: string,
  key: string,
  actor: Actor,
  ttlSeconds: number = DEFAULT_DOWNLOAD_TTL_SECONDS
): { token: string; expiresAt: number } {
  const ttl = Math.min(Math.max(Math.floor(ttlSeconds) || 0, 60), MAX_DOWNLOAD_TTL_SECONDS)
  const expiresAt = Math.floor(Date.now() / 1000) + ttl
  const exp = String(expiresAt)

  const signature = sign([TOKEN_VERSION, bucket, key, actor.userId, actor.role, exp])
  return { token: `${TOKEN_VERSION}.${actor.userId}.${actor.role}.${exp}.${signature}`, expiresAt }
}

/**
 * Verify a token against the bucket and key actually being requested.
 *
 * Returns the actor the token was issued to, so the caller can re-run its own
 * access checks rather than treating a valid signature as blanket permission.
 */
export function verifyDownloadToken(
  token: string,
  bucket: string,
  key: string
): DownloadGrant | null {
  const parts = token.split('.')
  if (parts.length !== 5) return null

  const [version, userId, role, exp, signature] = parts as [
    string,
    string,
    string,
    string,
    string,
  ]
  if (version !== TOKEN_VERSION || !userId || !role || !exp || !signature) return null

  const expiresAt = Number(exp)
  if (!Number.isSafeInteger(expiresAt) || expiresAt * 1000 <= Date.now()) return null

  if (!signaturesMatch(signature, sign([version, bucket, key, userId, role, exp]))) return null

  return { userId, role: role as Role, expiresAt }
}

/** The URL a browser can fetch directly, signature and all. */
export function signedDownloadUrl(
  bucket: string,
  key: string,
  actor: Actor,
  ttlSeconds?: number
): { url: string; expiresAt: number } {
  const { token, expiresAt } = signDownloadToken(bucket, key, actor, ttlSeconds)
  const path = key.split('/').map(encodeURIComponent).join('/')
  return {
    url: `${config.PUBLIC_URL}/api/storage/${bucket}/${path}?token=${token}`,
    expiresAt,
  }
}
