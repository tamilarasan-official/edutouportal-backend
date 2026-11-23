import { Router, type NextFunction, type Request, type Response } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { config } from '../config.js'
import { query, queryOne } from '../db/pool.js'
import { requireRole } from '../middleware/auth.js'
import { defaultLearnPage, learnPageSchema, type LearnPageContent } from './content.js'

/**
 * learn.edutou.in -- the public registration landing page.
 *
 *   GET    /api/learn/page            public   page content (defaults if never saved)
 *   PUT    /api/learn/page            admin    replace page content
 *   POST   /api/learn/register        public   submit the registration form
 *   GET    /api/learn/registrations   admin    list sign-ups (newest first)
 *   DELETE /api/learn/registrations/:id admin  remove one sign-up
 */
export const learnRouter = Router()

/** Express 4 does not catch rejected async handlers; forward them to the error middleware. */
const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next)
  }

async function loadContent(): Promise<{ content: LearnPageContent; updatedAt: string | null }> {
  const row = await queryOne<{ content: unknown; updated_at: Date }>(
    "SELECT content, updated_at FROM learn_page WHERE id = 'main'"
  )
  if (!row) return { content: defaultLearnPage, updatedAt: null }

  // Re-parse so fields added to the schema after this row was saved get defaults.
  const parsed = learnPageSchema.safeParse(row.content)
  if (!parsed.success) {
    console.error('[learn] stored page content no longer validates; serving defaults', parsed.error.issues)
    return { content: defaultLearnPage, updatedAt: row.updated_at.toISOString() }
  }
  return { content: parsed.data, updatedAt: row.updated_at.toISOString() }
}

learnRouter.get('/page', wrap(async (_req: Request, res: Response) => {
  const { content, updatedAt } = await loadContent()
  res.setHeader('Cache-Control', 'public, max-age=15')
  res.json({ data: { content, updatedAt } })
}))

learnRouter.put('/page', requireRole('admin'), wrap(async (req: Request, res: Response) => {
  const parsed = learnPageSchema.safeParse(req.body?.content)
  if (!parsed.success) {
    res.status(422).json({
      error: {
        message: 'Some fields are invalid',
        code: 'VALIDATION',
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    })
    return
  }

  const row = await queryOne<{ updated_at: Date }>(
    `INSERT INTO learn_page (id, content, updated_at, updated_by)
     VALUES ('main', $1, now(), $2)
     ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, updated_at = now(), updated_by = EXCLUDED.updated_by
     RETURNING updated_at`,
    [JSON.stringify(parsed.data), req.actor!.userId]
  )

  res.json({ data: { content: parsed.data, updatedAt: row?.updated_at.toISOString() ?? null } })
}))

// ---------------------------------------------------------------------------
// Registration form
// ---------------------------------------------------------------------------

/**
 * Per-IP cap on sign-ups. Browsers post here directly (learn.edutou.in must be
 * listed in CORS_ORIGINS), so req.ip is the visitor rather than a shared proxy.
 */
const registerLimiter =
  config.NODE_ENV === 'test'
    ? (_req: Request, _res: Response, next: () => void) => next()
    : rateLimit({
        windowMs: 10 * 60 * 1000,
        limit: 10,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: { error: { message: 'Too many attempts, please try again in a few minutes.', code: 'RATE_LIMITED' } },
      })

const clean = (max: number) =>
  z
    .string()
    .transform((v) => v.trim().replace(/\s+/g, ' ').slice(0, max))

const registrationSchema = z.object({
  name: clean(80).pipe(z.string().min(2, 'Please enter your name.')),
  email: clean(120)
    .transform((v) => v.toLowerCase())
    .pipe(z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, 'Please enter a valid email.')),
  // India only: 10 digits starting 6-9. Spaces, dashes and a leading +91/0 are tolerated.
  phone: z
    .string()
    .transform((v) => v.replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, ''))
    .pipe(z.string().regex(/^[6-9]\d{9}$/, 'Please enter a valid 10-digit Indian mobile number.')),
  profession: clean(40).pipe(z.string().min(1, 'Please select your profession.')),
  city: clean(60).pipe(z.string().min(2, 'Please enter your city.')),
  utm_source: clean(60).optional(),
  utm_medium: clean(60).optional(),
  utm_campaign: clean(80).optional(),
  company: z.string().optional(), // honeypot
})

learnRouter.post('/register', registerLimiter, wrap(async (req: Request, res: Response) => {
  // Honeypot: hidden from people, filled by naive bots. Pretend success.
  if (typeof req.body?.company === 'string' && req.body.company.trim() !== '') {
    res.status(201).json({ data: { ok: true } })
    return
  }

  const parsed = registrationSchema.safeParse(req.body ?? {})
  if (!parsed.success) {
    const errors: Record<string, string> = {}
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? 'form')
      errors[field] ??= issue.message.startsWith('Expected') || issue.message === 'Required'
        ? 'This field is required.'
        : issue.message
    }
    res.status(422).json({ error: { message: 'Please check the highlighted fields', code: 'VALIDATION', errors } })
    return
  }

  const { content } = await loadContent()
  const r = parsed.data
  if (!content.form.professions.includes(r.profession)) {
    res.status(422).json({
      error: { message: 'Please check the highlighted fields', code: 'VALIDATION', errors: { profession: 'Please select your profession.' } },
    })
    return
  }

  await query(
    `INSERT INTO learn_registrations (name, email, whatsapp, profession, city, utm_source, utm_medium, utm_campaign)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [r.name, r.email, `+91${r.phone}`, r.profession, r.city, r.utm_source || null, r.utm_medium || null, r.utm_campaign || null]
  )

  res.status(201).json({ data: { ok: true } })
}))

learnRouter.get('/registrations', requireRole('admin'), wrap(async (req: Request, res: Response) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 5000)
  const rows = await query(
    `SELECT id, name, email, whatsapp, profession, city, utm_source, utm_medium, utm_campaign, created_at
       FROM learn_registrations
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit]
  )
  const total = await queryOne<{ count: number }>('SELECT count(*)::int AS count FROM learn_registrations')
  res.json({ data: rows, count: total?.count ?? 0 })
}))

learnRouter.delete('/registrations/:id', requireRole('admin'), wrap(async (req: Request, res: Response) => {
  const id = req.params.id ?? ''
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    res.status(400).json({ error: { message: 'Invalid id', code: 'BAD_REQUEST' } })
    return
  }
  await query('DELETE FROM learn_registrations WHERE id = $1', [id])
  res.json({ data: { success: true } })
}))
