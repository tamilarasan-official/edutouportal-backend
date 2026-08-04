import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { closePool, queryOne, transaction } from '../db/pool.js'
import { hashPassword } from '../auth/tokens.js'

/**
 * Create (or promote) the first admin account.
 *
 * Needed because there is no bootstrap path otherwise: signup always yields a
 * student, and only an admin can change roles. Run once after the first deploy:
 *
 *   docker compose exec backend node dist/scripts/create-admin.js
 *
 * Credentials are read from argv or prompted for, never from the environment,
 * so the password does not end up in the container's env or in `docker inspect`.
 */

/**
 * Prompt only for the values that were not supplied on the command line.
 *
 * The readline interface is created lazily. Opening it unconditionally kept
 * stdin referenced in environments without a TTY -- such as a container web
 * terminal -- where the script could appear to do nothing at all.
 */
async function collectArgs(): Promise<[string, string, string]> {
  const [, , argEmail, argPassword, argName] = process.argv

  if (argEmail && argPassword) {
    return [argEmail, argPassword, argName ?? argEmail.split('@')[0] ?? 'Admin']
  }

  if (!stdin.isTTY) {
    throw new Error(
      'No interactive terminal available. Pass the values as arguments:\n' +
        '  node dist/scripts/create-admin.js <email> <password> "<full name>"'
    )
  }

  const rl = createInterface({ input: stdin, output: stdout })
  try {
    const email = argEmail ?? (await rl.question('Admin email: '))
    const password = argPassword ?? (await rl.question('Admin password (min 8 chars): '))
    const fullName = argName ?? (await rl.question('Full name: '))
    return [email, password, fullName]
  } finally {
    rl.close()
  }
}

async function main(): Promise<void> {
  console.log('[create-admin] starting...')

  const [email, password, fullName] = await collectArgs()

  if (!email.includes('@')) throw new Error('That does not look like an email address')
  if (password.length < 8) throw new Error('Password must be at least 8 characters')

  console.log(`[create-admin] target account: ${email}`)

  const existing = await queryOne<{ id: string }>(
    'SELECT id FROM users WHERE lower(email) = lower($1)',
    [email]
  )

  if (existing) {
    await transaction(async (client) => {
      await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [
        await hashPassword(password),
        existing.id,
      ])
      await client.query(`UPDATE profiles SET role = 'admin' WHERE id = $1`, [existing.id])
    })
    console.log(`Promoted existing account ${email} to admin and reset its password.`)
    return
  }

  const id = await transaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, user_metadata, email_confirmed_at)
       VALUES ($1, $2, $3, now())
       RETURNING id`,
      [email, await hashPassword(password), JSON.stringify({ full_name: fullName })]
    )
    const userId = rows[0]!.id
    // The on_user_created trigger made a student profile; upgrade it.
    await client.query(`UPDATE profiles SET role = 'admin', full_name = $2 WHERE id = $1`, [
      userId,
      fullName,
    ])
    return userId
  })

  console.log(`Created admin ${email} (${id}).`)
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('Failed:', (err as Error).message)
    await closePool().catch(() => {})
    process.exit(1)
  })
