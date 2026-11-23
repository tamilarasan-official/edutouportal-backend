import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { Client, createUser, startTestServer, stopTestServer, truncateAll } from './helpers.js'

/**
 * learn.edutou.in: page content edited by admins, and the public sign-up form.
 */

let base: string

before(async () => {
  base = await startTestServer()
})
after(stopTestServer)
beforeEach(truncateAll)

const validSignup = {
  name: 'Priya Kumar',
  email: 'Priya@Example.com ',
  phone: '98765 43210',
  profession: 'Student',
  city: 'Chennai',
  utm_source: 'instagram',
}

describe('learn page content', () => {
  it('serves complete defaults to anonymous visitors before anything is saved', async () => {
    const res = await new Client(base).get('/api/learn/page')
    assert.equal(res.status, 200)
    assert.equal(res.body.data.updatedAt, null)
    assert.equal(res.body.data.content.hero.headlineHighlight, 'AI Agents')
    assert.ok(res.body.data.content.gallery.photos.length > 0)
  })

  it('lets an admin save content that the public endpoint then serves', async () => {
    const admin = await createUser(base, 'admin')
    const current = (await admin.client.get('/api/learn/page')).body.data.content

    const content = {
      ...current,
      hero: { ...current.hero, headlineHighlight: 'Generative AI' },
      gallery: { ...current.gallery, photos: [{ url: 'https://api.edutou.in/api/storage/site-media/x.webp', alt: 'Lab' }] },
    }
    const saved = await admin.client.request('PUT', '/api/learn/page', { content })
    assert.equal(saved.status, 200)
    assert.ok(saved.body.data.updatedAt)

    const pub = await new Client(base).get('/api/learn/page')
    assert.equal(pub.body.data.content.hero.headlineHighlight, 'Generative AI')
    assert.equal(pub.body.data.content.gallery.photos.length, 1)
  })

  it('fills fields missing from a partial document with defaults', async () => {
    const admin = await createUser(base, 'admin')
    const saved = await admin.client.request('PUT', '/api/learn/page', { content: { webinar: { when: 'Sat 7 Dec, 7 PM' } } })
    assert.equal(saved.status, 200)
    assert.equal(saved.body.data.content.webinar.when, 'Sat 7 Dec, 7 PM')
    assert.equal(saved.body.data.content.webinar.duration, '90 minutes')
    assert.equal(saved.body.data.content.brand.name, 'Edutou')
  })

  it('rejects script URLs in image and link fields', async () => {
    const admin = await createUser(base, 'admin')
    const badImage = await admin.client.request('PUT', '/api/learn/page', {
      content: { gallery: { photos: [{ url: 'javascript:alert(1)', alt: '' }] } },
    })
    assert.equal(badImage.status, 422)

    const badLink = await admin.client.request('PUT', '/api/learn/page', {
      content: { form: { whatsappGroupUrl: 'http://chat.whatsapp.com/x' } },
    })
    assert.equal(badLink.status, 422)
  })

  it('refuses edits from anyone who is not an admin', async () => {
    const mentor = await createUser(base, 'mentor')
    assert.equal((await mentor.client.request('PUT', '/api/learn/page', { content: {} })).status, 403)
    assert.equal((await new Client(base).request('PUT', '/api/learn/page', { content: {} })).status, 401)
  })
})

describe('learn registrations', () => {
  it('stores a valid India-only sign-up with normalised fields', async () => {
    const res = await new Client(base).post('/api/learn/register', validSignup)
    assert.equal(res.status, 201)

    const admin = await createUser(base, 'admin')
    const list = await admin.client.get('/api/learn/registrations')
    assert.equal(list.status, 200)
    assert.equal(list.body.count, 1)
    const row = list.body.data[0]
    assert.equal(row.email, 'priya@example.com')
    assert.equal(row.whatsapp, '+919876543210')
    assert.equal(row.utm_source, 'instagram')
  })

  it('accepts a number typed with +91 or a leading 0', async () => {
    const anon = new Client(base)
    assert.equal((await anon.post('/api/learn/register', { ...validSignup, email: 'a@x.dev', phone: '+91 98765 43210' })).status, 201)
    assert.equal((await anon.post('/api/learn/register', { ...validSignup, email: 'b@x.dev', phone: '09123456780' })).status, 201)
  })

  it('refuses a second sign-up for the same course with the same email', async () => {
    const anon = new Client(base)
    assert.equal((await anon.post('/api/learn/register', validSignup)).status, 201)
    const again = await anon.post('/api/learn/register', { ...validSignup, email: 'PRIYA@example.com', phone: '9000000001' })
    assert.equal(again.status, 409)
    assert.equal(again.body.error.code, 'ALREADY_REGISTERED')
    assert.ok(again.body.error.errors.email)
    assert.equal(again.body.error.errors.phone, undefined)
  })

  it('refuses a second sign-up for the same course with the same WhatsApp number in any format', async () => {
    const anon = new Client(base)
    assert.equal((await anon.post('/api/learn/register', validSignup)).status, 201)
    const again = await anon.post('/api/learn/register', { ...validSignup, email: 'other@example.com', phone: '+91 9876543210' })
    assert.equal(again.status, 409)
    assert.ok(again.body.error.errors.phone)
    assert.equal(again.body.error.errors.email, undefined)
  })

  it('stores only one row when the same person submits twice at once', async () => {
    const results = await Promise.all([1, 2, 3].map(() => new Client(base).post('/api/learn/register', validSignup)))
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409])
    const admin = await createUser(base, 'admin')
    assert.equal((await admin.client.get('/api/learn/registrations')).body.count, 1)
  })

  it('allows the same person to register again once the course changes', async () => {
    const anon = new Client(base)
    assert.equal((await anon.post('/api/learn/register', validSignup)).status, 201)

    const admin = await createUser(base, 'admin')
    const saved = await admin.client.request('PUT', '/api/learn/page', { content: { webinar: { course: 'AI Agents - January batch' } } })
    assert.equal(saved.status, 200)

    assert.equal((await anon.post('/api/learn/register', validSignup)).status, 201)
    const list = (await admin.client.get('/api/learn/registrations')).body
    assert.equal(list.count, 2)
    assert.deepEqual(list.data.map((r: any) => r.course).sort(), ['AI Agents - January batch', 'Free AI Webinar'])
  })

  it('returns a message per invalid field', async () => {
    const res = await new Client(base).post('/api/learn/register', {
      name: 'A',
      email: 'nope',
      phone: '12345',
      profession: 'Astronaut',
      city: '',
    })
    assert.equal(res.status, 422)
    const errors = res.body.error.errors
    for (const field of ['name', 'email', 'phone', 'city']) assert.ok(errors[field], `missing error for ${field}`)
  })

  it('rejects a profession that is not offered on the page', async () => {
    const res = await new Client(base).post('/api/learn/register', { ...validSignup, profession: 'Astronaut' })
    assert.equal(res.status, 422)
    assert.ok(res.body.error.errors.profession)
  })

  it('silently drops honeypot submissions', async () => {
    const res = await new Client(base).post('/api/learn/register', { ...validSignup, company: 'Spam Inc' })
    assert.equal(res.status, 201)
    const admin = await createUser(base, 'admin')
    assert.equal((await admin.client.get('/api/learn/registrations')).body.count, 0)
  })

  it('keeps the lead list admin-only and lets an admin delete a row', async () => {
    await new Client(base).post('/api/learn/register', validSignup)
    const student = await createUser(base, 'student')
    assert.equal((await student.client.get('/api/learn/registrations')).status, 403)

    const admin = await createUser(base, 'admin')
    const id = (await admin.client.get('/api/learn/registrations')).body.data[0].id
    assert.equal((await admin.client.request('DELETE', `/api/learn/registrations/${id}`)).status, 200)
    assert.equal((await admin.client.get('/api/learn/registrations')).body.count, 0)
  })
})

describe('site-media bucket', () => {
  const png = async () =>
    new Blob([
      await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff5e00' } }).png().toBuffer(),
    ])

  it('lets admins upload images that anyone can then view without signing in', async () => {
    const admin = await createUser(base, 'admin')
    const up = await admin.client.upload('/api/storage/site-media', await png(), 'banner.png')
    assert.equal(up.status, 201)

    const path = new URL(up.body.data.publicUrl).pathname
    const res = await fetch(`${base}${path}`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /^image\//)
    assert.match(res.headers.get('cache-control') ?? '', /public/)
  })

  it('refuses uploads from non-admins and non-image files', async () => {
    const mentor = await createUser(base, 'mentor')
    assert.equal((await mentor.client.upload('/api/storage/site-media', await png(), 'x.png')).status, 403)

    const admin = await createUser(base, 'admin')
    const pdf = await admin.client.upload('/api/storage/site-media', new Blob(['%PDF-1.4']), 'doc.pdf')
    assert.equal(pdf.status, 415)
  })

  it('still requires sign-in for the private buckets', async () => {
    const res = await fetch(`${base}/api/storage/resources/documents/x/misc/misc/file.pdf`)
    assert.equal(res.status, 401)
  })
})
