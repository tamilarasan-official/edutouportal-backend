import { after, afterEach, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import type { Transporter } from 'nodemailer'
import { Client, createUser, startTestServer, stopTestServer, truncateAll, type TestUser } from './helpers.js'
import { setMailTransport } from '../src/notify/mailer.js'
import { processOutbox } from '../src/notify/outbox.js'
import { setRazorpayHttp } from '../src/payments/razorpay.js'

/**
 * Razorpay online payments. Uses the fake keys from .env.test and a fake
 * Razorpay API; nothing leaves the machine.
 */

const KEY_SECRET = 'test_key_secret_not_real'
const WEBHOOK_SECRET = 'test_webhook_secret_not_real'

let sent: { to: string; subject: string; html: string }[] = []
let orders: { amount: number; currency: string; receipt: string }[] = []
let failOrders = false

const sign = (orderId: string, paymentId: string) => createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex')

let base: string
before(async () => {
  base = await startTestServer()
})
after(async () => {
  setMailTransport(null)
  setRazorpayHttp(null)
  await stopTestServer()
})
beforeEach(async () => {
  await truncateAll()
  sent = []
  orders = []
  failOrders = false
  setMailTransport({
    async sendMail(m: { to: string; subject: string; html: string }) {
      sent.push(m)
      return { messageId: 't' }
    },
  } as unknown as Transporter)
  setRazorpayHttp((async (_url: string, init: RequestInit) => {
    if (failOrders) return new Response(JSON.stringify({ error: { description: 'Authentication failed' } }), { status: 401 })
    const body = JSON.parse(String(init.body))
    orders.push(body)
    return new Response(JSON.stringify({ id: `order_TEST${orders.length}`, amount: body.amount, currency: body.currency, status: 'created' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch)
})
afterEach(() => {
  setMailTransport(null)
  setRazorpayHttp(null)
})

const signup = { name: 'Priya Kumar', email: 'priya@example.com', phone: '98765 43210', profession: 'Student', city: 'Chennai' }

async function admin(): Promise<TestUser> {
  const a = await createUser(base, 'admin')
  await a.client.post('/api/cms/admin/categories', { id: 'courses', title: 'Online Programmes' })
  return a
}

async function paidProgramme(a: TestUser, slug: string, pricing: Record<string, unknown>, collectOnline = true) {
  const res = await a.client.post('/api/cms/admin/programmes', {
    slug,
    status: 'published',
    data: { title: `Paid ${slug}`, category: 'courses', type: 'Webinar', pricing: { model: 'paid', ...pricing }, payment: { collectOnline } },
  })
  assert.equal(res.status, 201, JSON.stringify(res.body))
}

async function settle() {
  await processOutbox()
  await new Promise((r) => setTimeout(r, 50))
  await processOutbox()
}

describe('razorpay checkout', () => {
  it('creates an order at the server price and sends no email until paid', async () => {
    const a = await admin()
    await paidProgramme(a, 'paid-webinar', { amount: 99, showCompareAt: true, compareAtAmount: 199 })

    const res = await new Client(base).post('/api/cms/enrol', { ...signup, programme: 'paid-webinar', amount: 1 })
    assert.equal(res.status, 201)
    const pay = res.body.data.payment
    assert.equal(pay.provider, 'razorpay')
    assert.equal(pay.orderId, 'order_TEST1')
    assert.equal(pay.amount, 9900)
    assert.equal(pay.currency, 'INR')
    assert.equal(pay.keyId, 'rzp_test_dummykey0000')
    assert.equal(pay.prefill.contact, '+919876543210')
    assert.equal(orders[0]!.amount, 9900, 'price from the server, not the request')

    await settle()
    assert.equal(sent.length, 0)
    const row = (await a.client.get('/api/cms/admin/enrolments')).body.data[0]
    assert.equal(row.payment_status, 'pending')
    assert.equal(row.razorpay_order_id, 'order_TEST1')
  })

  it('verifies the payment signature, marks it paid and then sends the emails', async () => {
    const a = await admin()
    await paidProgramme(a, 'paid-webinar', { amount: 99, showCompareAt: true, compareAtAmount: 199 })
    const { orderId } = (await new Client(base).post('/api/cms/enrol', { ...signup, programme: 'paid-webinar' })).body.data.payment

    const bad = await new Client(base).post('/api/cms/enrol/verify', { orderId, paymentId: 'pay_ABC', signature: 'deadbeef' })
    assert.equal(bad.status, 400)

    const ok = await new Client(base).post('/api/cms/enrol/verify', { orderId, paymentId: 'pay_ABC', signature: sign(orderId, 'pay_ABC') })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.data.paid, true)
    assert.equal(ok.body.data.confirmationEmail, true)
    await settle()

    const row = (await a.client.get('/api/cms/admin/enrolments')).body.data[0]
    assert.equal(row.payment_status, 'paid')
    assert.equal(row.payment_reference, 'pay_ABC')
    assert.ok(row.paid_at)

    const confirmation = sent.find((m) => m.to === 'priya@example.com')!
    assert.ok(confirmation.html.includes('Paid ₹99'))
    assert.ok(confirmation.html.includes('pay_ABC'))
    assert.ok(confirmation.html.includes('was ₹199'))
    assert.ok(sent.some((m) => m.to.includes('ceo@edutou.in')))

    // Verifying again (e.g. a double click) is harmless and sends nothing more.
    const count = sent.length
    assert.equal((await new Client(base).post('/api/cms/enrol/verify', { orderId, paymentId: 'pay_ABC', signature: sign(orderId, 'pay_ABC') })).status, 200)
    await settle()
    assert.equal(sent.length, count)
  })

  it('lets an unpaid attempt try again, but blocks once paid', async () => {
    const a = await admin()
    await paidProgramme(a, 'paid-webinar', { amount: 99 })
    const first = await new Client(base).post('/api/cms/enrol', { ...signup, programme: 'paid-webinar' })
    const again = await new Client(base).post('/api/cms/enrol', { ...signup, city: 'Madurai', programme: 'paid-webinar' })
    assert.equal(again.status, 201)
    assert.notEqual(again.body.data.payment.orderId, first.body.data.payment.orderId)
    assert.equal((await a.client.get('/api/cms/admin/enrolments')).body.data.length, 1, 'same enrolment reused')

    const { orderId } = again.body.data.payment
    await new Client(base).post('/api/cms/enrol/verify', { orderId, paymentId: 'pay_X', signature: sign(orderId, 'pay_X') })
    const third = await new Client(base).post('/api/cms/enrol', { ...signup, programme: 'paid-webinar' })
    assert.equal(third.status, 409)
  })

  it('charges in USD when the programme is priced in dollars', async () => {
    const a = await admin()
    await paidProgramme(a, 'usd-course', { amount: 19.99, currency: 'USD' })
    const pay = (await new Client(base).post('/api/cms/enrol', { ...signup, programme: 'usd-course' })).body.data.payment
    assert.equal(pay.currency, 'USD')
    assert.equal(pay.amount, 1999)
  })

  it('keeps the offline flow when online payment is off, and reports a Razorpay outage', async () => {
    const a = await admin()
    await paidProgramme(a, 'offline-pay', { amount: 499 }, false)
    const res = await new Client(base).post('/api/cms/enrol', { ...signup, programme: 'offline-pay' })
    assert.equal(res.status, 201)
    assert.equal(res.body.data.payment, undefined)
    await settle()
    assert.ok(sent.length >= 1, 'emails sent straight away')

    await paidProgramme(a, 'online-pay', { amount: 99 })
    failOrders = true
    const down = await new Client(base).post('/api/cms/enrol', { ...signup, email: 'z@z.dev', phone: '9123456789', programme: 'online-pay' })
    assert.equal(down.status, 502)
    assert.equal(down.body.error.code, 'PAYMENT_UNAVAILABLE')
  })

  it('rejects a strike-through price that is not higher than the price', async () => {
    const a = await admin()
    const res = await a.client.post('/api/cms/admin/programmes', {
      slug: 'bad-offer',
      data: { title: 'Bad offer', category: 'courses', pricing: { model: 'paid', amount: 199, showCompareAt: true, compareAtAmount: 99 } },
    })
    assert.equal(res.status, 422)
  })
})

describe('razorpay webhook', () => {
  const post = (body: unknown, secret = WEBHOOK_SECRET) => {
    const raw = JSON.stringify(body)
    return fetch(`${base}/api/payments/razorpay/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': createHmac('sha256', secret).update(raw).digest('hex') },
      body: raw,
    })
  }

  it('marks the order paid when the browser never reported back', async () => {
    const a = await admin()
    await paidProgramme(a, 'paid-webinar', { amount: 99 })
    const { orderId } = (await new Client(base).post('/api/cms/enrol', { ...signup, programme: 'paid-webinar' })).body.data.payment

    assert.equal((await post({ event: 'payment.captured' }, 'wrong-secret')).status, 400)

    const res = await post({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_HOOK', order_id: orderId } } } })
    assert.equal(res.status, 200)
    await settle()
    const row = (await a.client.get('/api/cms/admin/enrolments')).body.data[0]
    assert.equal(row.payment_status, 'paid')
    assert.equal(row.payment_reference, 'pay_HOOK')
    assert.ok(sent.some((m) => m.to === 'priya@example.com'))
  })

  it('records a failed payment', async () => {
    const a = await admin()
    await paidProgramme(a, 'paid-webinar', { amount: 99 })
    const { orderId } = (await new Client(base).post('/api/cms/enrol', { ...signup, programme: 'paid-webinar' })).body.data.payment
    await post({ event: 'payment.failed', payload: { payment: { entity: { id: 'pay_F', order_id: orderId } } } })
    assert.equal((await a.client.get('/api/cms/admin/enrolments')).body.data[0].payment_status, 'failed')
  })

  it('shows admins whether Razorpay is connected', async () => {
    const a = await admin()
    const st = (await a.client.get('/api/cms/admin/payments/status')).body.data
    assert.equal(st.configured, true)
    assert.equal(st.mode, 'test')
    assert.ok(!st.keyId.includes('dummykey0'), 'key id is masked')
    assert.equal((await (await createUser(base, 'student')).client.get('/api/cms/admin/payments/status')).status, 403)
  })
})
