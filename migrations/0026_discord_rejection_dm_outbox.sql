-- Private, durable delivery queue for submitter DMs after a moderation
-- rejection. This table is intentionally not part of public dumps/restores.
-- Rows identify the winning rejection event but contain no submission text,
-- reason, proof, or other content; the sender re-reads current eligible data.
CREATE TABLE discord_rejection_dm_outbox (
  delivery_key TEXT PRIMARY KEY,
  event_seq INTEGER NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('comment', 'link', 'wpm')),
  submission_id TEXT NOT NULL,
  layout_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  nonce TEXT NOT NULL UNIQUE CHECK (length(nonce) <= 25),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'sent', 'blocked', 'uncertain', 'failed', 'expired')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  lease_token TEXT,
  lease_until TEXT,
  ambiguous_message_attempt_at TEXT,
  dm_channel_id TEXT,
  discord_message_id TEXT,
  last_error_class TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX discord_rejection_dm_due ON discord_rejection_dm_outbox(status, next_attempt_at);
CREATE INDEX discord_rejection_dm_lease ON discord_rejection_dm_outbox(status, lease_until);
