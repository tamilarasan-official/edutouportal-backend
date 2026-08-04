import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import sharp from 'sharp'
import { config } from '../src/config.js'
import { compressUpload } from '../src/storage/compress.js'
import { createUser, startTestServer, stopTestServer, truncateAll } from './helpers.js'

/**
 * Upload compression.
 *
 * The fixtures are generated rather than committed, so the assertions are about
 * real encoder behaviour on real pixels -- a stub would prove only that the
 * code calls the functions it calls.
 */

let base: string

before(async () => {
  base = await startTestServer()
})

after(async () => {
  await stopTestServer()
  await rm(config.STORAGE_DIR, { recursive: true, force: true })
})

beforeEach(truncateAll)

/**
 * A photograph-like JPEG: smooth gradients plus noise, which is what a camera
 * produces and what a flat test colour would not exercise.
 */
async function photoJpeg(width = 3000, height = 2000): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3
      pixels[i] = (x * 255) / width
      pixels[i + 1] = (y * 255) / height
      pixels[i + 2] = ((x + y) % 97) * 2
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 95 })
    .toBuffer()
}

/**
 * Build a real multi-frame animated GIF.
 *
 * sharp cannot assemble a multi-page image from a plain buffer, and an
 * animation faked some other way would not prove the decoder handles a genuine
 * one. So the file is written byte by byte to the GIF89a spec.
 *
 * The pixel data uses a legal shortcut: emitting a CLEAR code before every
 * pixel stops the LZW dictionary ever growing, which pins the code width at
 * three bits and removes the need for a real compressor here. It is
 * deliberately inefficient, which also makes the fixture large enough that
 * re-encoding it is a genuine saving rather than a rounding error.
 */
function animatedGif(width: number, height: number, frames: number[][]): Buffer {
  const bytes: number[] = [
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // "GIF89a"
    width & 0xff, width >> 8,
    height & 0xff, height >> 8,
    0x80, 0x00, 0x00, // global colour table, two entries
    0xff, 0xff, 0xff, // white
    0x00, 0x00, 0x00, // black
  ]

  for (const indices of frames) {
    // Graphic control extension: 100 ms, no transparency.
    bytes.push(0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00)
    // Image descriptor at the origin, full size, no local table.
    bytes.push(0x2c, 0x00, 0x00, 0x00, 0x00, width & 0xff, width >> 8, height & 0xff, height >> 8, 0x00)

    // LZW with a 2-bit minimum: clear = 4, end = 5, codes stay 3 bits wide.
    const coded: number[] = []
    let acc = 0
    let held = 0
    const emit = (code: number): void => {
      acc |= code << held
      held += 3
      while (held >= 8) {
        coded.push(acc & 0xff)
        acc >>= 8
        held -= 8
      }
    }
    for (const index of indices) {
      emit(4)
      emit(index)
    }
    emit(5)
    if (held > 0) coded.push(acc & 0xff)

    bytes.push(0x02) // minimum code size
    for (let at = 0; at < coded.length; at += 255) {
      const block = coded.slice(at, at + 255)
      bytes.push(block.length, ...block)
    }
    bytes.push(0x00) // block terminator
  }

  bytes.push(0x3b) // trailer
  return Buffer.from(bytes)
}

/** 120x120, two frames: vertical stripes, then horizontal ones. */
const ANIMATED_GIF = animatedGif(120, 120, [
  Array.from({ length: 120 * 120 }, (_, i) => (i % 120 < 60 ? 0 : 1)),
  Array.from({ length: 120 * 120 }, (_, i) => (Math.floor(i / 120) < 60 ? 0 : 1)),
])

/** A screenshot-like PNG: flat colour and hard edges. */
async function screenshotPng(width = 1280, height = 720): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 245, g: 245, b: 245 } },
  })
    .composite([
      {
        input: {
          create: { width: 400, height: 40, channels: 3, background: { r: 20, g: 20, b: 20 } },
        },
        top: 100,
        left: 80,
      },
    ])
    .png()
    .toBuffer()
}

describe('compression: the encoder', () => {
  it('makes a camera-sized photo dramatically smaller', async () => {
    const original = await photoJpeg()
    const result = await compressUpload(original, 'IMG_2043.jpeg')

    assert.equal(result.applied, true)
    assert.equal(result.extension, '.webp')

    const ratio = result.storedBytes / result.originalBytes
    assert.ok(ratio < 0.5, `expected well under half, got ${(ratio * 100).toFixed(1)}%`)

    // Still a valid image, and capped at the configured dimension.
    const meta = await sharp(result.buffer).metadata()
    assert.equal(meta.format, 'webp')
    assert.equal(Math.max(meta.width ?? 0, meta.height ?? 0), config.IMAGE_MAX_DIMENSION)
  })

  it('keeps a screenshot lossless, so text does not smear', async () => {
    const original = await screenshotPng()
    const result = await compressUpload(original, 'Screenshot.png')

    assert.equal(result.applied, true)

    // Every pixel identical after the round trip. Alpha is normalised on both
    // sides first: the WebP encoder may add a channel, which says nothing about
    // whether colour was lost.
    const before = await sharp(original).removeAlpha().raw().toBuffer()
    const afterBytes = await sharp(result.buffer).removeAlpha().raw().toBuffer()

    // Compared by length and then by bytes rather than with deepEqual: on a
    // mismatch, deepEqual tries to render a diff of three million elements and
    // dies of memory exhaustion instead of reporting the failure.
    assert.equal(afterBytes.byteLength, before.byteLength)
    assert.equal(Buffer.compare(afterBytes, before), 0, 'pixels should survive unchanged')
  })

  it('does not enlarge an image that is already small', async () => {
    const small = await sharp({
      create: { width: 200, height: 150, channels: 3, background: { r: 10, g: 90, b: 200 } },
    })
      .png()
      .toBuffer()

    const result = await compressUpload(small, 'tiny.png')
    const meta = await sharp(result.buffer).metadata()

    assert.equal(meta.width, 200)
    assert.equal(meta.height, 150)
  })

  it('leaves a WebP that already fits completely alone', async () => {
    // This is the format the pipeline targets. Re-encoding could only lose
    // quality, and a file that came from here must survive a re-upload
    // unchanged rather than degrading a little each time.
    const already = await sharp(await photoJpeg(800, 600))
      .webp({ quality: 60 })
      .toBuffer()

    const result = await compressUpload(already, 'from-the-portal.webp')

    assert.equal(result.applied, false)
    assert.equal(Buffer.compare(result.buffer, already), 0)
    assert.match(result.reason ?? '', /already WebP/i)
  })

  it('keeps the original when a re-encode would come out bigger', async () => {
    // Random noise is incompressible, so the lossless encoder this PNG would
    // take cannot beat the source. The rule that matters: never store the
    // larger of the two.
    const width = 600
    const height = 400
    const noise = Buffer.alloc(width * height * 3)
    for (let i = 0; i < noise.length; i += 1) noise[i] = (i * 2654435761) % 251

    const png = await sharp(noise, { raw: { width, height, channels: 3 } })
      .png({ compressionLevel: 9 })
      .toBuffer()

    const result = await compressUpload(png, 'noise.png')

    // Whichever way the encoders land, what is stored is never the bigger one.
    assert.ok(
      result.storedBytes <= png.byteLength,
      `stored ${result.storedBytes} vs original ${png.byteLength}`
    )
    if (!result.applied) assert.equal(Buffer.compare(result.buffer, png), 0)
  })

  it('leaves a PDF completely untouched', async () => {
    const pdf = Buffer.from('%PDF-1.4\n% not really a pdf, but not an image either\n')
    const result = await compressUpload(pdf, 'submission.pdf')

    assert.equal(result.applied, false)
    assert.equal(result.extension, '.pdf')
    assert.deepEqual(result.buffer, pdf)
  })

  it('survives a file that claims to be an image but is not', async () => {
    const lying = Buffer.from('this is plain text pretending to be a photo')
    const result = await compressUpload(lying, 'trust-me.jpg')

    // No throw, no data loss -- the bytes are stored exactly as they arrived.
    assert.equal(result.applied, false)
    assert.deepEqual(result.buffer, lying)
  })

  it('strips EXIF, including where the photo was taken', async () => {
    const withExif = await sharp(await photoJpeg(800, 600))
      .withExif({
        IFD0: { Copyright: 'Test', Software: 'test-suite' },
        // A home address, in effect, riding along with a homework photo.
        GPSIFD: { GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' },
      })
      .toBuffer()

    assert.ok((await sharp(withExif).metadata()).exif, 'fixture should carry EXIF')

    const result = await compressUpload(withExif, 'holiday.jpg')
    assert.equal((await sharp(result.buffer).metadata()).exif, undefined)
  })

  it('preserves animation instead of flattening it to one frame', async () => {
    const result = await compressUpload(ANIMATED_GIF, 'reaction.gif')

    assert.equal(result.applied, true)
    assert.equal(result.extension, '.webp')

    // `animated: true` has to be passed to the decoder or only frame one
    // survives -- a silently broken GIF is worse than an uncompressed one.
    const meta = await sharp(result.buffer, { animated: true }).metadata()
    assert.equal(meta.pages, 2, 'both frames should survive')
  })
})

describe('compression: through the upload endpoint', () => {
  it('stores the compressed bytes and reports the saving', async () => {
    const mentor = await createUser(base, 'mentor')
    const photo = await photoJpeg()

    const res = await mentor.client.upload(
      '/api/storage/resources',
      new Blob([photo], { type: 'image/jpeg' }),
      'lecture-board.jpeg'
    )

    assert.equal(res.status, 201, JSON.stringify(res.body))
    const { data } = res.body

    assert.equal(data.compression.applied, true)
    assert.equal(data.compression.originalSize, photo.byteLength)
    assert.ok(data.compression.storedSize < photo.byteLength / 2)
    // `size` describes what is stored, so the row does not record a weight the
    // file no longer has.
    assert.equal(data.size, data.compression.storedSize)
    assert.equal(data.mimeType, 'image/webp')
    // The key follows the bytes, or the download would serve WebP as JPEG.
    assert.match(data.path, /\.webp$/)
  })

  it('serves the stored image back as WebP, inline', async () => {
    const mentor = await createUser(base, 'mentor')
    const res = await mentor.client.upload(
      '/api/storage/resources',
      new Blob([await photoJpeg(1200, 900)], { type: 'image/jpeg' }),
      'notes.jpeg'
    )

    const { pathname, search } = new URL(res.body.data.signedUrl)
    const view = await fetch(`${base}${pathname}${search}`)

    assert.equal(view.status, 200)
    assert.equal(view.headers.get('content-type'), 'image/webp')
    assert.equal(view.headers.get('content-disposition'), 'inline')

    const bytes = Buffer.from(await view.arrayBuffer())
    assert.equal((await sharp(bytes).metadata()).format, 'webp')
  })

  it('corrects the download filename to match the stored format', async () => {
    const mentor = await createUser(base, 'mentor')
    const res = await mentor.client.upload(
      '/api/storage/resources',
      new Blob([await photoJpeg(900, 600)], { type: 'image/jpeg' }),
      'diagram.jpeg'
    )

    const { pathname, search } = new URL(res.body.data.signedUrl)
    // The row still says .jpeg; saving that name would produce a file the OS
    // cannot open, since the bytes are WebP.
    const download = await fetch(`${base}${pathname}${search}&download=1&filename=diagram.jpeg`)

    assert.match(download.headers.get('content-disposition') ?? '', /filename="diagram\.webp"/)
  })

  it('leaves a student PDF submission byte-for-byte identical', async () => {
    const student = await createUser(base, 'student')
    const pdf = Buffer.from('%PDF-1.4\nhomework\n%%EOF\n')

    const res = await student.client.upload(
      '/api/storage/task-submissions',
      new Blob([pdf], { type: 'application/pdf' }),
      'homework.pdf',
      { taskId: 'task1', stepId: 'step1' }
    )

    assert.equal(res.body.data.compression.applied, false)
    assert.match(res.body.data.path, /\.pdf$/)

    const { pathname, search } = new URL(res.body.data.signedUrl)
    const view = await fetch(`${base}${pathname}${search}`)
    assert.deepEqual(Buffer.from(await view.arrayBuffer()), pdf)
  })
})
