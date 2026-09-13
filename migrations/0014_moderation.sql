-- L5 moderation (design/akldb-site/01-plan.md §4): bans, an admin "overwrite
-- likes" adjustment, and a moderated `link` field (H22/H23,
-- design/layout-db/review/REQUIREMENTS.md). Additive with defaults --
-- layoutdb is disposable (mem:layoutdb-is-disposable), so this is a plain
-- `ADD COLUMN ... DEFAULT`/`CREATE TABLE`, no backfill.

-- §4.1: a banned user's non-safe request is refused (auth/roles.ts's
-- `roleOf`, the gate in `requireActorOnWrites`). `by`/`at`/`reason` are
-- moderation bookkeeping, not identity -- the banned user's own name is
-- joined from `authors` on read, never stored here.
CREATE TABLE bans (
  user_id TEXT PRIMARY KEY,
  by      TEXT NOT NULL,   -- the admin's own user id
  at      TEXT NOT NULL,
  reason  TEXT NULL
);

-- §4.4: a user-submitted `link`, queued for admin approval before it shows
-- on any public wire (`layouts.link` below is the ONLY approved value).
-- `id` is a ULID (ordered, same id shape every other minted id in this
-- service uses); `status` is one of 'pending' | 'approved' | 'rejected' |
-- 'superseded' (a new pending submission from the owner replaces an older
-- pending one with no event -- the submitter's own bookkeeping, §4.4).
CREATE TABLE link_submissions (
  id            TEXT PRIMARY KEY,
  layout_id     TEXT NOT NULL,
  url           TEXT NOT NULL,
  submitted_by  TEXT NOT NULL,
  submitted_at  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  decided_by    TEXT NULL,
  decided_at    TEXT NULL,
  reason        TEXT NULL
);
CREATE INDEX link_submissions_layout ON link_submissions(layout_id, status);
CREATE INDEX link_submissions_status ON link_submissions(status, submitted_at);

-- §4.4: the layout's own approved link (folded from the latest
-- `link_approved`/`link_cleared` event's `after.link`, `core/events.ts`'s
-- `appendLinkChange` -- the only writer, same LDB-P1 boundary `like_count`
-- already follows). NULL until something is approved.
ALTER TABLE layouts ADD COLUMN link TEXT NULL;

-- §4.2: `like_count = MAX(0, COUNT(likes) + like_adjust)` everywhere
-- `like_count` is computed (`core/events.ts`'s `commitWrite`/`appendLike`/
-- `appendLikeAdjust`, `foldLayout`) -- folded from the latest
-- `admin.likes_set` event's `after.like_adjust`. 0 means "no admin
-- override has ever run", which also means every EXISTING row keeps its
-- exact current `like_count` the instant this migration applies.
ALTER TABLE layouts ADD COLUMN like_adjust INTEGER NOT NULL DEFAULT 0;
