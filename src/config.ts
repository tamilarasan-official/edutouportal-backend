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

  /**
   * Validated as a real URL, not just a non-empty string.
   *
   * Passwords routinely contain characters that are structural in a URL --
   * `@` separates the credentials from the host, `#` starts a fragment, `/`
   * starts the path. An unencoded one either fails to parse or, worse, parses
   * into the wrong host and produces a confusing connection error much later.
   * Percent-encode them: @ -> %40, # -> %23, / -> %2F, : -> %3A, ? -> %3F.
   */
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .superRefine((value, ctx) => {
      let parsed: URL
      try {
        parsed = new URL(value)
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'DATABASE_URL is not a valid URL. If the password contains @ # / : or ?, ' +
            'percent-encode it (@ -> %40, # -> %23, / -> %2F). Example: ' +
            'postgresql://user:p%40ssw%23rd@db-host:5432/edutou',
        })
        return
      }

      if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `DATABASE_URL must start with postgres:// or postgresql:// (got "${parsed.protocol}//")`,
        })
      }
      if (!parsed.hostname) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'DATABASE_URL has no host. Use the internal service hostname, not a public address.',
        })
      }
      if (!parsed.pathname || parsed.pathname === '/') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'DATABASE_URL has no database name (the part after the port, e.g. /edutou).',
        })
      }
    }),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  // Must be at least 32 bytes of entropy. Generate with:
  //   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 15),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 30),

  // Comma-separated list of allowed browser origins.
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  /**
   * Set when the API and frontend are on different subdomains behind Dokploy,
   * e.g. ".edutou.example.com", so the session cookie is shared.
   *
   * "To disable it" is spelled *empty*, and the words people reach for instead
   * are treated as empty here. `COOKIE_DOMAIN=none` is otherwise a perfectly
   * valid non-empty string, so it reaches the browser as `Domain=none`, which
   * matches no host and makes the browser silently discard the whole cookie --
   * every request then arrives unauthenticated with nothing in the logs.
   */
  COOKIE_DOMAIN: z
    .string()
    .optional()
    .transform((value) => {
      const trimmed = value?.trim() ?? ''
      if (!trimmed || ['none', 'null', 'undefined', '-'].includes(trimmed.toLowerCase())) {
        return undefined
      }
      return trimmed
    }),
  /**
   * "lax" while every frontend shares the API's registrable domain.
   *
   * Set to "none" only for a frontend on a *different* registrable domain
   * (portal.qbitio.com calling api.edutou.in): Lax withholds the cookie there,
   * so every request is anonymous. See middleware/auth.ts for the cost.
   */
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),

  /**
   * Where uploaded bytes live.
   *
   * "disk" writes to STORAGE_DIR inside the container. That is only durable if
   * the path is a mounted volume -- on a host that rebuilds the container per
   * deploy, an unmounted directory means every file uploaded before the last
   * deploy is gone, and downloads answer 404 while the database still lists
   * them.
   *
   * "s3" writes to any S3-compatible object store (Garage, MinIO, R2, AWS).
   * Storage then outlives the container by construction. Left unset, the driver
   * is inferred: s3 when S3_ENDPOINT is present, disk otherwise.
   */
  STORAGE_DRIVER: z.enum(['disk', 's3']).optional(),
  // Absolute path to the uploads volume, for STORAGE_DRIVER=disk.
  STORAGE_DIR: z.string().default('/var/lib/edutou/uploads'),

  // --- S3 / Garage. Required when the driver resolves to s3. -----------------
  // e.g. http://garage:3900 on Dokploy's internal network.
  S3_ENDPOINT: z.string().url().optional(),
  // Garage's region is whatever its config calls it -- typically "garage".
  S3_REGION: z.string().default('garage'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  /**
   * Path-style addressing (`endpoint/bucket/key`) rather than virtual-host
   * style (`bucket.endpoint/key`). Garage and MinIO need this unless a wildcard
   * DNS record points at them, so it defaults on.
   */
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // --- Image compression -----------------------------------------------------
  /**
   * Re-encode uploaded images before storing them.
   *
   * A phone photo is several megabytes and several times larger than anything
   * the portal displays. Off only for debugging; leaving it off means the store
   * grows roughly ten times faster.
   */
  IMAGE_COMPRESSION: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** Longest edge, in pixels. 2560 is sharper than any view in the portal. */
  IMAGE_MAX_DIMENSION: z.coerce.number().int().positive().default(2560),
  /** WebP quality for photographs. 82 is visually transparent for this content. */
  IMAGE_QUALITY: z.coerce.number().int().min(40).max(100).default(82),
  /** Concurrent re-encodes. Each holds a decoded bitmap, so this bounds memory. */
  IMAGE_COMPRESS_CONCURRENCY: z.coerce.number().int().positive().max(16).default(2),

  // Public base URL files are served from, e.g. https://api.edutou.example.com
  PUBLIC_URL: z.string().default('http://localhost:4000'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),

  /**
   * Optional first-admin bootstrap.
   *
   * When both are set, the server creates this admin at boot if no admin
   * account exists yet. Signup always yields a student and only an admin can
   * change roles, so without this the very first admin has to be made from a
   * shell -- which is awkward or impossible on hosts whose web terminal is
   * unreliable.
   *
   * It is a no-op once any admin exists, so it is safe to leave set. Remove it
   * (and change the password) once you are in.
   */
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(8).optional(),
  BOOTSTRAP_ADMIN_NAME: z.string().max(200).optional(),

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

/**
 * Naming an endpoint is taken as choosing object storage, so a deployment
 * cannot half-configure S3 and silently keep writing to a container-local
 * directory that the next deploy erases.
 */
const storageDriver = env.STORAGE_DRIVER ?? (env.S3_ENDPOINT ? 's3' : 'disk')

if (storageDriver === 's3') {
  const missing = (
    [
      ['S3_ENDPOINT', env.S3_ENDPOINT],
      ['S3_BUCKET', env.S3_BUCKET],
      ['S3_ACCESS_KEY_ID', env.S3_ACCESS_KEY_ID],
      ['S3_SECRET_ACCESS_KEY', env.S3_SECRET_ACCESS_KEY],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([name]) => name)

  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `Invalid environment configuration:\n` +
        `  - STORAGE_DRIVER is "s3" but ${missing.join(', ')} ${
          missing.length === 1 ? 'is' : 'are'
        } not set.\n` +
        `    Set them, or set STORAGE_DRIVER=disk to store uploads on a mounted volume.`
    )
    process.exit(1)
  }
}

export const config = {
  ...env,
  isProduction: env.NODE_ENV === 'production',
  corsOrigins: env.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  googleEnabled: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
  storageDriver,
} as const

export type Config = typeof config
