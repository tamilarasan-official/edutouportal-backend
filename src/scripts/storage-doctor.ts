import { closePool, query } from '../db/pool.js'
import { config } from '../config.js'
import { storage } from '../storage/index.js'

/**
 * Cross-check what the database says exists against what storage actually
 * holds.
 *
 * "File not found" on a resource the portal happily lists means the row and the
 * bytes have diverged. The usual cause is uploads written to a container-local
 * directory: the row survives in Postgres, the file goes with the old container
 * on the next deploy. This prints exactly which rows are affected, so the
 * damage is a list rather than a guess.
 *
 *   docker compose exec backend node dist/scripts/storage-doctor.js
 *
 * Read-only. It changes nothing.
 */

interface Reference {
  table: string
  id: string
  column: string
  url: string
  label: string
}

/** `.../api/storage/<bucket>/<key>` -- from any host, since PUBLIC_URL changes. */
const STORAGE_URL = /\/api\/storage\/([^/?#]+)\/([^?#]+)/

function parseReference(url: string): { bucket: string; key: string } | null {
  const match = STORAGE_URL.exec(url)
  if (!match) return null
  const [, bucket, key] = match
  if (!bucket || !key) return null
  return { bucket: decodeURIComponent(bucket), key: decodeURIComponent(key) }
}

async function collectReferences(): Promise<Reference[]> {
  const references: Reference[] = []

  const resources = await query<{ id: string; file_url: string | null; file_name: string | null }>(
    'SELECT id, file_url, file_name FROM resources WHERE file_url IS NOT NULL'
  )
  for (const row of resources) {
    references.push({
      table: 'resources',
      id: row.id,
      column: 'file_url',
      url: row.file_url!,
      label: row.file_name ?? '(unnamed)',
    })
  }

  const completions = await query<{
    id: string
    file_url: string | null
    file_urls: string[] | null
  }>(
    'SELECT id, file_url, file_urls FROM task_step_completions ' +
      'WHERE file_url IS NOT NULL OR file_urls IS NOT NULL'
  )
  for (const row of completions) {
    if (row.file_url) {
      references.push({
        table: 'task_step_completions',
        id: row.id,
        column: 'file_url',
        url: row.file_url,
        label: 'task submission',
      })
    }
    for (const url of row.file_urls ?? []) {
      references.push({
        table: 'task_step_completions',
        id: row.id,
        column: 'file_urls',
        url,
        label: 'task submission',
      })
    }
  }

  return references
}

async function main(): Promise<void> {
  const driver = storage()
  console.log(`Storage driver : ${driver.name}`)
  console.log(`Target         : ${driver.description}\n`)

  try {
    await driver.ensureReady()
  } catch (err) {
    console.error(`Storage is NOT reachable: ${err instanceof Error ? err.message : err}`)
    process.exitCode = 1
    return
  }

  const references = await collectReferences()
  console.log(`Database references: ${references.length}\n`)

  const missing: Reference[] = []
  const foreign: Reference[] = []
  const present = new Set<string>()

  for (const reference of references) {
    const parsed = parseReference(reference.url)
    if (!parsed) {
      // A leftover Supabase link, or something a user pasted. Not ours to serve.
      foreign.push(reference)
      continue
    }

    const info = await driver.head(parsed.bucket, parsed.key).catch(() => null)
    if (info) present.add(`${parsed.bucket}/${parsed.key}`)
    else missing.push(reference)
  }

  console.log(`Present in storage : ${present.size}`)
  console.log(`MISSING from storage: ${missing.length}`)
  console.log(`Not our URLs        : ${foreign.length}\n`)

  if (missing.length > 0) {
    console.log('Rows whose file is gone:')
    for (const row of missing) {
      console.log(`  ${row.table}.${row.column}  id=${row.id}  ${row.label}`)
      console.log(`    ${row.url}`)
    }
    console.log(
      '\nThese rows point at objects this store does not have. If the API used to\n' +
        'run with STORAGE_DRIVER=disk on an unmounted directory, those uploads were\n' +
        'discarded when the container was replaced and cannot be recovered -- the\n' +
        'files have to be uploaded again. If you have just switched to S3, run\n' +
        '`storage-migrate` first: the bytes may still be on the old volume.\n'
    )
  }

  // Objects with no row pointing at them. Harmless, but they are what a cleanup
  // job would target, and a large count usually means deletes are not wired up.
  let orphans = 0
  for (const bucket of ['resources', 'task-submissions']) {
    const keys = await driver.list(bucket).catch(() => [] as string[])
    for (const key of keys) if (!present.has(`${bucket}/${key}`)) orphans += 1
  }
  console.log(`Objects in storage with no database row: ${orphans}`)

  if (driver.name === 'disk') {
    console.log(
      `\nNote: this deployment stores uploads at ${config.STORAGE_DIR} inside the\n` +
        'container. That only survives a redeploy if the path is a mounted volume.\n' +
        'Set S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY to\n' +
        'store them in object storage instead.'
    )
  }

  if (missing.length > 0) process.exitCode = 1
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(closePool)
