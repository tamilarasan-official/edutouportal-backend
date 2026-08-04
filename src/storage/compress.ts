import sharp from 'sharp'
import { extname } from 'node:path'
import { config } from '../config.js'

/**
 * Shrink uploads before they are stored.
 *
 * With a cohort submitting phone photos and screenshots, what arrives is
 * typically a 3-8 MB JPEG straight off a camera sensor -- several times larger
 * than anything the portal ever displays. Re-encoding to WebP at a sane
 * resolution routinely removes 85-95% of that, which is the difference between
 * the object store filling in weeks and filling in years.
 *
 * This runs on the SERVER, so it cannot be bypassed. The browser compresses too
 * (see the portal's lib/compress-image.ts), which is what saves a student on
 * mobile data from uploading the full 8 MB in the first place -- but a client
 * is a convenience, never a guarantee: anyone can POST straight at this API.
 *
 * Three rules keep it safe to apply blindly:
 *
 *   1. Only images are touched. Everything else is stored byte-for-byte.
 *   2. If the re-encode is not smaller, the ORIGINAL is kept. Compression can
 *      inflate a file that is already optimal, and storing the larger one would
 *      be a loss on both counts.
 *   3. Any failure falls back to the original. A format libvips cannot decode
 *      -- an unusual HEIC, a corrupt file -- must not cost a student their
 *      submission.
 */

export interface CompressionOutcome {
  /** What to store. The original buffer when nothing was gained. */
  buffer: Buffer
  /** Extension for the storage key, with the dot. May differ from the upload's. */
  extension: string
  /** True when a re-encode was stored. */
  applied: boolean
  originalBytes: number
  storedBytes: number
  /** Populated when the original was kept, for the log line. */
  reason?: string
  width?: number
  height?: number
}

/**
 * Formats worth re-encoding. SVG is deliberately absent -- it is refused at
 * upload because it can carry script -- and so is PDF, which needs its embedded
 * images re-encoded to gain anything and risks corrupting documents that
 * students cannot re-create.
 */
const COMPRESSIBLE = new Set(['jpeg', 'jpg', 'png', 'webp', 'gif', 'tiff', 'heif', 'avif'])

/**
 * Above this, a PNG is treated as a photograph and encoded lossy.
 *
 * Screenshots and diagrams are where lossless matters: text and flat colour
 * turn to mush under a lossy encoder at any quality a person would choose.
 * Those are small in pixel terms. A 12-megapixel PNG is a camera photo whose
 * lossless WebP would be larger than the JPEG it came from.
 */
const PHOTO_PIXEL_THRESHOLD = 4_000_000

/**
 * Cap on concurrent re-encodes.
 *
 * Each one holds a decoded bitmap in memory -- a 12 MP image is ~48 MB as raw
 * pixels -- so a burst of submissions at a deadline could otherwise exhaust a
 * small container's memory. Requests queue here instead of dying together.
 */
class Semaphore {
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1
      return
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.active += 1
  }

  release(): void {
    this.active -= 1
    this.waiting.shift()?.()
  }
}

const gate = new Semaphore(config.IMAGE_COMPRESS_CONCURRENCY)

// libvips spawns a thread pool per operation. Left alone it will happily use
// every core for one image, which on a shared box starves the request loop.
sharp.concurrency(1)

function keep(
  buffer: Buffer,
  originalName: string,
  reason: string,
  extra: Partial<CompressionOutcome> = {}
): CompressionOutcome {
  return {
    buffer,
    extension: extname(originalName).toLowerCase(),
    applied: false,
    originalBytes: buffer.byteLength,
    storedBytes: buffer.byteLength,
    reason,
    ...extra,
  }
}

export async function compressUpload(
  input: Buffer,
  originalName: string
): Promise<CompressionOutcome> {
  if (!config.IMAGE_COMPRESSION) return keep(input, originalName, 'compression disabled')

  // The format is sniffed from the bytes, never taken from the upload's
  // extension or content-type -- both are attacker-controlled.
  let probe
  try {
    probe = await sharp(input, { failOn: 'error' }).metadata()
  } catch {
    return keep(input, originalName, 'not a decodable image')
  }

  const format = probe.format ?? ''
  if (!COMPRESSIBLE.has(format)) return keep(input, originalName, `format ${format || 'unknown'}`)

  const width = probe.width ?? 0
  const height = probe.height ?? 0
  if (width === 0 || height === 0) return keep(input, originalName, 'no dimensions')

  const animated = (probe.pages ?? 1) > 1
  const longestEdge = Math.max(width, height)
  const needsResize = longestEdge > config.IMAGE_MAX_DIMENSION

  /**
   * WebP that already fits is left exactly as it is.
   *
   * It is the format this pipeline targets, so re-encoding could only lose
   * quality -- and a lossy WebP put through a lossless encoder comes out
   * *larger*, while a lossless one put through a lossy encoder quietly
   * degrades every screenshot that passes through twice. Re-uploading a file
   * that came from here must be a no-op.
   */
  if (format === 'webp' && !needsResize) {
    return keep(input, originalName, 'already WebP within the size cap', { width, height })
  }

  await gate.acquire()
  try {
    const pipeline = sharp(input, {
      // Animation survives the round trip instead of collapsing to frame one.
      animated,
      failOn: 'error',
    })
      // EXIF orientation is applied to the pixels, because the metadata that
      // described it is about to be dropped -- otherwise sideways phone photos.
      .rotate()

    if (needsResize) {
      pipeline.resize({
        width: width >= height ? config.IMAGE_MAX_DIMENSION : undefined,
        height: height > width ? config.IMAGE_MAX_DIMENSION : undefined,
        // Never enlarge: a small screenshot must not be blown up to the cap.
        withoutEnlargement: true,
        fit: 'inside',
      })
    }

    // Flat colour and text must stay crisp; photographs must stay small.
    // libvips reports AVIF as "heif" -- both are camera formats either way.
    const photographic =
      format === 'jpeg' || format === 'heif' || width * height > PHOTO_PIXEL_THRESHOLD

    const encoded = await pipeline
      .webp(
        photographic
          ? { quality: config.IMAGE_QUALITY, effort: 4, smartSubsample: true }
          : { lossless: true, effort: 4 }
      )
      // Strips EXIF: smaller, and a phone photo no longer carries the GPS
      // coordinates of the student's home into shared storage.
      .toBuffer({ resolveWithObject: true })

    if (encoded.data.byteLength >= input.byteLength) {
      return keep(input, originalName, 'already smaller than a re-encode', {
        width,
        height,
      })
    }

    return {
      buffer: encoded.data,
      extension: '.webp',
      applied: true,
      originalBytes: input.byteLength,
      storedBytes: encoded.data.byteLength,
      width: encoded.info.width,
      height: encoded.info.height,
    }
  } catch (err) {
    // Never let a compression fault cost the upload.
    console.warn('[compress] falling back to the original', {
      name: originalName,
      format,
      err: err instanceof Error ? err.message : err,
    })
    return keep(input, originalName, 'compression failed')
  } finally {
    gate.release()
  }
}

/** `2.4 MB -> 180 KB (92% smaller)`, for the upload log line. */
export function describeSaving(outcome: CompressionOutcome): string {
  const format = (bytes: number): string =>
    bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

  if (!outcome.applied) return `${format(outcome.originalBytes)} stored as-is (${outcome.reason})`

  const saved = Math.round((1 - outcome.storedBytes / outcome.originalBytes) * 100)
  return `${format(outcome.originalBytes)} -> ${format(outcome.storedBytes)} (${saved}% smaller)`
}
