-- 0008_task_assignment_assigned_by.sql
-- Record who handed a task to a student.
--
-- Both admin/managetask and mentor/managetask send assigned_by with every
-- assignment they create, but the column never existed, so the insert was
-- rejected with "Column \"assigned_by\" is not writable on task_assignments"
-- and a freshly created task reached nobody.
--
-- Nullable and ON DELETE SET NULL, matching mentor_assignments.assigned_by:
-- rows created before this migration have no assigner to name, and deleting a
-- staff account must not cascade away every assignment they ever made.

ALTER TABLE task_assignments
  ADD COLUMN assigned_by uuid REFERENCES users(id) ON DELETE SET NULL;
