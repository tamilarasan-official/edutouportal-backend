import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Client, createUser, startTestServer, stopTestServer, truncateAll } from './helpers.js'
import { query } from '../src/db/pool.js'
import { seedCmsIfEmpty } from '../src/cms/seed.js'
import { bootstrapAdmin } from '../src/auth/bootstrap.js'

/** What the API does by itself on startup: seed the CMS, bootstrap the admin. */

let base: string

before(async () => {
  base = await startTestServer()
})
after(stopTestServer)
beforeEach(truncateAll)

describe('startup: CMS seed', () => {
  it('imports the starting programmes into an empty CMS', async () => {
    const result = await seedCmsIfEmpty()
    assert.ok(result)
    assert.ok(result.added >= 5)
    const site = (await new Client(base).get('/api/cms/site')).body.data
    assert.equal(site.categories.length, 6)
    assert.ok(site.programmes.some((p: any) => p.slug === 'ai-native-software-engineering'))
  })

  it('never runs again once the CMS has content, even after programmes are deleted', async () => {
    await seedCmsIfEmpty()
    await query('DELETE FROM cms_programmes')
    assert.equal(await seedCmsIfEmpty(), null)
    const rows = await query<{ n: number }>('SELECT count(*)::int AS n FROM cms_programmes')
    assert.equal(rows[0]!.n, 0)
  })
})

describe('startup: admin bootstrap', () => {
  it('leaves an existing admin alone unless reset is switched on', async () => {
    const admin = await createUser(base, 'admin')
    await bootstrapAdmin({ email: admin.email, password: 'a-brand-new-password' })
    assert.equal((await new Client(base).post('/auth/login', { email: admin.email, password: 'a-brand-new-password' })).status, 400)
    assert.equal((await new Client(base).post('/auth/login', { email: admin.email, password: admin.password })).status, 200)
  })

  it('with reset on, sets the password of an existing admin and signs out old sessions', async () => {
    const admin = await createUser(base, 'admin')
    assert.equal((await admin.client.get('/api/cms/admin/programmes')).status, 200)

    await bootstrapAdmin({ email: admin.email, password: 'a-brand-new-password', reset: true })

    assert.equal((await new Client(base).post('/auth/login', { email: admin.email, password: admin.password })).status, 400)
    const fresh = new Client(base)
    const login = await fresh.post('/auth/login', { email: admin.email, password: 'a-brand-new-password' })
    assert.equal(login.status, 200)
    assert.equal(login.body.user.role, 'admin')
    // The old refresh token no longer works.
    assert.notEqual((await admin.client.post('/auth/refresh')).status, 200)
  })

  it('with reset on, creates the admin when the account does not exist', async () => {
    await bootstrapAdmin({ email: 'boss@edutou.test', password: 'first-password-123', name: 'Boss', reset: true })
    const login = await new Client(base).post('/auth/login', { email: 'boss@edutou.test', password: 'first-password-123' })
    assert.equal(login.status, 200)
    assert.equal(login.body.user.role, 'admin')
  })
})
