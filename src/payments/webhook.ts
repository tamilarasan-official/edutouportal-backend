import type { Request, Response } from 'express'
import { markOrderFailed, markOrderPaid } from '../cms/routes.js'
import { verifyWebhookSignature } from './razorpay.js'

/**
 * POST /api/payments/razorpay/webhook
 *
 * Backstop for checkout: if the visitor pays and closes the page before the
 * browser reports back, Razorpay still tells us here. Mounted with a raw body
 * parser, because the signature covers the exact bytes Razorpay sent.
 * Subscribe to payment.captured, order.paid and payment.failed.
 */
export async function razorpayWebhook(req: Request, res: Response): Promise<void> {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('')
  const signature = String(req.headers['x-razorpay-signature'] ?? '')
  if (!verifyWebhookSignature(raw, signature)) {
    res.status(400).json({ error: { message: 'Invalid signature', code: 'BAD_SIGNATURE' } })
    return
  }

  let event: {
    event?: string
    payload?: { payment?: { entity?: { id?: string; order_id?: string } }; order?: { entity?: { id?: string } } }
  }
  try {
    event = JSON.parse(raw.toString('utf8'))
  } catch {
    res.status(400).json({ error: { message: 'Invalid JSON', code: 'BAD_BODY' } })
    return
  }

  const payment = event.payload?.payment?.entity
  const orderId = payment?.order_id || event.payload?.order?.entity?.id || ''
  try {
    if ((event.event === 'payment.captured' || event.event === 'order.paid') && orderId && payment?.id) {
      const r = await markOrderPaid(orderId, payment.id)
      if (r?.firstTime) console.log(`[payments] webhook marked order ${orderId} paid`)
    } else if (event.event === 'payment.failed' && orderId) {
      await markOrderFailed(orderId)
    }
  } catch (err) {
    console.error('[payments] webhook handling failed', err)
    // A 5xx makes Razorpay retry later.
    res.status(500).json({ error: { message: 'Webhook handling failed', code: 'INTERNAL' } })
    return
  }
  res.json({ ok: true })
}
