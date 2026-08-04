-- 0001_init.sql
-- Extensions, identity tables, and the profiles table.
--
-- Supabase provided auth.users via GoTrue. We replace it with a plain `users`
-- table owned by this application. `profiles` keeps the exact column set the
-- frontend reads today (see app/admin/students/page.tsx, app/settings/ProfileTab.tsx,
-- app/leaderboard/page.tsx) so no page code has to change.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- users : credentials + identity. Replaces auth.users.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              text NOT NULL,
  -- NULL for OAuth-only accounts that never set a password.
  password_hash      text,
  email_confirmed_at timestamptz,
  -- Mirrors Supabase's user_metadata; the signup flow writes full_name here.
  user_metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_sign_in_at    timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness: GoTrue treated a@b.com and A@B.com as one account.
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

-- ---------------------------------------------------------------------------
-- oauth_identities : Google sign-in, replacing GoTrue's identities table.
-- ---------------------------------------------------------------------------
CREATE TABLE oauth_identities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      text NOT NULL,
  provider_uid  text NOT NULL,
  provider_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_uid)
);

CREATE INDEX oauth_identities_user_id_idx ON oauth_identities (user_id);

-- ---------------------------------------------------------------------------
-- refresh_tokens : server-side session records so sessions can be revoked.
-- GoTrue did this internally; we need it to support logout-everywhere and to
-- invalidate sessions when an admin changes someone's role.
-- ---------------------------------------------------------------------------
CREATE TABLE refresh_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  user_agent text,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX refresh_tokens_user_id_idx ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_expires_at_idx ON refresh_tokens (expires_at);

-- ---------------------------------------------------------------------------
-- one_time_tokens : email confirmation + password reset.
-- Replaces GoTrue's token_hash / verifyOtp flow used by app/auth/confirm/route.ts.
-- ---------------------------------------------------------------------------
CREATE TABLE one_time_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'signup' | 'recovery' | 'email_change'
  token_type text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX one_time_tokens_user_id_idx ON one_time_tokens (user_id);

-- ---------------------------------------------------------------------------
-- profiles : application-level user record. 46 call sites read this table.
-- ---------------------------------------------------------------------------
CREATE TABLE profiles (
  id                 uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email              text,
  full_name          text,
  role               text NOT NULL DEFAULT 'student'
                       CHECK (role IN ('admin', 'mentor', 'student', 'coursemaster')),
  phone              text,
  bio                text,
  avatar_url         text,
  -- Denormalised running total. Written by the points RPCs and the quiz
  -- answer endpoint; read directly by /leaderboard and the admin student list.
  leaderboard_points integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX profiles_role_idx ON profiles (role);
CREATE INDEX profiles_leaderboard_points_idx ON profiles (leaderboard_points DESC);

-- ---------------------------------------------------------------------------
-- Auto-create a profile whenever a user is created.
--
-- The old system had both a DB trigger (referenced in app/login/actions.ts:82)
-- AND a manual insert in app/auth/callback/route.ts. Only the trigger survives;
-- the callback insert becomes a no-op because the row already exists.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION handle_new_user() RETURNS trigger AS $$
BEGIN
  -- `role` is deliberately NOT read from user_metadata. user_metadata is
  -- client-supplied (it carries full_name from the signup form), so honouring a
  -- role key there would let anyone register as an admin. Every account starts
  -- as a student; promotion happens only via PATCH /api/admin/role or the
  -- create-admin script.
  INSERT INTO profiles (id, email, full_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NULLIF(NEW.user_metadata->>'full_name', ''), split_part(NEW.email, '@', 1)),
    'student'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER on_user_created
  AFTER INSERT ON users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ---------------------------------------------------------------------------
-- Shared updated_at trigger, applied to every table that carries the column.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER profiles_set_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
