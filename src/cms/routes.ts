import { Router, type NextFunction, type Request, type Response } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { config } from '../config.js'
import { query, queryOne } from '../db/pool.js'
import { requireRole } from '../middleware/auth.js'
import { mailFrom } from '../notify/mailer.js'
import { enrolmentDetails, processOutbox, queueEnrolmentEmails, queueTestEmail } from '../notify/outbox.js'
import { createOrder, toMinorUnits, verifyPaymentSignature } from '../payments/razorpay.js'
import { CLARITY_DAYS, CLARITY_REPORTS, ClarityError, clarityReport, type ClarityReport } from '../analytics/clarity.js'
import {
  categoryInputSchema,
  programmeDataSchema,
  programmeInputSchema,
  programmeStatus,
  settingsDefaults,
  settingsSchemas,
  type ProgrammeData,
  type SettingsKey,
} from './schema.js'

/**
 * CMS for the public website (edutou.in), managed from admin.edutou.in.
 *
 * Public
 *   GET  /api/cms/site                 everything the website renders, published only
 *   POST /api/cms/enrol                enrolment form on edutou.in/enroll
 *
 * Admin (role: admin)
 *   /api/cms/admin/programmes          list, create, read, update, delete, duplicate
 *   /api/cms/admin/categories          list, create, update, delete
 *   /api/cms/admin/settings/:key       domains, enrol_form
 *   /api/cms/admin/enrolments          list, summary, update, mark seen, delete
 */
export const cmsRouter = Router()

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next)
  }

const admin = requireRole('admin')

function validationError(res: Response, error: z.ZodError) {
  res.status(422).json({
    error: {
      message: 'Some fields are invalid',
      code: 'VALIDATION',
      details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    },
  })
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

interface ProgrammeRow {
  id: string
  slug: string
  status: string
  sort_order: number
  data: unknown
  published_at: Date | null
  created_at: Date
  updated_at: Date
}

function shapeProgramme(row: ProgrammeRow) {
  // Re-parse so documents saved before a field existed come back with its default.
  const parsed = programmeDataSchema.safeParse(row.data)
  return {
    id: row.id,
    slug: row.slug,
    status: row.status,
    sortOrder: row.sort_order,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    data: parsed.success ? parsed.data : (row.data as ProgrammeData),
  }
}

async function loadCategories() {
  const rows = await query<{ id: string; title: string; description: string; sort_order: number }>(
    'SELECT id, title, description, sort_order FROM cms_categories ORDER BY sort_order, title'
  )
  return rows.map((r, i) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    sortOrder: r.sort_order,
    no: String(i + 1).padStart(2, '0'),
  }))
}

async function loadSetting<K extends SettingsKey>(key: K): Promise<z.infer<(typeof settingsSchemas)[K]>> {
  const row = await queryOne<{ value: unknown }>('SELECT value FROM cms_settings WHERE key = $1', [key])
  if (!row) return settingsDefaults[key] as z.infer<(typeof settingsSchemas)[K]>
  const parsed = settingsSchemas[key].safeParse(row.value)
  return (parsed.success ? parsed.data : settingsDefaults[key]) as z.infer<(typeof settingsSchemas)[K]>
}

async function assertCategoriesExist(data: ProgrammeData): Promise<string | null> {
  const ids = [data.category, ...data.alsoIn]
  const rows = await query<{ id: string }>('SELECT id FROM cms_categories WHERE id = ANY($1)', [ids])
  const known = new Set(rows.map((r) => r.id))
  const missing = ids.filter((id) => !known.has(id))
  return missing.length ? `Unknown category: ${missing.join(', ')}` : null
}

// ---------------------------------------------------------------------------
// Public: website content
// ---------------------------------------------------------------------------

cmsRouter.get(
  '/site',
  wrap(async (_req, res) => {
    const [categories, domains, enrolForm, analytics, rows] = await Promise.all([
      loadCategories(),
      loadSetting('domains'),
      loadSetting('enrol_form'),
      loadSetting('analytics'),
      query<ProgrammeRow>(
        `SELECT id, slug, status, sort_order, data, published_at, created_at, updated_at
           FROM cms_programmes WHERE status = 'published'
          ORDER BY sort_order, published_at DESC NULLS LAST`
      ),
    ])
    const programmes = rows.map(shapeProgramme).map(({ id, slug, sortOrder, data }) => ({ id, slug, sortOrder, data }))
    res.setHeader('Cache-Control', 'public, max-age=15')
    res.json({
      data: {
        categories,
        domains: domains.items,
        enrolForm,
        programmes,
        paymentsOnline: config.paymentsEnabled,
        analytics: { clarityProjectId: analytics.clarityEnabled ? analytics.clarityProjectId : '' },
      },
    })
  })
)

// ---------------------------------------------------------------------------
// Public: enrolment
// ---------------------------------------------------------------------------

const enrolLimiter =
  config.NODE_ENV === 'test'
    ? (_req: Request, _res: Response, next: () => void) => next()
    : rateLimit({
        windowMs: 10 * 60 * 1000,
        limit: 10,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: { error: { message: 'Too many attempts, please try again in a few minutes.', code: 'RATE_LIMITED' } },
      })

const clean = (max: number) => z.string().transform((v) => v.trim().replace(/\s+/g, ' ').slice(0, max))

const enrolSchema = z.object({
  programme: z.string().trim().max(80).optional().default(''),
  name: clean(80).pipe(z.string().min(2, 'Please enter your name.')),
  email: clean(120)
    .transform((v) => v.toLowerCase())
    .pipe(z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, 'Please enter a valid email.')),
  // India only: 10 digits starting 6-9. A leading +91 / 91 / 0 and spaces are tolerated.
  phone: z
    .string()
    .transform((v) => v.replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, ''))
    .pipe(z.string().regex(/^[6-9]\d{9}$/, 'Please enter a valid 10-digit Indian mobile number.')),
  profession: clean(40).pipe(z.string().min(1, 'Please select your profession.')),
  city: clean(60).pipe(z.string().min(2, 'Please enter your city.')),
  utm_source: clean(60).optional(),
  utm_medium: clean(60).optional(),
  utm_campaign: clean(80).optional(),
})

const DUPLICATE_EMAIL = 'This email is already enrolled for this programme.'
const DUPLICATE_PHONE = 'This WhatsApp number is already enrolled for this programme.'

cmsRouter.post(
  '/enrol',
  enrolLimiter,
  wrap(async (req, res) => {
    // Honeypot: hidden from people, filled by naive bots. Pretend success.
    if (typeof req.body?.company === 'string' && req.body.company.trim() !== '') {
      res.status(201).json({ data: { ok: true } })
      return
    }

    const parsed = enrolSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      const errors: Record<string, string> = {}
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? 'form')
        errors[field] ??=
          issue.message.startsWith('Expected') || issue.message === 'Required' ? 'This field is required.' : issue.message
      }
      res.status(422).json({ error: { message: 'Please check the highlighted fields', code: 'VALIDATION', errors } })
      return
    }
    const r = parsed.data

    const form = await loadSetting('enrol_form')
    if (!form.professions.includes(r.profession)) {
      res.status(422).json({
        error: { message: 'Please check the highlighted fields', code: 'VALIDATION', errors: { profession: 'Please select your profession.' } },
      })
      return
    }

    let programmeId: string | null = null
    let programmeKey = 'general'
    let programmeTitle = 'General enquiry'
    let amount: number | null = null
    let currency: 'INR' | 'USD' | null = null
    let paymentStatus = 'not_required'
    let collectOnline = false

    if (r.programme) {
      const row = await queryOne<ProgrammeRow>(
        "SELECT id, slug, status, sort_order, data, published_at, created_at, updated_at FROM cms_programmes WHERE slug = $1 AND status = 'published'",
        [r.programme]
      )
      if (!row) {
        res.status(422).json({
          error: { message: 'That programme is not open for enrolment.', code: 'VALIDATION', errors: { programme: 'Please choose a programme from the list.' } },
        })
        return
      }
      const p = shapeProgramme(row)
      programmeId = p.id
      programmeKey = p.slug
      programmeTitle = p.data.title
      if (p.data.pricing.model === 'paid') {
        // Always the server's price, never one sent by the browser.
        amount = p.data.pricing.amount
        currency = p.data.pricing.currency
        paymentStatus = 'pending'
        collectOnline = p.data.payment.collectOnline && amount != null && amount > 0 && config.paymentsEnabled
      }
    }

    const whatsapp = `+91${r.phone}`

    // Someone who started an online payment and did not finish may try again:
    // their unpaid enrolment is reused. Anyone else is a duplicate.
    const matches = await query<{ id: string; email_match: boolean; phone_match: boolean; payment_status: string; razorpay_order_id: string | null }>(
      `SELECT id, lower(email) = $2 AS email_match, whatsapp = $3 AS phone_match, payment_status, razorpay_order_id
         FROM enrolments WHERE programme_key = $1 AND (lower(email) = $2 OR whatsapp = $3)`,
      [programmeKey, r.email, whatsapp]
    )
    const retry =
      collectOnline && matches.length === 1 && matches[0]!.razorpay_order_id && matches[0]!.payment_status !== 'paid'
        ? matches[0]!
        : null
    if (matches.length > 0 && !retry) {
      const errors: Record<string, string> = {}
      if (matches.some((m) => m.email_match)) errors.email = DUPLICATE_EMAIL
      if (matches.some((m) => m.phone_match)) errors.phone = DUPLICATE_PHONE
      res.status(409).json({ error: { message: 'You are already enrolled for this programme.', code: 'ALREADY_ENROLLED', errors } })
      return
    }

    let enrolmentId: string
    try {
      if (retry) {
        await query(
          `UPDATE enrolments
              SET name = $2, email = $3, whatsapp = $4, profession = $5, city = $6, amount = $7, currency = $8,
                  payment_status = 'pending', updated_at = now()
            WHERE id = $1`,
          [retry.id, r.name, r.email, whatsapp, r.profession, r.city, amount, currency]
        )
        enrolmentId = retry.id
      } else {
        const row = await queryOne<{ id: string }>(
          `INSERT INTO enrolments (programme_id, programme_key, programme_title, name, email, whatsapp, profession, city,
                                   utm_source, utm_medium, utm_campaign, amount, currency, payment_status, payment_provider)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
           RETURNING id`,
          [
            programmeId, programmeKey, programmeTitle, r.name, r.email, whatsapp, r.profession, r.city,
            r.utm_source || null, r.utm_medium || null, r.utm_campaign || null, amount, currency, paymentStatus,
            collectOnline ? 'razorpay' : null,
          ]
        )
        enrolmentId = row!.id
      }
    } catch (err) {
      const pg = err as { code?: string; constraint?: string }
      if (pg.code === '23505') {
        const errors =
          pg.constraint === 'enrolments_programme_whatsapp_key' ? { phone: DUPLICATE_PHONE } : { email: DUPLICATE_EMAIL }
        res.status(409).json({ error: { message: 'You are already enrolled for this programme.', code: 'ALREADY_ENROLLED', errors } })
        return
      }
      throw err
    }

    // Paid online: open Razorpay checkout. Emails go out once payment is verified.
    if (collectOnline && amount != null && currency) {
      let order
      try {
        order = await createOrder(amount, currency, enrolmentId, { enrolment_id: enrolmentId, programme: programmeKey })
      } catch (err) {
        console.error('[payments] could not create Razorpay order', err)
        res.status(502).json({
          error: { message: 'Online payment could not be started. Please try again in a moment.', code: 'PAYMENT_UNAVAILABLE' },
        })
        return
      }
      await query(`UPDATE enrolments SET razorpay_order_id = $2, payment_provider = 'razorpay' WHERE id = $1`, [enrolmentId, order.id])
      res.status(201).json({
        data: {
          ok: true,
          programme: programmeTitle,
          payment: {
            provider: 'razorpay',
            keyId: config.RAZORPAY_KEY_ID,
            orderId: order.id,
            amount: toMinorUnits(amount),
            currency,
            name: 'Edutou',
            description: programmeTitle,
            prefill: { name: r.name, email: r.email, contact: whatsapp },
          },
        },
      })
      return
    }

    res.status(201).json({ data: { ok: true, programme: programmeTitle, ...(await sendEnrolmentEmails(enrolmentId)) } })
  })
)

/**
 * Queue the confirmation + team emails and start sending them in the
 * background. A mail problem must never turn a saved enrolment into an error.
 */
async function sendEnrolmentEmails(enrolmentId: string): Promise<{ whatsappGroupUrl: string; confirmationEmail: boolean }> {
  let whatsappGroupUrl = ''
  let confirmationEmail = false
  try {
    await queueEnrolmentEmails(enrolmentId)
    whatsappGroupUrl = (await enrolmentDetails(enrolmentId))?.whatsappGroupUrl ?? ''
    confirmationEmail = Boolean(
      await queryOne(`SELECT 1 FROM email_outbox WHERE enrolment_id = $1 AND kind = 'confirmation'`, [enrolmentId])
    )
  } catch (err) {
    console.error('[mail] could not queue enrolment emails', err)
  }
  processOutbox().catch((err) => console.error('[mail] send failed', err))
  return { whatsappGroupUrl, confirmationEmail }
}

/**
 * Mark a Razorpay order's enrolment paid (idempotent) and, the first time,
 * send its emails. Used by checkout verification and by the webhook.
 */
export async function markOrderPaid(orderId: string, paymentId: string): Promise<{ enrolmentId: string; programme: string; firstTime: boolean } | null> {
  const updated = await queryOne<{ id: string; programme_title: string }>(
    `UPDATE enrolments
        SET payment_status = 'paid', paid_at = COALESCE(paid_at, now()), payment_reference = $2, updated_at = now()
      WHERE razorpay_order_id = $1 AND payment_status <> 'paid'
  RETURNING id, programme_title`,
    [orderId, paymentId]
  )
  if (updated) {
    await sendEnrolmentEmails(updated.id)
    return { enrolmentId: updated.id, programme: updated.programme_title, firstTime: true }
  }
  const existing = await queryOne<{ id: string; programme_title: string }>(
    `SELECT id, programme_title FROM enrolments WHERE razorpay_order_id = $1 AND payment_status = 'paid'`,
    [orderId]
  )
  return existing ? { enrolmentId: existing.id, programme: existing.programme_title, firstTime: false } : null
}

export async function markOrderFailed(orderId: string): Promise<void> {
  await query(
    `UPDATE enrolments SET payment_status = 'failed', updated_at = now()
      WHERE razorpay_order_id = $1 AND payment_status = 'pending'`,
    [orderId]
  )
}

const verifySchema = z.object({
  orderId: z.string().trim().min(1).max(100),
  paymentId: z.string().trim().min(1).max(100),
  signature: z.string().trim().min(1).max(200),
})

/** Razorpay Checkout success handler posts here; the signature proves the payment. */
cmsRouter.post(
  '/enrol/verify',
  enrolLimiter,
  wrap(async (req, res) => {
    const parsed = verifySchema.safeParse(req.body ?? {})
    if (!parsed.success || !verifyPaymentSignature(parsed.data.orderId, parsed.data.paymentId, parsed.data.signature)) {
      res.status(400).json({ error: { message: 'We could not verify this payment. If money was deducted, contact us and we will sort it out.', code: 'PAYMENT_UNVERIFIED' } })
      return
    }
    const result = await markOrderPaid(parsed.data.orderId, parsed.data.paymentId)
    if (!result) {
      res.status(404).json({ error: { message: 'Enrolment for this payment was not found.', code: 'NOT_FOUND' } })
      return
    }
    const d = await enrolmentDetails(result.enrolmentId)
    const confirmationEmail = Boolean(
      await queryOne(`SELECT 1 FROM email_outbox WHERE enrolment_id = $1 AND kind = 'confirmation'`, [result.enrolmentId])
    )
    res.json({ data: { ok: true, paid: true, programme: result.programme, whatsappGroupUrl: d?.whatsappGroupUrl ?? '', confirmationEmail } })
  })
)

// ---------------------------------------------------------------------------
// Admin: programmes
// ---------------------------------------------------------------------------

const PROGRAMME_COLUMNS = 'id, slug, status, sort_order, data, published_at, created_at, updated_at'

cmsRouter.get(
  '/admin/programmes',
  admin,
  wrap(async (_req, res) => {
    const rows = await query<ProgrammeRow>(`SELECT ${PROGRAMME_COLUMNS} FROM cms_programmes ORDER BY sort_order, created_at`)
    res.json({ data: rows.map(shapeProgramme) })
  })
)

cmsRouter.get(
  '/admin/programmes/:id',
  admin,
  wrap(async (req, res) => {
    const row = await queryOne<ProgrammeRow>(`SELECT ${PROGRAMME_COLUMNS} FROM cms_programmes WHERE id::text = $1`, [req.params.id ?? ''])
    if (!row) {
      res.status(404).json({ error: { message: 'Programme not found', code: 'NOT_FOUND' } })
      return
    }
    res.json({ data: shapeProgramme(row) })
  })
)

async function saveProgramme(req: Request, res: Response, id: string | null) {
  const parsed = programmeInputSchema.safeParse(req.body)
  if (!parsed.success) return validationError(res, parsed.error)
  const { slug, status, sortOrder, data } = parsed.data

  const missing = await assertCategoriesExist(data)
  if (missing) {
    res.status(422).json({ error: { message: missing, code: 'VALIDATION', details: [{ path: 'data.category', message: missing }] } })
    return
  }

  try {
    const row = id
      ? await queryOne<ProgrammeRow>(
          `UPDATE cms_programmes
              SET slug = $2, status = $3, sort_order = $4, data = $5, updated_at = now(), updated_by = $6,
                  published_at = CASE WHEN $3 = 'published' THEN COALESCE(published_at, now()) ELSE published_at END
            WHERE id::text = $1
        RETURNING ${PROGRAMME_COLUMNS}`,
          [id, slug, status, sortOrder, JSON.stringify(data), req.actor!.userId]
        )
      : await queryOne<ProgrammeRow>(
          `INSERT INTO cms_programmes (slug, status, sort_order, data, updated_by, published_at)
           VALUES ($1, $2, $3, $4, $5, CASE WHEN $2 = 'published' THEN now() END)
        RETURNING ${PROGRAMME_COLUMNS}`,
          [slug, status, sortOrder, JSON.stringify(data), req.actor!.userId]
        )
    if (!row) {
      res.status(404).json({ error: { message: 'Programme not found', code: 'NOT_FOUND' } })
      return
    }
    res.status(id ? 200 : 201).json({ data: shapeProgramme(row) })
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      res.status(409).json({
        error: { message: `The web address "${slug}" is already used by another programme.`, code: 'SLUG_TAKEN', details: [{ path: 'slug', message: 'Already in use' }] },
      })
      return
    }
    throw err
  }
}

cmsRouter.post('/admin/programmes', admin, wrap((req, res) => saveProgramme(req, res, null)))
cmsRouter.put('/admin/programmes/:id', admin, wrap((req, res) => saveProgramme(req, res, req.params.id ?? '')))

cmsRouter.patch(
  '/admin/programmes/:id/status',
  admin,
  wrap(async (req, res) => {
    const parsed = z.object({ status: programmeStatus }).safeParse(req.body)
    if (!parsed.success) return validationError(res, parsed.error)
    const row = await queryOne<ProgrammeRow>(
      `UPDATE cms_programmes
          SET status = $2, updated_at = now(), updated_by = $3,
              published_at = CASE WHEN $2 = 'published' THEN COALESCE(published_at, now()) ELSE published_at END
        WHERE id::text = $1 RETURNING ${PROGRAMME_COLUMNS}`,
      [req.params.id ?? '', parsed.data.status, req.actor!.userId]
    )
    if (!row) {
      res.status(404).json({ error: { message: 'Programme not found', code: 'NOT_FOUND' } })
      return
    }
    res.json({ data: shapeProgramme(row) })
  })
)

cmsRouter.post(
  '/admin/programmes/:id/duplicate',
  admin,
  wrap(async (req, res) => {
    const source = await queryOne<ProgrammeRow>(`SELECT ${PROGRAMME_COLUMNS} FROM cms_programmes WHERE id::text = $1`, [req.params.id ?? ''])
    if (!source) {
      res.status(404).json({ error: { message: 'Programme not found', code: 'NOT_FOUND' } })
      return
    }
    const data = { ...shapeProgramme(source).data }
    data.title = `${data.title} (copy)`.slice(0, 160)
    let slug = `${source.slug}-copy`.slice(0, 80)
    for (let n = 2; await queryOne('SELECT 1 FROM cms_programmes WHERE slug = $1', [slug]); n++) {
      slug = `${source.slug}-copy-${n}`.slice(0, 80)
    }
    const row = await queryOne<ProgrammeRow>(
      `INSERT INTO cms_programmes (slug, status, sort_order, data, updated_by)
       VALUES ($1, 'draft', $2, $3, $4) RETURNING ${PROGRAMME_COLUMNS}`,
      [slug, source.sort_order + 1, JSON.stringify(data), req.actor!.userId]
    )
    res.status(201).json({ data: shapeProgramme(row!) })
  })
)

cmsRouter.delete(
  '/admin/programmes/:id',
  admin,
  wrap(async (req, res) => {
    await query('DELETE FROM cms_programmes WHERE id::text = $1', [req.params.id ?? ''])
    res.json({ data: { success: true } })
  })
)

// ---------------------------------------------------------------------------
// Admin: categories
// ---------------------------------------------------------------------------

cmsRouter.get(
  '/admin/categories',
  admin,
  wrap(async (_req, res) => {
    const categories = await loadCategories()
    const counts = await query<{ category: string; n: number }>(
      `SELECT c.id AS category, count(p.id)::int AS n
         FROM cms_categories c
         LEFT JOIN cms_programmes p ON p.data->>'category' = c.id OR p.data->'alsoIn' ? c.id
        GROUP BY c.id`
    )
    const byId = new Map(counts.map((c) => [c.category, c.n]))
    res.json({ data: categories.map((c) => ({ ...c, programmes: byId.get(c.id) ?? 0 })) })
  })
)

cmsRouter.post(
  '/admin/categories',
  admin,
  wrap(async (req, res) => {
    const parsed = categoryInputSchema.safeParse(req.body)
    if (!parsed.success) return validationError(res, parsed.error)
    const c = parsed.data
    try {
      await query('INSERT INTO cms_categories (id, title, description, sort_order) VALUES ($1, $2, $3, $4)', [
        c.id, c.title, c.description, c.sortOrder,
      ])
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        res.status(409).json({ error: { message: `Category "${c.id}" already exists.`, code: 'EXISTS' } })
        return
      }
      throw err
    }
    res.status(201).json({ data: c })
  })
)

cmsRouter.put(
  '/admin/categories/:id',
  admin,
  wrap(async (req, res) => {
    const parsed = categoryInputSchema.omit({ id: true }).safeParse(req.body)
    if (!parsed.success) return validationError(res, parsed.error)
    const c = parsed.data
    const row = await queryOne(
      'UPDATE cms_categories SET title = $2, description = $3, sort_order = $4, updated_at = now() WHERE id = $1 RETURNING id',
      [req.params.id ?? '', c.title, c.description, c.sortOrder]
    )
    if (!row) {
      res.status(404).json({ error: { message: 'Category not found', code: 'NOT_FOUND' } })
      return
    }
    res.json({ data: { id: req.params.id, ...c } })
  })
)

cmsRouter.delete(
  '/admin/categories/:id',
  admin,
  wrap(async (req, res) => {
    const inUse = await queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM cms_programmes WHERE data->>'category' = $1 OR data->'alsoIn' ? $1`,
      [req.params.id ?? '']
    )
    if (inUse && inUse.n > 0) {
      res.status(409).json({
        error: { message: `${inUse.n} programme(s) still use this category. Move them first.`, code: 'IN_USE' },
      })
      return
    }
    await query('DELETE FROM cms_categories WHERE id = $1', [req.params.id ?? ''])
    res.json({ data: { success: true } })
  })
)

// ---------------------------------------------------------------------------
// Admin: settings
// ---------------------------------------------------------------------------

const isSettingsKey = (k: string): k is SettingsKey => Object.prototype.hasOwnProperty.call(settingsSchemas, k)

cmsRouter.get(
  '/admin/settings/:key',
  admin,
  wrap(async (req, res) => {
    const key = req.params.key ?? ''
    if (!isSettingsKey(key)) {
      res.status(404).json({ error: { message: 'Unknown setting', code: 'NOT_FOUND' } })
      return
    }
    res.json({ data: await loadSetting(key) })
  })
)

cmsRouter.put(
  '/admin/settings/:key',
  admin,
  wrap(async (req, res) => {
    const key = req.params.key ?? ''
    if (!isSettingsKey(key)) {
      res.status(404).json({ error: { message: 'Unknown setting', code: 'NOT_FOUND' } })
      return
    }
    const parsed = settingsSchemas[key].safeParse(req.body)
    if (!parsed.success) return validationError(res, parsed.error)
    await query(
      `INSERT INTO cms_settings (key, value, updated_at, updated_by) VALUES ($1, $2, now(), $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [key, JSON.stringify(parsed.data), req.actor!.userId]
    )
    res.json({ data: parsed.data })
  })
)

// ---------------------------------------------------------------------------
// Admin: enrolments
// ---------------------------------------------------------------------------

const ENROLMENT_STATUSES = ['new', 'contacted', 'enrolled', 'not_interested'] as const
const PAYMENT_STATUSES = ['not_required', 'pending', 'paid', 'failed', 'refunded'] as const

cmsRouter.get(
  '/admin/enrolments/summary',
  admin,
  wrap(async (_req, res) => {
    const row = await queryOne<{ total: number; unseen: number; new: number; contacted: number; enrolled: number; not_interested: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE seen_at IS NULL)::int AS unseen,
              count(*) FILTER (WHERE status = 'new')::int AS new,
              count(*) FILTER (WHERE status = 'contacted')::int AS contacted,
              count(*) FILTER (WHERE status = 'enrolled')::int AS enrolled,
              count(*) FILTER (WHERE status = 'not_interested')::int AS not_interested
         FROM enrolments`
    )
    res.json({ data: row })
  })
)

cmsRouter.get(
  '/admin/enrolments',
  admin,
  wrap(async (req, res) => {
    const where: string[] = []
    const params: unknown[] = []
    const status = String(req.query.status ?? '')
    if ((ENROLMENT_STATUSES as readonly string[]).includes(status)) {
      params.push(status)
      where.push(`status = $${params.length}`)
    }
    const programme = String(req.query.programme ?? '')
    if (programme) {
      params.push(programme)
      where.push(`programme_key = $${params.length}`)
    }
    const q = String(req.query.q ?? '').trim()
    if (q) {
      params.push(`%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`)
      const p = `$${params.length}`
      where.push(`(name ILIKE ${p} OR email ILIKE ${p} OR whatsapp ILIKE ${p} OR city ILIKE ${p})`)
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 5000)
    params.push(limit)
    const rows = await query(
      `SELECT id, programme_id, programme_key, programme_title, name, email, whatsapp, profession, city,
              utm_source, utm_medium, utm_campaign, status, notes, seen_at, amount, currency,
              payment_status, payment_provider, payment_reference, razorpay_order_id, paid_at, created_at, updated_at,
              (SELECT o.status FROM email_outbox o WHERE o.enrolment_id = enrolments.id AND o.kind = 'confirmation'
                ORDER BY o.created_at DESC LIMIT 1) AS confirmation_email,
              (SELECT o.status FROM email_outbox o WHERE o.enrolment_id = enrolments.id AND o.kind = 'team'
                ORDER BY o.created_at DESC LIMIT 1) AS team_email,
              (SELECT o.last_error FROM email_outbox o WHERE o.enrolment_id = enrolments.id AND o.last_error IS NOT NULL
                ORDER BY o.created_at DESC LIMIT 1) AS email_error
         FROM enrolments ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY created_at DESC LIMIT $${params.length}`,
      params as never[]
    )
    res.json({ data: rows })
  })
)

const enrolmentPatchSchema = z.object({
  status: z.enum(ENROLMENT_STATUSES).optional(),
  notes: z.string().max(4000).optional(),
  paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
  paymentReference: z.string().trim().max(200).optional(),
})

cmsRouter.patch(
  '/admin/enrolments/:id',
  admin,
  wrap(async (req, res) => {
    const parsed = enrolmentPatchSchema.safeParse(req.body)
    if (!parsed.success) return validationError(res, parsed.error)
    const p = parsed.data
    const row = await queryOne(
      `UPDATE enrolments
          SET status = COALESCE($2, status),
              notes = COALESCE($3, notes),
              payment_status = COALESCE($4, payment_status),
              payment_reference = COALESCE($5, payment_reference),
              paid_at = CASE WHEN $4 = 'paid' THEN COALESCE(paid_at, now()) ELSE paid_at END,
              seen_at = COALESCE(seen_at, now()),
              updated_at = now()
        WHERE id::text = $1
    RETURNING id`,
      [req.params.id ?? '', p.status ?? null, p.notes ?? null, p.paymentStatus ?? null, p.paymentReference ?? null]
    )
    if (!row) {
      res.status(404).json({ error: { message: 'Enrolment not found', code: 'NOT_FOUND' } })
      return
    }
    res.json({ data: { success: true } })
  })
)

cmsRouter.post(
  '/admin/enrolments/mark-seen',
  admin,
  wrap(async (_req, res) => {
    await query('UPDATE enrolments SET seen_at = now() WHERE seen_at IS NULL')
    res.json({ data: { success: true } })
  })
)

cmsRouter.delete(
  '/admin/enrolments/:id',
  admin,
  wrap(async (req, res) => {
    await query('DELETE FROM enrolments WHERE id::text = $1', [req.params.id ?? ''])
    res.json({ data: { success: true } })
  })
)


// ---------------------------------------------------------------------------
// Admin: email
// ---------------------------------------------------------------------------

cmsRouter.get(
  '/admin/email/status',
  admin,
  wrap(async (_req, res) => {
    const counts = await queryOne<{ pending: number; failed: number; sent_today: number }>(
      `SELECT count(*) FILTER (WHERE status IN ('pending', 'sending'))::int AS pending,
              count(*) FILTER (WHERE status = 'failed')::int AS failed,
              count(*) FILTER (WHERE status = 'sent' AND sent_at > now() - interval '1 day')::int AS sent_today
         FROM email_outbox`
    )
    res.json({ data: { configured: config.mailEnabled, from: mailFrom(), ...counts } })
  })
)

cmsRouter.post(
  '/admin/email/test',
  admin,
  wrap(async (req, res) => {
    const parsed = z.object({ to: z.string().trim().toLowerCase().email() }).safeParse(req.body)
    if (!parsed.success) return validationError(res, parsed.error)
    if (!config.mailEnabled) {
      res.status(409).json({
        error: { message: 'Email is not set up on the server yet (SMTP_HOST, SMTP_USER, SMTP_PASS).', code: 'MAIL_NOT_CONFIGURED' },
      })
      return
    }
    await queueTestEmail(parsed.data.to)
    await processOutbox()
    const last = await queryOne<{ status: string; last_error: string | null }>(
      `SELECT status, last_error FROM email_outbox WHERE kind = 'test' ORDER BY created_at DESC LIMIT 1`
    )
    if (last?.status === 'sent') {
      res.json({ data: { sent: true } })
      return
    }
    res.status(502).json({ error: { message: `Sending failed: ${last?.last_error ?? 'unknown error'}`, code: 'MAIL_FAILED' } })
  })
)

cmsRouter.post(
  '/admin/enrolments/:id/resend-email',
  admin,
  wrap(async (req, res) => {
    const parsed = z.object({ kinds: z.array(z.enum(['confirmation', 'team'])).min(1).default(['confirmation']) }).safeParse(req.body ?? {})
    if (!parsed.success) return validationError(res, parsed.error)
    const id = req.params.id ?? ''
    if (!/^[0-9a-f-]{36}$/i.test(id) || !(await queryOne('SELECT 1 FROM enrolments WHERE id = $1', [id]))) {
      res.status(404).json({ error: { message: 'Enrolment not found', code: 'NOT_FOUND' } })
      return
    }
    // Resending is an explicit action, so it ignores the on/off switches.
    const before = await queueEnrolmentEmailsForced(id, parsed.data.kinds)
    await processOutbox()
    res.json({ data: { queued: before } })
  })
)

/** Like queueEnrolmentEmails, but sends even if the admin has switched a kind off. */
async function queueEnrolmentEmailsForced(id: string, kinds: ('confirmation' | 'team')[]): Promise<number> {
  return queueEnrolmentEmails(id, kinds, { force: true })
}

cmsRouter.get(
  '/admin/enrolments/:id/whatsapp',
  admin,
  wrap(async (req, res) => {
    const id = req.params.id ?? ''
    const d = /^[0-9a-f-]{36}$/i.test(id) ? await enrolmentDetails(id) : null
    if (!d) {
      res.status(404).json({ error: { message: 'Enrolment not found', code: 'NOT_FOUND' } })
      return
    }
    const row = await queryOne<{ value: unknown }>(`SELECT value FROM cms_settings WHERE key = 'notifications'`)
    const parsedSettings = row ? settingsSchemas.notifications.safeParse(row.value) : null
    const template = (parsedSettings?.success ? parsedSettings.data : settingsDefaults.notifications).whatsappMessage
    const text = template
      .replace(/\{name\}/g, d.name)
      .replace(/\{programme\}/g, d.programmeTitle)
      .replace(/\{whatsapp\}/g, d.whatsappGroupUrl)
      .replace(/\s*:\s*$/, '')
      .trim()
    res.json({ data: { url: `https://wa.me/${d.whatsapp.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`, text } })
  })
)

// ---------------------------------------------------------------------------
// Admin: payments
// ---------------------------------------------------------------------------

cmsRouter.get(
  '/admin/payments/status',
  admin,
  wrap(async (_req, res) => {
    const keyId = config.RAZORPAY_KEY_ID ?? ''
    const totals = await query<{ currency: string; paid: number; amount: string }>(
      `SELECT currency, count(*)::int AS paid, COALESCE(sum(amount), 0)::text AS amount
         FROM enrolments WHERE payment_status = 'paid' AND currency IS NOT NULL GROUP BY currency`
    )
    res.json({
      data: {
        configured: config.paymentsEnabled,
        mode: keyId.startsWith('rzp_live_') ? 'live' : keyId.startsWith('rzp_test_') ? 'test' : null,
        keyId: keyId ? `${keyId.slice(0, 9)}…${keyId.slice(-4)}` : '',
        webhookConfigured: Boolean(config.RAZORPAY_WEBHOOK_SECRET),
        webhookUrl: `${config.PUBLIC_URL.replace(/\/+$/, '')}/api/payments/razorpay/webhook`,
        totals,
      },
    })
  })
)

// ---------------------------------------------------------------------------
// Admin: Analytics & Event Tracking (Microsoft Clarity)
// ---------------------------------------------------------------------------

cmsRouter.get(
  '/admin/analytics/status',
  admin,
  wrap(async (_req, res) => {
    const a = await loadSetting('analytics')
    const base = a.clarityProjectId ? `https://clarity.microsoft.com/projects/view/${a.clarityProjectId}` : ''
    res.json({
      data: {
        enabled: a.clarityEnabled && Boolean(a.clarityProjectId),
        projectId: a.clarityProjectId,
        tokenConfigured: Boolean(config.CLARITY_API_TOKEN),
        days: CLARITY_DAYS,
        links: base
          ? { dashboard: `${base}/dashboard`, recordings: `${base}/impressions`, heatmaps: `${base}/heatmaps`, settings: `${base}/settings` }
          : null,
      },
    })
  })
)

cmsRouter.get(
  '/admin/analytics/clarity',
  admin,
  wrap(async (req, res) => {
    const report = String(req.query.report ?? 'overview') as ClarityReport
    if (!Object.prototype.hasOwnProperty.call(CLARITY_REPORTS, report)) {
      res.status(400).json({ error: { message: 'Unknown report', code: 'BAD_REQUEST' } })
      return
    }
    try {
      res.json({ data: await clarityReport(report, { refresh: req.query.refresh === '1' }) })
    } catch (err) {
      if (err instanceof ClarityError) {
        res.status(err.status).json({ error: { message: err.message, code: 'CLARITY' } })
        return
      }
      throw err
    }
  })
)
