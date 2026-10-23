-- Shared across isolates and cron/request paths; contains no credentials.
CREATE TABLE modqueue_delivery_gate (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO modqueue_delivery_gate (id) VALUES (1);
