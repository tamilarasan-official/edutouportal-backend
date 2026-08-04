import { Router, type NextFunction, type Request, type Response } from 'express'
import multer from 'multer'
import { randomUUID } from 'node:crypto'
import { extname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { config } from '../config.js'
import { requireAuth } from '../middleware/auth.js'
import type { Actor } from '../query/policies.js'
import { assertSafeKey, type ByteRange } from './driver.js'
import { storage } from './index.js'
import {
  DEFAULT_DOWNLOAD_TTL_SECONDS,
  signedDownloadUrl,
  verifyDownloadToken,
} from './signing.js'

export const storageRouter = Router()

/**
 * File storage. Replaces Supabase Storage.
 *
 * Bytes live outside the database -- on a mounted volume or, in production, in
 * object storage -- so the Postgres dump stays small and uploads can be backed
 * up separately. Which of the two is in use is a deployment decision; see
 * storage/driver.ts. The two logical buckets match the ones the frontend used:
 * `task-submissions` and `resources`.
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

/**
 * Types the resource previewer may render inline, mapped from extension.
 *
 * The list is deliberately narrow: every entry is inert in the browsing
 * context. `.svg` and `.html` are absent because both can execute script, and
 * serving them inline from this origin would be a stored-XSS vector -- they are
 * refused at upload for the same reason. Anything not listed downloads as
 * application/octet-stream.
 */
const INLINE_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 10 },
})

/**
 * Parse a single-range `Range` header.
 *
 * Only the simple `bytes=start-end` forms are honoured; anything else -- a
 * multi-range request, a malformed header -- is treated as no range at all,
 * which is a legal response. Video seeking is what needs this: without it a
 * browser re-downloads the whole file on every scrub.
 */
function parseRange(header: unknown, size: number): ByteRange | undefined {
  if (typeof header !== 'string' || size === 0) return undefined

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return undefined

  const [, rawStart, rawEnd] = match
  let start: number
  let end: number

  if (rawStart === '') {
    // `bytes=-500` means the LAST 500 bytes, not the first 500.
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return undefined
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined
  if (start > end || start >= size) return undefined

  return { start, end: Math.min(end, size - 1) }
}

/**
 * Who may read a given key.
 *
 * Shared by the download route and the URL signer so a signed URL can never
 * grant more than a direct request would.
 */
function mayRead(bucketName: BucketName, key: string, actor: Actor): boolean {
  if (BUCKETS[bucketName].visibility !== 'private') return true

  // Private bucket: the first path segment is the owning user's id.
  const ownerId = key.split('/')[0]
  return ownerId === actor.userId || actor.role === 'admin' || actor.role === 'mentor'
}

/**
 * `Content-Disposition` for a download, optionally naming the file.
 *
 * What is on disk is a UUID -- the original name lives in the caller's database
 * row -- so the client may supply one. It is reduced to a bare filename before
 * use: a newline would let a caller append headers of their own, and a slash
 * would suggest a path the response does not have.
 */
function attachmentDisposition(requested: unknown): string {
  if (typeof requested !== 'string') return 'attachment'

  const clean = requested
    .replace(/[\\/]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"]/g, '')
    .trim()
    .slice(0, 120)
  if (!clean) return 'attachment'

  // Two forms: a plain-ASCII fallback for old clients, and the encoded form
  // every current browser prefers.
  const ascii = clean.replace(/[^ -~]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`
}

/**
 * Frame and embedding policy for everything this router returns.
 *
 * helmet sets `X-Frame-Options: SAMEORIGIN` globally, which stops the frontend
 * -- a different host -- from framing a preview at all, and applies to error
 * responses too, so a plain 401 in an iframe surfaces as "Refused to display
 * ... because it set X-Frame-Options" and hides the real cause. X-Frame-Options
 * has no origin-list form, so it is replaced here with CSP `frame-ancestors`,
 * which does have one and still refuses every site that is not ours.
 *
 * `Cross-Origin-Resource-Policy` is widened for the same reason: helmet's
 * `same-site` blocks the frontend from embedding a file when the two are not
 * on one registrable domain. Reads are access-checked on every request, so the
 * header is not what is protecting these bytes.
 */
storageRouter.use((_req: Request, res: Response, next: NextFunction) => {
  res.removeHeader('X-Frame-Options')
  res.setHeader(
    'Content-Security-Policy',
    `frame-ancestors 'self' ${config.corsOrigins.join(' ')}`.trim()
  )
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  next()
})

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
    const key = [...parts, filename].join('/')

    await storage().put(bucketName, key, file.buffer, file.mimetype || 'application/octet-stream')
    const url = `${config.PUBLIC_URL}/api/storage/${bucketName}/${key}`
    // The caller usually wants to show the file straight away, and the raw URL
    // is not fetchable from the browser on its own -- see signing.ts.
    const signed = signedDownloadUrl(bucketName, key, actor)

    res.status(201).json({
      data: {
        path: key,
        bucket: bucketName,
        publicUrl: url,
        signedUrl: signed.url,
        signedUrlExpiresAt: signed.expiresAt,
        size: file.size,
        mimeType: file.mimetype,
        originalName: file.originalname,
      },
    })
  }
)

// ---------------------------------------------------------------------------
// GET /api/storage/sign?bucket=&path=  -- mint a browser-fetchable URL
// ---------------------------------------------------------------------------

/**
 * Registered before `/:bucket/*` so "sign" is not mistaken for a bucket name.
 *
 * Authenticated the ordinary way: the frontend calls this over its proxied,
 * cookie-carrying channel, then gives the returned URL to an <iframe>, <img> or
 * download anchor -- contexts that cannot authenticate themselves.
 */
storageRouter.get('/sign', requireAuth, async (req: Request, res: Response) => {
  const bucketName = String(req.query.bucket ?? '')
  if (!isBucket(bucketName)) {
    res.status(404).json({ error: { message: 'Unknown bucket', code: 'UNKNOWN_BUCKET' } })
    return
  }

  // Accept the key with or without a leading slash, and tolerate a full URL so
  // callers holding a stored `publicUrl` do not have to dissect it first.
  let key = String(req.query.path ?? '').trim()
  const marker = `/api/storage/${bucketName}/`
  const at = key.indexOf(marker)
  if (at !== -1) key = key.slice(at + marker.length)
  key = decodeURIComponent(key.split('?')[0] ?? '').replace(/^\/+/, '')

  if (!key) {
    res.status(400).json({ error: { message: 'path is required', code: 'BAD_REQUEST' } })
    return
  }

  // Reject traversal here rather than handing back a URL that 400s later.
  try {
    assertSafeKey(key)
  } catch {
    res.status(400).json({ error: { message: 'Invalid path', code: 'INVALID_PATH' } })
    return
  }

  const actor = req.actor!
  if (!mayRead(bucketName, key, actor)) {
    res.status(403).json({ error: { message: 'Not your file', code: 'FORBIDDEN' } })
    return
  }

  /**
   * Refuse to sign a key that holds nothing.
   *
   * Signing is pure arithmetic, so without this check a URL is handed back for
   * any key at all and the problem only appears later, as a 404 inside an
   * iframe with no indication of which layer was wrong. It is exactly how a
   * caller that stored a made-up key -- rather than the one the upload response
   * returned -- stayed invisible: the row listed fine and only the preview
   * failed.
   */
  let exists
  try {
    exists = await storage().head(bucketName, key)
  } catch (err) {
    console.error('[storage] head failed while signing', { bucket: bucketName, key, err })
    res.status(503).json({ error: { message: 'Storage is unavailable', code: 'STORAGE_DOWN' } })
    return
  }

  if (!exists) {
    console.warn('[storage] refusing to sign a missing object', {
      bucket: bucketName,
      key,
      driver: storage().description,
    })
    res.status(404).json({
      error: {
        message: 'That file is not in storage. The record may point at a key that was never written.',
        code: 'NOT_FOUND',
      },
    })
    return
  }

  const requested = Number(req.query.expiresIn)
  const { url, expiresAt } = signedDownloadUrl(
    bucketName,
    key,
    actor,
    Number.isFinite(requested) ? requested : DEFAULT_DOWNLOAD_TTL_SECONDS
  )

  res.json({ data: { signedUrl: url, path: key, bucket: bucketName, expiresAt } })
})

// ---------------------------------------------------------------------------
// GET /api/storage/:bucket/*  -- download
// ---------------------------------------------------------------------------

storageRouter.get('/:bucket/*', async (req: Request, res: Response) => {
  const bucketName = req.params.bucket ?? ''
  if (!isBucket(bucketName)) {
    res.status(404).json({ error: { message: 'Unknown bucket', code: 'UNKNOWN_BUCKET' } })
    return
  }

  const key = (req.params as Record<string, string>)[0] ?? ''

  // A signed token stands in for the session when the request comes from a
  // context that cannot carry one. The signature is bound to this bucket and
  // key, so it cannot be pointed at another file.
  const supplied = typeof req.query.token === 'string' ? req.query.token : ''
  const grant = supplied ? verifyDownloadToken(supplied, bucketName, key) : null

  if (supplied && !grant) {
    res.status(401).json({
      error: { message: 'Download link is invalid or has expired', code: 'BAD_TOKEN' },
    })
    return
  }

  const actor: Actor | undefined = grant
    ? { userId: grant.userId, role: grant.role }
    : req.actor

  if (!actor) {
    res.status(401).json({ error: { message: 'Not authenticated', code: 'UNAUTHENTICATED' } })
    return
  }

  // Re-run the check even for a signed request: the signature proves who asked
  // for the link, not that they are still entitled to the file.
  if (!mayRead(bucketName, key, actor)) {
    res.status(403).json({ error: { message: 'Not your file', code: 'FORBIDDEN' } })
    return
  }

  try {
    assertSafeKey(key)
  } catch {
    res.status(400).json({ error: { message: 'Invalid path', code: 'INVALID_PATH' } })
    return
  }

  const driver = storage()

  let info
  try {
    info = await driver.head(bucketName, key)
  } catch (err) {
    // A store that is unreachable is an outage, not a missing file. Reporting
    // 404 here is what makes a broken S3 endpoint look like lost data.
    console.error('[storage] head failed', { bucket: bucketName, key, err })
    res.status(503).json({ error: { message: 'Storage is unavailable', code: 'STORAGE_DOWN' } })
    return
  }

  if (!info) {
    // The row survives but the bytes do not: the usual cause is uploads written
    // to a container-local directory that a later deploy replaced.
    console.warn('[storage] object missing', {
      bucket: bucketName,
      key,
      driver: driver.description,
    })
    res.status(404).json({ error: { message: 'File not found', code: 'NOT_FOUND' } })
    return
  }

  const inlineType = INLINE_TYPES[extname(key).toLowerCase()]
  // `?download=1` turns a previewable file into a save-to-disk response, so
  // one URL serves both the previewer and the download button.
  const forceDownload = req.query.download === '1' || req.query.download === 'true'

  if (inlineType && !forceDownload) {
    // Rendered in the previewer. The type comes from the extension allowlist,
    // never from what the uploader labelled the file: only formats that cannot
    // execute script in this origin are listed -- notably NOT html or svg.
    // Framing is permitted by the router-level policy above.
    res.setHeader('Content-Type', inlineType)
    res.setHeader('Content-Disposition', 'inline')
  } else {
    // Anything unrecognised is downloaded, never rendered.
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Disposition', attachmentDisposition(req.query.filename))
  }

  // Kept in both branches: stops the browser second-guessing the type we set.
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', 'private, max-age=3600')
  // Seeking in a video or a long PDF depends on this being advertised.
  res.setHeader('Accept-Ranges', 'bytes')

  const range = parseRange(req.headers.range, info.size)

  let body
  try {
    body = await driver.get(bucketName, key, range)
  } catch (err) {
    console.error('[storage] read failed', { bucket: bucketName, key, err })
    res.status(503).json({ error: { message: 'Storage is unavailable', code: 'STORAGE_DOWN' } })
    return
  }

  if (!body) {
    res.status(404).json({ error: { message: 'File not found', code: 'NOT_FOUND' } })
    return
  }

  if (range) {
    res.status(206)
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`)
    res.setHeader('Content-Length', String(range.end - range.start + 1))
  } else {
    res.setHeader('Content-Length', String(info.size))
  }

  try {
    await pipeline(body.stream, res)
  } catch (err) {
    // The usual cause is the client closing the tab mid-download. Headers are
    // already sent by this point, so there is nothing to report but the log.
    if (!res.writableEnded) res.destroy()
    console.warn('[storage] download interrupted', { bucket: bucketName, key, err })
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
    await storage().delete(bucketName, key)
    res.json({ data: { success: true } })
  } catch (err) {
    // Deleting something already gone is not an error worth surfacing; a store
    // that refused the call is.
    console.error('[storage] delete failed', { bucket: bucketName, key, err })
    res.status(503).json({ error: { message: 'Storage is unavailable', code: 'STORAGE_DOWN' } })
  }
})

/**
 * Called at boot so a misconfigured volume or unreachable object store fails
 * fast, rather than surfacing on a student's first upload -- by which point the
 * file they submitted is already lost.
 */
export async function ensureStorageReady(): Promise<void> {
  const driver = storage()
  await driver.ensureReady()
  console.log(`[storage] using ${driver.description}`)
}
