import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { config } from '../src/config.js'
import { createUser, startTestServer, stopTestServer, truncateAll } from './helpers.js'

/**
 * File downloads, and specifically the case the session cookie cannot cover.
 *
 * The portal holds its session cookie on its OWN hostname, so anything the
 * browser fetches straight from this API -- an <iframe src>, an <img src>, a
 * download anchor -- arrives with no credentials and cannot be given an
 * Authorization header. Before signed URLs existed those requests were answered
 * 401, and because the 401 still carried helmet's `X-Frame-Options: SAMEORIGIN`
 * the browser reported only "Refused to display ... in a frame", hiding the
 * real cause. Both halves of that are asserted below.
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

const PDF = () => new Blob(['%PDF-1.4 test fixture'], { type: 'application/pdf' })

/** The signed URL names PUBLIC_URL; the test server is on an ephemeral port. */
function onTestServer(signedUrl: string): string {
  const { pathname, search } = new URL(signedUrl)
  return `${base}${pathname}${search}`
}

async function uploadResource(): Promise<{ signedUrl: string; publicUrl: string; path: string }> {
  const mentor = await createUser(base, 'mentor')
  const res = await mentor.client.upload('/api/storage/resources', PDF(), 'notes.pdf')
  assert.equal(res.status, 201, JSON.stringify(res.body))
  return res.body.data
}

describe('storage: signed download URLs', () => {
  it('serves a signed URL to a browser carrying no session at all', async () => {
    const { signedUrl } = await uploadResource()

    // No cookie header: exactly what an <iframe src> sends to this origin.
    const response = await fetch(onTestServer(signedUrl))

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/pdf')
    assert.equal(response.headers.get('content-disposition'), 'inline')
    assert.match(await response.text(), /^%PDF/)
  })

  it('lets the frontend frame a preview instead of blocking it', async () => {
    const { signedUrl } = await uploadResource()

    const response = await fetch(onTestServer(signedUrl))

    // X-Frame-Options has no origin-list form, so it must be gone entirely...
    assert.equal(response.headers.get('x-frame-options'), null)
    // ...replaced by a frame-ancestors list naming the configured frontends.
    const csp = response.headers.get('content-security-policy') ?? ''
    assert.match(csp, /frame-ancestors/)
    for (const origin of config.corsOrigins) assert.ok(csp.includes(origin), csp)
  })

  it('answers an unsigned, unauthenticated request 401 -- and still framable', async () => {
    const { publicUrl } = await uploadResource()

    const response = await fetch(onTestServer(publicUrl))

    assert.equal(response.status, 401)
    // The error itself must not be masked by a frame refusal, or the console
    // shows the framing complaint and never the authentication one.
    assert.equal(response.headers.get('x-frame-options'), null)
  })

  it('forces a download when asked, with the caller-supplied name', async () => {
    const { signedUrl } = await uploadResource()

    const response = await fetch(
      `${onTestServer(signedUrl)}&download=1&filename=${encodeURIComponent('Week 1 notes.pdf')}`
    )

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/octet-stream')
    assert.match(response.headers.get('content-disposition') ?? '', /^attachment; filename="Week 1 notes\.pdf"/)
  })

  it('strips a newline out of a supplied filename rather than emitting it', async () => {
    const { signedUrl } = await uploadResource()

    const response = await fetch(
      `${onTestServer(signedUrl)}&download=1&filename=${encodeURIComponent('a\r\nX-Injected: 1')}`
    )

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-injected'), null)
  })
})

describe('storage: signed URL integrity', () => {
  it('rejects a token whose signature has been altered', async () => {
    const { signedUrl } = await uploadResource()
    const url = new URL(onTestServer(signedUrl))
    const token = url.searchParams.get('token')!

    url.searchParams.set('token', token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a'))
    const response = await fetch(url)

    assert.equal(response.status, 401)
    assert.equal((await response.json()).error.code, 'BAD_TOKEN')
  })

  it('refuses a token minted for a different file', async () => {
    const first = await uploadResource()
    const second = await uploadResource()

    const stolen = new URL(onTestServer(first.signedUrl))
    const target = new URL(onTestServer(second.publicUrl))
    target.searchParams.set('token', stolen.searchParams.get('token')!)

    const response = await fetch(target)

    assert.equal(response.status, 401)
  })

  it('will not sign a URL for a file the caller may not read', async () => {
    const owner = await createUser(base, 'student')
    const upload = await owner.client.upload(
      '/api/storage/task-submissions',
      PDF(),
      'submission.pdf',
      { taskId: 'task1', stepId: 'step1' }
    )
    assert.equal(upload.status, 201, JSON.stringify(upload.body))

    const other = await createUser(base, 'student')
    const res = await other.client.get(
      `/api/storage/sign?bucket=task-submissions&path=${encodeURIComponent(upload.body.data.path)}`
    )

    assert.equal(res.status, 403)
  })

  it('signs for the owner of a private submission', async () => {
    const owner = await createUser(base, 'student')
    const upload = await owner.client.upload(
      '/api/storage/task-submissions',
      PDF(),
      'submission.pdf',
      { taskId: 'task1', stepId: 'step1' }
    )

    const res = await owner.client.get(
      `/api/storage/sign?bucket=task-submissions&path=${encodeURIComponent(upload.body.data.path)}`
    )

    assert.equal(res.status, 200)
    const download = await fetch(onTestServer(res.body.data.signedUrl))
    assert.equal(download.status, 200)
  })

  it('accepts a whole publicUrl as the path, not just the key', async () => {
    const mentor = await createUser(base, 'mentor')
    const upload = await mentor.client.upload('/api/storage/resources', PDF(), 'notes.pdf')

    const res = await mentor.client.get(
      `/api/storage/sign?bucket=resources&path=${encodeURIComponent(upload.body.data.publicUrl)}`
    )

    assert.equal(res.status, 200)
    assert.equal(res.body.data.path, upload.body.data.path)
  })

  it('refuses to sign a key that was never written', async () => {
    // The resources uploader used to record a filename it invented client-side
    // instead of the key the API returned. Signing succeeded, and the failure
    // only appeared as a 404 inside an iframe -- with nothing to say which
    // layer was wrong. It now fails here, where the caller can see it.
    const mentor = await createUser(base, 'mentor')

    const res = await mentor.client.get(
      '/api/storage/sign?bucket=resources&path=1764930000000_a1b2c3.jpeg'
    )

    assert.equal(res.status, 404)
    assert.equal(res.body.error.code, 'NOT_FOUND')
    assert.match(String(res.body.error.message), /never written/i)
  })

  it('turns away an anonymous caller asking for a signature', async () => {
    const { path } = await uploadResource()

    const response = await fetch(
      `${base}/api/storage/sign?bucket=resources&path=${encodeURIComponent(path)}`
    )

    assert.equal(response.status, 401)
  })
})
