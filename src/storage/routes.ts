import { Router, type Request, type Response } from 'express'
import multer from 'multer'
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { config } from '../config.js'
import { requireAuth } from '../middleware/auth.js'

export const storageRouter = Router()

/**
 * File storage. Replaces Supabase Storage.
 *
 * Files live on a mounted volume rather than in the database, so the Postgres
 * dump stays small and the volume can be backed up separately. The two buckets
 * match the ones the frontend used: `task-submissions` and `resources`.
 */

const BUCKETS = {
  'task-submissions': {
    // Only the owning student, their mentor, or staff may download.
    visibility: 'private' as const,
    maxBytes: config.MAX_UPLOAD_BYTES,
  },
  resources: {
    // Shared learning material; any signed-in user may download.
    visibility: 'authenticated' as const,
    maxBytes: config.MAX_UPLOAD_BYTES,
  },
} as const

type BucketName = keyof typeof BUCKETS

function isBucket(name: string): name is BucketName {
  return Object.prototype.hasOwnProperty.call(BUCKETS, name)
}

/**
 * Extensions we refuse outright. Serving one of these back from our own origin
 * would let an uploader run script in the context of the app.
 */
const BLOCKED_EXTENSIONS = new Set([
  '.html', '.htm', '.xhtml', '.svg', '.js', '.mjs', '.cjs', '.php', '.phtml',
  '.exe', '.dll', '.bat', '.cmd', '.sh', '.jar', '.msi', '.com', '.scr',
])

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 10 },
})

/**
 * Build a storage path that cannot escape the bucket directory.
 *
 * The client never supplies the filename that lands on disk -- we generate a
 * UUID and keep only the (validated) extension. That removes path traversal,
 * collisions, and any question of what a "safe" filename is.
 */
function resolveStoragePath(bucket: BucketName, relative: string): string {
  const base = join(config.STORAGE_DIR, bucket)
  const target = normalize(join(base, relative))

  // normalize() collapses `..`; verify we are still inside the bucket.
  if (!target.startsWith(base + sep) && target !== base) {
    throw new Error('Path escapes bucket')
  }
  return target
}

// ---------------------------------------------------------------------------
// POST /api/storage/:bucket
// ---------------------------------------------------------------------------

storageRouter.post(
  '/:bucket',
  requireAuth,
  upload.single('file'),
  async (req: Request, res: Response) => {
    const bucketName = req.params.bucket ?? ''
    if (!isBucket(bucketName)) {
      res.status(404).json({ error: { message: 'Unknown bucket', code: 'UNKNOWN_BUCKET' } })
      return
    }

    const actor = req.actor!
    const bucket = BUCKETS[bucketName]

    // Only staff may publish shared resources.
    if (bucketName === 'resources' && actor.role !== 'mentor' && actor.role !== 'admin') {
      res.status(403).json({ error: { message: 'Mentors only', code: 'FORBIDDEN' } })
      return
    }

    const file = req.file
    if (!file) {
      res.status(400).json({ error: { message: 'No file supplied', code: 'NO_FILE' } })
      return
    }

    if (file.size > bucket.maxBytes) {
      res.status(413).json({ error: { message: 'File is too large', code: 'TOO_LARGE' } })
      return
    }

    const extension = extname(file.originalname).toLowerCase()
    if (BLOCKED_EXTENSIONS.has(extension)) {
      res.status(415).json({
        error: { message: `Files of type ${extension} are not accepted`, code: 'BLOCKED_TYPE' },
      })
      return
    }

    // Layout mirrors the old Supabase key: <userId>/<taskId>/<stepId>/<file>.
    // Anything the client sends for these segments is coerced to a safe token.
    const segment = (value: unknown): string =>
      String(value ?? 'misc').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'misc'

    const parts = [
      actor.userId,
      segment(req.body?.taskId),
      segment(req.body?.stepId),
    ]
    const filename = `${Date.now()}-${randomUUID()}${extension}`
    const relative = join(...parts, filename)
    const absolute = resolveStoragePath(bucketName, relative)

    await mkdir(join(absolute, '..'), { recursive: true })
    await writeFile(absolute, file.buffer)

    const key = parts.join('/') + '/' + filename
    const url = `${config.PUBLIC_URL}/api/storage/${bucketName}/${key}`

    res.status(201).json({
      data: {
        path: key,
        bucket: bucketName,
        publicUrl: url,
        size: file.size,
        mimeType: file.mimetype,
        originalName: file.originalname,
      },
    })
  }
)

// ---------------------------------------------------------------------------
// GET /api/storage/:bucket/*  -- download
// ---------------------------------------------------------------------------

storageRouter.get('/:bucket/*', requireAuth, async (req: Request, res: Response) => {
  const bucketName = req.params.bucket ?? ''
  if (!isBucket(bucketName)) {
    res.status(404).json({ error: { message: 'Unknown bucket', code: 'UNKNOWN_BUCKET' } })
    return
  }

  const actor = req.actor!
  const key = (req.params as Record<string, string>)[0] ?? ''
  const bucket = BUCKETS[bucketName]

  // Private bucket: the first path segment is the owning user's id.
  if (bucket.visibility === 'private') {
    const ownerId = key.split('/')[0]
    const isOwner = ownerId === actor.userId
    const isStaff = actor.role === 'admin' || actor.role === 'mentor'
    if (!isOwner && !isStaff) {
      res.status(403).json({ error: { message: 'Not your file', code: 'FORBIDDEN' } })
      return
    }
  }

  let absolute: string
  try {
    absolute = resolveStoragePath(bucketName, key)
  } catch {
    res.status(400).json({ error: { message: 'Invalid path', code: 'INVALID_PATH' } })
    return
  }

  try {
    const info = await stat(absolute)
    if (!info.isFile()) throw new Error('not a file')

    // Never let the browser decide to render an upload inline.
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Disposition', 'attachment')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Length', String(info.size))
    res.setHeader('Cache-Control', 'private, max-age=3600')

    createReadStream(absolute).pipe(res)
  } catch {
    res.status(404).json({ error: { message: 'File not found', code: 'NOT_FOUND' } })
  }
})

// ---------------------------------------------------------------------------
// DELETE /api/storage/:bucket/*
// ---------------------------------------------------------------------------

storageRouter.delete('/:bucket/*', requireAuth, async (req: Request, res: Response) => {
  const bucketName = req.params.bucket ?? ''
  if (!isBucket(bucketName)) {
    res.status(404).json({ error: { message: 'Unknown bucket', code: 'UNKNOWN_BUCKET' } })
    return
  }

  const actor = req.actor!
  const key = (req.params as Record<string, string>)[0] ?? ''
  const ownerId = key.split('/')[0]

  if (ownerId !== actor.userId && actor.role !== 'admin') {
    res.status(403).json({ error: { message: 'Not your file', code: 'FORBIDDEN' } })
    return
  }

  try {
    await unlink(resolveStoragePath(bucketName, key))
    res.json({ data: { success: true } })
  } catch {
    // Deleting something that is already gone is not an error worth surfacing.
    res.json({ data: { success: true } })
  }
})

/** Called at boot so a misconfigured volume fails fast rather than on first upload. */
export async function ensureStorageDirs(): Promise<void> {
  for (const bucket of Object.keys(BUCKETS)) {
    await mkdir(join(config.STORAGE_DIR, bucket), { recursive: true })
  }
}
