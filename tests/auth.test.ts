import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Client, createUser, startTestServer, stopTestServer, truncateAll } from './helpers.js'
import { query } from '../src/db/pool.js'

let base: string

before(async () => {
  base = await startTestServer()
})
after(stopTestServer)
beforeEach(truncateAll)

describe('auth: signup', () => {
  it('creates a user, a profile, and a session', async () => {
    const client = new Client(base)
    const res = await client.post('/auth/signup', {
      email: 'new@test.local',
      password: 'password1234',
      full_name: 'New Person',
    })

    assert.equal(res.status, 201)
    assert.equal(res.body.user.email, 'new@test.local')
    assert.equal(res.body.user.role, 'student')
    assert.ok(client.hasSession(), 'session cookie should be set')

    // The on_user_created trigger must have produced the profile row.
    const profiles = await query('SELECT * FROM profiles WHERE id = $1', [res.body.user.id])
    assert.equal(profiles.length, 1)
    assert.equal(profiles[0]!.full_name, 'New Person')
  })

  it('always assigns the student role, even when the client asks for admin', async () => {
    // user_metadata is client-controlled. If handle_new_user honoured a role
    // key there, this request would mint an admin.
    const client = new Client(base)
    const res = await client.post('/auth/signup', {
      email: 'sneaky@test.local',
      password: 'password1234',
      full_name: 'Sneaky',
      role: 'admin',
      data: { role: 'admin' },
    })

    assert.equal(res.status, 201)
    assert.equal(res.body.user.role, 'student')
  })

  it('rejects passwords under 8 characters', async () => {
    const client = new Client(base)
    const res = await client.post('/auth/signup', { email: 'x@test.local', password: 'short' })
    assert.equal(res.status, 400)
  })

  it('does not reveal whether an email is already registered', async () => {
    const client = new Client(base)
    await client.post('/auth/signup', { email: 'dupe@test.local', password: 'password1234' })

    const second = await new Client(base).post('/auth/signup', {
      email: 'dupe@test.local',
      password: 'password1234',
    })

    assert.equal(second.status, 409)
    assert.doesNotMatch(String(second.body.error.message), /exist|registered|taken/i)
  })

  it('treats email as case-insensitive', async () => {
    const client = new Client(base)
    await client.post('/auth/signup', { email: 'Case@test.local', password: 'password1234' })

    const second = await new Client(base).post('/auth/signup', {
      email: 'CASE@TEST.LOCAL',
      password: 'password1234',
    })
    assert.equal(second.status, 409)
  })
})

describe('auth: login', () => {
  it('signs in with correct credentials', async () => {
    const user = await createUser(base)
    const fresh = new Client(base)

    const res = await fresh.post('/auth/login', {
      email: user.email,
      password: user.password,
    })

    assert.equal(res.status, 200)
    assert.equal(res.body.user.id, user.id)
    assert.ok(fresh.hasSession())
  })

  it('rejects a wrong password with the same message as an unknown user', async () => {
    const user = await createUser(base)

    const wrongPassword = await new Client(base).post('/auth/login', {
      email: user.email,
      password: 'not-the-password',
    })
    const unknownUser = await new Client(base).post('/auth/login', {
      email: 'nobody@test.local',
      password: 'not-the-password',
    })

    assert.equal(wrongPassword.status, 400)
    assert.equal(unknownUser.status, 400)
    assert.equal(wrongPassword.body.error.message, unknownUser.body.error.message)
  })

  it('stores passwords hashed, never in plaintext', async () => {
    const user = await createUser(base)
    const rows = await query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [user.id]
    )
    const hash = rows[0]!.password_hash
    assert.ok(hash.startsWith('$argon2id$'), `expected argon2id hash, got ${hash.slice(0, 20)}`)
    assert.ok(!hash.includes(user.password))
  })
})

describe('auth: session lifecycle', () => {
  it('returns the current user while signed in', async () => {
    const user = await createUser(base)
    const res = await user.client.get('/auth/user')
    assert.equal(res.status, 200)
    assert.equal(res.body.user.id, user.id)
  })

  it('returns { user: null } when anonymous rather than erroring', async () => {
    // A lot of page code does `const { data: { user } } = await getUser()` and
    // branches on null; a 401 here would break those pages.
    const res = await new Client(base).get('/auth/user')
    assert.equal(res.status, 200)
    assert.equal(res.body.user, null)
  })

  it('refreshes an access token and rotates the refresh token', async () => {
    const user = await createUser(base)

    const before = await query<{ token_hash: string }>(
      'SELECT token_hash FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL',
      [user.id]
    )
    assert.equal(before.length, 1)

    const res = await user.client.post('/auth/refresh')
    assert.equal(res.status, 200)

    const active = await query(
      'SELECT token_hash FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL',
      [user.id]
    )
    assert.equal(active.length, 1, 'old token should be revoked, new one issued')
    assert.notEqual(active[0]!.token_hash, before[0]!.token_hash)
  })

  it('logs out and revokes the refresh token', async () => {
    const user = await createUser(base)
    const res = await user.client.post('/auth/logout')
    assert.equal(res.status, 200)

    const active = await query(
      'SELECT 1 FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL',
      [user.id]
    )
    assert.equal(active.length, 0)

    const after = await user.client.get('/auth/user')
    assert.equal(after.body.user, null)
  })

  it('requires the current password before changing it', async () => {
    const user = await createUser(base)

    const withoutCurrent = await user.client.patch('/auth/user', { password: 'brand-new-pass-1' })
    assert.equal(withoutCurrent.status, 403)
    assert.equal(withoutCurrent.body.error.code, 'REAUTH_REQUIRED')

    const withCurrent = await user.client.patch('/auth/user', {
      password: 'brand-new-pass-1',
      current_password: user.password,
    })
    assert.equal(withCurrent.status, 200)

    const relogin = await new Client(base).post('/auth/login', {
      email: user.email,
      password: 'brand-new-pass-1',
    })
    assert.equal(relogin.status, 200)
  })

  it('ends other sessions when the password changes', async () => {
    const user = await createUser(base)

    // A second device.
    const other = new Client(base)
    await other.post('/auth/login', { email: user.email, password: user.password })
    assert.ok(other.hasSession())

    await user.client.patch('/auth/user', {
      password: 'rotated-password-9',
      current_password: user.password,
    })

    const stillValid = await query(
      'SELECT 1 FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL',
      [user.id]
    )
    // Only the session that performed the change survives.
    assert.equal(stillValid.length, 1)
  })
})

describe('auth: protected endpoints', () => {
  it('rejects unauthenticated data access', async () => {
    const res = await new Client(base).db({ table: 'profiles', op: 'select' })
    assert.equal(res.status, 401)
  })

  it('rejects unauthenticated RPC calls', async () => {
    const res = await new Client(base).post('/api/rpc/get_user_total_points', {
      p_user_id: '00000000-0000-0000-0000-000000000000',
    })
    assert.equal(res.status, 401)
  })
})
