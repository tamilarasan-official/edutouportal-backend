import type { NextFunction, Request, Response } from 'express'
import { config } from '../config.js'
import { verifyAccessToken } from '../auth/tokens.js'
import { queryOne } from '../db/pool.js'
import type { Actor, Role } from '../query/policies.js'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      actor?: Actor
    }
  }
}

export const ACCESS_COOKIE = 'edutou_access'
export const REFRESH_COOKIE = 'edutou_refresh'

export function cookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    // Lax rather than Strict: the Google OAuth callback is a top-level
    // cross-site navigation back to us, and Strict would drop the cookie.
    sameSite: 'lax' as const,
    secure: config.isProduction,
    path: '/',
    maxAge: maxAgeSeconds * 1000,
    ...(config.COOKIE_DOMAIN ? { domain: config.COOKIE_DOMAIN } : {}),
  }
}

const VALID_ROLES: readonly Role[] = ['admin', 'mentor', 'student', 'coursemaster']

/**
 * Populate req.actor from the access cookie (or a Bearer header, which the
 * Next.js server components use when forwarding a request server-side).
 *
 * The role is re-read from the database rather than trusted from the token.
 * A JWT minted before an admin demoted someone would otherwise keep working
 * until it expired.
 */
export async function attachActor(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const header = req.headers.authorization
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined
    const token = bearer ?? (req.cookies?.[ACCESS_COOKIE] as string | undefined)

    if (!token) return next()

    const claims = await verifyAccessToken(token)
    if (!claims) return next()

    const profile = await queryOne<{ role: string }>(
      'SELECT role FROM profiles WHERE id = $1',
      [claims.sub]
    )
    if (!profile) return next()

    const role = profile.role.toLowerCase() as Role
    if (!VALID_ROLES.includes(role)) return next()

    req.actor = { userId: claims.sub, role }
    next()
  } catch (err) {
    next(err)
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.actor) {
    res.status(401).json({ error: { message: 'Not authenticated', code: 'UNAUTHENTICATED' } })
    return
  }
  next()
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.actor) {
      res.status(401).json({ error: { message: 'Not authenticated', code: 'UNAUTHENTICATED' } })
      return
    }
    if (!roles.includes(req.actor.role)) {
      res.status(403).json({ error: { message: 'Insufficient role', code: 'FORBIDDEN' } })
      return
    }
    next()
  }
}
