import { closePool, query } from '../db/pool.js'
import { storage } from '../storage/index.js'

/**
 * Reunite rows with the files they lost track of.
 *
 * The resources uploader used to build `file_url` from a filename it invented
 * client-side, ignoring the key the API returned. The bytes were stored
 * correctly under the server's key -- `<uploader>/misc/misc/<millis>-<uuid>.<ext>`
 * -- while the row pointed at something like `1764930000000_a1b2c3.jpeg`, which
 * was never written. The portal listed those resources happily and only the
 * preview failed, with "File not found".
 *
 * Nothing was actually lost, so this matches the orphaned objects back to the
 * broken rows and rewrites `file_url`. Both halves carry a millisecond
 * timestamp from the same upload, so pairing on uploader + extension + nearest
 * time is unambiguous in practice.
 *
 *   node dist/scripts/storage-repair.js           # report only
 *   node dist/scripts/storage-repair.js --apply   # rewrite the rows
 *
 * Safe to re-run: rows whose file already resolves are left alone.
 */

const APPLY = process.argv.includes('--apply')

/** Objects uploaded more than this far from the row's timestamp are not paired. */
const MATCH_WINDOW_MS = 15 * 60 * 1000

const STORAGE_URL = /\/api\/storage\/([^/?#]+)\/([^?#]+)/

interface BrokenRow {
  table: 'resources' | 'task_step_completions'
  id: string
  url: string
  key: string
  bucket: string
  owner: string
  createdAt: Date
  label: string
}

function parse(url: string): { bucket: string; key: string } | null {
  const match = STORAGE_URL.exec(url)
  if (!match?.[1] || !match[2]) return null
  return { bucket: decodeURIComponent(match[1]), key: decodeURIComponent(match[2]) }
}

/** Both key formats lead with milliseconds; that is what pairs them. */
function timestampIn(key: string): number | null {
  const name = key.split('/').pop() ?? ''
  const match = /(\d{13})/.exec(name)
  return match?.[1] ? Number(match[1]) : null
}

function extensionOf(key: string): string {
  const name = key.split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot).toLowerCase()
}

async function findBrokenRows(): Promise<BrokenRow[]> {
  const driver = storage()
  const broken: BrokenRow[] = []

  const resources = await query<{
    id: string
    file_url: string
    file_name: string | null
    uploaded_by: string
    created_at: Date
  }>(
    'SELECT id, file_url, file_name, uploaded_by, created_at FROM resources WHERE file_url IS NOT NULL'
  )

  for (const row of resources) {
    const parsed = parse(row.file_url)
    if (!parsed) continue
    if (await driver.head(parsed.bucket, parsed.key).catch(() => null)) continue

    broken.push({
      table: 'resources',
      id: row.id,
      url: row.file_url,
      key: parsed.key,
      bucket: parsed.bucket,
      owner: row.uploaded_by,
      createdAt: row.created_at,
      label: row.file_name ?? '(unnamed)',
    })
  }

  const completions = await query<{
    id: string
    file_url: string
    student_id: string
    created_at: Date
  }>(
    `SELECT c.id, c.file_url, a.student_id, c.created_at
       FROM task_step_completions c
       JOIN task_assignments a ON a.id = c.assignment_id
      WHERE c.file_url IS NOT NULL`
  )

  for (const row of completions) {
    const parsed = parse(row.file_url)
    if (!parsed) continue
    if (await driver.head(parsed.bucket, parsed.key).catch(() => null)) continue

    broken.push({
      table: 'task_step_completions',
      id: row.id,
      url: row.file_url,
      key: parsed.key,
      bucket: parsed.bucket,
      owner: row.student_id,
      createdAt: row.created_at,
      label: 'task submission',
    })
  }

  return broken
}

async function main(): Promise<void> {
  const driver = storage()
  console.log(`Storage: ${driver.description}`)
  console.log(APPLY ? 'Mode   : APPLY (rows will be rewritten)\n' : 'Mode   : dry run\n')

  await driver.ensureReady()

  const broken = await findBrokenRows()
  console.log(`Rows whose file does not resolve: ${broken.length}\n`)
  if (broken.length === 0) return

  // Every object the rows do NOT already account for, per bucket.
  const claimed = new Set<string>()
  const objects = new Map<string, string[]>()
  for (const bucket of new Set(broken.map((row) => row.bucket))) {
    objects.set(bucket, await driver.list(bucket))
  }

  let repaired = 0
  let unmatched = 0

  for (const row of broken) {
    const candidates = (objects.get(row.bucket) ?? []).filter((key) => {
      if (claimed.has(`${row.bucket}/${key}`)) return false
      // The server key always starts with the uploader's id.
      if (!key.startsWith(`${row.owner}/`)) return false
      return extensionOf(key) === extensionOf(row.key)
    })

    // The row's own key carries the client-side timestamp; fall back to when
    // the row was written, which is within a second or two of the upload.
    const target = timestampIn(row.key) ?? row.createdAt.getTime()

    let best: { key: string; distance: number } | undefined
    for (const key of candidates) {
      const stamp = timestampIn(key)
      if (stamp === null) continue
      const distance = Math.abs(stamp - target)
      if (distance <= MATCH_WINDOW_MS && (!best || distance < best.distance)) {
        best = { key, distance }
      }
    }

    if (!best) {
      unmatched += 1
      console.log(`  NO MATCH  ${row.table} ${row.id}  ${row.label}`)
      console.log(`            ${row.url}`)
      continue
    }

    claimed.add(`${row.bucket}/${best.key}`)
    // Rebuild the URL from the row's own origin so a deployment that has moved
    // hosts is not silently rewritten to a different one here.
    const repairedUrl = row.url.replace(
      `/api/storage/${row.bucket}/${row.key}`,
      `/api/storage/${row.bucket}/${best.key}`
    )

    console.log(`  MATCH     ${row.table} ${row.id}  ${row.label}  (${best.distance} ms apart)`)
    console.log(`            -> ${best.key}`)

    if (APPLY) {
      await query(`UPDATE ${row.table} SET file_url = $1 WHERE id = $2`, [repairedUrl, row.id])
    }
    repaired += 1
  }

  console.log(
    `\n${APPLY ? 'Repaired' : 'Would repair'} ${repaired} row(s); ${unmatched} without a match.`
  )
  if (!APPLY && repaired > 0) console.log('Re-run with --apply to write these changes.')
  if (unmatched > 0) {
    console.log(
      'Rows without a match have no object under that uploader with the same\n' +
        'extension and a nearby timestamp. If the API ever ran on an unmounted\n' +
        'volume, those uploads are genuinely gone and must be re-submitted.'
    )
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(closePool)
