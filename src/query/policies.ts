import type { TableName } from './schema.js'

/**
 * Authorization policies.
 *
 * This file is the replacement for the Row Level Security policies that the
 * old project listed as a TODO and never wrote. Every request through the
 * generic query endpoint is checked here before any SQL runs.
 *
 * A policy returns one of:
 *   - deny                       -> 403
 *   - allow with no filter       -> the whole table is visible/writable
 *   - allow with a filter        -> the filter is ANDed into the WHERE clause,
 *                                   so it constrains reads AND the rows an
 *                                   UPDATE or DELETE can reach
 *
 * `redact` additionally strips columns from returned rows -- used so students
 * can see who wrote a discussion post without seeing everyone's email address.
 */

export type Role = 'admin' | 'mentor' | 'student' | 'coursemaster'

export interface Actor {
  readonly userId: string
  readonly role: Role
}

export type Operation = 'select' | 'insert' | 'update' | 'delete'

export interface RowFilter {
  /** SQL fragment referencing the base table as `t`. Uses $$ placeholders. */
  readonly sql: string
  readonly params: readonly unknown[]
}

export type PolicyResult =
  | { readonly allow: false; readonly reason: string }
  | {
      readonly allow: true
      readonly filter?: RowFilter
      /** Columns to strip from rows belonging to someone else. */
      readonly redact?: readonly string[]
      /** Force these column values on insert/update, ignoring the client. */
      readonly force?: Readonly<Record<string, unknown>>
    }

const ALLOW: PolicyResult = { allow: true }
const deny = (reason: string): PolicyResult => ({ allow: false, reason })

const own = (column: string, actor: Actor): RowFilter => ({
  sql: `t.${column} = $$`,
  params: [actor.userId],
})

const isStaff = (a: Actor) => a.role === 'admin' || a.role === 'mentor'

/**
 * Rows belonging to students this mentor is assigned, plus the mentor's own.
 * Admins bypass this entirely.
 */
const ownStudents = (column: string, actor: Actor): RowFilter => ({
  sql: `(t.${column} = $$ OR t.${column} IN (
           SELECT ma.student_id FROM mentor_assignments ma
            WHERE ma.mentor_id = $$ AND ma.status = 'active'))`,
  params: [actor.userId, actor.userId],
})

type PolicyFn = (actor: Actor) => PolicyResult

const POLICIES: Record<TableName, Partial<Record<Operation, PolicyFn>>> = {
  // ---------------------------------------------------------------------------
  profiles: {
    // Everyone can see everyone -- the leaderboard, discussion authors and the
    // team roster all need names. Contact details are redacted for non-staff.
    select: (a) =>
      isStaff(a) ? ALLOW : { allow: true, redact: ['email', 'phone', 'bio'] },
    // Self-heal insert only, and only for your own id.
    insert: (a) => ({ allow: true, force: { id: a.userId } }),
    update: (a) => (a.role === 'admin' ? ALLOW : { allow: true, filter: own('id', a) }),
    delete: () => deny('Profiles are deleted by removing the user account'),
  },

  // ---------------------------------------------------------------------------
  quizzes: {
    // Students need to read a published quiz to sit it. Drafts stay private to
    // their author. Note this still returns correctOptionIndex inside the
    // questions blob -- the live-quiz path deliberately does NOT go through
    // this endpoint for that reason; see quiz/routes.ts.
    select: (a) =>
      isStaff(a)
        ? ALLOW
        : { allow: true, filter: { sql: `t.status = 'published'`, params: [] } },
    insert: (a) =>
      isStaff(a) ? { allow: true, force: { created_by: a.userId } } : deny('Mentors only'),
    update: (a) =>
      a.role === 'admin' ? ALLOW : isStaff(a) ? { allow: true, filter: own('created_by', a) } : deny('Mentors only'),
    delete: (a) =>
      a.role === 'admin' ? ALLOW : isStaff(a) ? { allow: true, filter: own('created_by', a) } : deny('Mentors only'),
  },

  quiz_sessions: {
    // Read-only here. Everything that mutates a session goes through /api/quiz.
    select: () => ALLOW,
  },

  session_participants: {
    // A participant list is public within a session -- the lobby shows it.
    select: () => ALLOW,
  },

  session_answers: {
    // Your own answers, or any answer if you host the session. Without the
    // host clause a student could read the whole class's submissions.
    select: (a) =>
      a.role === 'admin'
        ? ALLOW
        : {
            allow: true,
            filter: {
              sql: `(t.user_id = $$ OR t.session_id IN (
                      SELECT qs.id FROM quiz_sessions qs WHERE qs.host_id = $$))`,
              params: [a.userId, a.userId],
            },
          },
  },

  session_events: {
    select: (a) =>
      a.role === 'admin'
        ? ALLOW
        : {
            allow: true,
            filter: {
              sql: `t.session_id IN (SELECT qs.id FROM quiz_sessions qs WHERE qs.host_id = $$)`,
              params: [a.userId],
            },
          },
  },

  quiz_attempts: {
    select: (a) => (isStaff(a) ? ALLOW : { allow: true, filter: own('user_id', a) }),
    insert: (a) => ({ allow: true, force: { user_id: a.userId } }),
  },

  // ---------------------------------------------------------------------------
  points_config: {
    select: () => ALLOW,
    insert: (a) => (a.role === 'admin' ? ALLOW : deny('Admins only')),
    update: (a) => (a.role === 'admin' ? ALLOW : deny('Admins only')),
    delete: (a) => (a.role === 'admin' ? ALLOW : deny('Admins only')),
  },

  points_history: {
    select: (a) =>
      a.role === 'admin'
        ? ALLOW
        : a.role === 'mentor'
        ? { allow: true, filter: ownStudents('user_id', a) }
        : { allow: true, filter: own('user_id', a) },
  },

  leaderboard: {
    // Public by design.
    select: () => ALLOW,
  },

  // ---------------------------------------------------------------------------
  tasks: {
    select: () => ALLOW,
    insert: (a) =>
      isStaff(a) ? { allow: true, force: { mentor_id: a.userId } } : deny('Mentors only'),
    update: (a) =>
      a.role === 'admin' ? ALLOW : isStaff(a) ? { allow: true, filter: own('mentor_id', a) } : deny('Mentors only'),
    delete: (a) =>
      a.role === 'admin' ? ALLOW : isStaff(a) ? { allow: true, filter: own('mentor_id', a) } : deny('Mentors only'),
  },

  task_steps: {
    select: () => ALLOW,
    insert: (a) => (isStaff(a) ? ALLOW : deny('Mentors only')),
    update: (a) => (isStaff(a) ? ALLOW : deny('Mentors only')),
    delete: (a) => (isStaff(a) ? ALLOW : deny('Mentors only')),
  },

  task_assignments: {
    select: (a) =>
      a.role === 'admin'
        ? ALLOW
        : a.role === 'mentor'
        ? { allow: true, filter: ownStudents('student_id', a) }
        : { allow: true, filter: own('student_id', a) },
    // assigned_by is server-set: the client sends its own id, but trusting it
    // would let one mentor record an assignment under another's name.
    insert: (a) =>
      isStaff(a) ? { allow: true, force: { assigned_by: a.userId } } : deny('Mentors only'),
    // A student may move their own assignment forward (e.g. to 'submitted');
    // mentors may update anyone they own.
    update: (a) =>
      a.role === 'admin'
        ? ALLOW
        : a.role === 'mentor'
        ? { allow: true, filter: ownStudents('student_id', a) }
        : { allow: true, filter: own('student_id', a) },
    delete: (a) => (isStaff(a) ? ALLOW : deny('Mentors only')),
  },

  task_step_completions: {
    // Scoped through the parent assignment, since this table has no user column.
    select: (a) =>
      a.role === 'admin'
        ? ALLOW
        : a.role === 'mentor'
        ? {
            allow: true,
            filter: {
              sql: `t.assignment_id IN (
                      SELECT ta.id FROM task_assignments ta
                       WHERE ta.student_id = $$
                          OR ta.student_id IN (SELECT ma.student_id FROM mentor_assignments ma
                                                WHERE ma.mentor_id = $$ AND ma.status = 'active'))`,
              params: [a.userId, a.userId],
            },
          }
        : {
            allow: true,
            filter: {
              sql: `t.assignment_id IN (
                      SELECT ta.id FROM task_assignments ta WHERE ta.student_id = $$)`,
              params: [a.userId],
            },
          },
    insert: (a) => ({
      allow: true,
      filter: {
        sql: `t.assignment_id IN (SELECT ta.id FROM task_assignments ta WHERE ta.student_id = $$)`,
        params: [a.userId],
      },
    }),
    update: (a) =>
      isStaff(a)
        ? ALLOW
        : {
            allow: true,
            filter: {
              sql: `t.assignment_id IN (SELECT ta.id FROM task_assignments ta WHERE ta.student_id = $$)`,
              params: [a.userId],
            },
          },
    delete: (a) => ({
      allow: true,
      filter: {
        sql: `t.assignment_id IN (SELECT ta.id FROM task_assignments ta WHERE ta.student_id = $$)`,
        params: [a.userId],
      },
    }),
  },

  // ---------------------------------------------------------------------------
  discussions: {
    select: () => ALLOW,
    insert: (a) => ({ allow: true, force: { user_id: a.userId } }),
    update: (a) => (a.role === 'admin' ? ALLOW : { allow: true, filter: own('user_id', a) }),
    delete: (a) => (a.role === 'admin' ? ALLOW : { allow: true, filter: own('user_id', a) }),
  },

  discussion_comments: {
    select: () => ALLOW,
    insert: (a) => ({ allow: true, force: { user_id: a.userId } }),
    update: (a) => (a.role === 'admin' ? ALLOW : { allow: true, filter: own('user_id', a) }),
    delete: (a) => (a.role === 'admin' ? ALLOW : { allow: true, filter: own('user_id', a) }),
  },

  discussion_votes: {
    select: () => ALLOW,
    insert: (a) => ({ allow: true, force: { user_id: a.userId } }),
    update: (a) => ({ allow: true, filter: own('user_id', a) }),
    delete: (a) => ({ allow: true, filter: own('user_id', a) }),
  },

  // ---------------------------------------------------------------------------
  hackathon_teams: {
    select: () => ALLOW,
    insert: (a) => ({ allow: true, force: { leader_id: a.userId } }),
    update: (a) => (isStaff(a) ? ALLOW : { allow: true, filter: own('leader_id', a) }),
    delete: (a) => (isStaff(a) ? ALLOW : { allow: true, filter: own('leader_id', a) }),
  },

  hackathon_team_members: {
    select: () => ALLOW,
    // You add yourself to a team; you cannot add someone else.
    insert: (a) => ({ allow: true, force: { user_id: a.userId } }),
    // Leaving is self-service; a team leader can also remove a member.
    delete: (a) =>
      isStaff(a)
        ? ALLOW
        : {
            allow: true,
            filter: {
              sql: `(t.user_id = $$ OR t.team_id IN (
                      SELECT ht.id FROM hackathon_teams ht WHERE ht.leader_id = $$))`,
              params: [a.userId, a.userId],
            },
          },
  },

  // ---------------------------------------------------------------------------
  resources: {
    select: () => ALLOW,
    insert: (a) =>
      isStaff(a) ? { allow: true, force: { uploaded_by: a.userId } } : deny('Mentors only'),
    update: (a) =>
      a.role === 'admin' ? ALLOW : { allow: true, filter: own('uploaded_by', a) },
    delete: (a) =>
      a.role === 'admin' ? ALLOW : { allow: true, filter: own('uploaded_by', a) },
  },

  notifications: {
    // Delivery scoping: a student sees broadcasts plus notifications from the
    // mentor they are assigned to.
    select: (a) =>
      isStaff(a)
        ? ALLOW
        : {
            allow: true,
            filter: {
              sql: `(t.target_audience = 'all_students'
                     OR t.mentor_id IN (SELECT ma.mentor_id FROM mentor_assignments ma
                                         WHERE ma.student_id = $$ AND ma.status = 'active'))`,
              params: [a.userId],
            },
          },
    insert: (a) =>
      isStaff(a)
        ? { allow: true, force: { created_by: a.userId, created_by_role: a.role } }
        : deny('Mentors only'),
    update: (a) => (isStaff(a) ? { allow: true, filter: own('created_by', a) } : deny('Mentors only')),
    delete: (a) =>
      a.role === 'admin' ? ALLOW : isStaff(a) ? { allow: true, filter: own('created_by', a) } : deny('Mentors only'),
  },

  notification_reads: {
    select: (a) => ({ allow: true, filter: own('user_id', a) }),
    insert: (a) => ({ allow: true, force: { user_id: a.userId } }),
    delete: (a) => ({ allow: true, filter: own('user_id', a) }),
  },

  session_tracker: {
    select: () => ALLOW,
    insert: (a) =>
      a.role === 'coursemaster' || a.role === 'admin'
        ? { allow: true, force: { coursemaster_id: a.userId } }
        : deny('Coursemasters only'),
    update: (a) =>
      a.role === 'admin' ? ALLOW : { allow: true, filter: own('coursemaster_id', a) },
    delete: (a) =>
      a.role === 'admin' ? ALLOW : { allow: true, filter: own('coursemaster_id', a) },
  },

  // ---------------------------------------------------------------------------
  mentor_assignments: {
    select: () => ALLOW,
    insert: (a) => (a.role === 'admin' ? { allow: true, force: { assigned_by: a.userId } } : deny('Admins only')),
    update: (a) => (a.role === 'admin' ? { allow: true, force: { assigned_by: a.userId } } : deny('Admins only')),
    delete: (a) => (a.role === 'admin' ? ALLOW : deny('Admins only')),
  },

  feedback: {
    select: (a) =>
      a.role === 'admin'
        ? ALLOW
        : a.role === 'mentor'
        ? {
            allow: true,
            filter: { sql: `(t.mentor_id = $$ OR t.student_id = $$)`, params: [a.userId, a.userId] },
          }
        : { allow: true, filter: own('student_id', a) },
    insert: (a) => ({ allow: true, force: { student_id: a.userId } }),
  },

  feedback_sessions: {
    select: (a) =>
      isStaff(a) ? ALLOW : { allow: true, filter: { sql: `t.status = 'active'`, params: [] } },
    insert: (a) => (a.role === 'admin' ? { allow: true, force: { created_by: a.userId } } : deny('Admins only')),
    update: (a) => (a.role === 'admin' ? ALLOW : deny('Admins only')),
    delete: (a) => (a.role === 'admin' ? ALLOW : deny('Admins only')),
  },

  session_feedback_responses: {
    // Staff read responses in aggregate; a student sees only their own.
    select: (a) => (isStaff(a) ? ALLOW : { allow: true, filter: own('user_id', a) }),
    insert: (a) => ({ allow: true, force: { user_id: a.userId } }),
  },
}

/**
 * Resolve the policy for one table+operation. Anything not explicitly granted
 * is denied -- adding a table to the registry does not make it writable.
 */
export function checkPolicy(
  table: TableName,
  operation: Operation,
  actor: Actor
): PolicyResult {
  const policy = POLICIES[table]?.[operation]
  if (!policy) {
    return deny(`${operation} is not permitted on ${table}`)
  }
  return policy(actor)
}
