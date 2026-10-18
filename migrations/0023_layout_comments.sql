-- Layout comments (docs/decisions/29-layout-comments.md, LDB-CMT1..): one
-- plain-text comment per user per layout, every write moderated like
-- `link_submissions` (migrations/0014) and `wpm_submissions` (0022), and
-- non-approved text private. Additive: one new table and its indexes,
-- nothing else touched.
--
-- `id` is a ULID. `body` is the comment text; NULL means ERASED -- a delete
-- (by the author) or a removal (by a mod) clears it for good, so the text
-- is gone from the database and from every later dump. `status`:
--   'pending'    waiting for an admin; the author's newest submission
--   'approved'   live and public; at most one per (layout, user) holds a body
--   'rejected'   an admin said no; the body is KEPT so the author can read
--                it back with the reason
--   'superseded' the author sent a newer pending one first (silent)
--   'replaced'   approved once, then a newer approval took its place; body
--                set NULL, the row stays so a later read can say "edited"
--   'deleted'    the author deleted their comment (approved or pending);
--                body NULL
--   'removed'    a mod took an approved comment down; body NULL, `reason`
--                kept for the author
-- A superseded or rejected row loses its body only when its author deletes.
--
-- `user_id` is the author (a Discord snowflake; it need not have an
-- `authors` row yet) and is always the actor who sent it -- there is no
-- on-behalf entry. `via` is the actor's lane, `discord` or `client:<id>`,
-- the same value `likes.via` carries. `decided_*` and `reason` record the
-- last decision made on the row (an approve, reject, supersede, replace,
-- delete or removal).
CREATE TABLE layout_comments (
  id            TEXT PRIMARY KEY,
  layout_id     TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  body          TEXT NULL,
  via           TEXT NOT NULL,
  submitted_at  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  decided_by    TEXT NULL,
  decided_at    TEXT NULL,
  reason        TEXT NULL,
  -- Mod-queue Discord notify claim (core/modqueue.ts, same pattern as
  -- migrations/0019 and 0022): NULL until the pending submission has been
  -- announced. A new table has no backlog to backfill.
  notified_at   TEXT NULL
);
-- The pending-queue listing and the notifier's candidate scan.
CREATE INDEX layout_comments_status ON layout_comments(status, submitted_at);
-- Everything one user has on one layout (supersede, replace, delete, the
-- author's own read).
CREATE INDEX layout_comments_user ON layout_comments(layout_id, user_id, status);
-- The public per-layout listing: approved rows, newest first.
CREATE INDEX layout_comments_approved ON layout_comments(layout_id, status, decided_at DESC);
