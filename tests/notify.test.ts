import { after, afterEach, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Transporter } from 'nodemailer'
import { Client, createUser, startTestServer, stopTestServer, truncateAll, type TestUser } from './helpers.js'
import { query } from '../src/db/pool.js'
import { setMailTransport } from '../src/notify/mailer.js'
import { processOutbox } from '../src/notify/outbox.js'

/** Enrolment emails: confirmation to the person, notification to the team. */

interface Sent { to: string; subject: string; html: string; text: string }
let sent: Sent[] = []
let failNext = 0

const fakeTransport = {
  async sendMail(m: Sent) {
    if (failNext > 0) {
      failNext -= 1
      throw new Error('SMTP connection refused')
    }
    sent.push(m)
    return { messageId: 'test' }
  },
} as unknown as Transporter

let base: string

before(async () => {
  base = await startTestServer()
})
after(async () => {
  setMailTransport(null)
  await stopTestServer()
})
beforeEach(async () => {
  await truncateAll()
  sent = []
  failNext = 0
  setMailTransport(fakeTransport)
})
afterEach(() => setMailTransport(null))

const signup = { name: 'Priya Kumar', email: 'priya@example.com', phone: '98765 43210', profession: 'Student', city: 'Chennai' }

async function adminWithWebinar(enrolment: Record<string, unknown> = {}): Promise<TestUser> {
  const admin = await createUser(base, 'admin')
  await admin.client.post('/api/cms/admin/categories', { id: 'courses', title: 'Online Programmes' })
  const res = await admin.client.post('/api/cms/admin/programmes', {
    slug: 'ai-webinar',
    status: 'published',
    data: {
      title: 'AI Agents Webinar',
      category: 'courses',
      type: 'Webinar',
      pricing: { model: 'free' },
      schedule: { startDate: '2026-12-12', time: '7:00 PM IST', duration: '90 minutes', mode: 'Online' },
      enrolment: { whatsappGroupUrl: 'https://chat.whatsapp.com/WEBINAR', emailNote: 'The Zoom link is shared in the group.', ...enrolment },
    },
  })
  assert.equal(res.status, 201)
  return admin
}

/** Enrolment sending runs in the background; wait for it to settle. */
async function settle() {
  await processOutbox()
  await new Promise((r) => setTimeout(r, 50))
  await processOutbox()
}

describe('enrolment emails', () => {
  it('sends a confirmation with programme details and the WhatsApp link, and notifies the whole team', async () => {
    await adminWithWebinar()
    const res = await new Client(base).post('/api/cms/enrol', { ...signup, programme: 'ai-webinar', utm_source: 'instagram' })
    assert.equal(res.status, 201)
    assert.equal(res.body.data.whatsappGroupUrl, 'https://chat.whatsapp.com/WEBINAR')
    assert.equal(res.body.data.confirmationEmail, true)
    await settle()

    const confirmation = sent.find((m) => m.to === 'priya@example.com')
    assert.ok(confirmation, 'confirmation sent to the person')
    assert.match(confirmation.subject, /AI Agents Webinar/)
    for (const s of ['Priya Kumar', 'AI Agents Webinar', 'Webinar', '7:00 PM IST', '90 minutes', 'Free', 'https://chat.whatsapp.com/WEBINAR', 'The Zoom link is shared in the group.']) {
      assert.ok(confirmation.html.includes(s), `confirmation html has ${s}`)
    }
    assert.ok(confirmation.text.includes('https://chat.whatsapp.com/WEBINAR'))

    const team = sent.find((m) => m.to.includes('ceo@edutou.in'))
    assert.ok(team, 'team notified')
    for (const a of ['ceo@edutou.in', 'bewin@edutou.in', 'sujan@edutou.in', 'contact@edutou.in', 'whitedevil@edutou.in']) {
      assert.ok(team.to.includes(a), a)
    }
    assert.match(team.subject, /New enrolment: Priya Kumar for AI Agents Webinar/)
    for (const s of ['priya@example.com', '+919876543210', 'Chennai', 'instagram']) assert.ok(team.html.includes(s), s)
  })

  it('escapes what visitors type', async () => {
    await adminWithWebinar()
    await new Client(base).post('/api/cms/enrol', { ...signup, name: 'Bob <script>alert(1)</script>', programme: 'ai-webinar' })
    await settle()
    for (const m of sent) {
      assert.ok(!m.html.includes('<script>'), 'no raw script tag')
      assert.ok(m.html.includes('&lt;script&gt;'))
    }
  })

  it('falls back to the general WhatsApp link, and works for a general enquiry', async () => {
    const admin = await adminWithWebinar({ whatsappGroupUrl: '' })
    const form = (await admin.client.get('/api/cms/admin/settings/enrol_form')).body.data
    await admin.client.request('PUT', '/api/cms/admin/settings/enrol_form', { ...form, whatsappGroupUrl: 'https://chat.whatsapp.com/GENERAL' })

    await new Client(base).post('/api/cms/enrol', { ...signup, programme: 'ai-webinar' })
    await new Client(base).post('/api/cms/enrol', { ...signup, email: 'x@y.dev', phone: '9123456789' })
    await settle()
    const confirmations = sent.filter((m) => !m.to.includes('ceo@'))
    assert.equal(confirmations.length, 2)
    assert.ok(confirmations.every((m) => m.html.includes('https://chat.whatsapp.com/GENERAL')))
  })

  it('follows the admin settings: team list, wording and on/off switches', async () => {
    const admin = await adminWithWebinar()
    const n = (await admin.client.get('/api/cms/admin/settings/notifications')).body.data
    const saved = await admin.client.request('PUT', '/api/cms/admin/settings/notifications', {
      ...n,
      teamEmails: ['ops@edutou.in'],
      confirmationSubject: 'Welcome aboard, {name}!',
    })
    assert.equal(saved.status, 200)
    await new Client(base).post('/api/cms/enrol', { ...signup, programme: 'ai-webinar' })
    await settle()
    assert.deepEqual(sent.map((m) => m.to).sort(), ['ops@edutou.in', 'priya@example.com'])
    assert.equal(sent.find((m) => m.to === 'priya@example.com')!.subject, 'Welcome aboard, Priya Kumar!')

    sent = []
    await admin.client.request('PUT', '/api/cms/admin/settings/notifications', { ...n, sendConfirmation: false, sendTeam: false })
    await new Client(base).post('/api/cms/enrol', { ...signup, email: 'b@b.dev', phone: '9000000002', programme: 'ai-webinar' })
    await settle()
    assert.equal(sent.length, 0)

    const bad = await admin.client.request('PUT', '/api/cms/admin/settings/notifications', { ...n, teamEmails: ['not-an-email'] })
    assert.equal(bad.status, 422)
  })

  it('keeps the enrolment when sending fails, retries, and shows the status to admins', async () => {
    const admin = await adminWithWebinar()
    failNext = 2
    const res = await new Client(base).post('/api/cms/enrol', { ...signup, programme: 'ai-webinar' })
    assert.equal(res.status, 201)
    await settle()

    let row = (await admin.client.get('/api/cms/admin/enrolments')).body.data[0]
    assert.equal(row.confirmation_email, 'pending')
    assert.match(row.email_error, /connection refused/)

    // Make the retries due now instead of in a minute.
    await query(`UPDATE email_outbox SET next_attempt_at = now() WHERE status = 'pending'`)
    await settle()
    row = (await admin.client.get('/api/cms/admin/enrolments')).body.data[0]
    assert.equal(row.confirmation_email, 'sent')
    assert.equal(row.team_email, 'sent')
  })

  it('lets an admin resend, and builds the WhatsApp message link', async () => {
    const admin = await adminWithWebinar()
    await new Client(base).post('/api/cms/enrol', { ...signup, programme: 'ai-webinar' })
    await settle()
    const [row] = (await admin.client.get('/api/cms/admin/enrolments')).body.data
    sent = []

    const resend = await admin.client.post(`/api/cms/admin/enrolments/${row.id}/resend-email`, { kinds: ['confirmation'] })
    assert.equal(resend.status, 200)
    assert.deepEqual(sent.map((m) => m.to), ['priya@example.com'])

    const wa = (await admin.client.get(`/api/cms/admin/enrolments/${row.id}/whatsapp`)).body.data
    assert.ok(wa.url.startsWith('https://wa.me/919876543210?text='))
    assert.match(wa.text, /Priya Kumar.*AI Agents Webinar.*https:\/\/chat\.whatsapp\.com\/WEBINAR/)
  })

  it('keeps email tools admin-only', async () => {
    const student = await createUser(base, 'student')
    assert.equal((await student.client.get('/api/cms/admin/email/status')).status, 403)
    assert.equal((await student.client.post('/api/cms/admin/email/test', { to: 'a@b.dev' })).status, 403)
  })
})
