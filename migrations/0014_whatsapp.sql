-- 0014_whatsapp.sql
-- WhatsApp messages to people who enrol, sent from the owner's WhatsApp
-- number through a linked-device (WhatsApp Web) session.
--
--   whatsapp_outbox  one message per enrolment, sent slowly and irregularly
--                    by the sender in the API process (src/whatsapp/).
--   whatsapp_auth    the linked-device session (keys and credentials), kept
--                    in the database so a redeploy reconnects without a new
--                    QR scan. Treat as a secret: it can send as that number.

CREATE TABLE whatsapp_outbox (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrolment_id uuid REFERENCES enrolments(id) ON DELETE CASCADE,
  to_number    text NOT NULL,
  body         text NOT NULL,
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped', 'not_on_whatsapp')),
  attempts     integer NOT NULL DEFAULT 0,
  last_error   text,
  sent_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Never message the same enrolment twice (backfill can be run repeatedly).
CREATE UNIQUE INDEX whatsapp_outbox_enrolment_key ON whatsapp_outbox (enrolment_id) WHERE enrolment_id IS NOT NULL;
CREATE INDEX whatsapp_outbox_pending_idx ON whatsapp_outbox (created_at) WHERE status = 'pending';
CREATE INDEX whatsapp_outbox_sent_at_idx ON whatsapp_outbox (sent_at) WHERE status = 'sent';

CREATE TABLE whatsapp_auth (
  id         text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
