-- Private Discord interaction replay guard, modal binding and post-ACK
-- continuation state. Tokens are short-lived credentials; never dump them.
ALTER TABLE modqueue_notifications ADD COLUMN reconcile_lease_token TEXT;
ALTER TABLE modqueue_notifications ADD COLUMN reconcile_lease_until TEXT;

CREATE TABLE discord_pending_actions (
  interaction_id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  token TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('link', 'wpm', 'comment')),
  action TEXT NOT NULL CHECK (action IN ('approve', 'deny')),
  submission_id TEXT NOT NULL,
  reason TEXT,
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
CREATE INDEX discord_pending_actions_due ON discord_pending_actions(state, expires_at, lease_until, created_at);

CREATE TABLE discord_deny_modals (
  modal_id TEXT PRIMARY KEY,
  initial_interaction_id TEXT NOT NULL UNIQUE,
  actor_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('link', 'wpm', 'comment')),
  submission_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_interaction_id TEXT
);
CREATE INDEX discord_deny_modals_expiry ON discord_deny_modals(expires_at);
