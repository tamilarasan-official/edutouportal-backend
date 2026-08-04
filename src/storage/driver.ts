import type { Readable } from 'node:stream'

/**
 * Where uploaded bytes live.
 *
 * Two implementations sit behind this: a local directory, and any S3-compatible
 * object store (Garage is what production runs). The routes never learn which
 * one is in play, so switching is an environment change rather than a code
 * change -- and the access checks, signed URLs and inline/attachment rules stay
 * in exactly one place regardless of where the bytes are.
 *
 * `bucket` here is the logical bucket the API exposes (`resources`,
 * `task-submissions`), NOT an S3 bucket. The S3 driver keeps every logical
 * bucket inside one real bucket under a key prefix, because creating buckets
 * needs administrative credentials that an application should not hold.
 */

export interface StoredObjectInfo {
  /** Bytes in the whole object, regardless of any range requested. */
  size: number
  /** As recorded at upload. Advisory: what is SERVED is decided from the extension. */
  contentType?: string
  lastModified?: Date
}

export interface ByteRange {
  start: number
  /** Inclusive, as in the HTTP Range header. */
  end: number
}

export interface StoredObjectBody extends StoredObjectInfo {
  stream: Readable
  /** Present when the driver honoured a range request. */
  range?: ByteRange
}

export interface StorageDriver {
  readonly name: 'disk' | 's3'
  /** Human-readable target, for logs and the doctor script. */
  readonly description: string

  /** Fails fast at boot if the destination is unusable. */
  ensureReady(): Promise<void>

  put(bucket: string, key: string, body: Buffer, contentType: string): Promise<void>

  /** Null when the object does not exist. */
  head(bucket: string, key: string): Promise<StoredObjectInfo | null>

  /** Null when the object does not exist. */
  get(bucket: string, key: string, range?: ByteRange): Promise<StoredObjectBody | null>

  /** Deleting something already gone is not an error. */
  delete(bucket: string, key: string): Promise<void>

  /** Every key under a logical bucket. Used by the migration and doctor scripts. */
  list(bucket: string): Promise<string[]>
}

/**
 * Reject keys that could escape their bucket before any driver sees them.
 *
 * The disk driver needs this to stay inside its directory; the S3 driver does
 * not strictly need it, but a key containing `..` would still produce objects
 * the disk driver could never serve, so both are held to one rule.
 */
export function assertSafeKey(key: string): void {
  if (!key || key.startsWith('/') || key.includes('\\')) {
    throw new Error('Invalid storage key')
  }
  for (const segment of key.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error('Invalid storage key')
    }
  }
}
