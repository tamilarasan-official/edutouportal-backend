-- 0012_email_outbox.sql
-- Outgoing email for enrolments: a confirmation to the person and a
-- notification to the team.
--
-- Emails are written here in the same request that saves the enrolment and
-- sent afterwards by a worker in the API process, so a slow or unavailable
-- mail server never fails an enrolment, and failures are retried.

CREATE TABLE email_outbox (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrolment_id  uuid REFERENCES enrolments(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('confirmation', 'team', 'test')),
  to_addresses  text[] NOT NULL,
  subject       text NOT NULL,
  html          text NOT NULL,
  text_body     text NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX email_outbox_due_idx ON email_outbox (next_attempt_at) WHERE status = 'pending';
CREATE INDEX email_outbox_enrolment_idx ON email_outbox (enrolment_id);
