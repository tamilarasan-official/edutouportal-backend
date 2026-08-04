import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp } from '../src/app.js'
import { runMigrations } from '../src/db/migrate.js'
import { pool, query } from '../src/db/pool.js'

/**
 * Test harness.
 *
 * Boots the REAL application against a real Postgres. Nothing is mocked: the
 * same routers, policy engine, migrations and SQL run here as in production, so
 * a passing test means the deployed thing works, not that a stub agrees with
 * itself.
 *
 * Requires DATABASE_URL pointing at a throwaway database.
 *
 * IMPORTANT: these files MUST run with `--test-concurrency=1`.
 *
 * node:test runs each test file in its own process, in parallel by default.
 * Every file shares one database, and `truncateAll()` in beforeEach wipes the
 * whole schema -- so a parallel run has file A deleting the fixtures file B is
 * midway through using, producing foreign-key violations and TRUNCATE
 * deadlocks. `npm test` sets the flag; do not run `tsx --test tests/*.test.ts`
 * directly without it.
 */

let server: Server | undefined
let baseUrl = ''

export async function startTestServer(): Promise<string> {
  if (server) return baseUrl

  await runMigrations()

  server = createServer(createApp())
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))

  const { port } = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${port}`
  return baseUrl
}

export async function stopTestServer(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = undefined
  }
  await pool.end().catch(() => undefined)
}

/**
 * Empty every application table. `users` cascades to almost everything, but
 * the reference tables are cleared explicitly so a suite never inherits state.
 */
export async function truncateAll(): Promise<void> {
  await query(`
    TRUNCATE TABLE
      session_answers, session_events, session_participants, quiz_sessions,
      quiz_attempts, quizzes,
      task_step_completions, task_assignments, task_steps, tasks,
      discussion_votes, discussion_comments, discussions,
      hackathon_team_members, hackathon_teams,
      notification_reads, notifications, resources, session_tracker,
      session_feedback_responses, feedback_sessions, feedback,
      mentor_assignments, points_history, leaderboard,
      profiles, oauth_identities, refresh_tokens, one_time_tokens, users
    RESTART IDENTITY CASCADE
  `)
}

// ---------------------------------------------------------------------------
// HTTP client that keeps a cookie jar, so sessions behave like a browser's.
// ---------------------------------------------------------------------------

export interface ApiResponse<T = any> {
  status: number
  body: T
}

export class Client {
  private readonly cookies = new Map<string, string>()

  constructor(private readonly base: string) {}

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  private absorb(response: Response): void {
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const pair = raw.split(';')[0] ?? ''
      const eq = pair.indexOf('=')
      if (eq === -1) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (value === '') this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
  }

  async request<T = any>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<ApiResponse<T>> {
    const cookie = this.cookieHeader()
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

    this.absorb(response)

    const text = await response.text()
    let parsed: unknown = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = text
    }

    return { status: response.status, body: parsed as T }
  }

  get<T = any>(path: string) {
    return this.request<T>('GET', path)
  }
  post<T = any>(path: string, body?: unknown) {
    return this.request<T>('POST', path, body)
  }
  patch<T = any>(path: string, body?: unknown) {
    return this.request<T>('PATCH', path, body)
  }

  /** Convenience for the generic data endpoint. */
  db<T = any>(payload: Record<string, unknown>) {
    return this.post<{ data: T; count: number | null; error?: { message: string; code: string } }>(
      '/api/db',
      payload
    )
  }

  hasSession(): boolean {
    return this.cookies.has('edutou_access')
  }
}

// ---------------------------------------------------------------------------
// User factories
// ---------------------------------------------------------------------------

export interface TestUser {
  client: Client
  id: string
  email: string
  password: string
}

let counter = 0

/**
 * Register a user through the real signup endpoint, then set their role
 * directly in the database -- signup deliberately always yields a student, and
 * the role trigger is one of the things under test.
 */
export async function createUser(
  base: string,
  role: 'admin' | 'mentor' | 'student' | 'coursemaster' = 'student',
  overrides: { fullName?: string } = {}
): Promise<TestUser> {
  counter += 1
  const email = `user${counter}.${Date.now()}@test.local`
  const password = 'test-password-1234'

  const client = new Client(base)
  const signup = await client.post('/auth/signup', {
    email,
    password,
    full_name: overrides.fullName ?? `Test User ${counter}`,
  })

  if (signup.status !== 201) {
    throw new Error(`signup failed (${signup.status}): ${JSON.stringify(signup.body)}`)
  }

  const id = signup.body.user.id as string

  if (role !== 'student') {
    await query('UPDATE profiles SET role = $1 WHERE id = $2', [role, id])
    // The access token embeds the role at sign-in; re-login so the cookie is current.
    await client.post('/auth/login', { email, password })
  }

  return { client, id, email, password }
}

/** Insert a quiz directly -- used as a fixture by the live-session tests. */
export async function createQuiz(
  createdBy: string,
  questions: unknown[],
  status: 'draft' | 'published' = 'published'
): Promise<string> {
  const rows = await query<{ id: string }>(
    `INSERT INTO quizzes (title, description, questions, status, created_by)
     VALUES ('Test Quiz', 'fixture', $1, $2, $3) RETURNING id`,
    [JSON.stringify(questions), status, createdBy]
  )
  return rows[0]!.id
}

export const SAMPLE_QUESTIONS = [
  {
    id: 'q1',
    question: 'What is 2 + 2?',
    options: ['3', '4', '5', '6'],
    correctOptionIndex: 1,
  },
  {
    id: 'q2',
    question: 'Capital of France?',
    options: ['Berlin', 'Madrid', 'Paris', 'Rome'],
    correctOptionIndex: 2,
  },
]
