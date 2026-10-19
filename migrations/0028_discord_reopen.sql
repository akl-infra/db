-- [LDB-MD21] Additive private reopen continuations and version fences.
ALTER TABLE modqueue_notifications ADD COLUMN shown_review_version INTEGER NOT NULL DEFAULT 0;
UPDATE modqueue_notifications SET shown_review_version = -1 WHERE kind IN ('comment', 'wpm');
ALTER TABLE discord_pending_actions ADD COLUMN expected_review_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE discord_deny_modals ADD COLUMN expected_review_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE discord_reopen_actions (
  interaction_id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  token TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('link', 'wpm', 'comment')),
  action TEXT NOT NULL CHECK (action IN ('reopen')),
  submission_id TEXT NOT NULL,
  reason TEXT,
  expected_review_version INTEGER NOT NULL DEFAULT 0,
  expected_status TEXT NOT NULL CHECK (expected_status IN ('approved', 'rejected')),
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'working', 'complete', 'expired')),
  lease_until TEXT,
  lease_token TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  result TEXT
);
CREATE INDEX discord_reopen_actions_due ON discord_reopen_actions(state, expires_at, lease_until, created_at);

CREATE TABLE discord_reopen_confirmations (
  confirmation_id TEXT PRIMARY KEY,
  initial_interaction_id TEXT NOT NULL UNIQUE,
  actor_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('comment', 'wpm')),
  submission_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  expected_status TEXT NOT NULL CHECK (expected_status = 'approved'),
  expected_review_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_interaction_id TEXT
);
CREATE INDEX discord_reopen_confirmations_expiry ON discord_reopen_confirmations(expires_at);
