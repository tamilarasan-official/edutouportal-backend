import { config } from '../config.js'

/**
 * Email bodies for enrolments. Every value from a form or the CMS is escaped
 * before it goes into HTML.
 */

export interface EnrolmentDetails {
  id: string
  name: string
  email: string
  whatsapp: string
  profession: string
  city: string
  programmeTitle: string
  programmeType: string | null
  schedule: { date: string; time: string; duration: string; mode: string; language: string } | null
  price: string
  whatsappGroupUrl: string
  emailNote: string
  programmePageUrl: string | null
  source: string
  createdAt: Date
}

export interface RenderedEmail {
  subject: string
  html: string
  text: string
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/** "{name}" / "{programme}" / "{whatsapp}" placeholders. */
export function fill(template: string, d: Pick<EnrolmentDetails, 'name' | 'programmeTitle' | 'whatsappGroupUrl'>): string {
  return template
    .replace(/\{name\}/g, d.name)
    .replace(/\{programme\}/g, d.programmeTitle)
    .replace(/\{whatsapp\}/g, d.whatsappGroupUrl)
}

const BRAND = '#ff5e00'

function layout(title: string, body: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#18181b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden">
<tr><td style="background:#171717;padding:20px 28px;color:#ffffff;font-size:20px;font-weight:bold">edutou<span style="color:${BRAND}">.</span></td></tr>
<tr><td style="padding:28px">${body}</td></tr>
<tr><td style="padding:16px 28px;background:#fafafa;color:#71717a;font-size:12px;line-height:1.5">
Edutou Skill Academy · <a href="${esc(config.SITE_URL)}" style="color:#71717a">${esc(config.SITE_URL.replace(/^https?:\/\//, ''))}</a>
</td></tr>
</table></td></tr></table></body></html>`
}

function rows(items: [string, string][]): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px">${items
    .filter(([, v]) => v)
    .map(
      ([k, v]) =>
        `<tr><td style="padding:8px 0;color:#71717a;width:38%;vertical-align:top;border-bottom:1px solid #f1f1f1">${esc(k)}</td><td style="padding:8px 0;font-weight:bold;border-bottom:1px solid #f1f1f1">${esc(v)}</td></tr>`
    )
    .join('')}</table>`
}

function button(href: string, label: string, color = BRAND): string {
  return `<p style="margin:22px 0"><a href="${esc(href)}" style="display:inline-block;background:${color};color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:10px">${esc(label)}</a></p>`
}

function scheduleRows(d: EnrolmentDetails): [string, string][] {
  const s = d.schedule
  return [
    ['Programme', d.programmeTitle],
    ['Type', d.programmeType ?? ''],
    ['Date', s?.date ?? ''],
    ['Time', s?.time ?? ''],
    ['Duration', s?.duration ?? ''],
    ['Mode', s?.mode ?? ''],
    ['Language', s?.language ?? ''],
    ['Fee', d.price],
  ]
}

export function confirmationEmail(
  d: EnrolmentDetails,
  settings: { confirmationSubject: string; confirmationIntro: string; confirmationSignoff: string }
): RenderedEmail {
  const subject = fill(settings.confirmationSubject, d) || `Your registration for ${d.programmeTitle} is confirmed`
  const intro = fill(settings.confirmationIntro, d)
  const html = layout(
    subject,
    `<h1 style="margin:0 0 8px;font-size:22px">Registration successful 🎉</h1>
<p style="margin:0 0 12px;font-size:15px;line-height:1.6">Hi ${esc(d.name)},</p>
<p style="margin:0 0 12px;font-size:15px;line-height:1.6">${esc(intro)}</p>
${rows(scheduleRows(d))}
${d.emailNote ? `<p style="margin:0 0 12px;font-size:15px;line-height:1.6">${esc(d.emailNote).replace(/\n/g, '<br>')}</p>` : ''}
${
  d.whatsappGroupUrl
    ? `<p style="margin:16px 0 0;font-size:15px;line-height:1.6">Join the WhatsApp group for updates and joining details:</p>${button(d.whatsappGroupUrl, 'Join the WhatsApp group', '#25D366')}`
    : ''
}
${d.programmePageUrl ? `<p style="margin:0 0 12px;font-size:14px"><a href="${esc(d.programmePageUrl)}" style="color:${BRAND}">View programme details</a></p>` : ''}
<p style="margin:20px 0 0;font-size:15px;line-height:1.6">${esc(settings.confirmationSignoff).replace(/\n/g, '<br>')}</p>`
  )
  const text = [
    `Hi ${d.name},`,
    '',
    intro,
    '',
    ...scheduleRows(d)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v}`),
    ...(d.emailNote ? ['', d.emailNote] : []),
    ...(d.whatsappGroupUrl ? ['', `Join the WhatsApp group: ${d.whatsappGroupUrl}`] : []),
    ...(d.programmePageUrl ? ['', `Programme details: ${d.programmePageUrl}`] : []),
    '',
    settings.confirmationSignoff,
  ].join('\n')
  return { subject, html, text }
}

export function teamEmail(d: EnrolmentDetails): RenderedEmail {
  const subject = `New enrolment: ${d.name} for ${d.programmeTitle}`
  const adminUrl = `${config.ADMIN_URL.replace(/\/+$/, '')}/enrolments`
  const wa = `https://wa.me/${d.whatsapp.replace(/\D/g, '')}`
  const details: [string, string][] = [
    ['Name', d.name],
    ['Email', d.email],
    ['WhatsApp', d.whatsapp],
    ['Profession', d.profession],
    ['City', d.city],
    ['Programme', d.programmeTitle],
    ['Type', d.programmeType ?? ''],
    ['Date', d.schedule?.date ?? ''],
    ['Fee', d.price],
    ['Source', d.source],
    ['Received', d.createdAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST'],
  ]
  const html = layout(
    subject,
    `<h1 style="margin:0 0 8px;font-size:20px">New enrolment</h1>
<p style="margin:0;font-size:15px">${esc(d.name)} enrolled for <strong>${esc(d.programmeTitle)}</strong>.</p>
${rows(details)}
${button(adminUrl, 'Open in admin')}
<p style="margin:0;font-size:14px"><a href="${esc(wa)}" style="color:#128C7E">Message ${esc(d.name)} on WhatsApp</a> · <a href="mailto:${esc(d.email)}" style="color:${BRAND}">Reply by email</a></p>`
  )
  const text = [
    `New enrolment: ${d.name} for ${d.programmeTitle}`,
    '',
    ...details.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`),
    '',
    `Admin: ${adminUrl}`,
    `WhatsApp: ${wa}`,
  ].join('\n')
  return { subject, html, text }
}

export function testEmail(): RenderedEmail {
  const subject = 'Edutou email test'
  return {
    subject,
    html: layout(subject, `<h1 style="margin:0 0 8px;font-size:20px">Email is working ✅</h1><p style="font-size:15px;line-height:1.6">This test was sent from admin.edutou.in. Enrolment confirmations and team notifications will be sent from this address.</p>`),
    text: 'Email is working. This test was sent from admin.edutou.in.',
  }
}
