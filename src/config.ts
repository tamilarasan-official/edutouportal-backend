import { z } from 'zod'

/**
 * Environment configuration.
 *
 * Every value is validated at boot. A missing or malformed secret crashes the
 * process immediately rather than surfacing as an auth bug in production --
 * the old frontend used `process.env.X!` and silently sent `undefined` to
 * Supabase when a variable was absent.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  // Must be at least 32 bytes of entropy. Generate with:
  //   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 15),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 30),

  // Comma-separated list of allowed browser origins.
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  // Set when the API and frontend are on different subdomains behind Dokploy,
  // e.g. ".edutou.example.com", so the session cookie is shared.
  COOKIE_DOMAIN: z.string().optional(),

  // Absolute path to the uploads volume. Replaces Supabase Storage.
  STORAGE_DIR: z.string().default('/var/lib/edutou/uploads'),
  // Public base URL files are served from, e.g. https://api.edutou.example.com
  PUBLIC_URL: z.string().default('http://localhost:4000'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  // Where the browser lands after OAuth completes.
  FRONTEND_URL: z.string().default('http://localhost:3000'),
})

const parsed = EnvSchema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n')
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration:\n${issues}`)
  process.exit(1)
}

const env = parsed.data

export const config = {
  ...env,
  isProduction: env.NODE_ENV === 'production',
  corsOrigins: env.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  googleEnabled: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
} as const

export type Config = typeof config
