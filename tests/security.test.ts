import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createUser, startTestServer, stopTestServer, truncateAll } from './helpers.js'
import { query } from '../src/db/pool.js'

/**
 * The policy engine is the replacement for the Row Level Security policies the
 * project never had. These tests are adversarial on purpose: each one is an
 * attack that succeeded against the old Supabase-with-no-RLS setup.
 */

let base: string

before(async () => {
  base = await startTestServer()
})
after(stopTestServer)
beforeEach(truncateAll)

describe('security: privilege escalation', () => {
  it('a student cannot promote themselves to admin via the data endpoint', async () => {
    const student = await createUser(base, 'student')

    const res = await student.client.db({
      table: 'profiles',
      op: 'update',
      values: { role: 'admin' },
      filters: [{ column: 'id', op: 'eq', value: student.id }],
    })

    assert.equal(res.status, 400)
    assert.match(String(res.body.error.message), /not writable/i)

    const rows = await query<{ role: string }>('SELECT role FROM profiles WHERE id = $1', [
      student.id,
    ])
    assert.equal(rows[0]!.role, 'student')
  })

  it('a student cannot promote themselves via the admin endpoint', async () => {
    const student = await createUser(base, 'student')

    const res = await student.client.patch('/api/admin/role', {
      user_id: student.id,
      role: 'admin',
    })

    assert.equal(res.status, 403)
    const rows = await query<{ role: string }>('SELECT role FROM profiles WHERE id = $1', [
      student.id,
    ])
    assert.equal(rows[0]!.role, 'student')
  })

  it('a mentor cannot promote anyone', async () => {
    const mentor = await createUser(base, 'mentor')
    const student = await createUser(base, 'student')

    const res = await mentor.client.patch('/api/admin/role', {
      user_id: student.id,
      role: 'admin',
    })
    assert.equal(res.status, 403)
  })

  it('an admin can change a role, and it revokes that user\'s sessions', async () => {
    const admin = await createUser(base, 'admin')
    const student = await createUser(base, 'student')

    const res = await admin.client.patch('/api/admin/role', {
      user_id: student.id,
      role: 'mentor',
    })
    assert.equal(res.status, 200)

    const rows = await query<{ role: string }>('SELECT role FROM profiles WHERE id = $1', [
      student.id,
    ])
    assert.equal(rows[0]!.role, 'mentor')

    const active = await query(
      'SELECT 1 FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL',
      [student.id]
    )
    assert.equal(active.length, 0, 'stale role claim must not survive')
  })

  it('refuses to demote the last remaining admin', async () => {
    const admin = await createUser(base, 'admin')

    const res = await admin.client.patch('/api/admin/role', {
      user_id: admin.id,
      role: 'student',
    })

    assert.equal(res.status, 409)
    assert.equal(res.body.error.code, 'LAST_ADMIN')
  })
})

describe('security: points cannot be minted', () => {
  it('a student cannot write their own leaderboard row', async () => {
    const student = await createUser(base, 'student')

    const res = await student.client.db({
      table: 'leaderboard',
      op: 'insert',
      values: { user_id: student.id, total_points: 999999 },
    })

    assert.equal(res.status, 403)
  })

  it('a student cannot set leaderboard_points on their profile', async () => {
    const student = await createUser(base, 'student')

    const res = await student.client.db({
      table: 'profiles',
      op: 'update',
      values: { leaderboard_points: 999999 },
      filters: [{ column: 'id', op: 'eq', value: student.id }],
    })

    assert.equal(res.status, 400)
  })

  it('a student cannot call adjust_points_manual', async () => {
    const student = await createUser(base, 'student')

    const res = await student.client.post('/api/rpc/adjust_points_manual', {
      p_user_id: student.id,
      p_action_type: 'manual_points_add',
      p_points: 100000,
    })

    assert.equal(res.status, 403)
  })

  it('a student cannot award points to another student', async () => {
    const a = await createUser(base, 'student')
    const b = await createUser(base, 'student')

    const res = await a.client.post('/api/rpc/award_points', {
      p_user_id: b.id,
      p_action_type: 'daily_login',
    })

    assert.equal(res.status, 403)
  })

  it('a mentor cannot adjust points for a student they do not own', async () => {
    const mentor = await createUser(base, 'mentor')
    const student = await createUser(base, 'student')

    const res = await mentor.client.post('/api/rpc/adjust_points_manual', {
      p_user_id: student.id,
      p_action_type: 'manual_points_add',
      p_points: 50,
    })

    assert.equal(res.status, 403)
  })

  it('a mentor CAN adjust points for their own assigned student', async () => {
    const admin = await createUser(base, 'admin')
    const mentor = await createUser(base, 'mentor')
    const student = await createUser(base, 'student')

    const assign = await admin.client.db({
      table: 'mentor_assignments',
      op: 'insert',
      values: { student_id: student.id, mentor_id: mentor.id, status: 'active' },
    })
    assert.equal(assign.status, 200)

    const res = await mentor.client.post('/api/rpc/adjust_points_manual', {
      p_user_id: student.id,
      p_action_type: 'manual_points_add',
      p_points: 50,
    })

    assert.equal(res.status, 200)
    assert.equal(res.body.data, 50)
  })

  it('clamps a manual adjustment to a sane range', async () => {
    const admin = await createUser(base, 'admin')
    const student = await createUser(base, 'student')

    const res = await admin.client.post('/api/rpc/adjust_points_manual', {
      p_user_id: student.id,
      p_action_type: 'manual_points_add',
      p_points: 999_999_999,
    })

    assert.equal(res.status, 400)
  })
})

describe('security: cross-user data access', () => {
  it("a student cannot read another student's task assignments", async () => {
    const admin = await createUser(base, 'admin')
    const victim = await createUser(base, 'student')
    const attacker = await createUser(base, 'student')

    const task = await admin.client.db({
      table: 'tasks',
      op: 'insert',
      values: { title: 'Private task', description: 'x' },
    })
    const taskId = task.body.data[0].id

    await admin.client.db({
      table: 'task_assignments',
      op: 'insert',
      values: { task_id: taskId, student_id: victim.id },
    })

    const res = await attacker.client.db({ table: 'task_assignments', op: 'select' })
    assert.equal(res.status, 200)
    assert.equal(res.body.data.length, 0, 'attacker must not see the victim assignment')
  })

  it("a student cannot read another student's points history", async () => {
    const admin = await createUser(base, 'admin')
    const victim = await createUser(base, 'student')
    const attacker = await createUser(base, 'student')

    await admin.client.post('/api/rpc/adjust_points_manual', {
      p_user_id: victim.id,
      p_action_type: 'manual_points_add',
      p_points: 42,
    })

    const res = await attacker.client.db({
      table: 'points_history',
      op: 'select',
      filters: [{ column: 'user_id', op: 'eq', value: victim.id }],
    })

    assert.equal(res.status, 200)
    assert.equal(res.body.data.length, 0)
  })

  it("redacts other users' contact details from a student", async () => {
    const other = await createUser(base, 'student')
    const viewer = await createUser(base, 'student')

    const res = await viewer.client.db({
      table: 'profiles',
      op: 'select',
      select: 'id, full_name, email, phone',
    })

    assert.equal(res.status, 200)
    const theirs = res.body.data.find((r: any) => r.id === other.id)
    const mine = res.body.data.find((r: any) => r.id === viewer.id)

    assert.ok(theirs, 'should still see that the user exists')
    assert.equal(theirs.email, undefined, 'email must be redacted')
    assert.ok(theirs.full_name, 'display name is still visible')
    assert.ok(mine.email, 'own email is not redacted')
  })

  it('lets staff see contact details', async () => {
    await createUser(base, 'student')
    const mentor = await createUser(base, 'mentor')

    const res = await mentor.client.db({
      table: 'profiles',
      op: 'select',
      select: 'id, email',
    })

    assert.equal(res.status, 200)
    assert.ok(res.body.data.every((r: any) => 'email' in r))
  })

  it("a student cannot delete another student's discussion", async () => {
    const owner = await createUser(base, 'student')
    const attacker = await createUser(base, 'student')

    const created = await owner.client.db({
      table: 'discussions',
      op: 'insert',
      values: { title: 'Mine', description: 'hands off', category: 'general' },
    })
    const id = created.body.data[0].id

    const res = await attacker.client.db({
      table: 'discussions',
      op: 'delete',
      filters: [{ column: 'id', op: 'eq', value: id }],
    })

    assert.equal(res.status, 200)
    assert.equal(res.body.data.length, 0, 'delete must match zero rows')

    const still = await query('SELECT 1 FROM discussions WHERE id = $1', [id])
    assert.equal(still.length, 1)
  })

  it('forces user_id to the caller on insert, ignoring a spoofed value', async () => {
    const victim = await createUser(base, 'student')
    const attacker = await createUser(base, 'student')

    const res = await attacker.client.db({
      table: 'discussions',
      op: 'insert',
      values: {
        title: 'Framed',
        description: 'posted as someone else',
        category: 'general',
        user_id: victim.id,
      },
    })

    assert.equal(res.status, 200)
    assert.equal(res.body.data[0].user_id, attacker.id, 'server must override spoofed user_id')
  })
})

describe('security: query layer hardening', () => {
  it('rejects an unknown table', async () => {
    const user = await createUser(base)
    const res = await user.client.db({ table: 'pg_shadow', op: 'select' })
    assert.equal(res.status, 404)
  })

  it('rejects an unknown column', async () => {
    const user = await createUser(base)
    const res = await user.client.db({
      table: 'profiles',
      op: 'select',
      select: 'id, password_hash',
    })
    assert.equal(res.status, 400)
  })

  it('does not let a filter value break out into SQL', async () => {
    const user = await createUser(base)
    const res = await user.client.db({
      table: 'profiles',
      op: 'select',
      filters: [{ column: 'full_name', op: 'eq', value: "'; DROP TABLE users; --" }],
    })

    assert.equal(res.status, 200)
    // The table must still exist.
    const users = await query('SELECT 1 FROM users LIMIT 1')
    assert.ok(users.length >= 0)
  })

  it('refuses an update with no filter', async () => {
    const admin = await createUser(base, 'admin')
    const res = await admin.client.db({
      table: 'profiles',
      op: 'update',
      values: { full_name: 'Everyone' },
    })
    assert.equal(res.status, 400)
    assert.equal(res.body.error.code, 'UNSAFE_UPDATE')
  })

  it('refuses a delete with no filter', async () => {
    const admin = await createUser(base, 'admin')
    const res = await admin.client.db({ table: 'discussions', op: 'delete' })
    assert.equal(res.status, 400)
    assert.equal(res.body.error.code, 'UNSAFE_DELETE')
  })

  it('rejects an undeclared embedded relationship', async () => {
    const user = await createUser(base)
    const res = await user.client.db({
      table: 'profiles',
      op: 'select',
      select: 'id, users(password_hash)',
    })
    assert.equal(res.status, 400)
  })
})
