import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Client, createUser, startTestServer, stopTestServer, truncateAll, type TestUser } from './helpers.js'
import { query } from '../src/db/pool.js'
import { renderMessage } from '../src/whatsapp/queue.js'
import { runBatch, waitAfter, type WhatsAppTransport } from '../src/whatsapp/sender.js'
import { settingsDefaults } from '../src/cms/schema.js'

/** WhatsApp from the owner's number: queueing, backfill, and slow sending. */

let base: string
before(async () => {
  base = await startTestServer()
})
after(stopTestServer)
beforeEach(truncateAll)

interface Sent { to: string; text: string }
function fakeTransport(opts: { notOnWhatsApp?: string[]; failSends?: number; connected?: boolean } = {}) {
  const sent: Sent[] = []
  let fails = opts.failSends ?? 0
  const t: WhatsAppTransport = {
    isConnected: () => opts.connected ?? true,
    exists: async (n) => !(opts.notOnWhatsApp ?? []).includes(n),
    typing: async () => {},
    send: async (to, text) => {
      if (fails > 0) {
        fails -= 1
        throw new Error('socket closed')
      }
      sent.push({ to, text })
    },
  }
  return { t, sent }
}
const sleeps: number[] = []
const sleep = async (ms: number) => {
  sleeps.push(ms)
}

async function adminWithProgramme(): Promise<TestUser> {
  const a = await createUser(base, 'admin')
  await a.client.post('/api/cms/admin/categories', { id: 'courses', title: 'Online Programmes' })
  await a.client.post('/api/cms/admin/programmes', {
    slug: 'ai-webinar',
    status: 'published',
    data: { title: 'AI Webinar', category: 'courses', pricing: { model: 'free' }, enrolment: { whatsappGroupUrl: 'https://chat.whatsapp.com/GROUP' } },
  })
  return a
}

const enrol = (n: number) =>
  new Client(base).post('/api/cms/enrol', {
    programme: 'ai-webinar',
    name: `Learner${n} Kumar`,
    email: `l${n}@example.com`,
    phone: `98765${String(n).padStart(5, '0')}`,
    profession: 'Student',
    city: 'Chennai',
  })

async function setWhatsApp(a: TestUser, patch: Record<string, unknown>) {
  const res = await a.client.request('PUT', '/api/cms/admin/settings/whatsapp', { ...settingsDefaults.whatsapp, ...patch })
  assert.equal(res.status, 200, JSON.stringify(res.body))
}

describe('whatsapp queue', () => {
  it('queues one personalised message per new enrolment', async () => {
    const a = await adminWithProgramme()
    assert.equal((await enrol(1)).status, 201)
    const q = (await a.client.get('/api/cms/admin/whatsapp/queue')).body.data
    assert.equal(q.length, 1)
    assert.equal(q[0].to_number, '+919876500001')
    assert.equal(q[0].status, 'pending')
    assert.match(q[0].body, /Learner1/)
    assert.ok(!q[0].body.includes('Kumar'), 'first name only')
    assert.match(q[0].body, /AI Webinar/)
    assert.match(q[0].body, /chat\.whatsapp\.com\/GROUP/)

    const row = (await a.client.get('/api/cms/admin/enrolments')).body.data[0]
    assert.equal(row.whatsapp_status, 'pending')
  })

  it('backfills everyone enrolled earlier, once', async () => {
    const a = await adminWithProgramme()
    await setWhatsApp(a, { enabled: false })
    await enrol(1)
    await enrol(2)
    assert.equal((await a.client.get('/api/cms/admin/whatsapp/queue')).body.data.length, 0, 'switched off: nothing queued')

    assert.equal((await a.client.post('/api/cms/admin/whatsapp/backfill?dry=1')).body.data.count, 2)
    assert.equal((await a.client.post('/api/cms/admin/whatsapp/backfill')).body.data.queued, 2)
    assert.equal((await a.client.post('/api/cms/admin/whatsapp/backfill')).body.data.queued, 0, 'never twice')
    assert.equal((await a.client.get('/api/cms/admin/whatsapp/status')).body.data.backfillCount, 0)
  })

  it('drops a dangling separator when there is no group link', () => {
    const text = renderMessage('Hi {name}, join here: {whatsapp}', { name: 'Priya K', programmeTitle: 'X', whatsappGroupUrl: '' })
    assert.equal(text, 'Hi Priya, join here')
  })
})

describe('whatsapp sending', () => {
  it('sends a random batch of 2-5 with random 20-90 s gaps, then pauses 5-15 min', async () => {
    const a = await adminWithProgramme()
    for (let i = 1; i <= 8; i++) await enrol(i)
    sleeps.length = 0
    const { t, sent } = fakeTransport()
    const r = await runBatch({ transport: t, sleep })
    assert.equal(r.outcome, 'sent')
    assert.ok(r.sent >= 2 && r.sent <= 5, `batch of ${r.sent}`)
    assert.equal(sent.length, r.sent)
    assert.equal(sleeps.length, r.sent - 1)
    assert.ok(sleeps.every((ms) => ms >= 20_000 && ms <= 90_000))
    const pause = waitAfter('sent', settingsDefaults.whatsapp)
    assert.ok(pause >= 5 * 60_000 && pause <= 15 * 60_000)
    void a
  })

  it('respects the daily cap, pause, connection and sending hours', async () => {
    const a = await adminWithProgramme()
    for (let i = 1; i <= 6; i++) await enrol(i)
    await setWhatsApp(a, { dailyCap: 3, batchMin: 5, batchMax: 5 })
    const { t, sent } = fakeTransport()
    assert.equal((await runBatch({ transport: t, sleep })).sent, 3)
    assert.equal((await runBatch({ transport: t, sleep })).outcome, 'capped')
    assert.equal(sent.length, 3)

    await setWhatsApp(a, { paused: true })
    assert.equal((await runBatch({ transport: t, sleep })).outcome, 'paused')
    await setWhatsApp(a, { paused: false, dailyCap: 100 })
    assert.equal((await runBatch({ transport: fakeTransport({ connected: false }).t, sleep })).outcome, 'disconnected')
    // 10:00 IST is outside a 0-1 window.
    await setWhatsApp(a, { startHour: 0, endHour: 1 })
    const tenAmIst = () => new Date('2026-12-01T04:30:00Z')
    assert.equal((await runBatch({ transport: t, sleep, now: tenAmIst })).outcome, 'outside_hours')
  })

  it('marks numbers without WhatsApp, and retries failed sends before giving up', async () => {
    const a = await adminWithProgramme()
    await enrol(1)
    await enrol(2)
    await setWhatsApp(a, { batchMin: 1, batchMax: 1 })

    await runBatch({ transport: fakeTransport({ notOnWhatsApp: ['+919876500001'] }).t, sleep })
    let q = (await a.client.get('/api/cms/admin/whatsapp/queue')).body.data
    assert.equal(q.find((m: any) => m.to_number === '+919876500001').status, 'not_on_whatsapp')

    const flaky = fakeTransport({ failSends: 5 })
    for (let i = 0; i < 3; i++) await runBatch({ transport: flaky.t, sleep })
    q = (await a.client.get('/api/cms/admin/whatsapp/queue')).body.data
    const m2 = q.find((m: any) => m.to_number === '+919876500002')
    assert.equal(m2.status, 'failed')
    assert.equal(m2.attempts, 3)
    assert.match(m2.last_error, /socket closed/)

    assert.equal((await a.client.post(`/api/cms/admin/whatsapp/queue/${m2.id}/retry`)).status, 200)
    assert.equal((await runBatch({ transport: fakeTransport().t, sleep })).sent, 1)
  })

  it('waits for payment before messaging a paid online enrolment', async () => {
    const a = await adminWithProgramme()
    await enrol(1)
    await query(`UPDATE enrolments SET razorpay_order_id = 'order_X', payment_status = 'pending'`)
    await query(`DELETE FROM whatsapp_outbox`)
    assert.equal((await a.client.post('/api/cms/admin/whatsapp/backfill?dry=1')).body.data.count, 0)
  })

  it('keeps WhatsApp admin-only and validates settings', async () => {
    const a = await adminWithProgramme()
    const bad = await a.client.request('PUT', '/api/cms/admin/settings/whatsapp', { ...settingsDefaults.whatsapp, batchMin: 6, batchMax: 2 })
    assert.equal(bad.status, 422)
    const st = (await a.client.get('/api/cms/admin/whatsapp/status')).body.data
    assert.equal(st.enabledOnServer, false)
    assert.equal((await a.client.post('/api/cms/admin/whatsapp/connect')).status, 409)
    const student = await createUser(base, 'student')
    assert.equal((await student.client.get('/api/cms/admin/whatsapp/status')).status, 403)
    assert.equal((await student.client.post('/api/cms/admin/whatsapp/backfill')).status, 403)
  })
})
