import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  SAMPLE_QUESTIONS,
  createQuiz,
  createUser,
  startTestServer,
  stopTestServer,
  truncateAll,
} from './helpers.js'
import { query } from '../src/db/pool.js'

/**
 * End-to-end coverage of the live quiz, including regression tests for the
 * four defects the audit found in the original server actions.
 */

let base: string

before(async () => {
  base = await startTestServer()
})
after(stopTestServer)
beforeEach(truncateAll)

async function setupSession() {
  const mentor = await createUser(base, 'mentor')
  const student = await createUser(base, 'student')
  const quizId = await createQuiz(mentor.id, SAMPLE_QUESTIONS)

  const created = await mentor.client.post('/api/quiz/sessions', {
    quiz_id: quizId,
    settings: { questionTimer: 30 },
  })
  assert.equal(created.status, 201)

  const sessionId = created.body.data.session.id as string
  const sessionCode = created.body.data.sessionCode as string

  return { mentor, student, quizId, sessionId, sessionCode }
}

describe('quiz: session creation', () => {
  it('a mentor can open a session for their own quiz', async () => {
    const { sessionCode } = await setupSession()
    assert.match(sessionCode, /^[A-Z0-9]{6}$/)
  })

  it('a student cannot open a session', async () => {
    const mentor = await createUser(base, 'mentor')
    const student = await createUser(base, 'student')
    const quizId = await createQuiz(mentor.id, SAMPLE_QUESTIONS)

    const res = await student.client.post('/api/quiz/sessions', { quiz_id: quizId })
    assert.equal(res.status, 403)
  })

  it("a mentor cannot open a session for another mentor's quiz", async () => {
    const owner = await createUser(base, 'mentor')
    const other = await createUser(base, 'mentor')
    const quizId = await createQuiz(owner.id, SAMPLE_QUESTIONS)

    const res = await other.client.post('/api/quiz/sessions', { quiz_id: quizId })
    assert.equal(res.status, 404)
  })

  it('clamps an out-of-range question timer', async () => {
    const mentor = await createUser(base, 'mentor')
    const quizId = await createQuiz(mentor.id, SAMPLE_QUESTIONS)

    const res = await mentor.client.post('/api/quiz/sessions', {
      quiz_id: quizId,
      settings: { questionTimer: 99999 },
    })
    assert.equal(res.status, 400)
  })
})

describe('quiz: joining', () => {
  it('a student joins by code', async () => {
    const { student, sessionCode } = await setupSession()

    const res = await student.client.post('/api/quiz/join', { session_code: sessionCode })
    assert.equal(res.status, 200)
    assert.equal(res.body.data.alreadyJoined, false)
    assert.ok(res.body.data.participant.id)
  })

  it('accepts a lowercase code', async () => {
    const { student, sessionCode } = await setupSession()
    const res = await student.client.post('/api/quiz/join', {
      session_code: sessionCode.toLowerCase(),
    })
    assert.equal(res.status, 200)
  })

  it('joining twice does not create a duplicate participant', async () => {
    const { student, sessionCode, sessionId } = await setupSession()

    await student.client.post('/api/quiz/join', { session_code: sessionCode })
    const second = await student.client.post('/api/quiz/join', { session_code: sessionCode })

    assert.equal(second.status, 200)
    assert.equal(second.body.data.alreadyJoined, true)

    const rows = await query('SELECT 1 FROM session_participants WHERE session_id = $1', [
      sessionId,
    ])
    assert.equal(rows.length, 1)
  })

  it('rejects an unknown code', async () => {
    const { student } = await setupSession()
    const res = await student.client.post('/api/quiz/join', { session_code: 'ZZZZZZ' })
    assert.equal(res.status, 404)
  })

  it('refuses late join when the session has started and late join is off', async () => {
    const { mentor, student, sessionId, sessionCode } = await setupSession()
    await mentor.client.post(`/api/quiz/sessions/${sessionId}/start`)

    const res = await student.client.post('/api/quiz/join', { session_code: sessionCode })
    assert.equal(res.status, 409)
  })
})

describe('quiz: host controls are authorized', () => {
  it('AUDIT FIX: a student cannot advance the question', async () => {
    // The original advanceQuestion server action had no auth check at all.
    const { mentor, student, sessionId, sessionCode } = await setupSession()
    await student.client.post('/api/quiz/join', { session_code: sessionCode })
    await mentor.client.post(`/api/quiz/sessions/${sessionId}/start`)

    const res = await student.client.post(`/api/quiz/sessions/${sessionId}/advance`)
    assert.equal(res.status, 403)

    const rows = await query<{ current_question_index: number }>(
      'SELECT current_question_index FROM quiz_sessions WHERE id = $1',
      [sessionId]
    )
    assert.equal(rows[0]!.current_question_index, 0, 'question must not have advanced')
  })

  it('AUDIT FIX: a student cannot end the session', async () => {
    const { mentor, student, sessionId, sessionCode } = await setupSession()
    await student.client.post('/api/quiz/join', { session_code: sessionCode })
    await mentor.client.post(`/api/quiz/sessions/${sessionId}/start`)

    const res = await student.client.post(`/api/quiz/sessions/${sessionId}/end`)
    assert.equal(res.status, 403)

    const rows = await query<{ status: string }>(
      'SELECT status FROM quiz_sessions WHERE id = $1',
      [sessionId]
    )
    assert.equal(rows[0]!.status, 'active')
  })

  it('a student cannot read the host answer-distribution stats', async () => {
    const { mentor, student, sessionId, sessionCode } = await setupSession()
    await student.client.post('/api/quiz/join', { session_code: sessionCode })
    await mentor.client.post(`/api/quiz/sessions/${sessionId}/start`)

    const res = await student.client.get(`/api/quiz/sessions/${sessionId}/stats?questionIndex=0`)
    assert.equal(res.status, 403)
  })

  it('the host can advance, and the clock is rewritten each time', async () => {
    const { mentor, sessionId } = await setupSession()
    await mentor.client.post(`/api/quiz/sessions/${sessionId}/start`)

    const first = await query<{ question_start_time: Date; question_end_time: Date }>(
      'SELECT question_start_time, question_end_time FROM quiz_sessions WHERE id = $1',
      [sessionId]
    )
    assert.ok(first[0]!.question_start_time, 'start must set the clock')

    const res = await mentor.client.post(`/api/quiz/sessions/${sessionId}/advance`)
    assert.equal(res.status, 200)
    assert.equal(res.body.data.nextIndex, 1)

    // AUDIT FIX: the original advanceQuestion never touched these columns, so
    // they stayed pinned to question 1 for the whole session.
    const second = await query<{ question_start_time: Date; question_end_time: Date }>(
      'SELECT question_start_time, question_end_time FROM quiz_sessions WHERE id = $1',
      [sessionId]
    )
    assert.notDeepEqual(
      second[0]!.question_start_time,
      first[0]!.question_start_time,
      'advancing must restart the clock'
    )
  })

  it('advancing past the last question finishes the session', async () => {
    const { mentor, student, sessionId, sessionCode } = await setupSession()
    await student.client.post('/api/quiz/join', { session_code: sessionCode })
    await mentor.client.post(`/api/quiz/sessions/${sessionId}/start`)

    await mentor.client.post(`/api/quiz/sessions/${sessionId}/advance`) // -> q2
    const last = await mentor.client.post(`/api/quiz/sessions/${sessionId}/advance`) // -> done

    assert.equal(last.body.data.finished, true)

    const rows = await query<{ status: string }>(
      'SELECT status FROM quiz_sessions WHERE id = $1',
      [sessionId]
    )
    assert.equal(rows[0]!.status, 'finished')

    const board = await query<{ quizzes_completed: number }>(
      'SELECT quizzes_completed FROM leaderboard WHERE user_id = $1',
      [student.id]
    )
    assert.equal(board[0]?.quizzes_completed, 1)
  })
})

describe('quiz: the student question view', () => {
  it('AUDIT FIX: does not leak the correct answer before answering', async () => {
    const { mentor, student, sessionId, sessionCode } = await setupSession()
    await student.client.post('/api/quiz/join', { session_code: sessionCode })
    await mentor.client.post(`/api/quiz/sessions/${sessionId}/start`)

    const res = await student.client.get(`/api/quiz/sessions/${sessionId}/question`)
    assert.equal(res.status, 200)

    const payload = JSON.stringify(res.body)
    assert.doesNotMatch(payload, /correctOptionIndex/, 'answer key must not be in the payload')
    assert.doesNotMatch(payload, /isCorrect/, 'option flags must not be in the payload')
    assert.equal(res.body.data.correctAnswer, null)

    // Only the current question is exposed, never the whole question bank.
    assert.equal(res.body.data.question.questionText, 'What is 2 + 2?')
    assert.deepEqual(res.body.data.question.options, ['3', '4', '5', '6'])
  })

  it('reveals the correct answer only after the student has answered', async () => {
    const { mentor, student, sessionId, sessionCode } = await setupSession()
    await student.client.post('/api/quiz/join', { session_code: sessionCode })
    await mentor.client.post(`/api/quiz/sessions/${sessionId}/start`)

    await student.client.post(`/api/quiz/sessions/${sessionId}/answer`, {
      questionIndex: 0,
      selectedOptionIndex: 1,
    })

    const res = await student.client.get(`/api/quiz/sessions/${sessionId}/question`)
    assert.equal(res.body.data.correctAnswer, 1)
  })

  it('a non-participant cannot read the question', async () => {
    const { mentor, sessionId } = await setupSession()
    const outsider = await createUser(base, 'student')
    await mentor.client.post(`/api/quiz/sessions/${sessionId}/start`)

    const res = await outsider.client.get(`/api/quiz/sessions/${sessionId}/question`)
    assert.equal(res.status, 403)
  })

  it('the host view DOES include the correct answer', async () => {
    const { mentor, sessionId } = await setupSession()
    await mentor.client.post(`/api/quiz/sessions/${sessionId}/start`)

    const res = await mentor.client.get(`/api/quiz/sessions/${sessionId}/host-question`)
    assert.equal(res.status, 200)
    assert.equal(res.body.data.question.correctOptionIndex, 1)
  })
})

describe('quiz: answer submission', () => {
  async function activeSession() {
    const ctx = await setupSession()
    await ctx.student.client.post('/api/quiz/join', { session_code: ctx.sessionCode })
    await ctx.mentor.client.post(`/api/quiz/sessions/${ctx.sessionId}/start`)
    return ctx
  }

  it('scores a correct answer and credits the ledger', async () => {
    const { student, sessionId } = await activeSession()

    const res = await student.client.post(`/api/quiz/sessions/${sessionId}/answer`, {
      questionIndex: 0,
      selectedOptionIndex: 1,
    })

    assert.equal(res.status, 200)
    assert.equal(res.body.data.isCorrect, true)
    assert.ok(res.body.data.pointsEarned > 0)

    // profiles.leaderboard_points and the leaderboard table are both derived
    // from points_history by trigger, so all three must agree.
    const ledger = await query<{ points: number }>(
      'SELECT points FROM points_history WHERE user_id = $1',
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

    assert.equal(ledger[0]!.points, res.body.data.pointsEarned)
    assert.equal(board[0]!.total_points, res.body.data.pointsEarned)
    assert.equal(profile[0]!.leaderboard_points, res.body.data.pointsEarned)
  })

  it('scores a wrong answer as zero and still counts the attempt', async () => {
    const { student, sessionId } = await activeSession()

    const res = await student.client.post(`/api/quiz/sessions/${sessionId}/answer`, {
      questionIndex: 0,
      selectedOptionIndex: 3,
    })

    assert.equal(res.body.data.isCorrect, false)
    assert.equal(res.body.data.pointsEarned, 0)

    const board = await query<{ total_attempts: number; correct_answers: number }>(
      'SELECT total_attempts, correct_answers FROM leaderboard WHERE user_id = $1',
      [student.id]
    )
    assert.equal(board[0]?.total_attempts, 1, 'a first wrong answer must still be recorded')
    assert.equal(board[0]?.correct_answers, 0)
  })

  it('AUDIT FIX: rejects a replayed submission for the same question', async () => {
    const { student, sessionId } = await activeSession()

    const first = await student.client.post(`/api/quiz/sessions/${sessionId}/answer`, {
      questionIndex: 0,
      selectedOptionIndex: 1,
    })
    assert.equal(first.status, 200)

    const replay = await student.client.post(`/api/quiz/sessions/${sessionId}/answer`, {
      questionIndex: 0,
      selectedOptionIndex: 1,
    })
    assert.equal(replay.status, 409)
    assert.equal(replay.body.error.code, 'ALREADY_ANSWERED')

    const answers = await query('SELECT 1 FROM session_answers WHERE session_id = $1', [sessionId])
    assert.equal(answers.length, 1, 'points must not stack')
  })

  it('AUDIT FIX: rejects an answer for a question that is not current', async () => {
    const { student, sessionId } = await activeSession()

    const res = await student.client.post(`/api/quiz/sessions/${sessionId}/answer`, {
      questionIndex: 1, // still on question 0
      selectedOptionIndex: 2,
    })

    assert.equal(res.status, 409)
    assert.equal(res.body.error.code, 'STALE_QUESTION')
  })

  it('AUDIT FIX: a client-supplied answer time cannot buy a speed bonus', async () => {
    const { student, sessionId } = await activeSession()

    // The old handler took answerTimeMs straight from the request, so sending 0
    // guaranteed the maximum bonus. The field is not even read now.
    const res = await student.client.post(`/api/quiz/sessions/${sessionId}/answer`, {
      questionIndex: 0,
      selectedOptionIndex: 1,
      answerTimeMs: 0,
      time_taken_ms: 0,
    })

    assert.equal(res.status, 200)
    const rows = await query<{ time_taken_ms: number }>(
      'SELECT time_taken_ms FROM session_answers WHERE session_id = $1',
      [sessionId]
    )
    assert.ok(rows[0]!.time_taken_ms > 0, 'server must measure the elapsed time itself')
  })

  it('refuses answers before the session is active', async () => {
    const { student, sessionId, sessionCode } = await setupSession()
    await student.client.post('/api/quiz/join', { session_code: sessionCode })

    const res = await student.client.post(`/api/quiz/sessions/${sessionId}/answer`, {
      questionIndex: 0,
      selectedOptionIndex: 1,
    })
    assert.equal(res.status, 409)
    assert.equal(res.body.error.code, 'NOT_ACTIVE')
  })

  it('a non-participant cannot answer', async () => {
    const { mentor, sessionId } = await setupSession()
    const outsider = await createUser(base, 'student')
    await mentor.client.post(`/api/quiz/sessions/${sessionId}/start`)

    const res = await outsider.client.post(`/api/quiz/sessions/${sessionId}/answer`, {
      questionIndex: 0,
      selectedOptionIndex: 1,
    })
    assert.equal(res.status, 403)
  })

  it('builds a streak across consecutive correct answers', async () => {
    const { mentor, student, sessionId } = await activeSession()

    await student.client.post(`/api/quiz/sessions/${sessionId}/answer`, {
      questionIndex: 0,
      selectedOptionIndex: 1,
    })
    await mentor.client.post(`/api/quiz/sessions/${sessionId}/advance`)
    const second = await student.client.post(`/api/quiz/sessions/${sessionId}/answer`, {
      questionIndex: 1,
      selectedOptionIndex: 2,
    })

    assert.equal(second.body.data.newStreak, 2)
  })
})

describe('quiz: self-paced attempts', () => {
  it('AUDIT FIX: the server grades the attempt, not the browser', async () => {
    const mentor = await createUser(base, 'mentor')
    const student = await createUser(base, 'student')
    const quizId = await createQuiz(mentor.id, SAMPLE_QUESTIONS)

    // Both answers correct -> 2 * 10 points.
    const res = await student.client.post('/api/quiz/attempts', {
      quiz_id: quizId,
      answers: [1, 2],
    })

    assert.equal(res.status, 201)
    assert.equal(res.body.data.correctAnswers, 2)
    assert.equal(res.body.data.pointsEarned, 20)

    const board = await query<{ total_points: number }>(
      'SELECT total_points FROM leaderboard WHERE user_id = $1',
      [student.id]
    )
    assert.equal(board[0]!.total_points, 20)
  })

  it('a fabricated score in the request is ignored', async () => {
    const mentor = await createUser(base, 'mentor')
    const student = await createUser(base, 'student')
    const quizId = await createQuiz(mentor.id, SAMPLE_QUESTIONS)

    const res = await student.client.post('/api/quiz/attempts', {
      quiz_id: quizId,
      answers: [0, 0], // both wrong
      score: 999,
      correct_answers: 999,
      pointsEarned: 999999,
    })

    assert.equal(res.status, 201)
    assert.equal(res.body.data.correctAnswers, 0)
    assert.equal(res.body.data.pointsEarned, 0)

    const board = await query<{ total_points: number }>(
      'SELECT total_points FROM leaderboard WHERE user_id = $1',
      [student.id]
    )
    assert.equal(board[0]?.total_points ?? 0, 0)
  })

  it('a student cannot attempt an unpublished quiz', async () => {
    const mentor = await createUser(base, 'mentor')
    const student = await createUser(base, 'student')
    const quizId = await createQuiz(mentor.id, SAMPLE_QUESTIONS, 'draft')

    const res = await student.client.post('/api/quiz/attempts', {
      quiz_id: quizId,
      answers: [1, 2],
    })
    assert.equal(res.status, 403)
  })
})

describe('quiz: leaderboard', () => {
  it('ranks participants by score', async () => {
    const mentor = await createUser(base, 'mentor')
    const quizId = await createQuiz(mentor.id, SAMPLE_QUESTIONS)
    const created = await mentor.client.post('/api/quiz/sessions', { quiz_id: quizId })
    const sessionId = created.body.data.session.id
    const code = created.body.data.sessionCode

    const strong = await createUser(base, 'student')
    const weak = await createUser(base, 'student')
    await strong.client.post('/api/quiz/join', { session_code: code })
    await weak.client.post('/api/quiz/join', { session_code: code })
    await mentor.client.post(`/api/quiz/sessions/${sessionId}/start`)

    await strong.client.post(`/api/quiz/sessions/${sessionId}/answer`, {
      questionIndex: 0,
      selectedOptionIndex: 1,
    })
    await weak.client.post(`/api/quiz/sessions/${sessionId}/answer`, {
      questionIndex: 0,
      selectedOptionIndex: 0,
    })

    const res = await mentor.client.get(`/api/quiz/sessions/${sessionId}/leaderboard`)
    assert.equal(res.status, 200)

    const board = res.body.data.leaderboard
    assert.equal(board[0].user_id, strong.id)
    assert.equal(board[0].rank, 1)
    assert.equal(board[1].rank, 2)
  })

  it('an outsider cannot read the session leaderboard', async () => {
    const { sessionId } = await setupSession()
    const outsider = await createUser(base, 'student')

    const res = await outsider.client.get(`/api/quiz/sessions/${sessionId}/leaderboard`)
    assert.equal(res.status, 403)
  })
})
