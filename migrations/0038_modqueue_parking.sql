-- [LDB-MD25] Mod-queue status edits stop retrying forever. A card edit that
-- Discord permanently refuses (400/403), or that kept failing transiently
-- up to the attempt cap, is PARKED: `parked_at` set, `parked_key` = the
-- source state (status:review_version:source_message_url) it was parked at,
-- `parked_error` = the Discord answer. A parked row is skipped by the
-- five-minute sweep until the source state changes (a new decision, reopen
-- or receipt binding), which un-parks it with a fresh attempt budget.
-- `next_attempt_at` is the transient backoff. Private bookkeeping, additive;
-- "how many are parked" is `SELECT COUNT(*) FROM modqueue_notifications
-- WHERE parked_at IS NOT NULL`.
ALTER TABLE modqueue_notifications ADD COLUMN next_attempt_at TEXT;
ALTER TABLE modqueue_notifications ADD COLUMN parked_at TEXT;
ALTER TABLE modqueue_notifications ADD COLUMN parked_key TEXT;
ALTER TABLE modqueue_notifications ADD COLUMN parked_error TEXT;
