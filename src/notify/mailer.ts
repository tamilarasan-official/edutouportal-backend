import nodemailer, { type Transporter } from 'nodemailer'
import { config } from '../config.js'

/**
 * SMTP transport for outgoing email.
 *
 * Configured from SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS (for Google
 * Workspace: smtp.gmail.com, 465, the mailbox, an app password). When those are
 * unset, `mailer()` returns null and queued emails wait until it is configured.
 * Tests swap in their own transport with `setMailTransport`.
 */

let transport: Transporter | null | undefined

export function mailer(): Transporter | null {
  if (transport !== undefined) return transport
  transport = config.mailEnabled
    ? nodemailer.createTransport({
        host: config.SMTP_HOST,
        port: config.SMTP_PORT,
        secure: config.SMTP_PORT === 465,
        auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
        // Fail fast; the outbox retries.
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 30_000,
      })
    : null
  return transport
}

export function setMailTransport(t: Transporter | null): void {
  transport = t
}

export const mailFrom = () => config.MAIL_FROM || (config.SMTP_USER ? `Edutou <${config.SMTP_USER}>` : 'Edutou <contact@edutou.in>')
