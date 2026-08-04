import type { Readable } from 'node:stream'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { config } from '../config.js'
import {
  assertSafeKey,
  type ByteRange,
  type StorageDriver,
  type StoredObjectBody,
  type StoredObjectInfo,
} from './driver.js'

/**
 * Files in an S3-compatible object store. Production runs Garage.
 *
 * Every logical bucket lives inside ONE real bucket under a key prefix
 * (`resources/…`, `task-submissions/…`). Creating buckets requires
 * administrative credentials, and an application key that can create and delete
 * buckets is a much larger blast radius than one that can only read and write
 * objects in a bucket someone else provisioned.
 *
 * Garage-specific notes, all handled by configuration rather than code paths:
 *   - path-style addressing is required unless wildcard DNS points at it, hence
 *     S3_FORCE_PATH_STYLE defaulting to true
 *   - the region is whatever garage.toml calls it, conventionally "garage"
 *   - objects are private; nothing here sets an ACL, and reads go through this
 *     API so the access checks and signed URLs still apply
 */
export class S3Driver implements StorageDriver {
  readonly name = 's3' as const

  private readonly client: S3Client
  private readonly bucket: string

  constructor(
    options: {
      endpoint?: string
      region?: string
      bucket?: string
      accessKeyId?: string
      secretAccessKey?: string
      forcePathStyle?: boolean
    } = {}
  ) {
    const endpoint = options.endpoint ?? config.S3_ENDPOINT
    const bucket = options.bucket ?? config.S3_BUCKET
    const accessKeyId = options.accessKeyId ?? config.S3_ACCESS_KEY_ID
    const secretAccessKey = options.secretAccessKey ?? config.S3_SECRET_ACCESS_KEY

    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
      throw new Error('S3 storage is missing endpoint, bucket, or credentials')
    }

    this.bucket = bucket
    this.client = new S3Client({
      endpoint,
      region: options.region ?? config.S3_REGION,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: options.forcePathStyle ?? config.S3_FORCE_PATH_STYLE,

      /**
       * The SDK's newer flexible-checksum behaviour has to be turned off for
       * third-party stores.
       *
       * On a ranged GET, Garage returns the checksum of the WHOLE object while
       * the body is only the requested slice; the SDK compares the two and
       * throws "Checksum mismatch", so every range request fails -- which is
       * every video seek and, in some viewers, every PDF open. On the request
       * side, aws-chunked trailer checksums are equally a source of 400s from
       * non-AWS implementations. WHEN_REQUIRED keeps checksums for the
       * operations that mandate them and leaves the rest alone; the transport
       * is HTTPS or a private network either way.
       */
      responseChecksumValidation: 'WHEN_REQUIRED',
      requestChecksumCalculation: 'WHEN_REQUIRED',
    })
  }

  get description(): string {
    return `S3 bucket ${this.bucket} at ${config.S3_ENDPOINT}`
  }

  private objectKey(bucket: string, key: string): string {
    assertSafeKey(key)
    return `${bucket}/${key}`
  }

  /**
   * A misconfigured endpoint, a wrong key, or a bucket the key cannot reach are
   * all worth crashing at boot for. Discovering any of them on a student's
   * first upload means the submission is simply lost.
   */
  async ensureReady(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }))
    } catch (err) {
      throw new Error(
        `Cannot reach S3 bucket "${this.bucket}" at ${config.S3_ENDPOINT}: ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          `Check S3_ENDPOINT, S3_BUCKET, the access key's permissions on that bucket, ` +
          `and that S3_REGION matches the store's configured region.`
      )
    }
  }

  async put(bucket: string, key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.objectKey(bucket, key),
        Body: body,
        ContentType: contentType,
        ContentLength: body.byteLength,
      })
    )
  }

  async head(bucket: string, key: string): Promise<StoredObjectInfo | null> {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.objectKey(bucket, key) })
      )
      return {
        size: res.ContentLength ?? 0,
        contentType: res.ContentType,
        lastModified: res.LastModified,
      }
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }

  async get(bucket: string, key: string, range?: ByteRange): Promise<StoredObjectBody | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.objectKey(bucket, key),
          ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
        })
      )

      // ContentRange looks like `bytes 0-99/1234`; the total is what callers
      // need for Content-Length accounting, not the length of this slice.
      const total = range
        ? Number(res.ContentRange?.split('/')[1] ?? res.ContentLength ?? 0)
        : (res.ContentLength ?? 0)

      return {
        size: total,
        contentType: res.ContentType,
        lastModified: res.LastModified,
        stream: res.Body as Readable,
        ...(range ? { range } : {}),
      }
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }

  async delete(bucket: string, key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: this.objectKey(bucket, key) })
      )
    } catch (err) {
      if (!isNotFound(err)) throw err
    }
  }

  async list(bucket: string): Promise<string[]> {
    const prefix = `${bucket}/`
    const keys: string[] = []
    let token: string | undefined

    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        })
      )
      for (const object of res.Contents ?? []) {
        if (object.Key) keys.push(object.Key.slice(prefix.length))
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined
    } while (token)

    return keys
  }
}

/**
 * A missing object is a normal outcome, not a fault.
 *
 * HeadObject reports it as a bare 404 with no error code, while GetObject sends
 * NoSuchKey -- so both shapes have to be recognised or a missing file would
 * surface as a 500.
 */
function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } }
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404
}
