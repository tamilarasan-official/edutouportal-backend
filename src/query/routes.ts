import { Router, type Request, type Response } from 'express'
import { pool, transaction } from '../db/pool.js'
import { requireAuth } from '../middleware/auth.js'
import {
  QueryError,
  QueryRequestSchema,
  applyRedaction,
  buildInsertCheck,
  buildQuery,
} from './builder.js'
import { checkPolicy } from './policies.js'
import { getTable, isTable, type TableName } from './schema.js'
import { publishTo } from '../realtime/hub.js'

export const queryRouter = Router()

/**
 * Fan out row changes on tables the frontend subscribes to.
 *
 * Only `notifications` has a live subscriber today (the header bell). The
 * recipient set is computed here so a student never receives a notification
 * addressed to a different mentor's students -- the old client received
 * everything and filtered in the browser.
 */
async function broadcastRowChange(
  table: TableName,
  eventType: 'INSERT' | 'UPDATE' | 'DELETE',
  rows: Record<string, unknown>[]
): Promise<void> {
  if (table !== 'notifications' || eventType !== 'INSERT') return

  for (const row of rows) {
    let recipients: string[]

    if (row.target_audience === 'mentor_students' && row.mentor_id) {
      const assigned = await pool.query<{ student_id: string }>(
        `SELECT student_id FROM mentor_assignments
          WHERE mentor_id = $1 AND status = 'active'`,
        [row.mentor_id]
      )
      recipients = assigned.rows.map((r) => r.student_id)
    } else {
      const students = await pool.query<{ id: string }>(
        `SELECT id FROM profiles WHERE role = 'student'`
      )
      recipients = students.rows.map((r) => r.id)
    }

    publishTo(new Set(recipients), `table:${table}`, 'postgres_changes', {
      eventType,
      new: row,
      old: {},
    })
  }
}

/**
 * POST /api/db
 *
 * The single data endpoint the frontend's query builder talks to. Everything
 * it can reach is constrained by schema.ts (which tables and columns exist)
 * and policies.ts (which rows this actor may touch).
 */
queryRouter.post('/', requireAuth, async (req: Request, res: Response) => {
  const parsed = QueryRequestSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: parsed.error.issues[0]?.message ?? 'Malformed query',
        code: 'INVALID_QUERY',
        details: parsed.error.issues,
      },
    })
    return
  }

  const request = parsed.data
  const actor = req.actor!

  if (!isTable(request.table)) {
    res.status(404).json({ error: { message: `Unknown table "${request.table}"`, code: 'UNKNOWN_TABLE' } })
    return
  }

  const policy = checkPolicy(request.table, request.op, actor)
  if (!policy.allow) {
    res.status(403).json({ error: { message: policy.reason, code: 'FORBIDDEN' } })
    return
  }

  try {
    const built = buildQuery(request, policy)
    const def = getTable(request.table)

    // -----------------------------------------------------------------------
    // Insert with a row filter needs WITH CHECK semantics: write, verify the
    // written rows satisfy the policy, roll back if not.
    // -----------------------------------------------------------------------
    if (request.op === 'insert' && policy.filter) {
      const rows = await transaction(async (client) => {
        const inserted = await client.query(built.text, built.params as unknown[])
        const ids = inserted.rows.map((r) => (r as { id?: unknown }).id).filter(Boolean)

        if (ids.length > 0) {
          const check = buildInsertCheck(request.table as never, ids, policy.filter!)
          const verdict = await client.query<{ count: number }>(
            check.text,
            check.params as unknown[]
          )
          if ((verdict.rows[0]?.count ?? 0) !== ids.length) {
            throw new QueryError(
              'Insert rejected by access policy',
              403,
              'FORBIDDEN'
            )
          }
        }

        return inserted.rows
      })

      await broadcastRowChange(request.table, 'INSERT', rows as Record<string, unknown>[])
      res.json({ data: rows, count: rows.length })
      return
    }

    // -----------------------------------------------------------------------
    // Everything else is a single statement.
    // -----------------------------------------------------------------------
    const result = await pool.query(built.text, built.params as unknown[])
    let rows = result.rows as Record<string, unknown>[]

    if (request.op === 'insert') {
      await broadcastRowChange(request.table, 'INSERT', rows)
    }

    rows = applyRedaction(rows, policy.redact, def.ownerColumn, actor.userId)

    let count: number | null = rows.length
    if (built.countText) {
      const countResult = await pool.query<{ count: number }>(
        built.countText,
        (built.countParams ?? []) as unknown[]
      )
      count = countResult.rows[0]?.count ?? 0
    }

    // ---------------------------------------------------------------------
    // Cardinality, matching PostgREST/supabase-js semantics so the existing
    // .single() / .maybeSingle() call sites behave identically.
    // ---------------------------------------------------------------------
    if (request.cardinality === 'single') {
      if (rows.length === 0) {
        res.status(406).json({
          error: {
            message: 'JSON object requested, multiple (or no) rows returned',
            // PGRST116 is the code app/auth/callback and several pages branch on.
            code: 'PGRST116',
          },
          data: null,
        })
        return
      }
      if (rows.length > 1) {
        res.status(406).json({
          error: { message: 'More than one row returned', code: 'PGRST114' },
          data: null,
        })
        return
      }
      res.json({ data: rows[0], count })
      return
    }

    if (request.cardinality === 'maybe') {
      if (rows.length > 1) {
        res.status(406).json({
          error: { message: 'More than one row returned', code: 'PGRST114' },
          data: null,
        })
        return
      }
      res.json({ data: rows[0] ?? null, count })
      return
    }

    res.json({ data: rows, count })
  } catch (err) {
    if (err instanceof QueryError) {
      res.status(err.status).json({ error: { message: err.message, code: err.code } })
      return
    }

    // Translate the Postgres errors the frontend actually branches on.
    const pgError = err as { code?: string; constraint?: string; detail?: string; message?: string }

    if (pgError.code === '23505') {
      res.status(409).json({
        error: {
          message: 'That record already exists',
          code: '23505',
          details: pgError.constraint,
        },
      })
      return
    }
    if (pgError.code === '23503') {
      res.status(409).json({
        error: { message: 'Referenced record does not exist', code: '23503' },
      })
      return
    }
    if (pgError.code === '23514') {
      res.status(400).json({
        error: { message: 'Value failed a validation constraint', code: '23514' },
      })
      return
    }

    console.error('[query] unexpected failure', {
      table: request.table,
      op: request.op,
      error: pgError.message,
    })
    res.status(500).json({ error: { message: 'Query failed', code: 'INTERNAL' } })
  }
})
