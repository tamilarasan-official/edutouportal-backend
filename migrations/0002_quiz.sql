-- 0002_quiz.sql
-- Quiz authoring + the live (Kahoot-style) session subsystem.
--
-- Column set is taken from types/realtime-quiz.ts, which was written as a spec
-- for exactly these tables but never imported by any code. Where the running
-- code disagreed with that file, the code wins and the difference is noted.

-- ---------------------------------------------------------------------------
-- quizzes
-- ---------------------------------------------------------------------------
CREATE TABLE quizzes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  description text,
  -- Question shape is NOT stable across the codebase:
  --   app/mentor/makequiz     writes options as [{id, text}] + correctOptionIndex
  --   app/student/quiz/...    reads  options as string[]     + correctOptionIndex
  -- makequiz has a "convertedQuestions" step that bridges them. Kept as jsonb so
  -- both shapes round-trip; normalising them is a frontend concern.
  questions   jsonb NOT NULL DEFAULT '[]'::jsonb,
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  quiz_code   text,
  created_by  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Codes are only unique among quizzes that have one (drafts have NULL).
CREATE UNIQUE INDEX quizzes_quiz_code_key ON quizzes (quiz_code) WHERE quiz_code IS NOT NULL;
CREATE INDEX quizzes_created_by_idx ON quizzes (created_by);
CREATE INDEX quizzes_status_idx ON quizzes (status);

CREATE TRIGGER quizzes_set_updated_at
  BEFORE UPDATE ON quizzes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- quiz_sessions : one live run of a quiz.
-- ---------------------------------------------------------------------------
CREATE TABLE quiz_sessions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_id                uuid NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  host_id                uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_code           text NOT NULL UNIQUE,
  status                 text NOT NULL DEFAULT 'lobby'
                           CHECK (status IN ('lobby', 'active', 'paused', 'finished')),

  current_question_index integer NOT NULL DEFAULT 0,
  current_question_id    text,
  -- These two are the authoritative clock. The old frontend ignored them and
  -- timed questions with client-side Date.now(), which let a student refresh to
  -- reset their timer. The new submit endpoint validates against these columns.
  question_start_time    timestamptz,
  question_end_time      timestamptz,

  settings               jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at             timestamptz NOT NULL DEFAULT now(),
  started_at             timestamptz,
  finished_at            timestamptz
);

CREATE INDEX quiz_sessions_quiz_id_idx ON quiz_sessions (quiz_id);
CREATE INDEX quiz_sessions_host_id_idx ON quiz_sessions (host_id);
CREATE INDEX quiz_sessions_status_idx ON quiz_sessions (status);

-- ---------------------------------------------------------------------------
-- session_participants
-- ---------------------------------------------------------------------------
CREATE TABLE session_participants (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id           uuid NOT NULL REFERENCES quiz_sessions(id) ON DELETE CASCADE,
  user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname             text,
  status               text NOT NULL DEFAULT 'waiting'
                         CHECK (status IN ('waiting', 'active', 'finished', 'disconnected')),

  total_score          integer NOT NULL DEFAULT 0,
  correct_answers      integer NOT NULL DEFAULT 0,
  incorrect_answers    integer NOT NULL DEFAULT 0,
  current_streak       integer NOT NULL DEFAULT 0,
  longest_streak       integer NOT NULL DEFAULT 0,

  questions_answered   integer NOT NULL DEFAULT 0,
  questions_skipped    integer NOT NULL DEFAULT 0,
  avg_response_time_ms integer NOT NULL DEFAULT 0,

  joined_at            timestamptz NOT NULL DEFAULT now(),
  last_seen            timestamptz NOT NULL DEFAULT now(),

  -- The join flow checked for duplicates with a SELECT first, which races under
  -- concurrent joins. Enforce it here instead.
  UNIQUE (session_id, user_id)
);

CREATE INDEX session_participants_session_id_idx ON session_participants (session_id);
CREATE INDEX session_participants_user_id_idx ON session_participants (user_id);
CREATE INDEX session_participants_leaderboard_idx
  ON session_participants (session_id, total_score DESC, joined_at ASC);

-- ---------------------------------------------------------------------------
-- session_answers
-- ---------------------------------------------------------------------------
CREATE TABLE session_answers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        uuid NOT NULL REFERENCES quiz_sessions(id) ON DELETE CASCADE,
  participant_id    uuid NOT NULL REFERENCES session_participants(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  question_id       text NOT NULL,
  question_index    integer NOT NULL,
  -- Stored as text because the old insert did selectedOptionIndex.toString().
  -- Kept as text so existing readers (which parseInt it) keep working.
  selected_option_id text,
  is_correct        boolean NOT NULL DEFAULT false,

  answered_at       timestamptz NOT NULL DEFAULT now(),
  time_taken_ms     integer NOT NULL DEFAULT 0,

  points_earned     integer NOT NULL DEFAULT 0,
  speed_bonus       integer NOT NULL DEFAULT 0,
  streak_multiplier numeric(4,2) NOT NULL DEFAULT 1.0,

  -- The old submitAnswer had no duplicate check at all, so a student could
  -- replay the same request and stack points. This constraint is the fix.
  UNIQUE (participant_id, question_index)
);

CREATE INDEX session_answers_session_id_idx ON session_answers (session_id);
CREATE INDEX session_answers_session_question_idx ON session_answers (session_id, question_index);
CREATE INDEX session_answers_user_id_idx ON session_answers (user_id);

-- ---------------------------------------------------------------------------
-- session_events : append-only session audit log.
-- ---------------------------------------------------------------------------
CREATE TABLE session_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES quiz_sessions(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  event_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX session_events_session_id_idx ON session_events (session_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- quiz_attempts : the older, non-live "enter a quiz code" flow.
-- Separate from the session subsystem; only app/quiz/[quizCode] writes it.
-- ---------------------------------------------------------------------------
CREATE TABLE quiz_attempts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_id         uuid NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  answers         jsonb NOT NULL DEFAULT '[]'::jsonb,
  score           integer NOT NULL DEFAULT 0,
  total_questions integer NOT NULL DEFAULT 0,
  correct_answers integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX quiz_attempts_quiz_id_idx ON quiz_attempts (quiz_id);
CREATE INDEX quiz_attempts_user_id_idx ON quiz_attempts (user_id);

-- ---------------------------------------------------------------------------
-- generate_session_code : 6-char code, retried until unique.
-- Excludes visually ambiguous characters (0/O, 1/I) since students type these
-- off a projected screen.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION generate_session_code() RETURNS text AS $$
DECLARE
  alphabet CONSTANT text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  candidate text;
  i integer;
BEGIN
  LOOP
    candidate := '';
    FOR i IN 1..6 LOOP
      candidate := candidate || substr(alphabet, floor(random() * length(alphabet) + 1)::int, 1);
    END LOOP;

    EXIT WHEN NOT EXISTS (SELECT 1 FROM quiz_sessions WHERE session_code = candidate);
  END LOOP;

  RETURN candidate;
END;
$$ LANGUAGE plpgsql;
