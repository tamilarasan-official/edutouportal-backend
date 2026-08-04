-- 0005_social.sql
-- Discussion board, hackathon teams, shared resources, notifications,
-- and the coursemaster session tracker.

-- ---------------------------------------------------------------------------
-- discussions
-- ---------------------------------------------------------------------------
CREATE TABLE discussions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       text NOT NULL,
  description text NOT NULL,
  category    text NOT NULL DEFAULT 'general',
  -- Denormalised counters maintained by trigger from discussion_votes.
  upvotes     integer NOT NULL DEFAULT 0,
  downvotes   integer NOT NULL DEFAULT 0,
  views       integer NOT NULL DEFAULT 0,
  is_pinned   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX discussions_user_id_idx ON discussions (user_id);
CREATE INDEX discussions_category_idx ON discussions (category);
CREATE INDEX discussions_created_at_idx ON discussions (created_at DESC);

CREATE TRIGGER discussions_set_updated_at
  BEFORE UPDATE ON discussions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- discussion_comments
-- ---------------------------------------------------------------------------
CREATE TABLE discussion_comments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discussion_id uuid NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content       text NOT NULL,
  upvotes       integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX discussion_comments_discussion_id_idx
  ON discussion_comments (discussion_id, created_at DESC);

CREATE TRIGGER discussion_comments_set_updated_at
  BEFORE UPDATE ON discussion_comments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- discussion_votes : one vote per user per thread.
-- ---------------------------------------------------------------------------
CREATE TABLE discussion_votes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discussion_id uuid NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vote_type     text NOT NULL CHECK (vote_type IN ('up', 'down')),
  created_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (discussion_id, user_id)
);

CREATE INDEX discussion_votes_discussion_id_idx ON discussion_votes (discussion_id);

-- Keep discussions.upvotes / downvotes correct without the frontend having to
-- recount. The old code read counts off the row and trusted them.
CREATE OR REPLACE FUNCTION sync_discussion_votes() RETURNS trigger AS $$
DECLARE
  v_discussion_id uuid := COALESCE(NEW.discussion_id, OLD.discussion_id);
BEGIN
  UPDATE discussions d
     SET upvotes   = (SELECT count(*) FROM discussion_votes v
                       WHERE v.discussion_id = v_discussion_id AND v.vote_type = 'up'),
         downvotes = (SELECT count(*) FROM discussion_votes v
                       WHERE v.discussion_id = v_discussion_id AND v.vote_type = 'down')
   WHERE d.id = v_discussion_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER discussion_votes_sync
  AFTER INSERT OR UPDATE OR DELETE ON discussion_votes
  FOR EACH ROW EXECUTE FUNCTION sync_discussion_votes();

-- ---------------------------------------------------------------------------
-- hackathon_teams
-- ---------------------------------------------------------------------------
CREATE TABLE hackathon_teams (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_name   text NOT NULL,
  team_code   text NOT NULL UNIQUE,
  leader_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  theme       text,
  max_members integer NOT NULL DEFAULT 4,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX hackathon_teams_leader_id_idx ON hackathon_teams (leader_id);

CREATE TRIGGER hackathon_teams_set_updated_at
  BEFORE UPDATE ON hackathon_teams
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- hackathon_team_members
-- ---------------------------------------------------------------------------
CREATE TABLE hackathon_team_members (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id   uuid NOT NULL REFERENCES hackathon_teams(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),

  -- The UI enforces "one team per user" with a SELECT before INSERT. Made real:
  -- a user can hold at most one membership overall, not just one per team.
  UNIQUE (user_id)
);

CREATE INDEX hackathon_team_members_team_id_idx ON hackathon_team_members (team_id, joined_at);

-- ---------------------------------------------------------------------------
-- resources : shared files and notes, uploaded by mentors.
-- ---------------------------------------------------------------------------
CREATE TABLE resources (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name    text,
  file_url     text,
  file_type    text,
  file_size    bigint,
  uploaded_by  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tags         text[] NOT NULL DEFAULT '{}',
  description  text,
  text_content text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX resources_uploaded_by_idx ON resources (uploaded_by);
CREATE INDEX resources_tags_idx ON resources USING gin (tags);
CREATE INDEX resources_created_at_idx ON resources (created_at DESC);

CREATE TRIGGER resources_set_updated_at
  BEFORE UPDATE ON resources
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- notifications : broadcast announcements.
-- ---------------------------------------------------------------------------
CREATE TABLE notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title           text NOT NULL,
  message         text NOT NULL,
  created_by      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by_role text NOT NULL,
  -- 'all_students' (admin broadcast) | 'mentor_students' (mentor's assignees)
  target_audience text NOT NULL DEFAULT 'all_students',
  -- Set when target_audience = 'mentor_students'; scopes delivery.
  mentor_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notifications_created_at_idx ON notifications (created_at DESC);
CREATE INDEX notifications_mentor_id_idx ON notifications (mentor_id);

-- ---------------------------------------------------------------------------
-- notification_reads : per-user read receipts.
-- ---------------------------------------------------------------------------
CREATE TABLE notification_reads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at         timestamptz NOT NULL DEFAULT now(),

  UNIQUE (notification_id, user_id)
);

CREATE INDEX notification_reads_user_id_idx ON notification_reads (user_id);

-- ---------------------------------------------------------------------------
-- session_tracker : coursemaster's ordered course-session checklist.
-- Note: "order" is a reserved word; the frontend quotes it via PostgREST, and
-- the query builder quotes every identifier, so the name is kept as-is.
-- ---------------------------------------------------------------------------
CREATE TABLE session_tracker (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coursemaster_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           text NOT NULL,
  completed       boolean NOT NULL DEFAULT false,
  "order"         integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX session_tracker_coursemaster_id_idx ON session_tracker (coursemaster_id, "order");

CREATE TRIGGER session_tracker_set_updated_at
  BEFORE UPDATE ON session_tracker
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
