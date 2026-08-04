-- 0006_feedback_mentorship.sql
-- Mentor assignment, direct feedback, and structured feedback campaigns.

-- ---------------------------------------------------------------------------
-- mentor_assignments : which mentor owns which student.
-- ---------------------------------------------------------------------------
CREATE TABLE mentor_assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mentor_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by uuid REFERENCES users(id) ON DELETE SET NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- admin/managementor updates by student_id without a limit, which only makes
  -- sense if a student has exactly one assignment row. Enforced.
  UNIQUE (student_id)
);

CREATE INDEX mentor_assignments_mentor_id_idx ON mentor_assignments (mentor_id, status);

CREATE TRIGGER mentor_assignments_set_updated_at
  BEFORE UPDATE ON mentor_assignments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- feedback : a student's direct feedback, optionally about a mentor.
-- ---------------------------------------------------------------------------
CREATE TABLE feedback (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Set when feedback_type = 'mentor'; the mentor dashboard filters on it.
  mentor_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  feedback_type text NOT NULL DEFAULT 'general',
  rating        integer CHECK (rating BETWEEN 1 AND 5),
  title         text,
  message       text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX feedback_student_id_idx ON feedback (student_id, created_at DESC);
CREATE INDEX feedback_mentor_id_idx ON feedback (mentor_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- feedback_sessions : an admin-run feedback campaign.
-- ---------------------------------------------------------------------------
CREATE TABLE feedback_sessions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title                    text NOT NULL,
  description              text,
  session_type             text NOT NULL DEFAULT 'general',
  status                   text NOT NULL DEFAULT 'draft'
                             CHECK (status IN ('draft', 'active', 'closed')),
  start_date               timestamptz,
  end_date                 timestamptz,
  allow_anonymous          boolean NOT NULL DEFAULT false,
  require_rating           boolean NOT NULL DEFAULT true,
  max_submissions_per_user integer NOT NULL DEFAULT 1,
  created_by               uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX feedback_sessions_status_idx ON feedback_sessions (status);

CREATE TRIGGER feedback_sessions_set_updated_at
  BEFORE UPDATE ON feedback_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- session_feedback_responses : submissions to a campaign.
-- user_id is nullable to support allow_anonymous campaigns.
-- ---------------------------------------------------------------------------
CREATE TABLE session_feedback_responses (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES feedback_sessions(id) ON DELETE CASCADE,
  user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  rating     integer CHECK (rating BETWEEN 1 AND 5),
  title      text,
  message    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX session_feedback_responses_session_id_idx
  ON session_feedback_responses (session_id, created_at DESC);
CREATE INDEX session_feedback_responses_user_id_idx ON session_feedback_responses (user_id);
