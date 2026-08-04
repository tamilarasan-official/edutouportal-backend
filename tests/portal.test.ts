import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createUser, startTestServer, stopTestServer, truncateAll } from './helpers.js'
import { query } from '../src/db/pool.js'

/**
 * Walks every portal area the way a real user does: admin, mentor, student and
 * coursemaster. Each test exercises the same generic data endpoint the pages
 * call, so a policy or registry gap shows up here rather than in production.
 */

let base: string

before(async () => {
  base = await startTestServer()
})
after(stopTestServer)
beforeEach(truncateAll)

// ---------------------------------------------------------------------------
describe('admin portal', () => {
  it('lists users with roles for the dashboard', async () => {
    const admin = await createUser(base, 'admin')
    await createUser(base, 'student')
    await createUser(base, 'mentor')

    const res = await admin.client.db({
      table: 'profiles',
      op: 'select',
      select: 'id, full_name, email, role, created_at',
      order: [{ column: 'created_at', ascending: false }],
    })

    assert.equal(res.status, 200)
    assert.equal(res.body.data.length, 3)
    assert.ok(res.body.data.every((r: any) => r.role))
  })

  it('counts users with a head+count query', async () => {
    const admin = await createUser(base, 'admin')
    await createUser(base, 'student')

    const res = await admin.client.db({
      table: 'profiles',
      op: 'select',
      count: true,
      limit: 1,
    })

    assert.equal(res.status, 200)
    assert.equal(res.body.count, 2)
  })

  it('assigns a mentor to a student', async () => {
    const admin = await createUser(base, 'admin')
    const mentor = await createUser(base, 'mentor')
    const student = await createUser(base, 'student')

    const res = await admin.client.db({
      table: 'mentor_assignments',
      op: 'insert',
      values: { student_id: student.id, mentor_id: mentor.id, status: 'active' },
    })

    assert.equal(res.status, 200)
    assert.equal(res.body.data[0].assigned_by, admin.id, 'assigned_by is server-set')
  })

  it('a student cannot create a mentor assignment', async () => {
    const mentor = await createUser(base, 'mentor')
    const student = await createUser(base, 'student')

    const res = await student.client.db({
      table: 'mentor_assignments',
      op: 'insert',
      values: { student_id: student.id, mentor_id: mentor.id },
    })
    assert.equal(res.status, 403)
  })

  it('edits the points configuration', async () => {
    const admin = await createUser(base, 'admin')

    const configs = await admin.client.db({ table: 'points_config', op: 'select' })
    assert.ok(configs.body.data.length >= 10, 'seed data should be present')

    const target = configs.body.data.find((c: any) => c.action_type === 'daily_login')
    const res = await admin.client.db({
      table: 'points_config',
      op: 'update',
      values: { points: 25 },
      filters: [{ column: 'id', op: 'eq', value: target.id }],
    })

    assert.equal(res.status, 200)
    assert.equal(res.body.data[0].points, 25)
  })

  it('a student cannot edit the points configuration', async () => {
    const student = await createUser(base, 'student')
    const res = await student.client.db({
      table: 'points_config',
      op: 'update',
      values: { points: 100000 },
      filters: [{ column: 'action_type', op: 'eq', value: 'daily_login' }],
    })
    assert.equal(res.status, 403)
  })

  it('broadcasts a notification to all students', async () => {
    const admin = await createUser(base, 'admin')
    const student = await createUser(base, 'student')

    const created = await admin.client.db({
      table: 'notifications',
      op: 'insert',
      values: { title: 'Exam', message: 'Tomorrow', target_audience: 'all_students' },
    })
    assert.equal(created.status, 200)
    assert.equal(created.body.data[0].created_by_role, 'admin', 'role is server-set')

    const seen = await student.client.db({ table: 'notifications', op: 'select' })
    assert.equal(seen.body.data.length, 1)
  })
})

// ---------------------------------------------------------------------------
describe('mentor portal', () => {
  it('creates a task with steps and assigns it', async () => {
    const mentor = await createUser(base, 'mentor')
    const student = await createUser(base, 'student')

    const task = await mentor.client.db({
      table: 'tasks',
      op: 'insert',
      values: { title: 'Build a page', description: 'React basics', points: 50 },
    })
    assert.equal(task.status, 200)
    assert.equal(task.body.data[0].mentor_id, mentor.id, 'creator is server-set')
    const taskId = task.body.data[0].id

    const steps = await mentor.client.db({
      table: 'task_steps',
      op: 'insert',
      values: [
        { task_id: taskId, step_number: 1, title: 'Setup', submission_type: 'text', is_required: true },
        { task_id: taskId, step_number: 2, title: 'Deploy', submission_type: 'link', is_required: true },
      ],
    })
    assert.equal(steps.status, 200)
    assert.equal(steps.body.data.length, 2)

    // managetask sends assigned_by with every assignment it creates; here it
    // names someone else, which the insert policy must overwrite rather than
    // reject.
    const assigned = await mentor.client.db({
      table: 'task_assignments',
      op: 'insert',
      values: { task_id: taskId, student_id: student.id, assigned_by: student.id },
    })
    assert.equal(assigned.status, 200)
    assert.equal(assigned.body.data[0].assigned_by, mentor.id, 'assigned_by is server-set')
  })

  it('does not let a student rewrite who assigned their task', async () => {
    const mentor = await createUser(base, 'mentor')
    const student = await createUser(base, 'student')

    const task = await mentor.client.db({
      table: 'tasks',
      op: 'insert',
      values: { title: 'Build a page', description: 'React basics' },
    })
    const assigned = await mentor.client.db({
      table: 'task_assignments',
      op: 'insert',
      values: { task_id: task.body.data[0].id, student_id: student.id },
    })

    const res = await student.client.db({
      table: 'task_assignments',
      op: 'update',
      values: { assigned_by: student.id },
      filters: [{ column: 'id', op: 'eq', value: assigned.body.data[0].id }],
    })
    assert.equal(res.status, 400)
  })

  it('a student cannot create a task', async () => {
    const student = await createUser(base, 'student')
    const res = await student.client.db({
      table: 'tasks',
      op: 'insert',
      values: { title: 'Fake', description: 'x' },
    })
    assert.equal(res.status, 403)
  })

  it('sees only its own assigned students in points history', async () => {
    const admin = await createUser(base, 'admin')
    const mentor = await createUser(base, 'mentor')
    const mine = await createUser(base, 'student')
    const theirs = await createUser(base, 'student')

    await admin.client.db({
      table: 'mentor_assignments',
      op: 'insert',
      values: { student_id: mine.id, mentor_id: mentor.id, status: 'active' },
    })

    await admin.client.post('/api/rpc/adjust_points_manual', {
      p_user_id: mine.id,
      p_action_type: 'manual_points_add',
      p_points: 10,
    })
    await admin.client.post('/api/rpc/adjust_points_manual', {
      p_user_id: theirs.id,
      p_action_type: 'manual_points_add',
      p_points: 10,
    })

    const res = await mentor.client.db({ table: 'points_history', op: 'select' })
    assert.equal(res.status, 200)
    assert.equal(res.body.data.length, 1)
    assert.equal(res.body.data[0].user_id, mine.id)
  })

  it('uploads a shared resource record', async () => {
    const mentor = await createUser(base, 'mentor')

    const res = await mentor.client.db({
      table: 'resources',
      op: 'insert',
      values: {
        file_name: 'notes.pdf',
        file_url: 'http://example/notes.pdf',
        file_type: 'application/pdf',
        file_size: 1024,
        tags: ['react', 'basics'],
        description: 'Week 1',
      },
    })

    assert.equal(res.status, 200)
    assert.equal(res.body.data[0].uploaded_by, mentor.id)
    assert.deepEqual(res.body.data[0].tags, ['react', 'basics'])
  })

  it('a student cannot publish a resource', async () => {
    const student = await createUser(base, 'student')
    const res = await student.client.db({
      table: 'resources',
      op: 'insert',
      values: { file_name: 'x.pdf', tags: [] },
    })
    assert.equal(res.status, 403)
  })

  it('creates and publishes a quiz', async () => {
    const mentor = await createUser(base, 'mentor')

    const created = await mentor.client.db({
      table: 'quizzes',
      op: 'insert',
      values: {
        title: 'JS Basics',
        description: 'intro',
        questions: [{ id: 'q1', question: 'x?', options: ['a', 'b'], correctOptionIndex: 0 }],
        status: 'draft',
        quiz_code: 'ABC123',
      },
    })
    assert.equal(created.status, 200)

    const published = await mentor.client.db({
      table: 'quizzes',
      op: 'update',
      values: { status: 'published', updated_at: new Date().toISOString() },
      filters: [{ column: 'id', op: 'eq', value: created.body.data[0].id }],
    })
    assert.equal(published.status, 200)
    assert.equal(published.body.data[0].status, 'published')
  })

  it('a student sees published quizzes but not drafts', async () => {
    const mentor = await createUser(base, 'mentor')
    const student = await createUser(base, 'student')

    await mentor.client.db({
      table: 'quizzes',
      op: 'insert',
      values: [
        { title: 'Draft one', questions: [], status: 'draft' },
        { title: 'Live one', questions: [], status: 'published' },
      ],
    })

    const res = await student.client.db({ table: 'quizzes', op: 'select' })
    assert.equal(res.body.data.length, 1)
    assert.equal(res.body.data[0].title, 'Live one')
  })
})

// ---------------------------------------------------------------------------
describe('student portal: tasks', () => {
  it('completes a task step end to end', async () => {
    const mentor = await createUser(base, 'mentor')
    const student = await createUser(base, 'student')

    const task = await mentor.client.db({
      table: 'tasks',
      op: 'insert',
      values: { title: 'T', description: 'd' },
    })
    const taskId = task.body.data[0].id

    const step = await mentor.client.db({
      table: 'task_steps',
      op: 'insert',
      values: { task_id: taskId, step_number: 1, title: 'S1', submission_type: 'text' },
    })
    const stepId = step.body.data[0].id

    const assignment = await mentor.client.db({
      table: 'task_assignments',
      op: 'insert',
      values: { task_id: taskId, student_id: student.id },
    })
    const assignmentId = assignment.body.data[0].id

    // Student sees their assignment, with the task embedded.
    const mine = await student.client.db({
      table: 'task_assignments',
      op: 'select',
      select: '*, task:tasks(*)',
    })
    assert.equal(mine.status, 200)
    assert.equal(mine.body.data.length, 1)
    assert.equal(mine.body.data[0].task.title, 'T')

    // Submit the step.
    const completion = await student.client.db({
      table: 'task_step_completions',
      op: 'insert',
      values: {
        assignment_id: assignmentId,
        step_id: stepId,
        submission_type: 'text',
        text_content: 'my answer',
        is_completed: true,
        completed_at: new Date().toISOString(),
      },
    })
    assert.equal(completion.status, 200)

    // Move the assignment forward.
    const progressed = await student.client.db({
      table: 'task_assignments',
      op: 'update',
      values: { status: 'in_progress', started_at: new Date().toISOString() },
      filters: [{ column: 'id', op: 'eq', value: assignmentId }],
    })
    assert.equal(progressed.status, 200)
    assert.equal(progressed.body.data[0].status, 'in_progress')
  })

  it("a student cannot submit against another student's assignment", async () => {
    const mentor = await createUser(base, 'mentor')
    const victim = await createUser(base, 'student')
    const attacker = await createUser(base, 'student')

    const task = await mentor.client.db({
      table: 'tasks',
      op: 'insert',
      values: { title: 'T', description: 'd' },
    })
    const taskId = task.body.data[0].id
    const step = await mentor.client.db({
      table: 'task_steps',
      op: 'insert',
      values: { task_id: taskId, step_number: 1, title: 'S1', submission_type: 'text' },
    })
    const assignment = await mentor.client.db({
      table: 'task_assignments',
      op: 'insert',
      values: { task_id: taskId, student_id: victim.id },
    })

    const res = await attacker.client.db({
      table: 'task_step_completions',
      op: 'insert',
      values: {
        assignment_id: assignment.body.data[0].id,
        step_id: step.body.data[0].id,
        text_content: 'hijacked',
        is_completed: true,
      },
    })

    // The WITH CHECK verification rolls the insert back.
    assert.equal(res.status, 403)
    const rows = await query('SELECT 1 FROM task_step_completions')
    assert.equal(rows.length, 0)
  })
})

// ---------------------------------------------------------------------------
describe('student portal: discussions', () => {
  it('posts, comments and votes', async () => {
    const author = await createUser(base, 'student')
    const reader = await createUser(base, 'student')

    const thread = await author.client.db({
      table: 'discussions',
      op: 'insert',
      values: { title: 'How do hooks work?', description: 'asking', category: 'general' },
    })
    assert.equal(thread.status, 200)
    const threadId = thread.body.data[0].id

    const comment = await reader.client.db({
      table: 'discussion_comments',
      op: 'insert',
      values: { discussion_id: threadId, content: 'Like this' },
    })
    assert.equal(comment.status, 200)
    assert.equal(comment.body.data[0].user_id, reader.id)

    const vote = await reader.client.db({
      table: 'discussion_votes',
      op: 'insert',
      values: { discussion_id: threadId, vote_type: 'up' },
    })
    assert.equal(vote.status, 200)

    // The vote trigger maintains the denormalised counter.
    const counts = await query<{ upvotes: number }>(
      'SELECT upvotes FROM discussions WHERE id = $1',
      [threadId]
    )
    assert.equal(counts[0]!.upvotes, 1)
  })

  it('reads threads with the author profile embedded', async () => {
    const author = await createUser(base, 'student', { fullName: 'Ada Lovelace' })

    await author.client.db({
      table: 'discussions',
      op: 'insert',
      values: { title: 'T', description: 'd', category: 'general' },
    })

    const res = await author.client.db({
      table: 'discussions',
      op: 'select',
      select: '*, profiles:user_id(full_name, email)',
    })

    assert.equal(res.status, 200)
    assert.equal(res.body.data[0].profiles.full_name, 'Ada Lovelace')
  })

  it('one vote per user per thread', async () => {
    const author = await createUser(base, 'student')
    const thread = await author.client.db({
      table: 'discussions',
      op: 'insert',
      values: { title: 'T', description: 'd', category: 'general' },
    })
    const threadId = thread.body.data[0].id

    await author.client.db({
      table: 'discussion_votes',
      op: 'insert',
      values: { discussion_id: threadId, vote_type: 'up' },
    })
    const second = await author.client.db({
      table: 'discussion_votes',
      op: 'insert',
      values: { discussion_id: threadId, vote_type: 'down' },
    })

    assert.equal(second.status, 409)
  })

  it('a student cannot pin their own thread', async () => {
    const author = await createUser(base, 'student')
    const thread = await author.client.db({
      table: 'discussions',
      op: 'insert',
      values: { title: 'T', description: 'd', category: 'general' },
    })

    const res = await author.client.db({
      table: 'discussions',
      op: 'update',
      values: { is_pinned: true },
      filters: [{ column: 'id', op: 'eq', value: thread.body.data[0].id }],
    })
    assert.equal(res.status, 400)
  })
})

// ---------------------------------------------------------------------------
describe('student portal: hackathon teams', () => {
  it('creates a team and adds the leader as a member', async () => {
    const leader = await createUser(base, 'student')

    const team = await leader.client.db({
      table: 'hackathon_teams',
      op: 'insert',
      values: { team_name: 'Rockets', team_code: 'RCKT01', max_members: 4 },
    })
    assert.equal(team.status, 200)
    assert.equal(team.body.data[0].leader_id, leader.id)

    const member = await leader.client.db({
      table: 'hackathon_team_members',
      op: 'insert',
      values: { team_id: team.body.data[0].id },
    })
    assert.equal(member.status, 200)
    assert.equal(member.body.data[0].user_id, leader.id)
  })

  it('a user can belong to only one team', async () => {
    const user = await createUser(base, 'student')

    const teamA = await user.client.db({
      table: 'hackathon_teams',
      op: 'insert',
      values: { team_name: 'A', team_code: 'AAA111' },
    })
    const teamB = await user.client.db({
      table: 'hackathon_teams',
      op: 'insert',
      values: { team_name: 'B', team_code: 'BBB222' },
    })

    await user.client.db({
      table: 'hackathon_team_members',
      op: 'insert',
      values: { team_id: teamA.body.data[0].id },
    })
    const second = await user.client.db({
      table: 'hackathon_team_members',
      op: 'insert',
      values: { team_id: teamB.body.data[0].id },
    })

    assert.equal(second.status, 409)
  })

  it('a user cannot add somebody else to a team', async () => {
    const leader = await createUser(base, 'student')
    const victim = await createUser(base, 'student')

    const team = await leader.client.db({
      table: 'hackathon_teams',
      op: 'insert',
      values: { team_name: 'X', team_code: 'XXX333' },
    })

    const res = await leader.client.db({
      table: 'hackathon_team_members',
      op: 'insert',
      values: { team_id: team.body.data[0].id, user_id: victim.id },
    })

    // user_id is forced to the caller, so the row belongs to the leader.
    assert.equal(res.status, 200)
    assert.equal(res.body.data[0].user_id, leader.id)
  })
})

// ---------------------------------------------------------------------------
describe('student portal: feedback and settings', () => {
  it('submits feedback about a mentor', async () => {
    const mentor = await createUser(base, 'mentor')
    const student = await createUser(base, 'student')

    const res = await student.client.db({
      table: 'feedback',
      op: 'insert',
      values: {
        mentor_id: mentor.id,
        feedback_type: 'mentor',
        rating: 5,
        title: 'Great',
        message: 'Very helpful',
      },
    })

    assert.equal(res.status, 200)
    assert.equal(res.body.data[0].student_id, student.id)

    // The mentor can read feedback about themselves.
    const seen = await mentor.client.db({ table: 'feedback', op: 'select' })
    assert.equal(seen.body.data.length, 1)
  })

  it('rejects an out-of-range rating', async () => {
    const student = await createUser(base, 'student')
    const res = await student.client.db({
      table: 'feedback',
      op: 'insert',
      values: { feedback_type: 'general', rating: 99, message: 'x' },
    })
    assert.equal(res.status, 400)
  })

  it('updates the profile but cannot touch role or points', async () => {
    const student = await createUser(base, 'student')

    const ok = await student.client.db({
      table: 'profiles',
      op: 'update',
      values: { full_name: 'Renamed', phone: '+1234', bio: 'hi' },
      filters: [{ column: 'id', op: 'eq', value: student.id }],
    })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.data[0].full_name, 'Renamed')

    const nope = await student.client.db({
      table: 'profiles',
      op: 'update',
      values: { full_name: 'X', role: 'admin' },
      filters: [{ column: 'id', op: 'eq', value: student.id }],
    })
    assert.equal(nope.status, 400)
  })

  it("cannot rename another user's profile", async () => {
    const victim = await createUser(base, 'student')
    const attacker = await createUser(base, 'student')

    const res = await attacker.client.db({
      table: 'profiles',
      op: 'update',
      values: { full_name: 'Hacked' },
      filters: [{ column: 'id', op: 'eq', value: victim.id }],
    })

    assert.equal(res.status, 200)
    assert.equal(res.body.data.length, 0, 'filter must match zero rows')
  })
})

// ---------------------------------------------------------------------------
describe('coursemaster portal', () => {
  it('manages the session tracker checklist', async () => {
    const cm = await createUser(base, 'coursemaster')

    const created = await cm.client.db({
      table: 'session_tracker',
      op: 'insert',
      values: { title: 'Week 1', completed: false, order: 1 },
    })
    assert.equal(created.status, 200)
    assert.equal(created.body.data[0].coursemaster_id, cm.id)

    // `order` is a reserved word; this proves the builder quotes identifiers.
    const listed = await cm.client.db({
      table: 'session_tracker',
      op: 'select',
      order: [{ column: 'order', ascending: true }],
    })
    assert.equal(listed.status, 200)

    const done = await cm.client.db({
      table: 'session_tracker',
      op: 'update',
      values: { completed: true },
      filters: [{ column: 'id', op: 'eq', value: created.body.data[0].id }],
    })
    assert.equal(done.body.data[0].completed, true)
  })

  it('a student cannot create tracker items', async () => {
    const student = await createUser(base, 'student')
    const res = await student.client.db({
      table: 'session_tracker',
      op: 'insert',
      values: { title: 'Nope', order: 1 },
    })
    assert.equal(res.status, 403)
  })
})

// ---------------------------------------------------------------------------
describe('points ledger consistency', () => {
  it('keeps points_history, leaderboard and profiles in agreement', async () => {
    const admin = await createUser(base, 'admin')
    const student = await createUser(base, 'student')

    for (const amount of [10, 25, 5]) {
      const res = await admin.client.post('/api/rpc/adjust_points_manual', {
        p_user_id: student.id,
        p_action_type: 'manual_points_add',
        p_points: amount,
      })
      assert.equal(res.status, 200)
    }

    const expected = 40

    const ledger = await query<{ total: string }>(
      'SELECT COALESCE(SUM(points),0)::int AS total FROM points_history WHERE user_id = $1',
      [student.id]
    )
    const board = await query<{ total_points: number }>(
      'SELECT total_points FROM leaderboard WHERE user_id = $1',
      [student.id]
    )
    const profile = await query<{ leaderboard_points: number }>(
      'SELECT leaderboard_points FROM profiles WHERE id = $1',
      [student.id]
    )

    assert.equal(Number(ledger[0]!.total), expected)
    assert.equal(board[0]!.total_points, expected)
    assert.equal(profile[0]!.leaderboard_points, expected)
  })

  it('supports negative adjustments', async () => {
    const admin = await createUser(base, 'admin')
    const student = await createUser(base, 'student')

    await admin.client.post('/api/rpc/adjust_points_manual', {
      p_user_id: student.id,
      p_action_type: 'manual_points_add',
      p_points: 100,
    })
    await admin.client.post('/api/rpc/adjust_points_manual', {
      p_user_id: student.id,
      p_action_type: 'manual_points_subtract',
      p_points: -30,
    })

    const profile = await query<{ leaderboard_points: number }>(
      'SELECT leaderboard_points FROM profiles WHERE id = $1',
      [student.id]
    )
    assert.equal(profile[0]!.leaderboard_points, 70)
  })

  it('award_points does not double-credit the same reference', async () => {
    const student = await createUser(base, 'student')

    const first = await student.client.post('/api/rpc/award_points', {
      p_user_id: student.id,
      p_action_type: 'discussion_create',
      p_reference_id: 'thread-1',
      p_reference_type: 'discussion',
    })
    const second = await student.client.post('/api/rpc/award_points', {
      p_user_id: student.id,
      p_action_type: 'discussion_create',
      p_reference_id: 'thread-1',
      p_reference_type: 'discussion',
    })

    assert.equal(first.body.data, 20)
    assert.equal(second.body.data, 0, 'repeat award must be a no-op')

    const profile = await query<{ leaderboard_points: number }>(
      'SELECT leaderboard_points FROM profiles WHERE id = $1',
      [student.id]
    )
    assert.equal(profile[0]!.leaderboard_points, 20)
  })

  it('award_points ignores a disabled action', async () => {
    const admin = await createUser(base, 'admin')
    const student = await createUser(base, 'student')

    await admin.client.db({
      table: 'points_config',
      op: 'update',
      values: { is_active: false },
      filters: [{ column: 'action_type', op: 'eq', value: 'daily_login' }],
    })

    const res = await student.client.post('/api/rpc/award_points', {
      p_user_id: student.id,
      p_action_type: 'daily_login',
    })
    assert.equal(res.body.data, 0)
  })

  it('reports the leaderboard ordered by points', async () => {
    const admin = await createUser(base, 'admin')
    const low = await createUser(base, 'student')
    const high = await createUser(base, 'student')

    await admin.client.post('/api/rpc/adjust_points_manual', {
      p_user_id: low.id,
      p_action_type: 'manual_points_add',
      p_points: 10,
    })
    await admin.client.post('/api/rpc/adjust_points_manual', {
      p_user_id: high.id,
      p_action_type: 'manual_points_add',
      p_points: 90,
    })

    const res = await low.client.db({
      table: 'profiles',
      op: 'select',
      select: 'id, full_name, leaderboard_points',
      order: [{ column: 'leaderboard_points', ascending: false }],
    })

    assert.equal(res.status, 200)
    assert.equal(res.body.data[0].id, high.id)
    assert.equal(res.body.data[0].leaderboard_points, 90)
  })
})
