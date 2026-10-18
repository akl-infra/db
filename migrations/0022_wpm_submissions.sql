-- WPM records (docs/decisions/28-wpm-records.md, LDB-WPM1..): a user's
-- best typing speed on a layout, submitted with a proof link and queued
-- for admin approval exactly like `link_submissions` (migrations/0014).
-- Additive: one new table and its indexes, nothing else touched.
--
-- Rows are NEVER deleted -- a rejected, superseded or approved row keeps
-- its `proof` reviewable forever; `status` is the only thing that moves.
-- `id` is a ULID (same minted-id shape `link_submissions` uses); `status`
-- is one of 'pending' | 'approved' | 'rejected' | 'superseded' (a new
-- pending submission from the same user for the same layout replaces the
-- older pending one with no event, LDB-WPM2).
--
-- `user_id` is whose speed it is (a Discord snowflake; it need not have an
-- `authors` row yet); `submitted_by` is the ACTOR who sent it -- equal to
-- `user_id` except on an admin's on-behalf entry (`POST /v1/admin/wpm`).
-- `via` is the actor's lane, `discord` or `client:<id>`, the same value
-- `likes.via` carries.
CREATE TABLE wpm_submissions (
  id            TEXT PRIMARY KEY,
  layout_id     TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  wpm           INTEGER NOT NULL,
  proof         TEXT NOT NULL,
  submitted_by  TEXT NOT NULL,
  via           TEXT NOT NULL,
  submitted_at  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  decided_by    TEXT NULL,
  decided_at    TEXT NULL,
  reason        TEXT NULL,
  -- Mod-queue Discord notify claim (core/modqueue.ts, same pattern as
  -- migrations/0019's `link_submissions.notified_at`): NULL until the
  -- pending submission has been announced. A new table has no backlog to
  -- backfill, so there is no UPDATE here.
  notified_at   TEXT NULL
);
-- The pending-queue listing and the notifier's candidate scan.
CREATE INDEX wpm_submissions_status ON wpm_submissions(status, submitted_at);
-- The "best approved row for (layout, user)" lookup behind GET /v1/wpm.
CREATE INDEX wpm_submissions_best ON wpm_submissions(layout_id, user_id, status, wpm DESC, decided_at);
-- Everything one user ever submitted (and the supersede lookup).
CREATE INDEX wpm_submissions_user ON wpm_submissions(user_id, status);
