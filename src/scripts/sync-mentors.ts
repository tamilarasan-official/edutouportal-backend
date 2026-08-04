import { closePool, query, transaction } from '../db/pool.js'
import { hashPassword } from '../auth/tokens.js'

/**
 * Reduce the mentor roster to exactly the two real mentors.
 *
 * Dummy mentor accounts accumulated during development are deleted outright --
 * demoting them to 'student' would leave them in the student lists instead.
 * Every foreign key pointing at users(id) is either ON DELETE CASCADE or
 * ON DELETE SET NULL (see migrations 0001-0006), so a plain DELETE is safe, but
 * it is not free: content a dummy mentor authored goes with it (quizzes.created_by,
 * resources.uploaded_by, notifications.created_by all cascade), while tasks they
 * created survive with mentor_id set to NULL.
 *
 * Run with --dry-run first to see exactly which accounts are in scope:
 *
 *   npm run sync-mentors -- --dry-run
 *   npm run sync-mentors
 *
 * In production:
 *
 *   docker compose exec backend node dist/scripts/sync-mentors.js --dry-run
 *   docker compose exec backend node dist/scripts/sync-mentors.js
 */

interface MentorSpec {
  email: string
  password: string
  fullName: string
}

// The password is the address with ".com" stripped, as requested. These are
// shared credentials for real people -- both should change them after first login.
const MENTORS: MentorSpec[] = [
  { email: 'vishal@qbitio.com', password: 'vishal@qbitio', fullName: 'Vishal' },
  { email: 'rishi@qbitio.com', password: 'rishi@qbitio', fullName: 'Rishi' },
]

interface UserRow {
  id: string
  email: string
  full_name: string | null
  role: string
}

const KEEP = MENTORS.map((m) => m.email.toLowerCase())

async function currentMentors(): Promise<UserRow[]> {
  return query<UserRow>(
    `SELECT u.id, u.email, p.full_name, p.role
       FROM users u
       JOIN profiles p ON p.id = u.id
      WHERE p.role = 'mentor'
      ORDER BY lower(u.email)`
  )
}

function print(rows: UserRow[], indent = '  '): void {
  if (rows.length === 0) {
    console.log(`${indent}(none)`)
    return
  }
  for (const r of rows) {
    console.log(`${indent}${r.email.padEnd(34)} ${r.full_name ?? '-'} (${r.id})`)
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')

  const before = await currentMentors()
  const doomed = before.filter((m) => !KEEP.includes(m.email.toLowerCase()))

  console.log(`\nMentors currently in the database: ${before.length}`)
  print(before)

  console.log(`\nWill be deleted: ${doomed.length}`)
  print(doomed)

  // An account can exist as a student/admin under a mentor address; it gets
  // promoted rather than duplicated, which the unique index on lower(email)
  // would reject anyway.
  const existing = await query<UserRow>(
    `SELECT u.id, u.email, p.full_name, p.role
       FROM users u
       JOIN profiles p ON p.id = u.id
      WHERE lower(u.email) = ANY($1::text[])`,
    [KEEP]
  )

  console.log('\nWill be created or updated (password reset, role set to mentor):')
  for (const m of MENTORS) {
    const hit = existing.find((e) => e.email.toLowerCase() === m.email.toLowerCase())
    console.log(
      `  ${m.email.padEnd(34)} ${hit ? `exists as '${hit.role}' -> mentor` : 'does not exist -> create'}`
    )
  }

  if (dryRun) {
    console.log('\n--dry-run: nothing was written.\n')
    return
  }

  // Hash outside the transaction: argon2 at these parameters takes ~100ms per
  // call and there is no reason to hold a database transaction open for it.
  const hashes = new Map<string, string>()
  for (const m of MENTORS) hashes.set(m.email, await hashPassword(m.password))

  await transaction(async (client) => {
    for (const m of MENTORS) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, user_metadata, email_confirmed_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (lower(email)) DO UPDATE
           SET password_hash      = EXCLUDED.password_hash,
               email_confirmed_at = COALESCE(users.email_confirmed_at, now()),
               updated_at         = now()
         RETURNING id`,
        [m.email, hashes.get(m.email)!, JSON.stringify({ full_name: m.fullName })]
      )
      const id = rows[0]!.id

      // On insert the on_user_created trigger has already written a student
      // profile; on conflict the profile is whatever it was before.
      await client.query(
        `UPDATE profiles
            SET role = 'mentor', full_name = $2, email = $3, updated_at = now()
          WHERE id = $1`,
        [id, m.fullName, m.email]
      )

      // A password change must not leave old sessions alive.
      await client.query(
        `UPDATE refresh_tokens SET revoked_at = now()
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [id]
      )
    }

    const { rowCount } = await client.query(
      `DELETE FROM users u
        USING profiles p
        WHERE p.id = u.id
          AND p.role = 'mentor'
          AND lower(u.email) <> ALL($1::text[])`,
      [KEEP]
    )
    console.log(`\nDeleted ${rowCount} dummy mentor account(s).`)
  })

  const after = await currentMentors()
  console.log(`\nMentors now in the database: ${after.length}`)
  print(after)
  console.log()
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('Failed:', (err as Error).message)
    await closePool().catch(() => {})
    process.exit(1)
  })
