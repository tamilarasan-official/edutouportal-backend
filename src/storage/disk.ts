import { createReadStream } from 'node:fs'
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join, normalize, posix, sep } from 'node:path'
import { config } from '../config.js'
import {
  assertSafeKey,
  type ByteRange,
  type StorageDriver,
  type StoredObjectBody,
  type StoredObjectInfo,
} from './driver.js'

/**
 * Files on a local directory.
 *
 * Correct for development, and for production ONLY when STORAGE_DIR is a
 * mounted volume. On a host that rebuilds the container each deploy an
 * unmounted directory silently discards every upload, which surfaces later as
 * "File not found" on rows the database still lists.
 */
export class DiskDriver implements StorageDriver {
  readonly name = 'disk' as const

  constructor(private readonly root: string = config.STORAGE_DIR) {}

  get description(): string {
    return `local directory ${this.root}`
  }

  private pathFor(bucket: string, key: string): string {
    assertSafeKey(key)
    const base = join(this.root, bucket)
    const target = normalize(join(base, key))

    // normalize() collapses `..`; verify we are still inside the bucket.
    if (!target.startsWith(base + sep) && target !== base) {
      throw new Error('Path escapes bucket')
    }
    return target
  }

  async ensureReady(): Promise<void> {
    await mkdir(this.root, { recursive: true })
  }

  async put(bucket: string, key: string, body: Buffer): Promise<void> {
    const absolute = this.pathFor(bucket, key)
    await mkdir(join(absolute, '..'), { recursive: true })
    await writeFile(absolute, body)
  }

  async head(bucket: string, key: string): Promise<StoredObjectInfo | null> {
    try {
      const info = await stat(this.pathFor(bucket, key))
      if (!info.isFile()) return null
      return { size: info.size, lastModified: info.mtime }
    } catch {
      return null
    }
  }

  async get(bucket: string, key: string, range?: ByteRange): Promise<StoredObjectBody | null> {
    const info = await this.head(bucket, key)
    if (!info) return null

    const absolute = this.pathFor(bucket, key)

    if (range) {
      return {
        ...info,
        range,
        stream: createReadStream(absolute, { start: range.start, end: range.end }),
      }
    }
    return { ...info, stream: createReadStream(absolute) }
  }

  async delete(bucket: string, key: string): Promise<void> {
    try {
      await unlink(this.pathFor(bucket, key))
    } catch {
      // Already gone is the state the caller wanted.
    }
  }

  async list(bucket: string): Promise<string[]> {
    const base = join(this.root, bucket)
    const keys: string[] = []

    const walk = async (dir: string, prefix: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        // Keys are always POSIX-separated, whatever the host filesystem uses.
        const next = prefix ? posix.join(prefix, entry.name) : entry.name
        if (entry.isDirectory()) await walk(join(dir, entry.name), next)
        else if (entry.isFile()) keys.push(next)
      }
    }

    await walk(base, '')
    return keys
  }
}
