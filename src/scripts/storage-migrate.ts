import { config } from '../config.js'
import { DiskDriver } from '../storage/disk.js'
import { storage } from '../storage/index.js'
import type { StorageDriver } from '../storage/driver.js'

/**
 * Copy every upload from the local volume into the configured object store.
 *
 * Run once when switching STORAGE_DRIVER from disk to s3, BEFORE retiring the
 * volume -- the database keys stay identical, so nothing else has to change and
 * links that already work keep working:
 *
 *   docker compose exec backend node dist/scripts/storage-migrate.js
 *
 * Idempotent: an object already present at the destination is skipped, so an
 * interrupted run can simply be repeated. Nothing is deleted from the source.
 */

const BUCKETS = ['resources', 'task-submissions'] as const

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

async function main(): Promise<void> {
  const destination: StorageDriver = storage()

  if (destination.name === 'disk') {
    console.error(
      'The active storage driver is still "disk", so there is nowhere to migrate to.\n' +
        'Set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY first.'
    )
    process.exitCode = 1
    return
  }

  // The source is the volume this deployment used to write to. `--from` allows
  // pointing at a mount that has been moved aside.
  const fromIndex = process.argv.indexOf('--from')
  const sourceDir = fromIndex !== -1 ? process.argv[fromIndex + 1] : config.STORAGE_DIR
  if (!sourceDir) {
    console.error('--from was given without a directory')
    process.exitCode = 1
    return
  }

  const source = new DiskDriver(sourceDir)

  console.log(`From : ${source.description}`)
  console.log(`To   : ${destination.description}\n`)

  await destination.ensureReady()

  let copied = 0
  let skipped = 0
  let failed = 0
  let bytes = 0

  for (const bucket of BUCKETS) {
    const keys = await source.list(bucket)
    console.log(`${bucket}: ${keys.length} file(s) on the volume`)

    for (const key of keys) {
      try {
        if (await destination.head(bucket, key)) {
          skipped += 1
          continue
        }

        const object = await source.get(bucket, key)
        if (!object) {
          // Vanished between listing and reading. Nothing to copy.
          skipped += 1
          continue
        }

        const chunks: Buffer[] = []
        for await (const chunk of object.stream) chunks.push(chunk as Buffer)
        const body = Buffer.concat(chunks)

        // The extension is the only type information the volume kept; the
        // download route decides what to serve from it anyway.
        await destination.put(bucket, key, body, 'application/octet-stream')

        copied += 1
        bytes += body.byteLength
        if (copied % 25 === 0) console.log(`  ... ${copied} copied`)
      } catch (err) {
        failed += 1
        console.error(`  FAILED ${bucket}/${key}: ${err instanceof Error ? err.message : err}`)
      }
    }
  }

  console.log(
    `\nCopied ${copied} (${formatBytes(bytes)}), skipped ${skipped} already present, ` +
      `${failed} failed.`
  )
  console.log(
    'Nothing was removed from the volume. Verify with `storage-doctor`, then keep\n' +
      'the volume as a backup for a while before deleting it.'
  )

  if (failed > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
