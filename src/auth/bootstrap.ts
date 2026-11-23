import { config } from '../config.js'
import { queryOne, transaction } from '../db/pool.js'
import { hashPassword, revokeAllUserTokens } from './tokens.js'

/**
 * Create the first admin account at startup, if one is configured and none
 * exists yet.
 *
 * Signup always produces a student and only an admin can change roles, so a
 * fresh deployment has no way in. The alternative is running a script inside
 * the container, which depends on the host providing a working shell.
 *
 * Deliberately conservative:
 *   - does nothing unless BOOTSTRAP_ADMIN_EMAIL and _PASSWORD are both set
 *   - does nothing if ANY admin already exists, so it cannot be used to reset
 *     a forgotten password or silently re-add a deliberately removed account
 *   - promotes a matching existing user rather than failing on the unique email
 *   - never logs the password
 */
export interface BootstrapOptions {
  email?: string
  password?: string
  name?: string
  /** BOOTSTRAP_ADMIN_RESET: (re)set this account's password even if admins exist. */
  reset?: boolean
}

export async function bootstrapAdmin(
  opts: BootstrapOptions = {
    email: config.BOOTSTRAP_ADMIN_EMAIL,
    password: config.BOOTSTRAP_ADMIN_PASSWORD,
    name: config.BOOTSTRAP_ADMIN_NAME,
    reset: config.BOOTSTRAP_ADMIN_RESET,
  }
): Promise<void> {
  const { email, password } = opts

  if (!email || !password) return

  if (opts.reset) {
    await resetAdminPassword(email, password, opts.name)
    return
  }

  const existingAdmin = await queryOne<{ count: number }>(
    `SELECT count(*)::int AS count FROM profiles WHERE role = 'admin'`
  )

  if ((existingAdmin?.count ?? 0) > 0) {
    console.log('[bootstrap] an admin already exists; skipping')
    return
  }

  const fullName = opts.name || email.split('@')[0] || 'Admin'
  const passwordHash = await hashPassword(password)

  await transaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      'SELECT id FROM users WHERE lower(email) = lower($1)',
      [email]
    )

    let userId = rows[0]?.id

    if (userId) {
      // The address is taken by a non-admin account -- promote it rather than
      // failing on the unique constraint and leaving the instance locked out.
      await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [
        passwordHash,
        userId,
      ])
    } else {
      const { rows: created } = await client.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, user_metadata, email_confirmed_at)
         VALUES ($1, $2, $3, now())
         RETURNING id`,
        [email, passwordHash, JSON.stringify({ full_name: fullName })]
      )
      userId = created[0]!.id
    }

    // The on_user_created trigger inserts the profile as a student.
    await client.query(
      `UPDATE profiles SET role = 'admin', full_name = COALESCE(NULLIF(full_name, ''), $2) WHERE id = $1`,
      [userId, fullName]
    )
  })

  console.log(`[bootstrap] created admin account: ${email}`)
  console.log('[bootstrap] remove BOOTSTRAP_ADMIN_* from the environment once you have signed in')
}

/**
 * BOOTSTRAP_ADMIN_RESET=true: make `email` an admin with `password`, creating
 * the account if needed, and sign out its existing sessions. Opt-in only, for
 * taking over an existing admin account on deploy; see config.ts.
 */
async function resetAdminPassword(email: string, password: string, name?: string): Promise<void> {
  const passwordHash = await hashPassword(password)
  const fullName = name || email.split('@')[0] || 'Admin'

  const userId = await transaction(async (client) => {
    const { rows } = await client.query<{ id: string }>('SELECT id FROM users WHERE lower(email) = lower($1)', [email])
    let id = rows[0]?.id
    if (id) {
      await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, id])
    } else {
      const { rows: created } = await client.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, user_metadata, email_confirmed_at)
         VALUES ($1, $2, $3, now()) RETURNING id`,
        [email, passwordHash, JSON.stringify({ full_name: fullName })]
      )
      id = created[0]!.id
    }
    await client.query(
      `UPDATE profiles SET role = 'admin', full_name = COALESCE(NULLIF(full_name, ''), $2) WHERE id = $1`,
      [id, fullName]
    )
    return id
  })

  await revokeAllUserTokens(userId)
  console.log(`[bootstrap] BOOTSTRAP_ADMIN_RESET: set the admin password for ${email}`)
  console.warn('[bootstrap] turn BOOTSTRAP_ADMIN_RESET off now, or every restart puts this password back')
}
