import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { queryOne, query } from '../db/pool.js'
import { requireAuth } from '../middleware/auth.js'
import { revokeAllUserTokens } from '../auth/tokens.js'
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
