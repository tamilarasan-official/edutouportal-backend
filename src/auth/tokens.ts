import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
import argon2 from 'argon2'
import { config } from '../config.js'
import { query, queryOne } from '../db/pool.js'
import type { Role } from '../query/policies.js'

/**
 * Session tokens. Replaces GoTrue.
 *
 * Access tokens are short-lived JWTs carried in an httpOnly cookie. Refresh
 * tokens are opaque random strings; only their SHA-256 hash is stored, so a
 * database leak does not hand over live sessions.
 */

const secret = new TextEncoder().encode(config.JWT_SECRET)
const ISSUER = 'edutou'
const AUDIENCE = 'edutou-app'

export interface AccessClaims {
  readonly sub: string
  readonly email: string
  readonly role: Role
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

/**
 * Argon2id with parameters at the OWASP-recommended floor. Chosen over bcrypt
 * because bcrypt silently truncates at 72 bytes.
 */
export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, {
    type: argon2.argon2id,
    memoryCost: 19 * 1024,
    timeCost: 2,
    parallelism: 1,
  })
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain)
  } catch {
    return false
  }
}

/**
 * Burn roughly the same time as a real verification when the account does not
 * exist, so response timing does not reveal which emails are registered.
 */
export async function fakeVerifyDelay(): Promise<void> {
  await argon2
    .hash('timing-equalisation-placeholder', {
      type: argon2.argon2id,
      memoryCost: 19 * 1024,
      timeCost: 2,
      parallelism: 1,
    })
    .catch(() => undefined)
}

// ---------------------------------------------------------------------------
// Access tokens
// ---------------------------------------------------------------------------

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT({ email: claims.email, role: claims.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${config.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(secret)
}

export async function verifyAccessToken(token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: ISSUER,
      audience: AUDIENCE,
    })
    if (typeof payload.sub !== 'string' || typeof payload.role !== 'string') return null
    return {
      sub: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : '',
      role: payload.role as Role,
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Refresh tokens
// ---------------------------------------------------------------------------

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

export async function issueRefreshToken(userId: string, userAgent?: string): Promise<string> {
  const token = randomBytes(48).toString('base64url')
  const expiresAt = new Date(Date.now() + config.REFRESH_TOKEN_TTL_SECONDS * 1000)

  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, user_agent, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [userId, sha256(token), userAgent ?? null, expiresAt]
  )

  return token
}

export interface RefreshResult {
  readonly userId: string
  readonly tokenId: string
}

export async function consumeRefreshToken(token: string): Promise<RefreshResult | null> {
  const row = await queryOne<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM refresh_tokens
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [sha256(token)]
  )
  if (!row) return null
  return { userId: row.user_id, tokenId: row.id }
}

/** Rotate on every use: the old token is revoked as the new one is issued. */
export async function rotateRefreshToken(
  tokenId: string,
  userId: string,
  userAgent?: string
): Promise<string> {
  await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1`, [tokenId])
  return issueRefreshToken(userId, userAgent)
}

export async function revokeRefreshToken(token: string): Promise<void> {
  await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1`, [
    sha256(token),
  ])
}

/** Used when an admin changes someone's role, so the stale role claim dies. */
export async function revokeAllUserTokens(userId: string): Promise<void> {
  await query(
    `UPDATE refresh_tokens SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  )
}

export async function purgeExpiredTokens(): Promise<void> {
  await query(`DELETE FROM refresh_tokens WHERE expires_at < now() - interval '7 days'`)
  await query(`DELETE FROM one_time_tokens WHERE expires_at < now() - interval '7 days'`)
}

// ---------------------------------------------------------------------------
// One-time tokens (email confirmation, password reset)
// ---------------------------------------------------------------------------

export async function issueOneTimeToken(
  userId: string,
  type: 'signup' | 'recovery' | 'email_change',
  ttlSeconds = 60 * 60 * 24
): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  await query(
    `INSERT INTO one_time_tokens (user_id, token_type, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [userId, type, sha256(token), new Date(Date.now() + ttlSeconds * 1000)]
  )
  return token
}

export async function consumeOneTimeToken(
  token: string,
  type: string
): Promise<string | null> {
  const row = await queryOne<{ id: string; user_id: string }>(
    `UPDATE one_time_tokens
        SET used_at = now()
      WHERE token_hash = $1
        AND token_type = $2
        AND used_at IS NULL
        AND expires_at > now()
      RETURNING id, user_id`,
    [sha256(token), type]
  )
  return row?.user_id ?? null
}

/** Constant-time compare for any secret we hand back to a client. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}
