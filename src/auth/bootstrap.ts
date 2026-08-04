import { config } from '../config.js'
import { queryOne, transaction } from '../db/pool.js'
import { hashPassword } from './tokens.js'

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
export async function bootstrapAdmin(): Promise<void> {
  const email = config.BOOTSTRAP_ADMIN_EMAIL
  const password = config.BOOTSTRAP_ADMIN_PASSWORD

  if (!email || !password) return

  const existingAdmin = await queryOne<{ count: number }>(
    `SELECT count(*)::int AS count FROM profiles WHERE role = 'admin'`
  )

  if ((existingAdmin?.count ?? 0) > 0) {
    console.log('[bootstrap] an admin already exists; skipping')
    return
  }

  const fullName = config.BOOTSTRAP_ADMIN_NAME || email.split('@')[0] || 'Admin'
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
