import { query, queryOne } from '../db/pool.js'
import { whatsappSettings, type WhatsAppSettings } from './queue.js'

/**
 * Sends queued WhatsApp messages the way a person would: a small batch
 * (batchMin-batchMax), a random gap between messages, "typing…" before each,
 * then a longer random pause before the next batch. Never more than dailyCap
 * in any 24 hours, and only inside the sending window (IST).
 */

export interface WhatsAppTransport {
  isConnected(): boolean
  /** Whether the number has a WhatsApp account. */
  exists(e164: string): Promise<boolean>
  /** Show "typing…" for roughly `ms`. */
  typing(e164: string, ms: number): Promise<void>
  send(e164: string, text: string): Promise<void>
}

export interface SenderDeps {
  transport: WhatsAppTransport
  sleep: (ms: number) => Promise<void>
  random?: () => number
  now?: () => Date
}

export const randInt = (min: number, max: number, random = Math.random) => min + Math.floor(random() * (max - min + 1))

export function istHour(d: Date): number {
  return Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }).format(d)) % 24
}

export const inWindow = (s: Pick<WhatsAppSettings, 'startHour' | 'endHour'>, d: Date) => {
  const h = istHour(d)
  return h >= s.startHour && h < s.endHour
}

interface Job {
  id: string
  to_number: string
  body: string
  attempts: number
}

async function claimNext(): Promise<Job | null> {
  return queryOne<Job>(
    `UPDATE whatsapp_outbox SET status = 'sending', attempts = attempts + 1
      WHERE id = (SELECT id FROM whatsapp_outbox WHERE status = 'pending' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
  RETURNING id, to_number, body, attempts`
  )
}

export type BatchOutcome = 'paused' | 'disconnected' | 'outside_hours' | 'capped' | 'idle' | 'sent'

/** One batch. Returns what happened so the loop knows how long to wait. */
export async function runBatch(deps: SenderDeps): Promise<{ outcome: BatchOutcome; sent: number }> {
  const random = deps.random ?? Math.random
  const now = deps.now ?? (() => new Date())
  const s = await whatsappSettings()

  if (s.paused) return { outcome: 'paused', sent: 0 }
  if (!deps.transport.isConnected()) return { outcome: 'disconnected', sent: 0 }
  if (!inWindow(s, now())) return { outcome: 'outside_hours', sent: 0 }

  const sent24h = (await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM whatsapp_outbox WHERE status = 'sent' AND sent_at > now() - interval '24 hours'`
  ))?.n ?? 0
  const remaining = s.dailyCap - sent24h
  if (remaining <= 0) return { outcome: 'capped', sent: 0 }

  const size = Math.min(randInt(s.batchMin, s.batchMax, random), remaining)
  let sent = 0
  let tried = 0
  for (let i = 0; i < size; i++) {
    const job = await claimNext()
    if (!job) break
    tried += 1
    try {
      if (!(await deps.transport.exists(job.to_number))) {
        await query(`UPDATE whatsapp_outbox SET status = 'not_on_whatsapp', last_error = NULL WHERE id = $1`, [job.id])
        continue
      }
      // Type for about as long as a person would (1.5-8 s).
      await deps.transport.typing(job.to_number, Math.min(8000, 1500 + job.body.length * 35))
      await deps.transport.send(job.to_number, job.body)
      await query(`UPDATE whatsapp_outbox SET status = 'sent', sent_at = now(), last_error = NULL WHERE id = $1`, [job.id])
      sent += 1
    } catch (err) {
      const message = (err as Error).message?.slice(0, 300) ?? 'Unknown error'
      await query(`UPDATE whatsapp_outbox SET status = $2, last_error = $3 WHERE id = $1`, [
        job.id,
        job.attempts >= 3 ? 'failed' : 'pending',
        message,
      ])
      console.error(`[whatsapp] send failed (attempt ${job.attempts}/3): ${message}`)
      if (!deps.transport.isConnected()) break
    }
    if (i < size - 1) await deps.sleep(randInt(s.gapMinSeconds, s.gapMaxSeconds, random) * 1000)
  }
  return { outcome: tried === 0 ? 'idle' : 'sent', sent }
}

/** Wait after a batch, by outcome. */
export function waitAfter(outcome: BatchOutcome, s: WhatsAppSettings, random = Math.random): number {
  switch (outcome) {
    case 'sent':
      return randInt(s.pauseMinMinutes * 60, s.pauseMaxMinutes * 60, random) * 1000
    case 'capped':
      return 15 * 60_000
    case 'idle':
    case 'disconnected':
    case 'paused':
    case 'outside_hours':
      return 60_000
  }
}

let stopped = false

/** The sending loop; runs for the life of the API process. */
export async function startSenderLoop(transport: WhatsAppTransport): Promise<void> {
  stopped = false
  // A crash mid-send leaves rows in 'sending'.
  await query(`UPDATE whatsapp_outbox SET status = 'pending' WHERE status = 'sending'`).catch(() => {})
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref())
  while (!stopped) {
    try {
      const { outcome, sent } = await runBatch({ transport, sleep })
      if (sent) console.log(`[whatsapp] sent ${sent} message(s)`)
      await sleep(waitAfter(outcome, await whatsappSettings()))
    } catch (err) {
      console.error('[whatsapp] sender loop error', err)
      await sleep(60_000)
    }
  }
}

export function stopSenderLoop(): void {
  stopped = true
}
