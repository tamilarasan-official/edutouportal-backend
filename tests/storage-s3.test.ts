import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3'
import { S3Driver } from '../src/storage/s3.js'
import { setStorageDriver } from '../src/storage/index.js'
import { createUser, startTestServer, stopTestServer, truncateAll } from './helpers.js'

/**
 * The object-storage driver, against a real S3-compatible server.
 *
 * Production stores uploads in Garage, so this exercises the actual protocol
 * rather than a stub: a fake that agrees with our assumptions would not have
 * caught path-style addressing, the two different shapes of "not found", or
 * ContentRange parsing -- all of which differ between implementations.
 *
 * Runs only when S3_TEST_ENDPOINT is set. CI starts a server and sets it; a
 * local run without one skips rather than failing.
 */

const ENDPOINT = process.env.S3_TEST_ENDPOINT
const BUCKET = process.env.S3_TEST_BUCKET ?? 'edutou'
const ACCESS_KEY = process.env.S3_TEST_ACCESS_KEY_ID ?? ''
const SECRET_KEY = process.env.S3_TEST_SECRET_ACCESS_KEY ?? ''
const REGION = process.env.S3_TEST_REGION ?? 'garage'

const options = {
  endpoint: ENDPOINT,
  bucket: BUCKET,
  accessKeyId: ACCESS_KEY,
  secretAccessKey: SECRET_KEY,
  region: REGION,
  forcePathStyle: true,
}

describe('storage: S3 driver', { skip: ENDPOINT ? false : 'S3_TEST_ENDPOINT is not set' }, () => {
  let driver: S3Driver
  let base: string
  // Every run works under its own prefix, so a shared server does not carry
  // state between runs.
  const run = `test-${Date.now()}`

  before(async () => {
    // The bucket may already exist -- Garage provisions it out of band, MinIO
    // in CI does not. Either way it must be there before the driver is used.
    const client = new S3Client({
      endpoint: ENDPOINT,
      region: REGION,
      credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
      forcePathStyle: true,
    })
    await client.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(() => undefined)

    driver = new S3Driver(options)
    await driver.ensureReady()

    // The routes resolve the driver per request, so the whole API now runs on S3.
    setStorageDriver(driver)
    base = await startTestServer()
  })

  after(async () => {
    await stopTestServer()
    setStorageDriver()
  })

  beforeEach(truncateAll)

  it('refuses to start against a bucket that is not reachable', async () => {
    const wrong = new S3Driver({ ...options, bucket: `${BUCKET}-does-not-exist` })
    await assert.rejects(() => wrong.ensureReady(), /Cannot reach S3 bucket/)
  })

  it('stores and reads back an object', async () => {
    const key = `${run}/hello.txt`
    await driver.put('resources', key, Buffer.from('hello garage'), 'text/plain')

    const info = await driver.head('resources', key)
    assert.equal(info?.size, 12)

    const body = await driver.get('resources', key)
    assert.ok(body)
    const chunks: Buffer[] = []
    for await (const chunk of body.stream) chunks.push(chunk as Buffer)
    assert.equal(Buffer.concat(chunks).toString(), 'hello garage')
  })

  it('reports a missing object as null rather than throwing', async () => {
    assert.equal(await driver.head('resources', `${run}/absent.txt`), null)
    assert.equal(await driver.get('resources', `${run}/absent.txt`), null)
  })

  it('serves a byte range and still reports the full size', async () => {
    const key = `${run}/range.txt`
    await driver.put('resources', key, Buffer.from('0123456789'), 'text/plain')

    const body = await driver.get('resources', key, { start: 2, end: 5 })
    assert.ok(body)
    // The total, not the length of the slice -- Content-Range accounting needs it.
    assert.equal(body.size, 10)

    const chunks: Buffer[] = []
    for await (const chunk of body.stream) chunks.push(chunk as Buffer)
    assert.equal(Buffer.concat(chunks).toString(), '2345')
  })

  it('keeps the two logical buckets apart', async () => {
    await driver.put('resources', `${run}/same-name.txt`, Buffer.from('shared'), 'text/plain')
    await driver.put('task-submissions', `${run}/same-name.txt`, Buffer.from('private'), 'text/plain')

    const shared = await driver.head('resources', `${run}/same-name.txt`)
    const priv = await driver.head('task-submissions', `${run}/same-name.txt`)
    assert.equal(shared?.size, 6)
    assert.equal(priv?.size, 7)

    const keys = await driver.list('resources')
    assert.ok(keys.includes(`${run}/same-name.txt`))
    // list() strips the logical-bucket prefix rather than leaking it back out.
    assert.ok(!keys.some((k) => k.startsWith('resources/')))
  })

  it('treats deleting an absent object as success', async () => {
    await driver.delete('resources', `${run}/never-existed.txt`)
  })

  it('carries a task submission from a student upload to a mentor view', async () => {
    const student = await createUser(base, 'student')
    const upload = await student.client.upload(
      '/api/storage/task-submissions',
      new Blob(['%PDF-1.4 submission'], { type: 'application/pdf' }),
      'homework.pdf',
      { taskId: 'task1', stepId: 'step1' }
    )
    assert.equal(upload.status, 201, JSON.stringify(upload.body))

    // The mentor signs a URL for a file they did not upload...
    const mentor = await createUser(base, 'mentor')
    const signed = await mentor.client.get(
      `/api/storage/sign?bucket=task-submissions&path=${encodeURIComponent(upload.body.data.path)}`
    )
    assert.equal(signed.status, 200, JSON.stringify(signed.body))

    // ...and the browser fetches it with no session of its own.
    const { pathname, search } = new URL(signed.body.data.signedUrl)
    const response = await fetch(`${base}${pathname}${search}`)

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/pdf')
    assert.equal(response.headers.get('content-disposition'), 'inline')
    assert.equal(response.headers.get('x-frame-options'), null)
    assert.match(await response.text(), /^%PDF/)
  })

  it('answers a range request over HTTP with 206 and the right slice', async () => {
    const mentor = await createUser(base, 'mentor')
    const upload = await mentor.client.upload(
      '/api/storage/resources',
      new Blob(['0123456789'], { type: 'text/plain' }),
      'digits.txt'
    )

    const { pathname, search } = new URL(upload.body.data.signedUrl)
    const response = await fetch(`${base}${pathname}${search}`, {
      headers: { range: 'bytes=3-6' },
    })

    assert.equal(response.status, 206)
    assert.equal(response.headers.get('content-range'), 'bytes 3-6/10')
    assert.equal(response.headers.get('content-length'), '4')
    assert.equal(await response.text(), '3456')
  })

  it('404s a row whose object is gone, without pretending it is an auth problem', async () => {
    const mentor = await createUser(base, 'mentor')
    const upload = await mentor.client.upload(
      '/api/storage/resources',
      new Blob(['gone soon'], { type: 'text/plain' }),
      'vanishing.txt'
    )

    // Exactly the production symptom: the database row survives, the bytes do not.
    await driver.delete('resources', upload.body.data.path)

    const { pathname, search } = new URL(upload.body.data.signedUrl)
    const response = await fetch(`${base}${pathname}${search}`)

    assert.equal(response.status, 404)
    assert.equal((await response.json()).error.code, 'NOT_FOUND')
  })
})
