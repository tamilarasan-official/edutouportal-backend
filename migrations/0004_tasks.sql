-- 0004_tasks.sql
-- Multi-step task assignments and student submissions.
--
-- Columns come from app/task/page.tsx (TaskStep / TaskCompletion / Task
-- interfaces), plus the insert payloads in admin/managetask and mentor/managetask.

-- ---------------------------------------------------------------------------
-- tasks
-- ---------------------------------------------------------------------------
CREATE TABLE tasks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  description text,
  due_date    timestamptz,
  -- Creator. Named mentor_id even when an admin creates the task -- the admin
  -- page writes its own id here with the comment "Store admin ID as creator".
  mentor_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  points      integer NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tasks_mentor_id_idx ON tasks (mentor_id);
CREATE INDEX tasks_is_active_idx ON tasks (is_active);

CREATE TRIGGER tasks_set_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- task_steps : ordered checklist within a task.
-- ---------------------------------------------------------------------------
CREATE TABLE task_steps (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id         uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step_number     integer NOT NULL,
  title           text NOT NULL,
  description     text,
  -- 'text' | 'file' | 'link' | 'checkbox' -- unconstrained because the UI
  -- builds this string freely and a CHECK would break unknown existing values.
  submission_type text NOT NULL DEFAULT 'text',
  allowed_types   text[],
  is_required     boolean NOT NULL DEFAULT true,
  -- Bytes. NULL means "use the server default".
  max_file_size   bigint,
  created_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (task_id, step_number)
);

CREATE INDEX task_steps_task_id_idx ON task_steps (task_id, step_number);

-- ---------------------------------------------------------------------------
-- task_assignments : a task handed to a specific student.
-- ---------------------------------------------------------------------------
CREATE TABLE task_assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  student_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'assigned'
                CHECK (status IN ('assigned', 'in_progress', 'submitted', 'completed', 'rejected')),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  -- Set when the student first submits any step; app/task/page.tsx writes both.
  started_at   timestamptz,
  completed_at timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- Assigning the same task twice to one student was previously possible.
  UNIQUE (task_id, student_id)
);

CREATE INDEX task_assignments_student_id_idx ON task_assignments (student_id);
CREATE INDEX task_assignments_task_id_idx ON task_assignments (task_id);

CREATE TRIGGER task_assignments_set_updated_at
  BEFORE UPDATE ON task_assignments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- task_step_completions : one row per (assignment, step).
-- ---------------------------------------------------------------------------
CREATE TABLE task_step_completions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id   uuid NOT NULL REFERENCES task_assignments(id) ON DELETE CASCADE,
  step_id         uuid NOT NULL REFERENCES task_steps(id) ON DELETE CASCADE,
  submission_type text,
  text_content    text,
  file_url        text,
  link_url        text,
  -- Multi-file submissions; uploadTaskFiles returns an array of URLs.
  file_urls       text[],
  is_completed    boolean NOT NULL DEFAULT false,
  completed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- The frontend keyed completions by step_id in a Map, assuming one row per
  -- step. It did a SELECT-then-INSERT-or-UPDATE, which races. Enforced here.
  UNIQUE (assignment_id, step_id)
);

CREATE INDEX task_step_completions_assignment_id_idx ON task_step_completions (assignment_id);
CREATE INDEX task_step_completions_step_id_idx ON task_step_completions (step_id);

CREATE TRIGGER task_step_completions_set_updated_at
  BEFORE UPDATE ON task_step_completions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
