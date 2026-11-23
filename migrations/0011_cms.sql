-- 0011_cms.sql
-- Content management for the public website (edutou.in), edited from
-- admin.edutou.in.
--
--   cms_categories  the Programmes menu items ("learning formats"): Online
--                   Programmes, Workshops, Bootcamps, ...
--   cms_programmes  every course, webinar, workshop, bootcamp or internship.
--                   Indexed columns for lookup and ordering; everything shown on
--                   the card and the full programme page lives in `data`,
--                   validated by src/cms/schema.ts.
--   cms_settings    small site-wide documents (domain filters, enrol form text).
--   enrolments      sign-ups from edutou.in/enroll, one per person per
--                   programme, with payment fields ready for a gateway.

CREATE TABLE cms_categories (
  id          text PRIMARY KEY CHECK (id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title       text NOT NULL,
  description text NOT NULL DEFAULT '',
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cms_programmes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'hidden')),
  sort_order   integer NOT NULL DEFAULT 0,
  data         jsonb NOT NULL,
  published_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX cms_programmes_status_order_idx ON cms_programmes (status, sort_order);

CREATE TABLE cms_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE enrolments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Which programme. `programme_key` is the programme slug, or 'general' for an
  -- enquiry without one; it survives the programme being deleted and is what
  -- duplicates are checked against.
  programme_id      uuid REFERENCES cms_programmes(id) ON DELETE SET NULL,
  programme_key     text NOT NULL,
  programme_title   text NOT NULL,
  name              text NOT NULL,
  email             text NOT NULL,
  whatsapp          text NOT NULL,
  profession        text NOT NULL,
  city              text NOT NULL,
  utm_source        text,
  utm_medium        text,
  utm_campaign      text,
  status            text NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new', 'contacted', 'enrolled', 'not_interested')),
  notes             text NOT NULL DEFAULT '',
  seen_at           timestamptz,
  -- Payment: recorded now, collected later once a gateway is chosen.
  amount            numeric(12, 2),
  currency          text,
  payment_status    text NOT NULL DEFAULT 'not_required'
                    CHECK (payment_status IN ('not_required', 'pending', 'paid', 'failed', 'refunded')),
  payment_provider  text,
  payment_reference text,
  paid_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX enrolments_created_at_idx ON enrolments (created_at DESC);
CREATE INDEX enrolments_status_idx ON enrolments (status);
CREATE UNIQUE INDEX enrolments_programme_email_key ON enrolments (programme_key, lower(email));
CREATE UNIQUE INDEX enrolments_programme_whatsapp_key ON enrolments (programme_key, whatsapp);
