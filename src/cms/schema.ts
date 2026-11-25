import { z } from 'zod'

/**
 * Content shapes for the edutou.in CMS.
 *
 * A programme is one document: its card on the catalogue, its badges, and an
 * optional full page made of ordered blocks. The website renders whatever the
 * document holds, so anything here is editable from admin.edutou.in.
 */

const str = (max: number) => z.string().trim().max(max).default('')
const list = (max: number, itemMax = 300) => z.array(z.string().trim().min(1).max(itemMax)).max(max).default([])

/** A /path on edutou.in, or an absolute http(s) URL (uploaded media). Nothing else. */
export const imageUrl = z
  .string()
  .trim()
  .max(600)
  .refine((v) => v === '' || /^\/(?!\/)/.test(v) || /^https?:\/\//i.test(v), 'Must be a /path or an http(s) URL')
  .default('')

/** Link targets: site paths, http(s), mailto: or tel:. */
const href = z
  .string()
  .trim()
  .max(600)
  .refine((v) => v === '' || /^\/(?!\/)/.test(v) || /^(https?:\/\/|mailto:|tel:)/i.test(v), 'Must be a /path, http(s), mailto: or tel: link')
  .default('')

export const slug = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(80)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and single hyphens')

const image = z
  .object({ url: imageUrl, alt: str(200), focus: str(30) })
  .default({})

const titled = z.object({ title: z.string().trim().min(1).max(160), desc: str(500) })
const button = z.object({ label: z.string().trim().min(1).max(60), href })

// ---------------------------------------------------------------------------
// Full-page blocks. Each renders as one section of the programme page.
// ---------------------------------------------------------------------------

const blockBase = { id: z.string().trim().min(1).max(40), label: str(80), title: str(200), lead: str(400) }

export const blockSchema = z.discriminatedUnion('type', [
  // Text beside a photo, with an optional "by the numbers" stat.
  z.object({
    ...blockBase,
    type: z.literal('text_media'),
    paragraphs: list(8, 1500),
    stat: z
      .object({ prefix: str(60), value: str(40), label: str(300), source: str(200) })
      .default({}),
    image,
  }),
  // A grid of cards: roles, modules, projects, outcomes, partners...
  z.object({
    ...blockBase,
    type: z.literal('cards'),
    columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(3),
    numbered: z.boolean().default(true),
    numberPrefix: str(30),
    items: z.array(titled).max(40).default([]),
    buttons: z.array(button).max(4).default([]),
  }),
  // Text on one side, a checklist on the other ("Who it's for" / "What you walk away with").
  z.object({
    ...blockBase,
    type: z.literal('split_list'),
    body: str(2000),
    noteLabel: str(80),
    note: str(400),
    listTitle: str(120),
    list: list(20, 300),
  }),
  // Grouped tags ("Your toolkit").
  z.object({
    ...blockBase,
    type: z.literal('tag_groups'),
    groups: z
      .array(z.object({ name: z.string().trim().min(1).max(60), items: list(40, 60) }))
      .max(20)
      .default([]),
  }),
  // Plans with bars, ways to join, and a step roadmap ("How it runs").
  z.object({
    ...blockBase,
    type: z.literal('plans'),
    plansTitle: str(120),
    plans: z
      .array(z.object({ name: z.string().trim().min(1).max(40), desc: str(300), weight: z.number().min(0).max(100).default(100) }))
      .max(12)
      .default([]),
    modesTitle: str(120),
    modes: z.array(titled).max(8).default([]),
    stepsTitle: str(200),
    steps: z.array(titled).max(12).default([]),
  }),
])

export type Block = z.infer<typeof blockSchema>

// ---------------------------------------------------------------------------
// Programme
// ---------------------------------------------------------------------------

export const programmeDataSchema = z.object({
  title: z.string().trim().min(2).max(160),
  /** Category id (cms_categories.id): the Programmes menu item it belongs to. */
  category: z.string().trim().min(1).max(80),
  /** Other categories whose page also lists it. */
  alsoIn: z.array(z.string().trim().min(1).max(80)).max(10).default([]),
  domains: list(15, 40),
  /** Badge: Course, Webinar, Workshop, Bootcamp, Internship, or anything else. */
  type: z.string().trim().min(1).max(40).default('Course'),

  pricing: z
    .object({
      /** free → "Free" badge; paid → price badge; hidden → no price shown. */
      model: z.enum(['free', 'paid', 'hidden']).default('free'),
      amount: z.number().min(0).max(10_000_000).nullable().default(null),
      currency: z.string().trim().toUpperCase().length(3).default('INR'),
      /** Optional wording instead of the number, e.g. "Fees depend on the plan". */
      note: str(200),
    })
    .default({}),

  /** What enrolled people receive for this programme. */
  enrolment: z
    .object({
      /** WhatsApp group invite (https://chat.whatsapp.com/...). Falls back to the enrol form's general link. */
      whatsappGroupUrl: z
        .string()
        .trim()
        .max(500)
        .refine((v) => v === '' || /^https:\/\//i.test(v), 'Must be an https:// URL')
        .default(''),
      /** Extra paragraph in the confirmation email, e.g. joining instructions. */
      emailNote: str(1500),
    })
    .default({}),

  /** Placeholders for the payment gateway, wired up once a provider is chosen. */
  payment: z
    .object({
      collectOnline: z.boolean().default(false),
      provider: str(40),
      productRef: str(120),
    })
    .default({}),

  schedule: z
    .object({
      startDate: str(40),
      time: str(40),
      duration: str(80),
      mode: str(80),
      language: str(80),
      seats: z.number().int().min(0).max(100000).nullable().default(null),
    })
    .default({}),

  image,

  card: z
    .object({
      meta: list(6, 120),
      summary: str(1200),
      highlights: list(16, 120),
      tools: list(40, 60),
      details: z
        .object({ enabled: z.boolean().default(false), roles: list(16, 160), projects: list(20, 300), note: str(1200) })
        .default({}),
    })
    .default({}),

  page: z
    .object({
      enabled: z.boolean().default(false),
      eyebrow: str(80),
      tagline: str(400),
      topics: list(12, 60),
      facts: z.array(z.object({ value: z.string().trim().min(1).max(40), label: str(120) })).max(8).default([]),
      primaryButton: str(40),
      counsellor: z.object({ name: str(80), phone: str(30) }).default({}),
      blocks: z.array(blockSchema).max(30).default([]),
      related: z.object({ enabled: z.boolean().default(true), label: str(80), title: str(160) }).default({}),
      cta: z.object({ title: str(160), text: str(600) }).default({}),
    })
    .default({}),
})

export type ProgrammeData = z.infer<typeof programmeDataSchema>

export const programmeStatus = z.enum(['draft', 'published', 'hidden'])

export const programmeInputSchema = z.object({
  slug,
  status: programmeStatus.default('draft'),
  sortOrder: z.number().int().min(-100000).max(100000).default(0),
  data: programmeDataSchema,
})

// ---------------------------------------------------------------------------
// Categories and settings
// ---------------------------------------------------------------------------

export const categoryInputSchema = z.object({
  id: slug,
  title: z.string().trim().min(1).max(80),
  description: str(300),
  sortOrder: z.number().int().min(-100000).max(100000).default(0),
})

export const settingsSchemas = {
  domains: z.object({ items: list(40, 40) }),
  enrol_form: z.object({
    title: str(120).default('Enrol with Edutou'),
    intro: str(400).default('Tell us a little about yourself and the team will reach out on WhatsApp.'),
    professions: z
      .array(z.string().trim().min(1).max(40))
      .min(1)
      .max(12)
      .default(['Student', 'Working professional', 'Business owner', 'Freelancer', 'Looking for a job', 'Other']),
    buttonText: str(60).default('Submit enrolment'),
    privacyNote: str(160).default('We respect your privacy. No spam, ever.'),
    successTitle: str(80).default("You're enrolled!"),
    successMessage: str(400).default('Our team will contact you on WhatsApp with the next steps.'),
    whatsappGroupUrl: z
      .string()
      .trim()
      .max(500)
      .refine((v) => v === '' || /^https:\/\//i.test(v), 'Must be an https:// URL')
      .default(''),
  }),
  notifications: z.object({
    /** Confirmation email to the person who enrolled. */
    sendConfirmation: z.boolean().default(true),
    confirmationSubject: str(200).default('Your registration for {programme} is confirmed'),
    confirmationIntro: str(1500).default(
      "Thank you for registering with Edutou. We have received your registration and our team will be in touch with the next steps."
    ),
    confirmationSignoff: str(500).default('Team Edutou'),
    /** Notification email to the team for every enrolment. */
    sendTeam: z.boolean().default(true),
    teamEmails: z
      .array(z.string().trim().toLowerCase().email('Not a valid email address'))
      .max(20)
      .default(['ceo@edutou.in', 'bewin@edutou.in', 'sujan@edutou.in', 'contact@edutou.in', 'whitedevil@edutou.in']),
    /** Pre-filled text for the one-click "Send WhatsApp" button in the admin. */
    whatsappMessage: str(1000).default(
      'Hi {name}, thank you for registering for {programme} with Edutou! Join the WhatsApp group for updates: {whatsapp}'
    ),
  }),
} as const

export type SettingsKey = keyof typeof settingsSchemas

export const settingsDefaults = {
  domains: { items: ['AI', 'CSE', 'ECE', 'EEE', 'Robotics', 'Drone', 'AMR', 'VLSI', 'PCB'] },
  enrol_form: settingsSchemas.enrol_form.parse({}),
  notifications: settingsSchemas.notifications.parse({}),
}
