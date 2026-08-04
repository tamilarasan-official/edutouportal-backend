-- 0007_seed.sql
-- Baseline reference data. Idempotent: safe to re-run.
--
-- points_config is seeded from the ACTION_TYPE_LABELS map in
-- app/admin/managepoints/page.tsx plus the ActionType union in utils/points.ts,
-- so every action the code can award has a row. Values are a starting point --
-- admins can edit them in the UI.

INSERT INTO points_config (action_type, points, description) VALUES
  ('task_submission',         50,  'Submitting a completed task'),
  ('discussion_create',       20,  'Starting a discussion thread'),
  ('discussion_comment',      5,   'Commenting on a discussion'),
  ('quiz_completion',         100, 'Finishing a quiz'),
  ('quiz_perfect_score',      200, 'Scoring 100% on a quiz'),
  ('resource_upload',         30,  'Sharing a learning resource'),
  ('hackathon_participation', 150, 'Taking part in a hackathon'),
  ('feedback_submission',     10,  'Submitting feedback'),
  ('daily_login',             5,   'Logging in for the day'),
  ('profile_completion',      25,  'Completing your profile')
ON CONFLICT (action_type) DO NOTHING;

-- Manual adjustment types are recorded in the ledger but are never looked up in
-- points_config (adjust_points_manual takes an explicit amount). Rows exist
-- only so the admin UI can list them; is_active = false keeps award_points
-- from ever matching them.
INSERT INTO points_config (action_type, points, description, is_active) VALUES
  ('manual_points_add',      0, 'Manual grant by a mentor or admin',     false),
  ('manual_points_subtract', 0, 'Manual deduction by a mentor or admin', false)
ON CONFLICT (action_type) DO NOTHING;
