-- 0009_learn_page.sql
-- Content and sign-ups for the learn.edutou.in registration landing page.
--
-- learn_page holds a single row ('main') whose `content` is the whole page as
-- JSON, edited from the portal's admin "Learn Page" screen. The shape is
-- validated in src/learn/content.ts, not here, so marketing can add fields
-- without a migration. When the row is absent the API serves built-in
-- defaults.
--
-- learn_registrations is the lead list collected by that page's form.

CREATE TABLE learn_page (
  id         text PRIMARY KEY DEFAULT 'main' CHECK (id = 'main'),
  content    jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE learn_registrations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  email        text NOT NULL,
  whatsapp     text NOT NULL,
  profession   text NOT NULL,
  city         text NOT NULL,
  utm_source   text,
  utm_medium   text,
  utm_campaign text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX learn_registrations_created_at_idx ON learn_registrations (created_at DESC);
