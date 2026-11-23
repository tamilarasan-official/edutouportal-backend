import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Client, createUser, startTestServer, stopTestServer, truncateAll, type TestUser } from './helpers.js'

/**
 * CMS for edutou.in, managed from admin.edutou.in: categories, programmes,
 * the public site feed, and enrolments.
 */

let base: string

before(async () => {
  base = await startTestServer()
})
after(stopTestServer)
beforeEach(truncateAll)

const programme = (slug: string, overrides: Record<string, unknown> = {}, status = 'published') => ({
  slug,
  status,
  sortOrder: 10,
  data: {
    title: `Programme ${slug}`,
    category: 'courses',
    domains: ['AI'],
    type: 'Webinar',
    pricing: { model: 'free' },
    card: { summary: 'Short description', highlights: ['One', 'Two'] },
    ...overrides,
  },
})

async function adminWithCategory(): Promise<TestUser> {
  const admin = await createUser(base, 'admin')
  const res = await admin.client.post('/api/cms/admin/categories', { id: 'courses', title: 'Online Programmes', sortOrder: 10 })
  assert.equal(res.status, 201)
  return admin
}

const signup = {
  name: 'Priya Kumar',
  email: 'priya@example.com',
  phone: '98765 43210',
  profession: 'Student',
  city: 'Chennai',
}

describe('cms programmes', () => {
  it('publishes only published programmes to the public site feed', async () => {
    const admin = await adminWithCategory()
    assert.equal((await admin.client.post('/api/cms/admin/programmes', programme('live-one'))).status, 201)
    assert.equal((await admin.client.post('/api/cms/admin/programmes', programme('draft-one', {}, 'draft'))).status, 201)
    assert.equal((await admin.client.post('/api/cms/admin/programmes', programme('hidden-one', {}, 'hidden'))).status, 201)

    const site = await new Client(base).get('/api/cms/site')
    assert.equal(site.status, 200)
    assert.deepEqual(site.body.data.programmes.map((p: any) => p.slug), ['live-one'])
    assert.equal(site.body.data.categories[0].no, '01')
    assert.ok(site.body.data.enrolForm.professions.length > 0)
  })

  it('fills defaults, so a minimal programme renders completely', async () => {
    const admin = await adminWithCategory()
    const res = await admin.client.post('/api/cms/admin/programmes', programme('minimal'))
    const data = res.body.data.data
    assert.equal(data.pricing.currency, 'INR')
    assert.equal(data.page.enabled, false)
    assert.deepEqual(data.page.blocks, [])
    assert.equal(data.payment.collectOnline, false)
  })

  it('updates, changes status, duplicates and deletes', async () => {
    const admin = await adminWithCategory()
    const created = (await admin.client.post('/api/cms/admin/programmes', programme('edit-me', {}, 'draft'))).body.data
    assert.equal(created.publishedAt, null)

    const body = programme('edit-me', { title: 'Renamed', pricing: { model: 'paid', amount: 4999 } }, 'draft')
    const updated = await admin.client.request('PUT', `/api/cms/admin/programmes/${created.id}`, body)
    assert.equal(updated.status, 200)
    assert.equal(updated.body.data.data.title, 'Renamed')
    assert.equal(updated.body.data.data.pricing.amount, 4999)

    const published = await admin.client.request('PATCH', `/api/cms/admin/programmes/${created.id}/status`, { status: 'published' })
    assert.equal(published.body.data.status, 'published')
    assert.ok(published.body.data.publishedAt)

    const copy = await admin.client.post(`/api/cms/admin/programmes/${created.id}/duplicate`)
    assert.equal(copy.status, 201)
    assert.equal(copy.body.data.slug, 'edit-me-copy')
    assert.equal(copy.body.data.status, 'draft')

    assert.equal((await admin.client.request('DELETE', `/api/cms/admin/programmes/${created.id}`)).status, 200)
    const list = (await admin.client.get('/api/cms/admin/programmes')).body.data
    assert.deepEqual(list.map((p: any) => p.slug), ['edit-me-copy'])
  })

  it('accepts full-page blocks and rejects unsafe links', async () => {
    const admin = await adminWithCategory()
    const page = {
      enabled: true,
      tagline: 'Build things',
      blocks: [
        { id: 'b1', type: 'cards', title: 'Modules', items: [{ title: 'One', desc: 'First' }], columns: 4 },
        { id: 'b2', type: 'plans', plans: [{ name: '7 days', desc: 'Short', weight: 25 }] },
      ],
    }
    const ok = await admin.client.post('/api/cms/admin/programmes', programme('with-page', { page }))
    assert.equal(ok.status, 201)
    assert.equal(ok.body.data.data.page.blocks[0].numbered, true)

    const bad = await admin.client.post(
      '/api/cms/admin/programmes',
      programme('bad-link', { page: { blocks: [{ id: 'x', type: 'cards', buttons: [{ label: 'Go', href: 'javascript:alert(1)' }] }] } })
    )
    assert.equal(bad.status, 422)
    const badImage = await admin.client.post('/api/cms/admin/programmes', programme('bad-image', { image: { url: 'data:image/png;base64,x' } }))
    assert.equal(badImage.status, 422)
  })

  it('refuses a duplicate web address and an unknown category', async () => {
    const admin = await adminWithCategory()
    await admin.client.post('/api/cms/admin/programmes', programme('same'))
    const dup = await admin.client.post('/api/cms/admin/programmes', programme('same'))
    assert.equal(dup.status, 409)
    assert.equal(dup.body.error.code, 'SLUG_TAKEN')

    const unknown = await admin.client.post('/api/cms/admin/programmes', programme('other', { category: 'nope' }))
    assert.equal(unknown.status, 422)
  })

  it('keeps a category that is in use', async () => {
    const admin = await adminWithCategory()
    await admin.client.post('/api/cms/admin/programmes', programme('uses-it'))
    assert.equal((await admin.client.request('DELETE', '/api/cms/admin/categories/courses')).status, 409)
    const cats = (await admin.client.get('/api/cms/admin/categories')).body.data
    assert.equal(cats[0].programmes, 1)
  })

  it('is admin-only', async () => {
    const student = await createUser(base, 'student')
    assert.equal((await student.client.get('/api/cms/admin/programmes')).status, 403)
    assert.equal((await new Client(base).post('/api/cms/admin/programmes', programme('x'))).status, 401)
    assert.equal((await student.client.get('/api/cms/admin/enrolments')).status, 403)
  })
})

describe('cms enrolments', () => {
  it('records an enrolment for a published programme and shows it as new', async () => {
    const admin = await adminWithCategory()
    await admin.client.post('/api/cms/admin/programmes', programme('webinar-1'))

    const res = await new Client(base).post('/api/cms/enrol', { ...signup, programme: 'webinar-1', utm_source: 'instagram' })
    assert.equal(res.status, 201)

    const summary = (await admin.client.get('/api/cms/admin/enrolments/summary')).body.data
    assert.equal(summary.total, 1)
    assert.equal(summary.unseen, 1)
    assert.equal(summary.new, 1)

    const row = (await admin.client.get('/api/cms/admin/enrolments')).body.data[0]
    assert.equal(row.programme_key, 'webinar-1')
    assert.equal(row.programme_title, 'Programme webinar-1')
    assert.equal(row.whatsapp, '+919876543210')
    assert.equal(row.payment_status, 'not_required')
  })

  it('marks paid programmes as awaiting payment with the price', async () => {
    const admin = await adminWithCategory()
    await admin.client.post('/api/cms/admin/programmes', programme('paid-course', { pricing: { model: 'paid', amount: 2999 } }))
    await new Client(base).post('/api/cms/enrol', { ...signup, programme: 'paid-course' })
    const row = (await admin.client.get('/api/cms/admin/enrolments')).body.data[0]
    assert.equal(row.payment_status, 'pending')
    assert.equal(Number(row.amount), 2999)
    assert.equal(row.currency, 'INR')
  })

  it('allows one enrolment per email and per number for each programme', async () => {
    const admin = await adminWithCategory()
    await admin.client.post('/api/cms/admin/programmes', programme('prog-a'))
    await admin.client.post('/api/cms/admin/programmes', programme('prog-b'))
    const anon = new Client(base)

    assert.equal((await anon.post('/api/cms/enrol', { ...signup, programme: 'prog-a' })).status, 201)
    const sameEmail = await anon.post('/api/cms/enrol', { ...signup, programme: 'prog-a', phone: '9000000001' })
    assert.equal(sameEmail.status, 409)
    assert.ok(sameEmail.body.error.errors.email)
    const samePhone = await anon.post('/api/cms/enrol', { ...signup, programme: 'prog-a', email: 'x@y.dev', phone: '+91 98765 43210' })
    assert.equal(samePhone.status, 409)
    assert.ok(samePhone.body.error.errors.phone)

    assert.equal((await anon.post('/api/cms/enrol', { ...signup, programme: 'prog-b' })).status, 201)
    assert.equal((await anon.post('/api/cms/enrol', signup)).status, 201) // general enquiry
  })

  it('refuses drafts and unknown programmes', async () => {
    const admin = await adminWithCategory()
    await admin.client.post('/api/cms/admin/programmes', programme('not-yet', {}, 'draft'))
    const res = await new Client(base).post('/api/cms/enrol', { ...signup, programme: 'not-yet' })
    assert.equal(res.status, 422)
    assert.ok(res.body.error.errors.programme)
  })

  it('validates fields and drops honeypot submissions', async () => {
    const bad = await new Client(base).post('/api/cms/enrol', { name: 'A', email: 'no', phone: '123', profession: 'x', city: '' })
    assert.equal(bad.status, 422)
    for (const f of ['name', 'email', 'phone', 'city']) assert.ok(bad.body.error.errors[f], f)

    const bot = await new Client(base).post('/api/cms/enrol', { ...signup, company: 'Spam' })
    assert.equal(bot.status, 201)
    const admin = await createUser(base, 'admin')
    assert.equal((await admin.client.get('/api/cms/admin/enrolments/summary')).body.data.total, 0)
  })

  it('lets an admin update status, notes and payment, filter, and mark all seen', async () => {
    const admin = await adminWithCategory()
    await admin.client.post('/api/cms/admin/programmes', programme('p1'))
    await new Client(base).post('/api/cms/enrol', { ...signup, programme: 'p1' })
    await new Client(base).post('/api/cms/enrol', { ...signup, email: 'z@z.dev', phone: '9123456789' })

    const [first] = (await admin.client.get('/api/cms/admin/enrolments?programme=p1')).body.data
    const patched = await admin.client.request('PATCH', `/api/cms/admin/enrolments/${first.id}`, {
      status: 'contacted',
      notes: 'Called, interested',
      paymentStatus: 'paid',
      paymentReference: 'MANUAL-001',
    })
    assert.equal(patched.status, 200)

    const contacted = (await admin.client.get('/api/cms/admin/enrolments?status=contacted')).body.data
    assert.equal(contacted.length, 1)
    assert.equal(contacted[0].notes, 'Called, interested')
    assert.equal(contacted[0].payment_status, 'paid')
    assert.ok(contacted[0].paid_at)

    assert.equal((await admin.client.get('/api/cms/admin/enrolments?q=z%40z')).body.data.length, 1)

    await admin.client.post('/api/cms/admin/enrolments/mark-seen')
    assert.equal((await admin.client.get('/api/cms/admin/enrolments/summary')).body.data.unseen, 0)
  })
})

describe('cms settings', () => {
  it('saves enrol form settings and domains', async () => {
    const admin = await createUser(base, 'admin')
    const form = (await admin.client.get('/api/cms/admin/settings/enrol_form')).body.data
    const saved = await admin.client.request('PUT', '/api/cms/admin/settings/enrol_form', { ...form, professions: ['Student', 'Other'] })
    assert.equal(saved.status, 200)
    const domains = await admin.client.request('PUT', '/api/cms/admin/settings/domains', { items: ['AI', 'IoT'] })
    assert.equal(domains.status, 200)

    const site = (await new Client(base).get('/api/cms/site')).body.data
    assert.deepEqual(site.enrolForm.professions, ['Student', 'Other'])
    assert.deepEqual(site.domains, ['AI', 'IoT'])
    assert.equal((await admin.client.get('/api/cms/admin/settings/unknown')).status, 404)
  })
})
