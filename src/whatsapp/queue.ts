import { query, queryOne } from '../db/pool.js'
import { settingsDefaults, settingsSchemas } from '../cms/schema.js'
import { enrolmentDetails } from '../notify/outbox.js'

/**
 * WhatsApp queue: one message per enrolment, rendered from a randomly chosen
 * template when queued. Sending (slow, irregular) is in sender.ts.
 */

export type WhatsAppSettings = (typeof settingsDefaults)['whatsapp']

export async function whatsappSettings(): Promise<WhatsAppSettings> {
  const row = await queryOne<{ value: unknown }>(`SELECT value FROM cms_settings WHERE key = 'whatsapp'`)
  const parsed = row ? settingsSchemas.whatsapp.safeParse(row.value) : null
  return parsed?.success ? parsed.data : settingsDefaults.whatsapp
}

export function renderMessage(
  template: string,
  d: { name: string; programmeTitle: string; whatsappGroupUrl: string }
): string {
  const firstName = d.name.trim().split(/\s+/)[0] ?? d.name
  return template
    .replace(/\{name\}/g, firstName)
    .replace(/\{programme\}/g, d.programmeTitle)
    .replace(/\{whatsapp\}/g, d.whatsappGroupUrl)
    // A template ending "…updates: {whatsapp}" with no group link set.
    .replace(/[\s:,-]+$/, '')
    .trim()
}

const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)]!

/** Queue the message for one enrolment (no-op if already queued or switched off). */
export async function queueWhatsApp(enrolmentId: string, { force = false } = {}): Promise<boolean> {
  const s = await whatsappSettings()
  if (!s.enabled && !force) return false
  const d = await enrolmentDetails(enrolmentId)
  if (!d) return false
  const body = renderMessage(pick(s.templates), d)
  const row = await queryOne<{ id: string }>(
    `INSERT INTO whatsapp_outbox (enrolment_id, to_number, body)
     VALUES ($1, $2, $3)
     ON CONFLICT (enrolment_id) WHERE enrolment_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [enrolmentId, d.whatsapp, body]
  )
  return Boolean(row)
}

/**
 * Everyone already enrolled who has no WhatsApp message yet. Paid online
 * enrolments are only included once paid.
 */
const BACKFILL_WHERE = `
  NOT EXISTS (SELECT 1 FROM whatsapp_outbox w WHERE w.enrolment_id = e.id)
  AND NOT (e.razorpay_order_id IS NOT NULL AND e.payment_status <> 'paid')`

export async function backfillCount(): Promise<number> {
  const r = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM enrolments e WHERE ${BACKFILL_WHERE}`)
  return r?.n ?? 0
}

export async function backfill(): Promise<number> {
  const rows = await query<{ id: string }>(`SELECT e.id FROM enrolments e WHERE ${BACKFILL_WHERE} ORDER BY e.created_at`)
  let queued = 0
  for (const r of rows) if (await queueWhatsApp(r.id, { force: true })) queued += 1
  return queued
}

export async function queueStats() {
  const r = await queryOne<{
    pending: number; sent: number; failed: number; not_on_whatsapp: number; skipped: number; sent_24h: number
  }>(
    `SELECT count(*) FILTER (WHERE status IN ('pending', 'sending'))::int AS pending,
            count(*) FILTER (WHERE status = 'sent')::int AS sent,
            count(*) FILTER (WHERE status = 'failed')::int AS failed,
            count(*) FILTER (WHERE status = 'not_on_whatsapp')::int AS not_on_whatsapp,
            count(*) FILTER (WHERE status = 'skipped')::int AS skipped,
            count(*) FILTER (WHERE status = 'sent' AND sent_at > now() - interval '24 hours')::int AS sent_24h
       FROM whatsapp_outbox`
  )
  return r ?? { pending: 0, sent: 0, failed: 0, not_on_whatsapp: 0, skipped: 0, sent_24h: 0 }
}
