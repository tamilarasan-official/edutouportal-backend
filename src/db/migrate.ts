import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pool, closePool } from './pool.js'

/**
 * Minimal forward-only migration runner.
 *
 * Applies every .sql file in ./migrations in filename order, exactly once,
 * each inside its own transaction. Records what it applied in schema_migrations
 * along with a checksum, so an edited file that was already applied is a hard
 * error rather than a silent divergence between environments.
 */

const here = dirname(fileURLToPath(import.meta.url))
// src/db -> backend/migrations  (and dist/db -> backend/migrations)
const MIGRATIONS_DIR = join(here, '..', '..', 'migrations')

async function checksum(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Buffer.from(digest).toString('hex')
}

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `)
}

export async function runMigrations(): Promise<void> {
  await ensureMigrationsTable()

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()

  const { rows: applied } = await pool.query<{ name: string; checksum: string }>(
    'SELECT name, checksum FROM schema_migrations'
  )
  const appliedByName = new Map(applied.map((r) => [r.name, r.checksum]))

  let ran = 0

  for (const file of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8')
    const sum = await checksum(sql)
    const previous = appliedByName.get(file)

    if (previous !== undefined) {
      if (previous !== sum) {
        throw new Error(
          `Migration ${file} was already applied but its contents have changed.\n` +
            `Applied migrations are immutable -- add a new migration instead of editing this one.`
        )
      }
      continue
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
        file,
        sum,
      ])
      await client.query('COMMIT')
      console.log(`[migrate] applied ${file}`)
      ran += 1
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err })
    } finally {
      client.release()
    }
  }

  console.log(
    ran === 0 ? '[migrate] already up to date' : `[migrate] applied ${ran} migration(s)`
  )
}

// Allow running standalone: `npm run migrate`
const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]

if (invokedDirectly) {
  runMigrations()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error('[migrate] failed:', err)
      await closePool().catch(() => {})
      process.exit(1)
    })
}
