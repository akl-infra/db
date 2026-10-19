-- Private Discord message bookkeeping for mod-queue notifications. This
-- stores only Discord message ids and status bookkeeping, never message
-- content; it is deliberately excluded from the public dump and API.
CREATE TABLE modqueue_notifications (
  kind             TEXT NOT NULL CHECK (kind IN ('link', 'wpm', 'comment')),
  submission_id    TEXT NOT NULL,
  message_id       TEXT NOT NULL,
  shown_status     TEXT NOT NULL,
  failed_attempts  INTEGER NOT NULL DEFAULT 0,
  message_format   TEXT NOT NULL DEFAULT 'text' CHECK (message_format IN ('text', 'components_v2')),
  transport        TEXT NOT NULL DEFAULT 'legacy_webhook' CHECK (transport IN ('legacy_webhook', 'bot')),
  channel_id       TEXT,
  PRIMARY KEY (kind, submission_id)
);
CREATE INDEX modqueue_notifications_status ON modqueue_notifications(kind, shown_status);
