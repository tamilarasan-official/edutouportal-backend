/**
 * Table registry.
 *
 * This is the allowlist that makes a generic query endpoint safe. A table that
 * is not listed here cannot be reached at all; a column that is not listed
 * cannot be selected, filtered on, or written. Nothing is derived from the
 * request -- identifiers only ever come from these constants, so the query
 * builder never has to interpolate user input into SQL text.
 */

/**
 * Declared up front rather than inferred from TABLES: a relationship names a
 * table, and TABLES contains relationships, so inference would be circular.
 */
export type TableName =
  | 'profiles'
  | 'quizzes'
  | 'quiz_sessions'
  | 'session_participants'
  | 'session_answers'
  | 'session_events'
  | 'quiz_attempts'
  | 'points_config'
  | 'points_history'
  | 'leaderboard'
  | 'tasks'
  | 'task_steps'
  | 'task_assignments'
  | 'task_step_completions'
  | 'discussions'
  | 'discussion_comments'
  | 'discussion_votes'
  | 'hackathon_teams'
  | 'hackathon_team_members'
  | 'resources'
  | 'notifications'
  | 'notification_reads'
  | 'session_tracker'
  | 'mentor_assignments'
  | 'feedback'
  | 'feedback_sessions'
  | 'session_feedback_responses'

export interface Relationship {
  /** Alias the frontend uses in an embedded select, e.g. `profiles:user_id(...)`. */
  readonly alias: string
  /** Table being joined to. */
  readonly table: TableName
  /** Column on THIS table holding the foreign key. */
  readonly localColumn: string
  /** Column on the FOREIGN table the key points at. Almost always `id`. */
  readonly foreignColumn: string
  /** one = embeds an object, many = embeds an array. */
  readonly cardinality: 'one' | 'many'
}

export interface TableDef {
  /** Columns readable via select. */
  readonly columns: readonly string[]
  /** Columns accepted in an insert payload. */
  readonly insertable: readonly string[]
  /** Columns accepted in an update payload. */
  readonly updatable: readonly string[]
  /**
   * Columns of type jsonb.
   *
   * node-postgres serialises a JS array as a Postgres ARRAY literal, not JSON,
   * so an array bound to a jsonb column fails with a type error. These columns
   * get JSON.stringify()'d before binding. Genuine text[] columns (tags,
   * allowed_types, file_urls) are NOT listed -- node-pg handles those natively.
   */
  readonly jsonColumns?: readonly string[]
  /** Embedded selects this table supports. */
  readonly relationships?: readonly Relationship[]
  /**
   * Column holding the owning user's id, if any. The policy layer uses it for
   * "you may only touch your own rows" rules.
   */
  readonly ownerColumn?: string
}

const TIMESTAMPS = ['created_at', 'updated_at'] as const

export const TABLES: Record<TableName, TableDef> = {
  // -------------------------------------------------------------------------
  profiles: {
    columns: [
      'id', 'email', 'full_name', 'role', 'phone', 'bio', 'avatar_url',
      'leaderboard_points', ...TIMESTAMPS,
    ],
    // `id` is insertable because app/settings/ProfileTab.tsx self-heals a
    // missing profile row by inserting one with the user's own id.
    insertable: ['id', 'email', 'full_name', 'phone', 'bio', 'avatar_url'],
    // `role` and `leaderboard_points` are deliberately absent: role changes go
    // through /api/admin/set-role, points go through the ledger. Leaving them
    // writable here would let any student PATCH themselves to admin.
    updatable: ['full_name', 'phone', 'bio', 'avatar_url', 'email'],
    ownerColumn: 'id',
  },

  // -------------------------------------------------------------------------
  quizzes: {
    columns: [
      'id', 'title', 'description', 'questions', 'status', 'quiz_code',
      'created_by', ...TIMESTAMPS,
    ],
    insertable: ['title', 'description', 'questions', 'status', 'quiz_code', 'created_by'],
    // updated_at is accepted but inert: the quizzes_set_updated_at trigger
    // overwrites it with now(). Listed so the existing save call does not 400.
    updatable: ['title', 'description', 'questions', 'status', 'quiz_code', 'updated_at'],
    jsonColumns: ['questions'],
    ownerColumn: 'created_by',
  },

  quiz_sessions: {
    columns: [
      'id', 'quiz_id', 'host_id', 'session_code', 'status', 'current_question_index',
      'current_question_id', 'question_start_time', 'question_end_time', 'settings',
      'created_at', 'started_at', 'finished_at',
    ],
    // Sessions are created and driven exclusively through /api/quiz/* so the
    // server controls the clock and the question pointer.
    insertable: [],
    updatable: [],
    relationships: [
      { alias: 'quiz', table: 'quizzes', localColumn: 'quiz_id', foreignColumn: 'id', cardinality: 'one' },
      { alias: 'quizzes', table: 'quizzes', localColumn: 'quiz_id', foreignColumn: 'id', cardinality: 'one' },
      { alias: 'host', table: 'profiles', localColumn: 'host_id', foreignColumn: 'id', cardinality: 'one' },
    ],
    ownerColumn: 'host_id',
  },

  session_participants: {
    columns: [
      'id', 'session_id', 'user_id', 'nickname', 'status', 'total_score',
      'correct_answers', 'incorrect_answers', 'current_streak', 'longest_streak',
      'questions_answered', 'questions_skipped', 'avg_response_time_ms',
      'joined_at', 'last_seen',
    ],
    insertable: [],
    updatable: [],
    relationships: [
      { alias: 'profiles', table: 'profiles', localColumn: 'user_id', foreignColumn: 'id', cardinality: 'one' },
      { alias: 'user', table: 'profiles', localColumn: 'user_id', foreignColumn: 'id', cardinality: 'one' },
    ],
    ownerColumn: 'user_id',
  },

  session_answers: {
    columns: [
      'id', 'session_id', 'participant_id', 'user_id', 'question_id', 'question_index',
      'selected_option_id', 'is_correct', 'answered_at', 'time_taken_ms',
      'points_earned', 'speed_bonus', 'streak_multiplier',
    ],
    insertable: [],
    updatable: [],
    ownerColumn: 'user_id',
  },

  session_events: {
    columns: ['id', 'session_id', 'event_type', 'event_data', 'user_id', 'created_at'],
    insertable: [],
    updatable: [],
    ownerColumn: 'user_id',
  },

  quiz_attempts: {
    columns: [
      'id', 'quiz_id', 'user_id', 'answers', 'score', 'total_questions',
      'correct_answers', 'created_at',
    ],
    insertable: ['quiz_id', 'user_id', 'answers', 'score', 'total_questions', 'correct_answers'],
    updatable: [],
    jsonColumns: ['answers'],
    relationships: [
      { alias: 'quiz', table: 'quizzes', localColumn: 'quiz_id', foreignColumn: 'id', cardinality: 'one' },
    ],
    ownerColumn: 'user_id',
  },

  // -------------------------------------------------------------------------
  points_config: {
    columns: ['id', 'action_type', 'points', 'description', 'is_active', ...TIMESTAMPS],
    insertable: ['action_type', 'points', 'description', 'is_active'],
    updatable: ['points', 'description', 'is_active'],
  },

  points_history: {
    columns: [
      'id', 'user_id', 'action_type', 'points', 'category', 'reference_id',
      'reference_type', 'description', 'created_at',
    ],
    // Ledger rows are only ever written by the award_points / adjust_points RPCs.
    insertable: [],
    updatable: [],
    ownerColumn: 'user_id',
  },

  leaderboard: {
    columns: [
      'user_id', 'total_points', 'quiz_points', 'assignment_points', 'bonus_points',
      'quizzes_completed', 'correct_answers', 'total_attempts', 'last_activity',
    ],
    insertable: [],
    updatable: [],
    relationships: [
      { alias: 'profiles', table: 'profiles', localColumn: 'user_id', foreignColumn: 'id', cardinality: 'one' },
    ],
    ownerColumn: 'user_id',
  },

  // -------------------------------------------------------------------------
  tasks: {
    columns: ['id', 'title', 'description', 'due_date', 'mentor_id', 'points', 'is_active', ...TIMESTAMPS],
    insertable: ['title', 'description', 'due_date', 'mentor_id', 'points', 'is_active'],
    updatable: ['title', 'description', 'due_date', 'points', 'is_active'],
    ownerColumn: 'mentor_id',
  },

  task_steps: {
    columns: [
      'id', 'task_id', 'step_number', 'title', 'description', 'submission_type',
      'allowed_types', 'is_required', 'max_file_size', 'created_at',
    ],
    insertable: [
      'task_id', 'step_number', 'title', 'description', 'submission_type',
      'allowed_types', 'is_required', 'max_file_size',
    ],
    updatable: [
      'step_number', 'title', 'description', 'submission_type', 'allowed_types',
      'is_required', 'max_file_size',
    ],
  },

  task_assignments: {
    columns: [
      'id', 'task_id', 'student_id', 'assigned_by', 'status', 'assigned_at',
      'started_at', 'completed_at', 'updated_at',
    ],
    // assigned_by is listed so the managetask pages that send it do not 400,
    // but the insert policy overwrites it with the caller's own id.
    insertable: ['task_id', 'student_id', 'assigned_by', 'status'],
    // started_at / completed_at are stamped by the student's own submit flow.
    // assigned_by is deliberately absent: who assigned the task is fixed at
    // creation, and update is reachable by the student who owns the row.
    updatable: ['status', 'started_at', 'completed_at'],
    relationships: [
      { alias: 'task', table: 'tasks', localColumn: 'task_id', foreignColumn: 'id', cardinality: 'one' },
      { alias: 'tasks', table: 'tasks', localColumn: 'task_id', foreignColumn: 'id', cardinality: 'one' },
      { alias: 'student', table: 'profiles', localColumn: 'student_id', foreignColumn: 'id', cardinality: 'one' },
      { alias: 'profiles', table: 'profiles', localColumn: 'student_id', foreignColumn: 'id', cardinality: 'one' },
    ],
    ownerColumn: 'student_id',
  },

  task_step_completions: {
    columns: [
      'id', 'assignment_id', 'step_id', 'submission_type', 'text_content', 'file_url',
      'link_url', 'file_urls', 'is_completed', 'completed_at', ...TIMESTAMPS,
    ],
    insertable: [
      'assignment_id', 'step_id', 'submission_type', 'text_content', 'file_url',
      'link_url', 'file_urls', 'is_completed', 'completed_at',
    ],
    updatable: [
      'submission_type', 'text_content', 'file_url', 'link_url', 'file_urls',
      'is_completed', 'completed_at',
      // Inert -- the set_updated_at trigger overwrites it. Listed so the
      // existing submit call does not 400.
      'updated_at',
    ],
  },

  // -------------------------------------------------------------------------
  discussions: {
    columns: [
      'id', 'user_id', 'title', 'description', 'category', 'upvotes', 'downvotes',
      'views', 'is_pinned', ...TIMESTAMPS,
    ],
    insertable: ['user_id', 'title', 'description', 'category'],
    // upvotes/downvotes are trigger-maintained from discussion_votes.
    // is_pinned is omitted: pinning changes global thread ordering, and the
    // update policy scopes to your own rows, so leaving it writable would let
    // any student pin their own thread to the top of the board. No code writes
    // it today -- it is read-only until an admin endpoint needs it.
    updatable: ['title', 'description', 'category', 'views'],
    relationships: [
      { alias: 'profiles', table: 'profiles', localColumn: 'user_id', foreignColumn: 'id', cardinality: 'one' },
    ],
    ownerColumn: 'user_id',
  },

  discussion_comments: {
    columns: ['id', 'discussion_id', 'user_id', 'content', 'upvotes', ...TIMESTAMPS],
    insertable: ['discussion_id', 'user_id', 'content'],
    updatable: ['content'],
    relationships: [
      { alias: 'profiles', table: 'profiles', localColumn: 'user_id', foreignColumn: 'id', cardinality: 'one' },
    ],
    ownerColumn: 'user_id',
  },

  discussion_votes: {
    columns: ['id', 'discussion_id', 'user_id', 'vote_type', 'created_at'],
    insertable: ['discussion_id', 'user_id', 'vote_type'],
    updatable: ['vote_type'],
    ownerColumn: 'user_id',
  },

  // -------------------------------------------------------------------------
  hackathon_teams: {
    columns: ['id', 'team_name', 'team_code', 'leader_id', 'theme', 'max_members', ...TIMESTAMPS],
    insertable: ['team_name', 'team_code', 'leader_id', 'theme', 'max_members'],
    updatable: ['team_name', 'theme', 'max_members'],
    ownerColumn: 'leader_id',
  },

  hackathon_team_members: {
    columns: ['id', 'team_id', 'user_id', 'joined_at'],
    insertable: ['team_id', 'user_id'],
    updatable: [],
    relationships: [
      { alias: 'profiles', table: 'profiles', localColumn: 'user_id', foreignColumn: 'id', cardinality: 'one' },
    ],
    ownerColumn: 'user_id',
  },

  // -------------------------------------------------------------------------
  resources: {
    columns: [
      'id', 'file_name', 'file_url', 'file_type', 'file_size', 'uploaded_by',
      'tags', 'description', 'text_content', ...TIMESTAMPS,
    ],
    insertable: [
      'file_name', 'file_url', 'file_type', 'file_size', 'uploaded_by', 'tags',
      'description', 'text_content',
    ],
    updatable: ['file_name', 'tags', 'description', 'text_content'],
    relationships: [
      { alias: 'profiles', table: 'profiles', localColumn: 'uploaded_by', foreignColumn: 'id', cardinality: 'one' },
    ],
    ownerColumn: 'uploaded_by',
  },

  notifications: {
    columns: [
      'id', 'title', 'message', 'created_by', 'created_by_role', 'target_audience',
      'mentor_id', 'created_at',
    ],
    insertable: ['title', 'message', 'created_by', 'created_by_role', 'target_audience', 'mentor_id'],
    updatable: ['title', 'message'],
    ownerColumn: 'created_by',
  },

  notification_reads: {
    columns: ['id', 'notification_id', 'user_id', 'read_at'],
    insertable: ['notification_id', 'user_id'],
    updatable: [],
    ownerColumn: 'user_id',
  },

  session_tracker: {
    columns: ['id', 'coursemaster_id', 'title', 'completed', 'order', ...TIMESTAMPS],
    insertable: ['id', 'coursemaster_id', 'title', 'completed', 'order'],
    updatable: ['title', 'completed', 'order'],
    relationships: [
      { alias: 'creator', table: 'profiles', localColumn: 'coursemaster_id', foreignColumn: 'id', cardinality: 'one' },
      { alias: 'profiles', table: 'profiles', localColumn: 'coursemaster_id', foreignColumn: 'id', cardinality: 'one' },
    ],
    ownerColumn: 'coursemaster_id',
  },

  // -------------------------------------------------------------------------
  mentor_assignments: {
    columns: ['id', 'student_id', 'mentor_id', 'assigned_by', 'status', 'assigned_at', 'updated_at'],
    insertable: ['student_id', 'mentor_id', 'assigned_by', 'status'],
    updatable: ['mentor_id', 'assigned_by', 'status', 'updated_at'],
    relationships: [
      { alias: 'student', table: 'profiles', localColumn: 'student_id', foreignColumn: 'id', cardinality: 'one' },
      { alias: 'mentor', table: 'profiles', localColumn: 'mentor_id', foreignColumn: 'id', cardinality: 'one' },
    ],
  },

  feedback: {
    columns: ['id', 'student_id', 'mentor_id', 'feedback_type', 'rating', 'title', 'message', 'created_at'],
    insertable: ['student_id', 'mentor_id', 'feedback_type', 'rating', 'title', 'message'],
    updatable: [],
    relationships: [
      { alias: 'student', table: 'profiles', localColumn: 'student_id', foreignColumn: 'id', cardinality: 'one' },
      { alias: 'mentor', table: 'profiles', localColumn: 'mentor_id', foreignColumn: 'id', cardinality: 'one' },
    ],
    ownerColumn: 'student_id',
  },

  feedback_sessions: {
    columns: [
      'id', 'title', 'description', 'session_type', 'status', 'start_date', 'end_date',
      'allow_anonymous', 'require_rating', 'max_submissions_per_user', 'created_by',
      ...TIMESTAMPS,
    ],
    insertable: [
      'title', 'description', 'session_type', 'status', 'start_date', 'end_date',
      'allow_anonymous', 'require_rating', 'max_submissions_per_user', 'created_by',
    ],
    updatable: [
      'title', 'description', 'session_type', 'status', 'start_date', 'end_date',
      'allow_anonymous', 'require_rating', 'max_submissions_per_user',
    ],
  },

  session_feedback_responses: {
    columns: ['id', 'session_id', 'user_id', 'rating', 'title', 'message', 'created_at'],
    insertable: ['session_id', 'user_id', 'rating', 'title', 'message'],
    updatable: [],
    ownerColumn: 'user_id',
  },
}

export function isTable(name: string): name is TableName {
  return Object.prototype.hasOwnProperty.call(TABLES, name)
}

export function getTable(name: TableName): TableDef {
  return TABLES[name]
}

export function hasColumn(table: TableName, column: string): boolean {
  return getTable(table).columns.includes(column)
}

export function findRelationship(table: TableName, alias: string): Relationship | undefined {
  return getTable(table).relationships?.find((r) => r.alias === alias)
}
