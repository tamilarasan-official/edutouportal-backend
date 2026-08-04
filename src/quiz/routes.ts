import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { query, queryOne, transaction } from '../db/pool.js'
import { requireAuth } from '../middleware/auth.js'
import { publish, publishChange } from '../realtime/hub.js'

export const quizRouter = Router()

/**
 * Live quiz session control.
 *
 * These endpoints replace the server actions in app/mentor/live/[sessionId]/,
 * app/student/quiz/[sessionId]/ and app/student/session/join/. Four separate
 * defects from the audit are fixed here:
 *
 *   1. advanceQuestion / endSession had NO auth check at all. Server actions
 *      are public POST endpoints, so any student could end the class's quiz.
 *      Every mutating route below verifies host ownership.
 *
 *   2. getQuestionForStudent returned the whole quiz -- every question with its
 *      correctOptionIndex -- to the browser. The student view now strips it.
 *
 *   3. submitAnswer trusted a client-supplied answerTimeMs for the speed bonus
 *      and never validated questionIndex. Timing is now derived from
 *      question_start_time on the server, and the index must match the session.
 *
 *   4. The question clock lived only in the browser, so a refresh reset it.
 *      question_start_time / question_end_time are now authoritative and are
 *      rewritten on every advance.
 */

interface SessionRow {
  id: string
  quiz_id: string
  host_id: string
  session_code: string
  status: string
  current_question_index: number
  question_start_time: string | null
  question_end_time: string | null
  settings: Record<string, unknown>
  questions: unknown[]
}

async function loadSession(sessionId: string): Promise<SessionRow | null> {
  return queryOne<SessionRow>(
    `SELECT s.id, s.quiz_id, s.host_id, s.session_code, s.status,
            s.current_question_index, s.question_start_time, s.question_end_time,
            s.settings, q.questions
       FROM quiz_sessions s
       JOIN quizzes q ON q.id = s.quiz_id
      WHERE s.id = $1`,
    [sessionId]
  )
}

function forbidden(res: Response, message = 'You do not host this session'): void {
  res.status(403).json({ error: { message, code: 'FORBIDDEN' } })
}

function notFound(res: Response, message = 'Session not found'): void {
  res.status(404).json({ error: { message, code: 'NOT_FOUND' } })
}

/** Remove anything that reveals the answer before the student has submitted. */
function publicQuestion(raw: unknown, index: number): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null
  const q = raw as Record<string, unknown>

  const options = Array.isArray(q.options)
    ? q.options.map((option) =>
        // Authoring stores [{id, text, isCorrect}]; the live view expects plain
        // strings. Either way, isCorrect must not survive the trip.
        typeof option === 'object' && option !== null
          ? String((option as Record<string, unknown>).text ?? '')
          : String(option)
      )
    : []

  return {
    id: q.id ?? `q_${index}`,
    questionText: q.question ?? q.questionText ?? q.text ?? '',
    options,
    type: q.type ?? 'multiple_choice',
    imageUrl: q.imageUrl ?? null,
  }
}

function correctIndexOf(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object') return null
  const q = raw as Record<string, unknown>

  if (typeof q.correctOptionIndex === 'number') return q.correctOptionIndex

  // Authoring format: the correct option carries isCorrect.
  if (Array.isArray(q.options)) {
    const index = q.options.findIndex(
      (o) => typeof o === 'object' && o !== null && (o as Record<string, unknown>).isCorrect === true
    )
    return index >= 0 ? index : null
  }
  return null
}

// ---------------------------------------------------------------------------
// POST /api/quiz/sessions  -- open a session for a quiz you own
// ---------------------------------------------------------------------------

quizRouter.post('/sessions', requireAuth, async (req: Request, res: Response) => {
  const actor = req.actor!
  if (actor.role !== 'mentor' && actor.role !== 'admin') {
    return forbidden(res, 'Only mentors can host sessions')
  }

  const schema = z.object({
    quiz_id: z.string().uuid(),
    settings: z
      .object({
        questionTimer: z.number().int().min(5).max(300).default(20),
        showAnswerDistribution: z.boolean().default(true),
        showLeaderboard: z.boolean().default(true),
        allowLateJoin: z.boolean().default(false),
        pointsPerQuestion: z.number().int().min(0).max(10_000).default(1000),
        speedBonus: z.boolean().default(true),
        streakMultiplier: z.boolean().default(true),
      })
      .partial()
      .default({}),
  })

  const parsed = schema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid session request', code: 'INVALID' } })
    return
  }

  const quiz = await queryOne<{ id: string; title: string }>(
    // Admins may host any quiz; mentors only their own.
    actor.role === 'admin'
      ? 'SELECT id, title FROM quizzes WHERE id = $1'
      : 'SELECT id, title FROM quizzes WHERE id = $1 AND created_by = $2',
    actor.role === 'admin' ? [parsed.data.quiz_id] : [parsed.data.quiz_id, actor.userId]
  )
  if (!quiz) return notFound(res, 'Quiz not found')

  const settings = {
    questionTimer: 20,
    showAnswerDistribution: true,
    showLeaderboard: true,
    allowLateJoin: false,
    pointsPerQuestion: 1000,
    speedBonus: true,
    streakMultiplier: true,
    ...parsed.data.settings,
  }

  const session = await transaction(async (client) => {
    const { rows: codeRows } = await client.query<{ code: string }>(
      'SELECT generate_session_code() AS code'
    )
    const code = codeRows[0]!.code

    const { rows } = await client.query(
      `INSERT INTO quiz_sessions (quiz_id, host_id, session_code, status, settings, current_question_index)
       VALUES ($1, $2, $3, 'lobby', $4, 0)
       RETURNING *`,
      [quiz.id, actor.userId, code, JSON.stringify(settings)]
    )

    await client.query(
      `INSERT INTO session_events (session_id, event_type, user_id, event_data)
       VALUES ($1, 'session_created', $2, $3)`,
      [rows[0]!.id, actor.userId, JSON.stringify({ quiz_id: quiz.id, quiz_title: quiz.title })]
    )

    return rows[0]!
  })

  res.status(201).json({ data: { session, sessionCode: session.session_code } })
})

// ---------------------------------------------------------------------------
// POST /api/quiz/join  -- student joins by code
// ---------------------------------------------------------------------------

quizRouter.post('/join', requireAuth, async (req: Request, res: Response) => {
  const schema = z.object({ session_code: z.string().min(4).max(12) })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid session code', code: 'INVALID' } })
    return
  }

  const actor = req.actor!
  const code = parsed.data.session_code.toUpperCase()

  const session = await queryOne<SessionRow & { settings: { allowLateJoin?: boolean } }>(
    `SELECT s.*, q.questions FROM quiz_sessions s
       JOIN quizzes q ON q.id = s.quiz_id
      WHERE s.session_code = $1`,
    [code]
  )
  if (!session) return notFound(res, 'Session not found. Please check the code.')

  if (session.status === 'finished') {
    res.status(409).json({ error: { message: 'This session has already ended', code: 'FINISHED' } })
    return
  }
  if (session.status !== 'lobby' && !session.settings?.allowLateJoin) {
    res.status(409).json({
      error: { message: 'This session has started and late join is not allowed', code: 'CLOSED' },
    })
    return
  }

  const profile = await queryOne<{ full_name: string | null; email: string | null }>(
    'SELECT full_name, email FROM profiles WHERE id = $1',
    [actor.userId]
  )
  const nickname =
    profile?.full_name || profile?.email?.split('@')[0] || 'Anonymous'

  // ON CONFLICT rather than SELECT-then-INSERT: two rapid joins from the same
  // student used to be able to create two participant rows.
  const participant = await transaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO session_participants (session_id, user_id, nickname, status)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (session_id, user_id)
       DO UPDATE SET last_seen = now()
       RETURNING *, (xmax = 0) AS inserted`,
      [session.id, actor.userId, nickname, session.status === 'lobby' ? 'waiting' : 'active']
    )
    const row = rows[0]! as Record<string, unknown> & { inserted: boolean }

    if (row.inserted) {
      await client.query(
        `INSERT INTO session_events (session_id, event_type, user_id, event_data)
         VALUES ($1, 'participant_joined', $2, $3)`,
        [session.id, actor.userId, JSON.stringify({ nickname })]
      )
    }
    return row
  })

  const alreadyJoined = !participant.inserted
  delete (participant as Record<string, unknown>).inserted

  if (!alreadyJoined) {
    publishChange(`participants:${session.id}`, 'INSERT', participant)
    publish(`lobby:${session.session_code}`, 'participant_joined', participant)
  }

  res.json({ data: { session, participant, alreadyJoined } })
})

// ---------------------------------------------------------------------------
// POST /api/quiz/sessions/:id/start
// ---------------------------------------------------------------------------

quizRouter.post('/sessions/:id/start', requireAuth, async (req: Request, res: Response) => {
  const session = await loadSession(req.params.id!)
  if (!session) return notFound(res)
  if (session.host_id !== req.actor!.userId && req.actor!.role !== 'admin') return forbidden(res)

  const questions = Array.isArray(session.questions) ? session.questions : []
  if (questions.length === 0) {
    res.status(409).json({ error: { message: 'Quiz has no questions', code: 'EMPTY_QUIZ' } })
    return
  }
  if (session.status !== 'lobby') {
    res.status(409).json({ error: { message: 'Session already started', code: 'ALREADY_STARTED' } })
    return
  }

  const timer = Number(session.settings?.questionTimer ?? 20)
  const first = questions[0] as Record<string, unknown>

  const updated = await transaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE quiz_sessions
          SET status = 'active',
              started_at = now(),
              current_question_index = 0,
              current_question_id = $2,
              question_start_time = now(),
              question_end_time = now() + make_interval(secs => $3::int)
        WHERE id = $1
        RETURNING *`,
      [session.id, String(first.id ?? 'q_0'), timer]
    )

    await client.query(
      `UPDATE session_participants SET status = 'active'
        WHERE session_id = $1 AND status = 'waiting'`,
      [session.id]
    )

    await client.query(
      `INSERT INTO session_events (session_id, event_type, user_id, event_data)
       VALUES ($1, 'session_started', $2, $3)`,
      [session.id, req.actor!.userId, JSON.stringify({ question_index: 0 })]
    )

    return rows[0]!
  })

  publishChange(`session:${session.id}`, 'UPDATE', updated)
  publish(`lobby:${session.session_code}`, 'quiz_starting', { session_id: session.id })
  publish(`session:${session.id}`, 'question_start', {
    questionIndex: 0,
    question: publicQuestion(first, 0),
    endsAt: updated.question_end_time,
  })

  res.json({ data: { success: true } })
})

// ---------------------------------------------------------------------------
// POST /api/quiz/sessions/:id/advance
// ---------------------------------------------------------------------------

quizRouter.post('/sessions/:id/advance', requireAuth, async (req: Request, res: Response) => {
  const session = await loadSession(req.params.id!)
  if (!session) return notFound(res)
  // This check is the whole point of the endpoint: the old server action had none.
  if (session.host_id !== req.actor!.userId && req.actor!.role !== 'admin') return forbidden(res)

  const questions = Array.isArray(session.questions) ? session.questions : []
  const nextIndex = session.current_question_index + 1

  if (nextIndex >= questions.length) {
    await finishSession(session.id, req.actor!.userId)
    publish(`session:${session.id}`, 'quiz_finished', { session_id: session.id })
    res.json({ data: { finished: true } })
    return
  }

  const timer = Number(session.settings?.questionTimer ?? 20)
  const next = questions[nextIndex] as Record<string, unknown>

  const updated = await queryOne(
    `UPDATE quiz_sessions
        SET current_question_index = $2,
            current_question_id = $3,
            question_start_time = now(),
            question_end_time = now() + make_interval(secs => $4::int)
      WHERE id = $1
      RETURNING *`,
    [session.id, nextIndex, String(next.id ?? `q_${nextIndex}`), timer]
  )

  publishChange(`session:${session.id}`, 'UPDATE', updated)
  publish(`session:${session.id}`, 'question_start', {
    questionIndex: nextIndex,
    question: publicQuestion(next, nextIndex),
    endsAt: (updated as Record<string, unknown>).question_end_time,
  })

  res.json({ data: { success: true, nextIndex } })
})

// ---------------------------------------------------------------------------
// POST /api/quiz/sessions/:id/end
// ---------------------------------------------------------------------------

quizRouter.post('/sessions/:id/end', requireAuth, async (req: Request, res: Response) => {
  const session = await loadSession(req.params.id!)
  if (!session) return notFound(res)
  if (session.host_id !== req.actor!.userId && req.actor!.role !== 'admin') return forbidden(res)

  await finishSession(session.id, req.actor!.userId)
  publish(`session:${session.id}`, 'quiz_finished', { session_id: session.id })
  res.json({ data: { success: true } })
})

/**
 * Close a session and roll its results into the leaderboard.
 *
 * The old version looped over participants issuing a SELECT then an UPDATE per
 * person -- N+1 round trips, non-atomic, and it silently skipped anyone without
 * an existing leaderboard row. This is one transaction and three statements.
 */
async function finishSession(sessionId: string, actorId: string): Promise<void> {
  await transaction(async (client) => {
    await client.query(
      `UPDATE quiz_sessions SET status = 'finished', finished_at = now()
        WHERE id = $1 AND status <> 'finished'`,
      [sessionId]
    )

    await client.query(
      `INSERT INTO leaderboard (user_id, quizzes_completed, last_activity)
       SELECT sp.user_id, 1, now() FROM session_participants sp WHERE sp.session_id = $1
       ON CONFLICT (user_id) DO UPDATE
         SET quizzes_completed = leaderboard.quizzes_completed + 1,
             last_activity = now()`,
      [sessionId]
    )

    await client.query(
      `UPDATE session_participants SET status = 'finished' WHERE session_id = $1`,
      [sessionId]
    )

    await client.query(
      `INSERT INTO session_events (session_id, event_type, user_id, event_data)
       VALUES ($1, 'session_finished', $2, '{}'::jsonb)`,
      [sessionId, actorId]
    )
  })
}

// ---------------------------------------------------------------------------
// GET /api/quiz/sessions/:id/question  -- the student's view
// ---------------------------------------------------------------------------

quizRouter.get('/sessions/:id/question', requireAuth, async (req: Request, res: Response) => {
  const actor = req.actor!
  const session = await loadSession(req.params.id!)
  if (!session) return notFound(res)

  const participant = await queryOne<{ id: string } & Record<string, unknown>>(
    'SELECT * FROM session_participants WHERE session_id = $1 AND user_id = $2',
    [session.id, actor.userId]
  )
  if (!participant) {
    res.status(403).json({ error: { message: 'You have not joined this session', code: 'NOT_JOINED' } })
    return
  }

  const questions = Array.isArray(session.questions) ? session.questions : []
  const index = session.current_question_index
  const raw = questions[index]

  const existing = await queryOne<Record<string, unknown>>(
    `SELECT * FROM session_answers WHERE participant_id = $1 AND question_index = $2`,
    [participant.id, index]
  )

  const hasAnswered = existing !== null

  res.json({
    data: {
      session: {
        id: session.id,
        status: session.status,
        session_code: session.session_code,
        current_question_index: index,
        // The clock the client should render, straight from the server.
        question_start_time: session.question_start_time,
        question_end_time: session.question_end_time,
        settings: session.settings,
      },
      participant,
      question: publicQuestion(raw, index),
      questionIndex: index,
      totalQuestions: questions.length,
      hasAnswered,
      answer: existing,
      // Only revealed once this student has committed an answer.
      correctAnswer: hasAnswered ? correctIndexOf(raw) : null,
    },
  })
})

// ---------------------------------------------------------------------------
// GET /api/quiz/sessions/:id/host-question  -- the mentor's view
//
// Unlike the student view this DOES include the correct answer: the host needs
// it to read out results. Gated on host ownership.
// ---------------------------------------------------------------------------

quizRouter.get('/sessions/:id/host-question', requireAuth, async (req: Request, res: Response) => {
  const session = await loadSession(req.params.id!)
  if (!session) return notFound(res)
  if (session.host_id !== req.actor!.userId && req.actor!.role !== 'admin') return forbidden(res)

  const questions = Array.isArray(session.questions) ? session.questions : []
  const index = session.current_question_index
  const raw = questions[index]
  const view = publicQuestion(raw, index)

  res.json({
    data: {
      question: view ? { ...view, correctOptionIndex: correctIndexOf(raw) } : null,
      index,
      total: questions.length,
      session: {
        id: session.id,
        status: session.status,
        session_code: session.session_code,
        current_question_index: index,
        question_start_time: session.question_start_time,
        question_end_time: session.question_end_time,
        settings: session.settings,
      },
    },
  })
})

// ---------------------------------------------------------------------------
// POST /api/quiz/sessions/:id/answer
// ---------------------------------------------------------------------------

quizRouter.post('/sessions/:id/answer', requireAuth, async (req: Request, res: Response) => {
  const schema = z.object({
    questionIndex: z.number().int().min(0).max(999),
    selectedOptionIndex: z.number().int().min(0).max(9),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid answer', code: 'INVALID' } })
    return
  }

  const actor = req.actor!
  const session = await loadSession(req.params.id!)
  if (!session) return notFound(res)

  if (session.status !== 'active') {
    res.status(409).json({ error: { message: 'This session is not accepting answers', code: 'NOT_ACTIVE' } })
    return
  }

  // Fix: the old code accepted any index the client sent, so a student could
  // answer questions that had not been asked yet.
  if (parsed.data.questionIndex !== session.current_question_index) {
    res.status(409).json({
      error: { message: 'That is not the current question', code: 'STALE_QUESTION' },
    })
    return
  }

  const questions = Array.isArray(session.questions) ? session.questions : []
  const raw = questions[session.current_question_index]
  if (!raw) return notFound(res, 'Question not found')

  const participant = await queryOne<{
    id: string
    current_streak: number
    longest_streak: number
  }>(
    'SELECT id, current_streak, longest_streak FROM session_participants WHERE session_id = $1 AND user_id = $2',
    [session.id, actor.userId]
  )
  if (!participant) {
    res.status(403).json({ error: { message: 'You have not joined this session', code: 'NOT_JOINED' } })
    return
  }

  // Fix: timing comes from the server, not from the client. Sending
  // answerTimeMs: 0 used to guarantee the maximum speed bonus.
  const startedAt = session.question_start_time ? new Date(session.question_start_time).getTime() : null
  const endsAt = session.question_end_time ? new Date(session.question_end_time).getTime() : null
  const now = Date.now()

  if (!startedAt) {
    res.status(409).json({ error: { message: 'Question has not started', code: 'NOT_STARTED' } })
    return
  }
  // Small grace period for network latency on a genuinely in-time answer.
  if (endsAt && now > endsAt + 1500) {
    res.status(409).json({ error: { message: "Time's up for this question", code: 'TIME_UP' } })
    return
  }

  const answerTimeMs = Math.max(0, now - startedAt)

  const settings = session.settings as Record<string, unknown>
  const correctIndex = correctIndexOf(raw)
  const isCorrect = correctIndex !== null && parsed.data.selectedOptionIndex === correctIndex

  let pointsEarned = 0
  let speedBonus = 0
  let multiplier = 1

  if (isCorrect) {
    pointsEarned = Number(settings.pointsPerQuestion ?? 1000)

    if (settings.speedBonus) {
      const windowMs = Number(settings.questionTimer ?? 20) * 1000
      const ratio = Math.max(0, (windowMs - answerTimeMs) / windowMs)
      speedBonus = Math.floor(ratio * Number(settings.maxSpeedBonus ?? 500))
      pointsEarned += speedBonus
    }

    if (settings.streakMultiplier) {
      const newStreak = participant.current_streak + 1
      multiplier = Math.min(2, 1 + (newStreak - 1) * 0.1)
      pointsEarned = Math.floor(pointsEarned * multiplier)
    }
  }

  const newStreak = isCorrect ? participant.current_streak + 1 : 0

  try {
    const result = await transaction(async (client) => {
      // The UNIQUE (participant_id, question_index) constraint added in
      // migration 0002 is what actually blocks replayed submissions; this
      // insert simply surfaces it as a clean 409.
      const { rows: answerRows } = await client.query(
        `INSERT INTO session_answers (
           session_id, participant_id, user_id, question_id, question_index,
           selected_option_id, is_correct, time_taken_ms, points_earned,
           speed_bonus, streak_multiplier
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          session.id,
          participant.id,
          actor.userId,
          String((raw as Record<string, unknown>).id ?? `q_${session.current_question_index}`),
          session.current_question_index,
          String(parsed.data.selectedOptionIndex),
          isCorrect,
          answerTimeMs,
          pointsEarned,
          speedBonus,
          multiplier,
        ]
      )

      const { rows: participantRows } = await client.query<{ total_score: number }>(
        `UPDATE session_participants
            SET total_score        = total_score + $2,
                current_streak     = $3,
                longest_streak     = GREATEST(longest_streak, $3),
                correct_answers    = correct_answers + $4,
                incorrect_answers  = incorrect_answers + $5,
                questions_answered = questions_answered + 1,
                last_seen          = now()
          WHERE id = $1
          RETURNING total_score`,
        [participant.id, pointsEarned, newStreak, isCorrect ? 1 : 0, isCorrect ? 0 : 1]
      )

      // Points flow through the ledger, which maintains both the leaderboard
      // table and profiles.leaderboard_points via trigger. The old code wrote
      // all three stores by hand and they drifted apart.
      if (pointsEarned > 0) {
        await client.query(
          `INSERT INTO points_history (user_id, action_type, points, category, reference_id, reference_type, description)
           VALUES ($1, 'quiz_completion', $2, 'quiz', $3, 'session_answer', $4)`,
          [
            actor.userId,
            pointsEarned,
            `${session.id}:${session.current_question_index}`,
            `Live quiz answer in session ${session.session_code}`,
          ]
        )
      }

      // Upsert, not update: a student whose very first answer is wrong earns no
      // points, so the points_history trigger has not created their leaderboard
      // row yet and a plain UPDATE would silently affect zero rows -- losing
      // their attempt count until they first score.
      await client.query(
        `INSERT INTO leaderboard (user_id, correct_answers, total_attempts, last_activity)
         VALUES ($1, $2, 1, now())
         ON CONFLICT (user_id) DO UPDATE
           SET correct_answers = leaderboard.correct_answers + EXCLUDED.correct_answers,
               total_attempts  = leaderboard.total_attempts + 1,
               last_activity   = now()`,
        [actor.userId, isCorrect ? 1 : 0]
      )

      return {
        answer: answerRows[0]!,
        totalScore: participantRows[0]?.total_score ?? 0,
      }
    })

    publishChange(`answers:${session.id}`, 'INSERT', result.answer)
    publish(`session:${session.id}`, 'answer_submitted', {
      participant_id: participant.id,
      question_index: session.current_question_index,
    })

    res.json({
      data: {
        success: true,
        isCorrect,
        pointsEarned,
        newTotalScore: result.totalScore,
        newStreak,
        // Safe to reveal now: the answer is committed and immutable.
        correctAnswer: correctIndex,
      },
    })
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      res.status(409).json({
        error: { message: 'You have already answered this question', code: 'ALREADY_ANSWERED' },
      })
      return
    }
    console.error('[quiz] answer submission failed', err)
    res.status(500).json({ error: { message: 'Failed to submit answer', code: 'INTERNAL' } })
  }
})

// ---------------------------------------------------------------------------
// POST /api/quiz/attempts  -- the self-paced "enter a quiz code" flow
//
// Grading happens here, not in the browser. app/quiz/[quizCode]/page.tsx used
// to compute `pointsEarned = correctCount * 10` client-side and then write that
// number straight into the leaderboard table, so any user could award
// themselves an arbitrary score by editing the request.
// ---------------------------------------------------------------------------

quizRouter.post('/attempts', requireAuth, async (req: Request, res: Response) => {
  const schema = z.object({
    quiz_id: z.string().uuid(),
    // Index of the chosen option per question, in question order.
    answers: z.array(z.number().int().min(0).max(9).nullable()).max(500),
  })
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid attempt', code: 'INVALID' } })
    return
  }

  const actor = req.actor!

  const quiz = await queryOne<{ id: string; questions: unknown[]; status: string }>(
    'SELECT id, questions, status FROM quizzes WHERE id = $1',
    [parsed.data.quiz_id]
  )
  if (!quiz) return notFound(res, 'Quiz not found')
  if (quiz.status !== 'published' && actor.role === 'student') {
    return forbidden(res, 'This quiz is not published')
  }

  const questions = Array.isArray(quiz.questions) ? quiz.questions : []

  let correctCount = 0
  questions.forEach((raw, index) => {
    const expected = correctIndexOf(raw)
    if (expected !== null && parsed.data.answers[index] === expected) correctCount += 1
  })

  const POINTS_PER_CORRECT = 10
  const pointsEarned = correctCount * POINTS_PER_CORRECT

  try {
    const attempt = await transaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO quiz_attempts (quiz_id, user_id, answers, score, total_questions, correct_answers)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          quiz.id,
          actor.userId,
          JSON.stringify(parsed.data.answers),
          correctCount,
          questions.length,
          correctCount,
        ]
      )

      // Ledger first: its trigger creates/updates the leaderboard row.
      if (pointsEarned > 0) {
        await client.query(
          `INSERT INTO points_history (user_id, action_type, points, category, reference_id, reference_type, description)
           VALUES ($1, 'quiz_completion', $2, 'quiz', $3, 'quiz_attempt', $4)
           ON CONFLICT DO NOTHING`,
          [actor.userId, pointsEarned, rows[0]!.id, 'Self-paced quiz attempt'],
        )
      }

      await client.query(
        `INSERT INTO leaderboard (user_id, quizzes_completed, correct_answers, total_attempts, last_activity)
         VALUES ($1, 1, $2, $3, now())
         ON CONFLICT (user_id) DO UPDATE
           SET quizzes_completed = leaderboard.quizzes_completed + 1,
               correct_answers   = leaderboard.correct_answers + EXCLUDED.correct_answers,
               total_attempts    = leaderboard.total_attempts + EXCLUDED.total_attempts,
               last_activity     = now()`,
        [actor.userId, correctCount, questions.length]
      )

      return rows[0]!
    })

    res.status(201).json({
      data: {
        attempt,
        score: correctCount,
        totalQuestions: questions.length,
        correctAnswers: correctCount,
        pointsEarned,
      },
    })
  } catch (err) {
    console.error('[quiz] attempt submission failed', err)
    res.status(500).json({ error: { message: 'Failed to save attempt', code: 'INTERNAL' } })
  }
})

// ---------------------------------------------------------------------------
// GET /api/quiz/sessions/:id/leaderboard
// ---------------------------------------------------------------------------

quizRouter.get('/sessions/:id/leaderboard', requireAuth, async (req: Request, res: Response) => {
  const sessionId = req.params.id!

  const participant = await queryOne(
    'SELECT 1 FROM session_participants WHERE session_id = $1 AND user_id = $2',
    [sessionId, req.actor!.userId]
  )
  const session = await queryOne<{ host_id: string }>(
    'SELECT host_id FROM quiz_sessions WHERE id = $1',
    [sessionId]
  )
  if (!session) return notFound(res)

  const isHost = session.host_id === req.actor!.userId || req.actor!.role === 'admin'
  if (!participant && !isHost) return forbidden(res, 'You are not in this session')

  const rows = await query(
    `SELECT *, ROW_NUMBER() OVER (ORDER BY total_score DESC, joined_at ASC)::int AS rank
       FROM session_participants
      WHERE session_id = $1
      ORDER BY total_score DESC, joined_at ASC`,
    [sessionId]
  )

  res.json({ data: { leaderboard: rows } })
})

// ---------------------------------------------------------------------------
// GET /api/quiz/sessions/:id/stats?questionIndex=N  -- host only
// ---------------------------------------------------------------------------

quizRouter.get('/sessions/:id/stats', requireAuth, async (req: Request, res: Response) => {
  const sessionId = req.params.id!
  const session = await queryOne<{ host_id: string }>(
    'SELECT host_id FROM quiz_sessions WHERE id = $1',
    [sessionId]
  )
  if (!session) return notFound(res)
  if (session.host_id !== req.actor!.userId && req.actor!.role !== 'admin') return forbidden(res)

  const index = Number(req.query.questionIndex ?? 0)
  if (!Number.isInteger(index) || index < 0) {
    res.status(400).json({ error: { message: 'Invalid questionIndex', code: 'INVALID' } })
    return
  }

  const rows = await query<{ selected_option_id: string | null; is_correct: boolean; n: number }>(
    `SELECT selected_option_id, is_correct, count(*)::int AS n
       FROM session_answers
      WHERE session_id = $1 AND question_index = $2
      GROUP BY selected_option_id, is_correct`,
    [sessionId, index]
  )

  // Shape matches what the mentor dashboard already renders: numeric keys for
  // each option plus `total` and `correctCount`.
  const stats = { 0: 0, 1: 0, 2: 0, 3: 0, total: 0, correctCount: 0 }
  for (const row of rows) {
    const option = Number.parseInt(row.selected_option_id ?? '', 10)
    if (option === 0 || option === 1 || option === 2 || option === 3) {
      stats[option] += row.n
    }
    stats.total += row.n
    if (row.is_correct) stats.correctCount += row.n
  }

  res.json({ data: { stats } })
})

// ---------------------------------------------------------------------------
// GET /api/quiz/sessions/:id/participants/count
// ---------------------------------------------------------------------------

quizRouter.get('/sessions/:id/participants/count', requireAuth, async (req: Request, res: Response) => {
  const row = await queryOne<{ count: number }>(
    'SELECT count(*)::int AS count FROM session_participants WHERE session_id = $1',
    [req.params.id!]
  )
  res.json({ data: { count: row?.count ?? 0 } })
})
