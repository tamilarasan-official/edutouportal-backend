import { config } from '../config.js'
import { query, queryOne } from '../db/pool.js'
import { programmeDataSchema, settingsDefaults, settingsSchemas } from '../cms/schema.js'
import { mailer, mailFrom } from './mailer.js'
import { confirmationEmail, teamEmail, testEmail, type EnrolmentDetails, type RenderedEmail } from './templates.js'

/**
 * Email outbox for enrolments.
 *
 * queueEnrolmentEmails() writes the confirmation and the team notification
 * for an enrolment; processOutbox() sends whatever is due. The API runs
 * processOutbox() right after each enrolment and every 30 seconds, so sending
 * never slows down or fails the enrolment itself, and failures are retried
 * with backoff (1, 2, 4, 8 minutes) before being marked failed.
 */

const MAX_ATTEMPTS = 5

async function setting<K extends 'notifications' | 'enrol_form'>(key: K) {
  const row = await queryOne<{ value: unknown }>('SELECT value FROM cms_settings WHERE key = $1', [key])
  const parsed = row ? settingsSchemas[key].safeParse(row.value) : null
  return (parsed?.success ? parsed.data : settingsDefaults[key]) as (typeof settingsDefaults)[K]
}

function priceLabel(p: { model: string; amount: number | null; currency: string; note: string }): string {
  if (p.model === 'free') return 'Free'
  if (p.model !== 'paid') return ''
  if (p.amount != null) {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: p.currency || 'INR', maximumFractionDigits: 0 }).format(p.amount)
  }
  return p.note || ''
}

function formatDate(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  })
}

interface EnrolmentRow {
  id: string
  programme_id: string | null
  programme_key: string
  programme_title: string
  name: string
  email: string
  whatsapp: string
  profession: string
  city: string
  utm_source: string | null
  utm_medium: string | null
  utm_campaign: string | null
  created_at: Date
}

/** Everything the templates (and the admin's WhatsApp button) need about one enrolment. */
export async function enrolmentDetails(enrolmentId: string): Promise<EnrolmentDetails | null> {
  const e = await queryOne<EnrolmentRow>(
    `SELECT id, programme_id, programme_key, programme_title, name, email, whatsapp, profession, city,
            utm_source, utm_medium, utm_campaign, created_at
       FROM enrolments WHERE id = $1`,
    [enrolmentId]
  )
  if (!e) return null

  const form = await setting('enrol_form')
  const prog = e.programme_id
    ? await queryOne<{ slug: string; data: unknown }>('SELECT slug, data FROM cms_programmes WHERE id = $1', [e.programme_id])
    : null
  const parsed = prog ? programmeDataSchema.safeParse(prog.data) : null
  const data = parsed?.success ? parsed.data : null

  const site = config.SITE_URL.replace(/\/+$/, '')
  return {
    id: e.id,
    name: e.name,
    email: e.email,
    whatsapp: e.whatsapp,
    profession: e.profession,
    city: e.city,
    programmeTitle: data?.title ?? e.programme_title,
    programmeType: data?.type ?? null,
    schedule: data
      ? {
          date: data.schedule.startDate ? formatDate(data.schedule.startDate) : '',
          time: data.schedule.time,
          duration: data.schedule.duration,
          mode: data.schedule.mode,
          language: data.schedule.language,
        }
      : null,
    price: data ? priceLabel(data.pricing) : '',
    whatsappGroupUrl: data?.enrolment.whatsappGroupUrl || form.whatsappGroupUrl || '',
    emailNote: data?.enrolment.emailNote ?? '',
    programmePageUrl: data?.page.enabled && prog ? `${site}/programmes/${data.category}/${prog.slug}` : null,
    source: [e.utm_source, e.utm_medium, e.utm_campaign].filter(Boolean).join(' / ') || 'Website',
    createdAt: e.created_at,
  }
}

async function enqueue(enrolmentId: string | null, kind: string, to: string[], mail: RenderedEmail): Promise<void> {
  await query(
    `INSERT INTO email_outbox (enrolment_id, kind, to_addresses, subject, html, text_body)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [enrolmentId, kind, to, mail.subject, mail.html, mail.text]
  )
}

/** Queue the confirmation and team emails for a new enrolment, per the admin's settings. */
export async function queueEnrolmentEmails(
  enrolmentId: string,
  kinds: ('confirmation' | 'team')[] = ['confirmation', 'team'],
  { force = false } = {}
): Promise<number> {
  const d = await enrolmentDetails(enrolmentId)
  if (!d) return 0
  const n = await setting('notifications')
  let queued = 0
  if (kinds.includes('confirmation') && (n.sendConfirmation || force)) {
    await enqueue(enrolmentId, 'confirmation', [d.email], confirmationEmail(d, n))
    queued += 1
  }
  if (kinds.includes('team') && (n.sendTeam || force) && n.teamEmails.length > 0) {
    await enqueue(enrolmentId, 'team', n.teamEmails, teamEmail(d))
    queued += 1
  }
  return queued
}

export async function queueTestEmail(to: string): Promise<void> {
  await enqueue(null, 'test', [to], testEmail())
}

interface Job {
  id: string
  kind: string
  to_addresses: string[]
  subject: string
  html: string
  text_body: string
  attempts: number
}

let running: Promise<number> | null = null

/** Send every due email. Safe to call often; overlapping calls share one run. */
export function processOutbox(): Promise<number> {
  running ??= sendDue().finally(() => {
    running = null
  })
  return running
}

async function sendDue(): Promise<number> {
  const transport = mailer()
  if (!transport) return 0

  const jobs = await query<Job>(
    `UPDATE email_outbox SET status = 'sending', attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM email_outbox
         WHERE status = 'pending' AND next_attempt_at <= now()
         ORDER BY created_at
         LIMIT 20
         FOR UPDATE SKIP LOCKED)
      RETURNING id, kind, to_addresses, subject, html, text_body, attempts`
  )

  let sent = 0
  for (const job of jobs) {
    try {
      await transport.sendMail({
        from: mailFrom(),
        // Team notifications go to everyone at once; replies reach the sender.
        to: job.to_addresses.join(', '),
        subject: job.subject,
        html: job.html,
        text: job.text_body,
      })
      await query(`UPDATE email_outbox SET status = 'sent', sent_at = now(), last_error = NULL WHERE id = $1`, [job.id])
      sent += 1
    } catch (err) {
      const message = (err as Error).message?.slice(0, 500) ?? 'Unknown error'
      const final = job.attempts >= MAX_ATTEMPTS
      await query(
        `UPDATE email_outbox
            SET status = $2, last_error = $3,
                next_attempt_at = now() + make_interval(mins => $4)
          WHERE id = $1`,
        [job.id, final ? 'failed' : 'pending', message, 2 ** (job.attempts - 1)]
      )
      console.error(`[mail] ${job.kind} email failed (attempt ${job.attempts}/${MAX_ATTEMPTS}): ${message}`)
    }
  }
  return sent
}

/** Background sender inside the API process. */
export function startOutboxWorker(): void {
  if (!config.mailEnabled) {
    console.warn('[mail] SMTP is not configured (SMTP_HOST/SMTP_USER/SMTP_PASS); enrolment emails are queued but not sent')
    return
  }
  // A crash mid-send leaves rows in 'sending'; give them another go.
  query(`UPDATE email_outbox SET status = 'pending' WHERE status = 'sending' AND created_at < now() - interval '10 minutes'`).catch(
    () => {}
  )
  const tick = () => processOutbox().catch((err) => console.error('[mail] outbox run failed', err))
  tick()
  setInterval(tick, 30_000).unref()
  console.log(`[mail] sending enrolment emails as ${mailFrom()} via ${config.SMTP_HOST}`)
}
