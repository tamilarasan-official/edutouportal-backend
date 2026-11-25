import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../config.js'

/**
 * Minimal Razorpay client: create an order, and verify the signatures Razorpay
 * returns from Checkout and sends with webhooks.
 * https://razorpay.com/docs/api/orders/  https://razorpay.com/docs/webhooks/
 */

type Http = typeof fetch
let http: Http = (...args) => fetch(...args)

/** Tests replace the HTTP call to Razorpay. */
export function setRazorpayHttp(h: Http | null): void {
  http = h ?? ((...args) => fetch(...args))
}

export interface RazorpayOrder {
  id: string
  amount: number
  currency: string
  status: string
}

/** Amount in the currency's smallest unit (paise for INR, cents for USD). */
export const toMinorUnits = (amount: number) => Math.round(amount * 100)

export async function createOrder(
  amount: number,
  currency: 'INR' | 'USD',
  receipt: string,
  notes: Record<string, string>
): Promise<RazorpayOrder> {
  if (!config.paymentsEnabled) throw new Error('Razorpay is not configured')
  const auth = Buffer.from(`${config.RAZORPAY_KEY_ID}:${config.RAZORPAY_KEY_SECRET}`).toString('base64')
  const res = await http('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${auth}` },
    body: JSON.stringify({ amount: toMinorUnits(amount), currency, receipt: receipt.slice(0, 40), notes }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = (await res.json().catch(() => ({}))) as RazorpayOrder & { error?: { description?: string } }
  if (!res.ok || !body.id) {
    throw new Error(`Razorpay order failed (${res.status}): ${body.error?.description ?? 'unknown error'}`)
  }
  return body
}

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Checkout success: HMAC-SHA256(order_id + "|" + payment_id, key secret). */
export function verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean {
  if (!config.RAZORPAY_KEY_SECRET || !orderId || !paymentId || !signature) return false
  const expected = createHmac('sha256', config.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex')
  return safeEqualHex(expected, signature)
}

/** Webhook: HMAC-SHA256(raw request body, webhook secret). */
export function verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
  if (!config.RAZORPAY_WEBHOOK_SECRET || !signature) return false
  const expected = createHmac('sha256', config.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex')
  return safeEqualHex(expected, signature)
}
