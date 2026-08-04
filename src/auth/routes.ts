import { Router, type Request, type Response } from 'express'
import rateLimit from 'express-rate-limit'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { config } from '../config.js'
import { query, queryOne, transaction } from '../db/pool.js'
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  cookieOptions,
  requireAuth,
} from '../middleware/auth.js'
import {
  consumeOneTimeToken,
  consumeRefreshToken,
  fakeVerifyDelay,
  hashPassword,
  issueRefreshToken,
  revokeAllUserTokens,
  revokeRefreshToken,
  rotateRefreshToken,
  signAccessToken,
  verifyPassword,
} from './tokens.js'
import type { Role } from '../query/policies.js'

export const authRouter = Router()

/**
 * Brute-force protection. GoTrue rate-limited these endpoints for us; nothing
 * in the old app did once we own the server.
 *
 * Disabled under NODE_ENV=test only: the integration suite creates dozens of
 * accounts from one address, and a 5-per-hour signup cap makes the whole suite
 * unrunnable. Production and development keep the real limits.
 */
const noopLimiter = (_req: Request, _res: Response, next: () => void) => next()

const loginLimiter =
  config.NODE_ENV === 'test'
    ? noopLimiter
    : rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 10,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: { error: { message: 'Too many attempts, try again later', code: 'RATE_LIMITED' } },
      })

const signupLimiter =
  config.NODE_ENV === 'test'
    ? noopLimiter
    : rateLimit({
        windowMs: 60 * 60 * 1000,
        limit: 5,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: {
          error: { message: 'Too many signups from this address', code: 'RATE_LIMITED' },
        },
      })

interface UserRow {
  id: string
  email: string
  password_hash: string | null
}

async function establishSession(
  res: Response,
  req: Request,
  user: { id: string; email: string; role: Role }
): Promise<void> {
  const access = await signAccessToken({ sub: user.id, email: user.email, role: user.role })
  const refresh = await issueRefreshToken(user.id, req.get('user-agent') ?? undefined)

  res.cookie(ACCESS_COOKIE, access, cookieOptions(config.ACCESS_TOKEN_TTL_SECONDS))
  res.cookie(REFRESH_COOKIE, refresh, cookieOptions(config.REFRESH_TOKEN_TTL_SECONDS))

  await query('UPDATE users SET last_sign_in_at = now() WHERE id = $1', [user.id])
}

function clearSession(res: Response): void {
  const base = { ...cookieOptions(0), maxAge: undefined }
  res.clearCookie(ACCESS_COOKIE, base)
  res.clearCookie(REFRESH_COOKIE, base)
}

/** The user object the frontend expects, matching supabase-js's shape. */
async function serialiseUser(userId: string) {
  return queryOne(
    `SELECT u.id,
            u.email,
            u.email_confirmed_at,
            u.created_at,
            u.last_sign_in_at,
            u.user_metadata,
            p.role,
            p.full_name,
            p.avatar_url
       FROM users u
       JOIN profiles p ON p.id = u.id
      WHERE u.id = $1`,
    [userId]
  )
}

// ---------------------------------------------------------------------------
// POST /auth/signup
// ---------------------------------------------------------------------------

const SignupSchema = z.object({
  email: z.string().email().max(320),
  // 8 is the practical floor; the old app inherited Supabase's 6 and never
  // stated a policy anywhere.
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
  full_name: z.string().max(200).optional(),
})

authRouter.post('/signup', signupLimiter, async (req: Request, res: Response) => {
  const parsed = SignupSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({
      error: { message: parsed.error.issues[0]?.message ?? 'Invalid signup', code: 'INVALID' },
    })
    return
  }

  const { email, password, full_name } = parsed.data

  const existing = await queryOne<{ id: string }>(
    'SELECT id FROM users WHERE lower(email) = lower($1)',
    [email]
  )
  if (existing) {
    // Do not confirm which addresses are registered.
    res.status(409).json({
      error: { message: 'Could not create this account', code: 'SIGNUP_FAILED' },
    })
    return
  }

  const passwordHash = await hashPassword(password)

  const user = await transaction(async (client) => {
    const { rows } = await client.query<{ id: string; email: string }>(
      `INSERT INTO users (email, password_hash, user_metadata, email_confirmed_at)
       VALUES ($1, $2, $3, now())
       RETURNING id, email`,
      [email, passwordHash, JSON.stringify({ full_name: full_name ?? null })]
    )
    // The on_user_created trigger has already inserted the profile row.
    return rows[0]!
  })

  const profile = await queryOne<{ role: string }>('SELECT role FROM profiles WHERE id = $1', [
    user.id,
  ])

  await establishSession(res, req, {
    id: user.id,
    email: user.email,
    role: (profile?.role ?? 'student') as Role,
  })

  res.status(201).json({ user: await serialiseUser(user.id) })
})

// ---------------------------------------------------------------------------
// POST /auth/login
// ---------------------------------------------------------------------------

const LoginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
})

authRouter.post('/login', loginLimiter, async (req: Request, res: Response) => {
  const parsed = LoginSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid credentials', code: 'INVALID' } })
    return
  }

  const { email, password } = parsed.data

  const user = await queryOne<UserRow>(
    'SELECT id, email, password_hash FROM users WHERE lower(email) = lower($1)',
    [email]
  )

  if (!user?.password_hash) {
    // Equalise timing between "no such user" and "wrong password".
    await fakeVerifyDelay()
    res.status(400).json({ error: { message: 'Invalid login credentials', code: 'INVALID_CREDENTIALS' } })
    return
  }

  const ok = await verifyPassword(user.password_hash, password)
  if (!ok) {
    res.status(400).json({ error: { message: 'Invalid login credentials', code: 'INVALID_CREDENTIALS' } })
    return
  }

  const profile = await queryOne<{ role: string }>('SELECT role FROM profiles WHERE id = $1', [
    user.id,
  ])

  await establishSession(res, req, {
    id: user.id,
    email: user.email,
    role: (profile?.role ?? 'student') as Role,
  })

  res.json({ user: await serialiseUser(user.id) })
})

// ---------------------------------------------------------------------------
// POST /auth/refresh
// ---------------------------------------------------------------------------

authRouter.post('/refresh', async (req: Request, res: Response) => {
  const token = req.cookies?.[REFRESH_COOKIE] as string | undefined
  if (!token) {
    res.status(401).json({ error: { message: 'No refresh token', code: 'UNAUTHENTICATED' } })
    return
  }

  const result = await consumeRefreshToken(token)
  if (!result) {
    clearSession(res)
    res.status(401).json({ error: { message: 'Session expired', code: 'UNAUTHENTICATED' } })
    return
  }

  const row = await queryOne<{ email: string; role: string }>(
    `SELECT u.email, p.role FROM users u JOIN profiles p ON p.id = u.id WHERE u.id = $1`,
    [result.userId]
  )
  if (!row) {
    clearSession(res)
    res.status(401).json({ error: { message: 'Account not found', code: 'UNAUTHENTICATED' } })
    return
  }

  const access = await signAccessToken({
    sub: result.userId,
    email: row.email,
    role: row.role as Role,
  })
  const rotated = await rotateRefreshToken(
    result.tokenId,
    result.userId,
    req.get('user-agent') ?? undefined
  )

  res.cookie(ACCESS_COOKIE, access, cookieOptions(config.ACCESS_TOKEN_TTL_SECONDS))
  res.cookie(REFRESH_COOKIE, rotated, cookieOptions(config.REFRESH_TOKEN_TTL_SECONDS))

  res.json({ user: await serialiseUser(result.userId) })
})

// ---------------------------------------------------------------------------
// POST /auth/logout
// ---------------------------------------------------------------------------

authRouter.post('/logout', async (req: Request, res: Response) => {
  const token = req.cookies?.[REFRESH_COOKIE] as string | undefined
  if (token) await revokeRefreshToken(token)
  clearSession(res)
  res.json({ success: true })
})

// ---------------------------------------------------------------------------
// GET /auth/user
// ---------------------------------------------------------------------------

authRouter.get('/user', async (req: Request, res: Response) => {
  if (!req.actor) {
    // supabase-js resolves getUser() to { user: null } rather than throwing,
    // and a lot of page code depends on that.
    res.json({ user: null })
    return
  }
  res.json({ user: await serialiseUser(req.actor.userId) })
})

// ---------------------------------------------------------------------------
// PATCH /auth/user  -- password / email change (settings > Security)
// ---------------------------------------------------------------------------

const UpdateUserSchema = z.object({
  password: z.string().min(8).max(200).optional(),
  current_password: z.string().max(200).optional(),
  email: z.string().email().max(320).optional(),
  data: z.record(z.unknown()).optional(),
})

authRouter.patch('/user', requireAuth, async (req: Request, res: Response) => {
  const parsed = UpdateUserSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid update', code: 'INVALID' } })
    return
  }

  const actor = req.actor!
  const { password, current_password, email, data } = parsed.data

  if (password) {
    // Supabase let a logged-in session change the password without re-auth.
    // Requiring the current password means a stolen session alone cannot lock
    // the real owner out of their account.
    const row = await queryOne<{ password_hash: string | null }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [actor.userId]
    )
    if (row?.password_hash) {
      if (!current_password || !(await verifyPassword(row.password_hash, current_password))) {
        res.status(403).json({
          error: { message: 'Current password is incorrect', code: 'REAUTH_REQUIRED' },
        })
        return
      }
    }

    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [
      await hashPassword(password),
      actor.userId,
    ])
    // Changing a password ends every other session.
    await revokeAllUserTokens(actor.userId)
    await establishSession(res, req, {
      id: actor.userId,
      email: email ?? '',
      role: actor.role,
    })
  }

  if (email) {
    const clash = await queryOne<{ id: string }>(
      'SELECT id FROM users WHERE lower(email) = lower($1) AND id <> $2',
      [email, actor.userId]
    )
    if (clash) {
      res.status(409).json({ error: { message: 'Email already in use', code: 'EMAIL_TAKEN' } })
      return
    }
    await query('UPDATE users SET email = $1 WHERE id = $2', [email, actor.userId])
    await query('UPDATE profiles SET email = $1 WHERE id = $2', [email, actor.userId])
  }

  if (data) {
    await query('UPDATE users SET user_metadata = user_metadata || $1::jsonb WHERE id = $2', [
      JSON.stringify(data),
      actor.userId,
    ])
  }

  res.json({ user: await serialiseUser(actor.userId) })
})

// ---------------------------------------------------------------------------
// POST /auth/verify-otp  -- email confirmation links (app/auth/confirm)
// ---------------------------------------------------------------------------

authRouter.post('/verify-otp', async (req: Request, res: Response) => {
  const schema = z.object({
    token_hash: z.string().min(1).max(500),
    type: z.enum(['signup', 'recovery', 'email_change', 'email']),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid token', code: 'INVALID' } })
    return
  }

  // supabase-js used 'email' as an alias for signup confirmation.
  const type = parsed.data.type === 'email' ? 'signup' : parsed.data.type
  const userId = await consumeOneTimeToken(parsed.data.token_hash, type)

  if (!userId) {
    res.status(400).json({ error: { message: 'Token is invalid or expired', code: 'INVALID_TOKEN' } })
    return
  }

  await query('UPDATE users SET email_confirmed_at = COALESCE(email_confirmed_at, now()) WHERE id = $1', [
    userId,
  ])

  const row = await queryOne<{ email: string; role: string }>(
    `SELECT u.email, p.role FROM users u JOIN profiles p ON p.id = u.id WHERE u.id = $1`,
    [userId]
  )

  await establishSession(res, req, {
    id: userId,
    email: row?.email ?? '',
    role: (row?.role ?? 'student') as Role,
  })

  res.json({ user: await serialiseUser(userId) })
})

// ---------------------------------------------------------------------------
// Google OAuth  (README task #1 -- already implemented client-side, now server-side)
// ---------------------------------------------------------------------------

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo'
const OAUTH_STATE_COOKIE = 'edutou_oauth_state'

authRouter.get('/oauth/google', (req: Request, res: Response) => {
  if (!config.googleEnabled) {
    res.status(501).json({ error: { message: 'Google sign-in is not configured', code: 'NOT_CONFIGURED' } })
    return
  }

  // CSRF protection for the OAuth round trip.
  const state = randomBytes(24).toString('base64url')
  res.cookie(OAUTH_STATE_COOKIE, state, { ...cookieOptions(600), httpOnly: true })

  const redirectUri = `${config.PUBLIC_URL}/auth/oauth/google/callback`
  const url = new URL(GOOGLE_AUTH_URL)
  url.searchParams.set('client_id', config.GOOGLE_CLIENT_ID!)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'openid email profile')
  url.searchParams.set('state', state)
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')

  res.redirect(url.toString())
})

authRouter.get('/oauth/google/callback', async (req: Request, res: Response) => {
  const failure = (reason: string) =>
    res.redirect(`${config.FRONTEND_URL}/login?error=${encodeURIComponent(reason)}`)

  if (!config.googleEnabled) return failure('oauth_not_configured')

  const code = typeof req.query.code === 'string' ? req.query.code : null
  const state = typeof req.query.state === 'string' ? req.query.state : null
  const expected = req.cookies?.[OAUTH_STATE_COOKIE] as string | undefined

  res.clearCookie(OAUTH_STATE_COOKIE, { ...cookieOptions(0), maxAge: undefined })

  if (!code) return failure('no_code')
  if (!state || !expected || state !== expected) return failure('state_mismatch')

  try {
    const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: config.GOOGLE_CLIENT_ID!,
        client_secret: config.GOOGLE_CLIENT_SECRET!,
        redirect_uri: `${config.PUBLIC_URL}/auth/oauth/google/callback`,
        grant_type: 'authorization_code',
      }),
    })

    if (!tokenResponse.ok) return failure('token_exchange_failed')
    const tokens = (await tokenResponse.json()) as { access_token?: string }
    if (!tokens.access_token) return failure('token_exchange_failed')

    const profileResponse = await fetch(GOOGLE_USERINFO_URL, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    })
    if (!profileResponse.ok) return failure('userinfo_failed')

    const googleUser = (await profileResponse.json()) as {
      sub: string
      email?: string
      email_verified?: boolean
      name?: string
      picture?: string
    }

    if (!googleUser.email || googleUser.email_verified === false) {
      return failure('unverified_email')
    }

    const userId = await transaction(async (client) => {
      const { rows: identityRows } = await client.query<{ user_id: string }>(
        `SELECT user_id FROM oauth_identities WHERE provider = 'google' AND provider_uid = $1`,
        [googleUser.sub]
      )
      if (identityRows[0]) return identityRows[0].user_id

      // Link to an existing local account with the same address, otherwise
      // create one. Safe because Google asserted email_verified.
      const { rows: userRows } = await client.query<{ id: string }>(
        'SELECT id FROM users WHERE lower(email) = lower($1)',
        [googleUser.email]
      )

      let id = userRows[0]?.id
      if (!id) {
        const { rows: created } = await client.query<{ id: string }>(
          `INSERT INTO users (email, user_metadata, email_confirmed_at)
           VALUES ($1, $2, now()) RETURNING id`,
          [
            googleUser.email,
            JSON.stringify({ full_name: googleUser.name ?? null, avatar_url: googleUser.picture ?? null }),
          ]
        )
        id = created[0]!.id
      }

      await client.query(
        `INSERT INTO oauth_identities (user_id, provider, provider_uid, provider_data)
         VALUES ($1, 'google', $2, $3)
         ON CONFLICT (provider, provider_uid) DO NOTHING`,
        [id, googleUser.sub, JSON.stringify(googleUser)]
      )

      return id
    })

    const row = await queryOne<{ email: string; role: string }>(
      `SELECT u.email, p.role FROM users u JOIN profiles p ON p.id = u.id WHERE u.id = $1`,
      [userId]
    )

    await establishSession(res, req, {
      id: userId,
      email: row?.email ?? googleUser.email,
      role: (row?.role ?? 'student') as Role,
    })

    // Land on the role's home, mirroring the old callback route's behaviour.
    const role = (row?.role ?? 'student').toLowerCase()
    const destination = role === 'admin' ? '/admin' : role === 'mentor' ? '/mentor' : '/'
    res.redirect(`${config.FRONTEND_URL}${destination}`)
  } catch (err) {
    console.error('[auth] google oauth failed', err)
    return failure('unexpected')
  }
})
