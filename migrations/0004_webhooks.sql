-- X1: webhooks (12-implementation-phase5.md §2.1). No delivery-attempt
-- ledger: each subscription carries a cursor into the ONE event log, and
-- delivery is "advance the cursor by POSTing what lies past it" -- LDB-P3's
-- "feed is truth" made literal. `secret` is stored verbatim (an HMAC needs
-- the key itself, not a hash of it); it is never returned by any route,
-- never placed on an event, and never dumped (`Dump.webhooks: []`, LDB-H4).
CREATE TABLE webhooks (
  id            TEXT PRIMARY KEY,          -- ULID
  owner_user_id TEXT NOT NULL,
  url           TEXT NOT NULL,             -- https:// only, <= 2048 chars
  secret        TEXT NOT NULL,             -- the HMAC key, verbatim (16-256 chars); never read back out, never dumped
  kinds         TEXT,                      -- JSON array subset of KNOWN_KINDS, or NULL = every kind
  owner_filter  TEXT,                      -- a user id: only events whose `owner` equals it; NULL = all
  status        TEXT NOT NULL,             -- 'active' | 'failing' | 'disabled'
  cursor        INTEGER NOT NULL,          -- last seq delivered; starts at the head seq at registration
  failures      INTEGER NOT NULL DEFAULT 0,-- consecutive failed drains; reset to 0 by a success
  failing_since TEXT,                      -- first failure of the current run, NULL when healthy
  next_at       TEXT NOT NULL,             -- earliest time the cron/nudge may try again
  last_error    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX webhooks_due ON webhooks(status, next_at);
CREATE INDEX webhooks_owner ON webhooks(owner_user_id);
