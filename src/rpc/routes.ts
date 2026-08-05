import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { queryOne, query, transaction } from '../db/pool.js'
import { requireAuth } from '../middleware/auth.js'
import { hashPassword, revokeAllUserTokens } from '../auth/tokens.js'
import type { Actor } from '../query/policies.js'

export const rpcRouter = Router()

/**
 * Stored-procedure endpoints, mirroring the four supabase.rpc() calls in
 * utils/points.ts and the live-session code.
 *
 * Each one is individually authorized. The old client called these with the
 * anon key and nothing but (unwritten) RLS between a student and
 * `adjust_points_manual(me, +1000000)`.
 */

type Handler = (actor: Actor, args: Record<string, unknown>) => Promise<unknown>

const isStaff = (a: Actor) => a.role === 'admin' || a.role === 'mentor'

/** Mentors may only act on students assigned to them. */
async function mentorOwnsStudent(mentorId: string, studentId: string): Promise<boolean> {
  const row = await queryOne(
    `SELECT 1 FROM mentor_assignments
      WHERE mentor_id = $1 AND student_id = $2 AND status = 'active'`,
    [mentorId, studentId]
  )
  return row !== null
}

const HANDLERS: Record<string, Handler> = {
  // -------------------------------------------------------------------------
  // award_points : credit a configured action.
  //
  // Callers pass p_user_id, but a student may only award points to themselves,
  // and only for actions they could plausibly have performed. Staff may award
  // to anyone they manage.
  // -------------------------------------------------------------------------
  award_points: async (actor, args) => {
    const schema = z.object({
      p_user_id: z.string().uuid(),
      p_action_type: z.string().max(64),
      p_reference_id: z.string().max(200).nullish(),
      p_reference_type: z.string().max(64).nullish(),
      p_description: z.string().max(500).nullish(),
    })
    const a = schema.parse(args)

    if (a.p_user_id !== actor.userId) {
      if (actor.role === 'admin') {
        // allowed
      } else if (actor.role === 'mentor' && (await mentorOwnsStudent(actor.userId, a.p_user_id))) {
        // allowed
      } else {
        throw Object.assign(new Error('Cannot award points to another user'), { status: 403 })
      }
    }

    // Manual types must go through adjust_points_manual, which is staff-gated.
    if (a.p_action_type.startsWith('manual_')) {
      throw Object.assign(new Error('Use adjust_points_manual for manual awards'), { status: 400 })
    }

    const row = await queryOne<{ award_points: number }>(
      'SELECT award_points($1, $2, $3, $4, $5) AS award_points',
      [
        a.p_user_id,
        a.p_action_type,
        a.p_reference_id ?? null,
        a.p_reference_type ?? null,
        a.p_description ?? null,
      ]
    )
    return row?.award_points ?? 0
  },

  // -------------------------------------------------------------------------
  // adjust_points_manual : staff-only grant or deduction.
  // -------------------------------------------------------------------------
  adjust_points_manual: async (actor, args) => {
    if (!isStaff(actor)) {
      throw Object.assign(new Error('Only mentors and admins can adjust points'), { status: 403 })
    }

    const schema = z.object({
      p_user_id: z.string().uuid(),
      p_action_type: z.string().max(64),
      // Bounded so a typo or a tampered request cannot mint a billion points.
      p_points: z.number().int().min(-100_000).max(100_000),
      p_reference_id: z.string().max(200).nullish(),
      p_reference_type: z.string().max(64).nullish(),
      p_description: z.string().max(500).nullish(),
    })
    const a = schema.parse(args)

    if (actor.role === 'mentor' && !(await mentorOwnsStudent(actor.userId, a.p_user_id))) {
      throw Object.assign(new Error('That student is not assigned to you'), { status: 403 })
    }

    const row = await queryOne<{ adjust_points_manual: number }>(
      'SELECT adjust_points_manual($1, $2, $3, $4, $5, $6) AS adjust_points_manual',
      [
        a.p_user_id,
        a.p_action_type,
        a.p_points,
        a.p_reference_id ?? null,
        a.p_reference_type ?? null,
        a.p_description ?? `Manual adjustment by ${actor.role}`,
      ]
    )
    return row?.adjust_points_manual ?? 0
  },

  // -------------------------------------------------------------------------
  // get_user_total_points
  // -------------------------------------------------------------------------
  get_user_total_points: async (actor, args) => {
    const schema = z.object({ p_user_id: z.string().uuid() })
    const a = schema.parse(args)

    if (a.p_user_id !== actor.userId && !isStaff(actor)) {
      throw Object.assign(new Error('Cannot read another user\'s points'), { status: 403 })
    }

    const row = await queryOne<{ total: number }>(
      'SELECT get_user_total_points($1) AS total',
      [a.p_user_id]
    )
    return row?.total ?? 0
  },

  // -------------------------------------------------------------------------
  // generate_session_code : mentor-only; used when opening a live session.
  // -------------------------------------------------------------------------
  generate_session_code: async (actor) => {
    if (!isStaff(actor)) {
      throw Object.assign(new Error('Only mentors can create sessions'), { status: 403 })
    }
    const row = await queryOne<{ code: string }>('SELECT generate_session_code() AS code')
    return row?.code ?? null
  },
}

rpcRouter.post('/:name', requireAuth, async (req: Request, res: Response) => {
  const name = req.params.name ?? ''
  const handler = HANDLERS[name]

  if (!handler) {
    res.status(404).json({ error: { message: `Unknown function "${name}"`, code: 'UNKNOWN_RPC' } })
    return
  }

  try {
    const args = (req.body ?? {}) as Record<string, unknown>
    const data = await handler(req.actor!, args)
    res.json({ data })
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({
        error: { message: err.issues[0]?.message ?? 'Invalid arguments', code: 'INVALID_ARGS' },
      })
      return
    }
    const status = (err as { status?: number }).status ?? 500
    if (status === 500) console.error(`[rpc] ${name} failed`, err)
    res.status(status).json({
      error: {
        message: status === 500 ? 'Function failed' : (err as Error).message,
        code: status === 500 ? 'INTERNAL' : 'FORBIDDEN',
      },
    })
  }
})

// ---------------------------------------------------------------------------
// "Me" -- things about the caller that the generic query layer cannot express.
// ---------------------------------------------------------------------------

export const meRouter = Router()

/**
 * GET /api/me/mentor
 *
 * The student-facing My Mentor page needs the assigned mentor's contact
 * details, which /api/db cannot return: the profiles policy redacts email,
 * phone and bio for non-staff, and that redaction is column-level with an
 * exception only for the caller's OWN row. A student reading their mentor's
 * profile therefore gets a name and nothing else, which left the page rendering
 * an empty address and a mailto: link pointing at "undefined".
 *
 * Relaxing the blanket rule would expose every mentor's address to every
 * student. This endpoint instead returns exactly one profile -- the mentor the
 * caller is actively assigned to -- resolved server-side from the caller's own
 * id, so it cannot be pointed at anybody else.
 */
meRouter.get('/mentor', requireAuth, async (req: Request, res: Response) => {
  const row = await queryOne<{
    id: string
    full_name: string | null
    email: string | null
    phone: string | null
    bio: string | null
    assigned_at: string
    student_count: number
  }>(
    `SELECT p.id, p.full_name, p.email, p.phone, p.bio, ma.assigned_at,
            (SELECT count(*)::int FROM mentor_assignments m
              WHERE m.mentor_id = p.id AND m.status = 'active') AS student_count
       FROM mentor_assignments ma
       JOIN profiles p ON p.id = ma.mentor_id
      WHERE ma.student_id = $1 AND ma.status = 'active'
      LIMIT 1`,
    [req.actor!.userId]
  )

  // Not an error: plenty of students have no mentor yet, and the page renders
  // an empty state for it.
  res.json({ data: row })
})

// ---------------------------------------------------------------------------
// Admin-only account operations that used to be plain table writes.
// ---------------------------------------------------------------------------

export const adminRouter = Router()

/**
 * PATCH /api/admin/role
 *
 * Previously this was `supabase.from('profiles').update({ role })` issued from
 * a client component (app/admin/page.tsx, app/admin/students/page.tsx). With
 * RLS unwritten, any authenticated user could promote themselves. `role` is now
 * absent from the profiles updatable list, so this endpoint is the only path.
 */
adminRouter.patch('/role', requireAuth, async (req: Request, res: Response) => {
  if (req.actor!.role !== 'admin') {
    res.status(403).json({ error: { message: 'Admins only', code: 'FORBIDDEN' } })
    return
  }

  const schema = z.object({
    user_id: z.string().uuid(),
    role: z.enum(['admin', 'mentor', 'student', 'coursemaster']),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid role change', code: 'INVALID' } })
    return
  }

  const { user_id, role } = parsed.data

  // Refuse to remove the last admin -- otherwise the instance becomes
  // unadministrable and the only fix is a manual SQL edit in production.
  if (req.actor!.userId === user_id && role !== 'admin') {
    const others = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM profiles WHERE role = 'admin' AND id <> $1`,
      [user_id]
    )
    if ((others?.count ?? 0) === 0) {
      res.status(409).json({
        error: { message: 'Cannot demote the only remaining admin', code: 'LAST_ADMIN' },
      })
      return
    }
  }

  await query('UPDATE profiles SET role = $1 WHERE id = $2', [role, user_id])

  // Force the affected user to re-authenticate so their next token carries the
  // new role rather than the old one.
  await revokeAllUserTokens(user_id)

  res.json({ data: { user_id, role } })
})

/**
 * Account management for the admin student/mentor lists.
 *
 * These three exist because an account cannot be reached through /api/db at
 * all: `users` is deliberately absent from the table registry (it holds
 * password hashes), and the profiles policy denies delete outright with
 * "Profiles are deleted by removing the user account" -- which, until now,
 * nothing was able to do. Creating and deleting a person was a manual SQL job.
 *
 * A profile is not an account. `users` carries the credentials and `profiles`
 * the display record, linked 1:1 by id and created by the on_user_created
 * trigger, so both have to move together -- hence a dedicated endpoint rather
 * than another entry in the generic query layer.
 */

const adminOnly = (req: Request, res: Response): boolean => {
  if (req.actor!.role !== 'admin') {
    res.status(403).json({ error: { message: 'Admins only', code: 'FORBIDDEN' } })
    return false
  }
  return true
}

/**
 * POST /api/admin/users
 *
 * Create an account on someone's behalf. Signup always yields a student and
 * requires the person to choose their own password, which is no use for a
 * cohort an admin is enrolling.
 */
adminRouter.post('/users', requireAuth, async (req: Request, res: Response) => {
  if (!adminOnly(req, res)) return

  const schema = z.object({
    email: z.string().email(),
    // Matches the signup endpoint. argon2 has no bcrypt-style 72-byte cliff, so
    // only a floor is enforced.
    password: z.string().min(8, 'Password must be at least 8 characters'),
    full_name: z.string().min(1).max(200),
    role: z.enum(['admin', 'mentor', 'student', 'coursemaster']).default('student'),
  })

  const parsed = schema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: parsed.error.issues[0]?.message ?? 'Invalid account details',
        code: 'INVALID',
      },
    })
    return
  }

  const { email, password, full_name, role } = parsed.data

  const existing = await queryOne<{ id: string }>(
    'SELECT id FROM users WHERE lower(email) = lower($1)',
    [email]
  )
  if (existing) {
    res.status(409).json({
      error: { message: 'That email address is already registered', code: 'EMAIL_TAKEN' },
    })
    return
  }

  const passwordHash = await hashPassword(password)

  const created = await transaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, user_metadata, email_confirmed_at)
       VALUES ($1, $2, $3, now())
       RETURNING id`,
      [email, passwordHash, JSON.stringify({ full_name })]
    )
    const userId = rows[0]!.id

    // on_user_created has already inserted the profile as a student; correct the
    // name and role in the same transaction so a failure leaves no half-account.
    await client.query('UPDATE profiles SET full_name = $2, role = $3 WHERE id = $1', [
      userId,
      full_name,
      role,
    ])

    return userId
  })

  res.status(201).json({ data: { id: created, email, full_name, role } })
})

/**
 * PATCH /api/admin/users/:id
 *
 * Edit somebody else's details. A student can already edit their own profile
 * through /api/db, but that path is scoped to the caller's own row and cannot
 * touch `users.email`.
 *
 * Email is the reason this endpoint exists rather than widening the profiles
 * policy: the address is stored twice -- `users.email` is what login checks,
 * `profiles.email` is what the UI renders. Updating only the profile would
 * leave someone unable to sign in with the address shown next to their name.
 */
adminRouter.patch('/users/:id', requireAuth, async (req: Request, res: Response) => {
  const actor = req.actor!

  // Mentors get a narrow slice of this: their own students, and only the fields
  // that are not credentials. Everyone else must be an admin.
  if (actor.role !== 'admin' && actor.role !== 'mentor') {
    res.status(403).json({ error: { message: 'Admins only', code: 'FORBIDDEN' } })
    return
  }

  const idResult = z.string().uuid().safeParse(req.params.id)
  if (!idResult.success) {
    res.status(400).json({ error: { message: 'Invalid user id', code: 'INVALID' } })
    return
  }
  const userId = idResult.data

  const schema = z
    .object({
      full_name: z.string().min(1).max(200).optional(),
      email: z.string().email().optional(),
      phone: z.string().max(40).nullable().optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' })

  const parsed = schema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: parsed.error.issues[0]?.message ?? 'Invalid account details',
        code: 'INVALID',
      },
    })
    return
  }

  const target = await queryOne<{ id: string }>('SELECT id FROM users WHERE id = $1', [userId])
  if (!target) {
    res.status(404).json({ error: { message: 'No such user', code: 'NOT_FOUND' } })
    return
  }

  const { full_name, email, phone } = parsed.data

  if (actor.role === 'mentor') {
    // Email is the address login checks, so changing it can lock someone out or
    // hand their account to a different inbox. That stays with admins.
    if (email !== undefined) {
      res.status(403).json({
        error: {
          message: 'Only an admin can change the sign-in email',
          code: 'FORBIDDEN_FIELD',
        },
      })
      return
    }

    // Scope: an active assignment to THIS mentor. Without the status check a
    // mentor would keep write access to students they no longer teach.
    if (!(await mentorOwnsStudent(actor.userId, userId))) {
      res.status(403).json({
        error: { message: 'That student is not assigned to you', code: 'FORBIDDEN' },
      })
      return
    }
  }

  if (email) {
    const clash = await queryOne<{ id: string }>(
      'SELECT id FROM users WHERE lower(email) = lower($1) AND id <> $2',
      [email, userId]
    )
    if (clash) {
      res.status(409).json({
        error: { message: 'That email address is already registered', code: 'EMAIL_TAKEN' },
      })
      return
    }
  }

  await transaction(async (client) => {
    if (email) {
      await client.query('UPDATE users SET email = $1 WHERE id = $2', [email, userId])
    }

    // COALESCE so an omitted field keeps its current value rather than nulling.
    await client.query(
      `UPDATE profiles
          SET full_name = COALESCE($2, full_name),
              email     = COALESCE($3, email),
              phone     = CASE WHEN $4::boolean THEN $5 ELSE phone END
        WHERE id = $1`,
      [userId, full_name ?? null, email ?? null, phone !== undefined, phone ?? null]
    )
  })

  const updated = await queryOne(
    'SELECT id, full_name, email, phone, role FROM profiles WHERE id = $1',
    [userId]
  )

  res.json({ data: updated })
})

/**
 * DELETE /api/admin/users/:id
 *
 * Removes the account. Every dependent row is ON DELETE CASCADE from `users`,
 * so this also erases the person's profile, submissions, quiz attempts, points
 * ledger and team membership. There is no soft-delete in this schema.
 */
adminRouter.delete('/users/:id', requireAuth, async (req: Request, res: Response) => {
  if (!adminOnly(req, res)) return

  const idResult = z.string().uuid().safeParse(req.params.id)
  if (!idResult.success) {
    res.status(400).json({ error: { message: 'Invalid user id', code: 'INVALID' } })
    return
  }
  const userId = idResult.data

  // Deleting yourself would end the session mid-request and, if you were the
  // only admin, lock the instance out of its own administration.
  if (req.actor!.userId === userId) {
    res.status(409).json({
      error: { message: 'You cannot delete your own account', code: 'SELF_DELETE' },
    })
    return
  }

  const target = await queryOne<{ role: string }>('SELECT role FROM profiles WHERE id = $1', [
    userId,
  ])
  if (!target) {
    res.status(404).json({ error: { message: 'No such user', code: 'NOT_FOUND' } })
    return
  }

  // Same reasoning as the demotion guard on PATCH /role.
  if (target.role === 'admin') {
    const others = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM profiles WHERE role = 'admin' AND id <> $1`,
      [userId]
    )
    if ((others?.count ?? 0) === 0) {
      res.status(409).json({
        error: { message: 'Cannot delete the only remaining admin', code: 'LAST_ADMIN' },
      })
      return
    }
  }

  await query('DELETE FROM users WHERE id = $1', [userId])

  res.json({ data: { id: userId } })
})
