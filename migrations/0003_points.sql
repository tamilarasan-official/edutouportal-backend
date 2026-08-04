-- 0003_points.sql
-- Points, ledger, and leaderboard.
--
-- The old system had THREE parallel points stores that could not agree:
--   1. profiles.leaderboard_points  <- what /leaderboard actually renders
--   2. leaderboard table            <- written by the quiz answer handler
--   3. points_history + award_points RPC <- written by tasks and discussions
-- Nothing reconciled them, and every write was a non-atomic read-modify-write.
--
-- This migration makes points_history the single append-only ledger. A trigger
-- derives both `leaderboard` and `profiles.leaderboard_points` from it, so the
-- existing frontend reads keep working and can no longer drift apart.

-- ---------------------------------------------------------------------------
-- points_config : how many points each action is worth. Admin-editable.
-- ---------------------------------------------------------------------------
CREATE TABLE points_config (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type text NOT NULL UNIQUE,
  points      integer NOT NULL DEFAULT 0,
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER points_config_set_updated_at
  BEFORE UPDATE ON points_config
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- points_history : the ledger. Append-only; never UPDATE or DELETE rows here.
-- ---------------------------------------------------------------------------
CREATE TABLE points_history (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_type    text NOT NULL,
  -- Signed: negative for manual deductions via adjust_points_manual.
  points         integer NOT NULL,
  -- Which bucket on the leaderboard this credits.
  category       text NOT NULL DEFAULT 'bonus'
                   CHECK (category IN ('quiz', 'assignment', 'bonus')),
  reference_id   text,
  reference_type text,
  description    text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX points_history_user_id_idx ON points_history (user_id, created_at DESC);
CREATE INDEX points_history_action_type_idx ON points_history (action_type);

-- Lets award_points enforce "once per reference" for actions that should not
-- be repeatable (e.g. completing the same task twice).
CREATE UNIQUE INDEX points_history_unique_reference
  ON points_history (user_id, action_type, reference_id)
  WHERE reference_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- leaderboard : per-user rollup, derived from the ledger by trigger.
-- ---------------------------------------------------------------------------
CREATE TABLE leaderboard (
  user_id           uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  total_points      integer NOT NULL DEFAULT 0,
  quiz_points       integer NOT NULL DEFAULT 0,
  assignment_points integer NOT NULL DEFAULT 0,
  bonus_points      integer NOT NULL DEFAULT 0,
  quizzes_completed integer NOT NULL DEFAULT 0,
  correct_answers   integer NOT NULL DEFAULT 0,
  total_attempts    integer NOT NULL DEFAULT 0,
  last_activity     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX leaderboard_total_points_idx ON leaderboard (total_points DESC);

-- ---------------------------------------------------------------------------
-- Ledger -> rollup. One statement, atomic, no read-modify-write race.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION apply_points_to_leaderboard() RETURNS trigger AS $$
BEGIN
  INSERT INTO leaderboard (
    user_id, total_points, quiz_points, assignment_points, bonus_points, last_activity
  )
  VALUES (
    NEW.user_id,
    NEW.points,
    CASE WHEN NEW.category = 'quiz'       THEN NEW.points ELSE 0 END,
    CASE WHEN NEW.category = 'assignment' THEN NEW.points ELSE 0 END,
    CASE WHEN NEW.category = 'bonus'      THEN NEW.points ELSE 0 END,
    NEW.created_at
  )
  ON CONFLICT (user_id) DO UPDATE SET
    total_points      = leaderboard.total_points      + EXCLUDED.total_points,
    quiz_points       = leaderboard.quiz_points       + EXCLUDED.quiz_points,
    assignment_points = leaderboard.assignment_points + EXCLUDED.assignment_points,
    bonus_points      = leaderboard.bonus_points      + EXCLUDED.bonus_points,
    last_activity     = EXCLUDED.last_activity;

  -- Keep the denormalised mirror that /leaderboard reads in lockstep.
  UPDATE profiles
     SET leaderboard_points = (SELECT total_points FROM leaderboard WHERE user_id = NEW.user_id)
   WHERE id = NEW.user_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER points_history_apply
  AFTER INSERT ON points_history
  FOR EACH ROW EXECUTE FUNCTION apply_points_to_leaderboard();

-- ---------------------------------------------------------------------------
-- award_points : look up the configured value and write one ledger row.
-- Signature matches the existing utils/points.ts call exactly.
--
-- Returns the number of points actually awarded (0 if the action is disabled,
-- unconfigured, or already credited for this reference).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION award_points(
  p_user_id        uuid,
  p_action_type    text,
  p_reference_id   text DEFAULT NULL,
  p_reference_type text DEFAULT NULL,
  p_description    text DEFAULT NULL
) RETURNS integer AS $$
DECLARE
  v_points   integer;
  v_category text;
BEGIN
  SELECT points INTO v_points
    FROM points_config
   WHERE action_type = p_action_type AND is_active = true;

  IF v_points IS NULL OR v_points = 0 THEN
    RETURN 0;
  END IF;

  v_category := CASE
    WHEN p_action_type LIKE 'quiz%' THEN 'quiz'
    WHEN p_action_type IN ('task_submission') THEN 'assignment'
    ELSE 'bonus'
  END;

  -- ON CONFLICT covers the partial unique index: re-awarding the same
  -- reference is a silent no-op rather than duplicate credit.
  INSERT INTO points_history (
    user_id, action_type, points, category, reference_id, reference_type, description
  )
  VALUES (
    p_user_id, p_action_type, v_points, v_category, p_reference_id, p_reference_type, p_description
  )
  ON CONFLICT DO NOTHING;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  RETURN v_points;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- adjust_points_manual : mentor/admin manual grant or deduction.
-- p_points is signed. Never deduplicated -- manual adjustments are intentional.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION adjust_points_manual(
  p_user_id        uuid,
  p_action_type    text,
  p_points         integer,
  p_reference_id   text DEFAULT NULL,
  p_reference_type text DEFAULT NULL,
  p_description    text DEFAULT NULL
) RETURNS integer AS $$
BEGIN
  INSERT INTO points_history (
    user_id, action_type, points, category, reference_id, reference_type, description
  )
  VALUES (
    p_user_id, p_action_type, p_points, 'bonus', p_reference_id, p_reference_type, p_description
  );

  RETURN p_points;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- get_user_total_points : authoritative total, straight from the ledger.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_user_total_points(p_user_id uuid) RETURNS integer AS $$
  SELECT COALESCE(SUM(points), 0)::integer FROM points_history WHERE user_id = p_user_id;
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------------
-- Rebuild helper: recompute every rollup from the ledger. Use after a manual
-- data fix, or to verify the trigger has not drifted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rebuild_leaderboard() RETURNS void AS $$
BEGIN
  INSERT INTO leaderboard (user_id, total_points, quiz_points, assignment_points, bonus_points, last_activity)
  SELECT
    user_id,
    COALESCE(SUM(points), 0)::integer,
    COALESCE(SUM(points) FILTER (WHERE category = 'quiz'), 0)::integer,
    COALESCE(SUM(points) FILTER (WHERE category = 'assignment'), 0)::integer,
    COALESCE(SUM(points) FILTER (WHERE category = 'bonus'), 0)::integer,
    MAX(created_at)
  FROM points_history
  GROUP BY user_id
  ON CONFLICT (user_id) DO UPDATE SET
    total_points      = EXCLUDED.total_points,
    quiz_points       = EXCLUDED.quiz_points,
    assignment_points = EXCLUDED.assignment_points,
    bonus_points      = EXCLUDED.bonus_points,
    last_activity     = EXCLUDED.last_activity;

  UPDATE profiles p
     SET leaderboard_points = COALESCE(l.total_points, 0)
    FROM leaderboard l
   WHERE l.user_id = p.id;
END;
$$ LANGUAGE plpgsql;
