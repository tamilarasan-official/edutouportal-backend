import { z } from 'zod'

/**
 * Shape of the learn.edutou.in landing page, as edited in the portal admin.
 *
 * Every field has a default so a partially filled document -- or a document
 * saved before a field existed -- still renders a complete page.
 */

const text = (max: number, fallback: string) => z.string().trim().max(max).default(fallback)

/**
 * Images are either a site-relative path ("/images/x.jpg", served by the learn
 * site itself) or an absolute http(s) URL (an upload in the site-media bucket).
 * Anything else -- javascript:, data:, protocol-relative -- is refused.
 */
const imageUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === '' || /^\/(?!\/)/.test(v) || /^https?:\/\//i.test(v), 'Must be a /path or http(s) URL')

const linkUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === '' || /^https:\/\//i.test(v), 'Must be an https:// URL')

export const learnPageSchema = z.object({
  seo: z
    .object({
      title: text(120, 'Registration | Edutou'),
      description: text(300, 'Learn to build AI agents and future-ready career skills. Register free for the Edutou live webinar.'),
    })
    .default({}),

  brand: z
    .object({
      name: text(60, 'Edutou'),
      tagline: text(60, 'Skill Academy'),
      logoUrl: imageUrl.default('/logo.jpg'),
    })
    .default({}),

  hero: z
    .object({
      eyebrow: text(60, 'Free Live Webinar'),
      headlineBefore: text(120, 'Learn to Build'),
      headlineHighlight: text(80, 'AI Agents'),
      headlineAfter: text(120, '& Future-Ready Career Skills'),
      subhead: text(300, "Even if you're a fresher with no coding background, or looking to switch careers."),
      imageUrl: imageUrl.default('/images/photo-12.jpg'),
    })
    .default({}),

  webinar: z
    .object({
      title: text(80, 'Free AI Webinar'),
      // Registrations are de-duplicated per course: the same email or WhatsApp
      // number can sign up once for each course name. Change it to open a new batch.
      course: z.string().trim().min(1).max(80).default('Free AI Webinar'),
      when: text(80, 'Date & time announced soon'),
      duration: text(40, '90 minutes'),
      language: text(60, 'English & Tamil'),
    })
    .default({}),

  form: z
    .object({
      title: text(80, 'Reserve your free seat'),
      buttonText: text(60, "Register Now — It's Free"),
      privacyNote: text(120, 'We respect your privacy. No spam, ever.'),
      professions: z
        .array(z.string().trim().min(1).max(40))
        .min(1)
        .max(12)
        .default(['Student', 'Job', 'Business', 'Freelancer', 'Looking for a job', 'Other']),
      successTitle: text(80, "You're registered!"),
      successMessage: text(300, "We'll send the webinar details to your WhatsApp and email."),
      whatsappGroupUrl: linkUrl.default(''),
    })
    .default({}),

  learn: z
    .object({
      title: text(120, "What you'll learn in this free webinar"),
      points: z
        .array(z.string().trim().min(1).max(200))
        .max(12)
        .default([
          'What AI agents are and where companies use them today',
          'Build your first working AI agent live, no coding needed',
          'Tools freshers and career-switchers can start with this week',
          'A clear roadmap to AI roles and how to build a portfolio',
        ]),
    })
    .default({}),

  stats: z
    .array(z.object({ value: z.string().trim().min(1).max(20), label: z.string().trim().min(1).max(60) }))
    .max(6)
    .default([
      { value: '98.7%', label: 'Learner satisfaction' },
      { value: '2500+', label: 'Lessons completed' },
      { value: '120+', label: 'Hands-on projects' },
    ]),

  institutions: z
    .object({
      title: text(80, "Institutions we've worked with"),
      names: z
        .array(z.string().trim().min(1).max(80))
        .max(20)
        .default(['Saveetha University', 'Madras Engineering College']),
    })
    .default({}),

  gallery: z
    .object({
      title: text(80, 'Inside the Edutou classroom'),
      photos: z
        .array(z.object({ url: imageUrl.refine((v) => v !== '', 'Required'), alt: z.string().trim().max(160).default('') }))
        .max(24)
        .default([
          { url: '/images/photo-01.jpg', alt: 'Students in an Edutou AI training session' },
          { url: '/images/photo-04.jpg', alt: 'Full computer lab of Edutou students' },
          { url: '/images/photo-08.jpg', alt: 'Edutou mentor presenting to students' },
          { url: '/images/photo-05.jpg', alt: 'Welcome session on stage at an Edutou campus program' },
          { url: '/images/photo-02.jpg', alt: 'Wide view of an Edutou computer lab' },
          { url: '/images/photo-13.jpg', alt: 'Edutou cohort group selfie' },
        ]),
    })
    .default({}),

  stickyBar: z
    .object({
      enabled: z.boolean().default(true),
      buttonText: text(30, 'Join now'),
    })
    .default({}),
})

export type LearnPageContent = z.infer<typeof learnPageSchema>

export const defaultLearnPage: LearnPageContent = learnPageSchema.parse({})
