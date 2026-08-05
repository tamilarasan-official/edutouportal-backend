import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createQuiz,
  createUser,
  SAMPLE_QUESTIONS,
  startTestServer,
  stopTestServer,
  truncateAll,
} from './helpers.js'
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

// ---------------------------------------------------------------------------
describe('teaching modules: admin-only CRUD', () => {
  /** quiz_sessions is not insertable through /api/db by design, so seed it directly. */
  async function seedSession(quizId: string, hostId: string, code: string): Promise<string> {
    const rows = await query<{ id: string }>(
      `INSERT INTO quiz_sessions (quiz_id, host_id, session_code)
       VALUES ($1, $2, $3) RETURNING id`,
      [quizId, hostId, code]
    )
    return rows[0]!.id
  }

  async function seedAttempt(client: any, quizId: string): Promise<string> {
    const res = await client.db({
      table: 'quiz_attempts',
      op: 'insert',
      values: { quiz_id: quizId, answers: [{ q: 'q1', a: 0 }], score: 1, total_questions: 2, correct_answers: 1 },
    })
    assert.equal(res.status, 200)
    return res.body.data[0].id
  }

  it('a student cannot regrade their own quiz attempt', async () => {
    const mentor = await createUser(base, 'mentor')
    const student = await createUser(base, 'student')
    const quizId = await createQuiz(mentor.id, SAMPLE_QUESTIONS)
    const attemptId = await seedAttempt(student.client, quizId)

    const res = await student.client.db({
      table: 'quiz_attempts',
      op: 'update',
      values: { score: 99, correct_answers: 99 },
      filters: [{ column: 'id', op: 'eq', value: attemptId }],
    })

    assert.equal(res.status, 403)
    const rows = await query<{ score: number }>('SELECT score FROM quiz_attempts WHERE id = $1', [
      attemptId,
    ])
    assert.equal(rows[0]!.score, 1, 'score must be untouched')
  })

  it('a mentor cannot regrade an attempt either -- this is admin-only', async () => {
    const mentor = await createUser(base, 'mentor')
    const student = await createUser(base, 'student')
    const quizId = await createQuiz(mentor.id, SAMPLE_QUESTIONS)
    const attemptId = await seedAttempt(student.client, quizId)

    const res = await mentor.client.db({
      table: 'quiz_attempts',
      op: 'update',
      values: { score: 2 },
      filters: [{ column: 'id', op: 'eq', value: attemptId }],
    })
    assert.equal(res.status, 403)
  })

  it('an admin can regrade and delete a quiz attempt', async () => {
    const admin = await createUser(base, 'admin')
    const mentor = await createUser(base, 'mentor')
    const student = await createUser(base, 'student')
    const quizId = await createQuiz(mentor.id, SAMPLE_QUESTIONS)
    const attemptId = await seedAttempt(student.client, quizId)

    const updated = await admin.client.db({
      table: 'quiz_attempts',
      op: 'update',
      values: { score: 2, correct_answers: 2 },
      filters: [{ column: 'id', op: 'eq', value: attemptId }],
    })
    assert.equal(updated.status, 200)
    assert.equal(updated.body.data[0].score, 2)

    const removed = await admin.client.db({
      table: 'quiz_attempts',
      op: 'delete',
      filters: [{ column: 'id', op: 'eq', value: attemptId }],
    })
    assert.equal(removed.status, 200)
    const rows = await query('SELECT 1 FROM quiz_attempts WHERE id = $1', [attemptId])
    assert.equal(rows.length, 0)
  })

  it('an attempt cannot be repointed at another student, even by an admin', async () => {
    const admin = await createUser(base, 'admin')
    const mentor = await createUser(base, 'mentor')
    const student = await createUser(base, 'student')
    const victim = await createUser(base, 'student')
    const quizId = await createQuiz(mentor.id, SAMPLE_QUESTIONS)
    const attemptId = await seedAttempt(student.client, quizId)

    const res = await admin.client.db({
      table: 'quiz_attempts',
      op: 'update',
      values: { user_id: victim.id },
      filters: [{ column: 'id', op: 'eq', value: attemptId }],
    })
    assert.equal(res.status, 400)
    assert.match(String(res.body.error.message), /not writable/i)
  })

  it('only an admin can delete a live quiz session', async () => {
    const admin = await createUser(base, 'admin')
    const mentor = await createUser(base, 'mentor')
    const quizId = await createQuiz(mentor.id, SAMPLE_QUESTIONS)
    const sessionId = await seedSession(quizId, mentor.id, 'SESS01')

    // The host is a mentor, and hosting still does not grant deletion.
    const denied = await mentor.client.db({
      table: 'quiz_sessions',
      op: 'delete',
      filters: [{ column: 'id', op: 'eq', value: sessionId }],
    })
    assert.equal(denied.status, 403)

    const allowed = await admin.client.db({
      table: 'quiz_sessions',
      op: 'delete',
      filters: [{ column: 'id', op: 'eq', value: sessionId }],
    })
    assert.equal(allowed.status, 200)
    const rows = await query('SELECT 1 FROM quiz_sessions WHERE id = $1', [sessionId])
    assert.equal(rows.length, 0)
  })

  it('the live session engine stays closed to writes for everyone', async () => {
    const admin = await createUser(base, 'admin')
    const mentor = await createUser(base, 'mentor')
    const quizId = await createQuiz(mentor.id, SAMPLE_QUESTIONS)
    const sessionId = await seedSession(quizId, mentor.id, 'SESS02')

    // Advancing the question pointer by hand would desync the authoritative clock.
    const res = await admin.client.db({
      table: 'quiz_sessions',
      op: 'update',
      values: { current_question_index: 5 },
      filters: [{ column: 'id', op: 'eq', value: sessionId }],
    })
    assert.equal(res.status, 403)
  })

  it('only an admin can remove a participant from a session', async () => {
    const admin = await createUser(base, 'admin')
    const mentor = await createUser(base, 'mentor')
    const student = await createUser(base, 'student')
    const quizId = await createQuiz(mentor.id, SAMPLE_QUESTIONS)
    const sessionId = await seedSession(quizId, mentor.id, 'SESS03')

    const rows = await query<{ id: string }>(
      `INSERT INTO session_participants (session_id, user_id, nickname)
       VALUES ($1, $2, 'disruptive') RETURNING id`,
      [sessionId, student.id]
    )
    const participantId = rows[0]!.id

    const denied = await student.client.db({
      table: 'session_participants',
      op: 'delete',
      filters: [{ column: 'id', op: 'eq', value: participantId }],
    })
    assert.equal(denied.status, 403)

    const allowed = await admin.client.db({
      table: 'session_participants',
      op: 'delete',
      filters: [{ column: 'id', op: 'eq', value: participantId }],
    })
    assert.equal(allowed.status, 200)
  })

  it('only an admin can move a hackathon member between teams', async () => {
    const admin = await createUser(base, 'admin')
    const leader = await createUser(base, 'student')
    const rival = await createUser(base, 'student')
    const member = await createUser(base, 'student')

    const teamA = await leader.client.db({
      table: 'hackathon_teams',
      op: 'insert',
      values: { team_name: 'Alpha', team_code: 'ALPHA1' },
    })
    const teamB = await rival.client.db({
      table: 'hackathon_teams',
      op: 'insert',
      values: { team_name: 'Beta', team_code: 'BETA01' },
    })

    const joined = await member.client.db({
      table: 'hackathon_team_members',
      op: 'insert',
      values: { team_id: teamA.body.data[0].id },
    })
    assert.equal(joined.status, 200)
    const membershipId = joined.body.data[0].id

    // A leader poaching someone into their own team is exactly what this blocks.
    const denied = await leader.client.db({
      table: 'hackathon_team_members',
      op: 'update',
      values: { team_id: teamB.body.data[0].id },
      filters: [{ column: 'id', op: 'eq', value: membershipId }],
    })
    assert.equal(denied.status, 403)

    const allowed = await admin.client.db({
      table: 'hackathon_team_members',
      op: 'update',
      values: { team_id: teamB.body.data[0].id },
      filters: [{ column: 'id', op: 'eq', value: membershipId }],
    })
    assert.equal(allowed.status, 200)
    assert.equal(allowed.body.data[0].team_id, teamB.body.data[0].id)
  })

  it('a membership row cannot be reassigned to a different person', async () => {
    const admin = await createUser(base, 'admin')
    const leader = await createUser(base, 'student')
    const victim = await createUser(base, 'student')

    const team = await leader.client.db({
      table: 'hackathon_teams',
      op: 'insert',
      values: { team_name: 'Gamma', team_code: 'GAMMA1' },
    })
    const joined = await leader.client.db({
      table: 'hackathon_team_members',
      op: 'insert',
      values: { team_id: team.body.data[0].id },
    })

    const res = await admin.client.db({
      table: 'hackathon_team_members',
      op: 'update',
      values: { user_id: victim.id },
      filters: [{ column: 'id', op: 'eq', value: joined.body.data[0].id }],
    })
    assert.equal(res.status, 400)
    assert.match(String(res.body.error.message), /not writable/i)
  })

  it('only an admin can retract a feedback submission, and nobody can edit one', async () => {
    const admin = await createUser(base, 'admin')
    const mentor = await createUser(base, 'mentor')
    const student = await createUser(base, 'student')

    const submitted = await student.client.db({
      table: 'feedback',
      op: 'insert',
      values: { mentor_id: mentor.id, feedback_type: 'general', rating: 2, title: 'T', message: 'M' },
    })
    assert.equal(submitted.status, 200)
    const feedbackId = submitted.body.data[0].id

    // Rewriting someone's opinion is denied for every role.
    const edited = await admin.client.db({
      table: 'feedback',
      op: 'update',
      values: { message: 'Actually it was great' },
      filters: [{ column: 'id', op: 'eq', value: feedbackId }],
    })
    assert.equal(edited.status, 403)

    const byMentor = await mentor.client.db({
      table: 'feedback',
      op: 'delete',
      filters: [{ column: 'id', op: 'eq', value: feedbackId }],
    })
    assert.equal(byMentor.status, 403, 'a mentor must not delete feedback about themselves')

    const byAdmin = await admin.client.db({
      table: 'feedback',
      op: 'delete',
      filters: [{ column: 'id', op: 'eq', value: feedbackId }],
    })
    assert.equal(byAdmin.status, 200)
  })

  it('the derived leaderboard and answer log stay read-only, admin included', async () => {
    const admin = await createUser(base, 'admin')

    // leaderboard is rebuilt from points_history by trigger; a direct write
    // would drift from the ledger and from profiles.leaderboard_points.
    const board = await admin.client.db({
      table: 'leaderboard',
      op: 'update',
      values: { total_points: 9999 },
      filters: [{ column: 'user_id', op: 'eq', value: admin.id }],
    })
    assert.equal(board.status, 403)

    // session_answers is what scoring derived its points from.
    const answers = await admin.client.db({
      table: 'session_answers',
      op: 'delete',
      filters: [{ column: 'user_id', op: 'eq', value: admin.id }],
    })
    assert.equal(answers.status, 403)
  })
})
