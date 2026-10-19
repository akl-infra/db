-- A review version identifies a pending review cycle, including old clients'
-- original cycle zero. History is private and never part of a public dump.
ALTER TABLE layout_comments ADD COLUMN review_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE wpm_submissions ADD COLUMN review_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE discord_rejection_dm_outbox ADD COLUMN review_version INTEGER NOT NULL DEFAULT 0;
CREATE TABLE moderation_review_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('comment', 'wpm')),
  submission_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('approved', 'rejected', 'reopened')),
  actor TEXT NOT NULL,
  at TEXT NOT NULL,
  reason TEXT,
  review_version INTEGER NOT NULL,
  UNIQUE (kind, submission_id, review_version, action)
);
CREATE INDEX moderation_review_history_submission ON moderation_review_history(kind, submission_id, id);
