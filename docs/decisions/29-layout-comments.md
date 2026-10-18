# 29 — Layout comments: one moderated comment per user per layout

*2026-10-18 · scope: akldb's HTTP API, `migrations/0023_layout_comments.sql`,
the moderation queue and its Discord notifier, the dump, and the admin
console's Inbox and the layout page. Clients (the site, the spark bot) read
this API; none is privileged.*

## Decision

A signed-in user can leave one plain-text comment on a layout. Every write is
reviewed by an admin first, and only approved text is public. It follows the
moderation queue pattern of a layout's `link` (`core/links.ts`) and of WPM
records (decision 28).

| piece | rule |
|---|---|
| table | `layout_comments`: `id` (ULID), `layout_id`, `user_id`, `body` (NULL = erased by the author's delete or replaced by a newer approval), `via`, `submitted_at`, `status` (`pending` / `approved` / `rejected` / `superseded` / `replaced` / `deleted` / `removed`), `decided_by`, `decided_at`, `reason` |
| validation | `body` a string; `\r\n` and `\r` become `\n`, trimmed, 1..2000 Unicode code points, else `400 invalid_comment`. Nothing else is refused. One validator in `core/comments.ts` |
| write | `PUT /v1/layouts/:ref/comment {body}`: `202` queued; an admin's own comment is `201` approved. A new pending comment supersedes the same user's older pending one (silently). The old approved text stays live until the new one is approved |
| delete | `DELETE /v1/layouts/:ref/comment`: immediate, `204`. Erases the text of every comment the caller has on that layout (rejected and superseded ones included, so a lone rejected text can still be erased); `404` only if none of their rows there has a text left |
| read | `GET /v1/layouts/:ref/comments`: public, `{comments}`, one approved comment per user, the layout owner's own comment pinned first, then most liked first then newest approval (`?sort=newest` for newest approval first; any other value is `400`), `likes` count, `liked` only for an authenticated caller (that answer is `private, no-store`), `edited` flag, deleted layouts hidden. `GET /v1/layouts/:ref/comment`: the caller's own `{live, pending, decision}`, never publicly cached |
| likes | `PUT` / `DELETE /v1/layouts/:ref/comments/:author_id/like`: `204`, idempotent. A like targets the author's comment *slot* `(layout, author)`, one per (slot, liker); `400 own_comment` for the author, `404` when the slot has no approved comment. Cleared by the author's delete and by a mod's removal; a pending or rejected edit leaves them. Table `comment_likes` |
| mine | `GET /v1/me/comments`: the caller's own slots across all layouts, one row per layout with a live, pending or kept (rejected/removed) text, by the same rules as `GET .../comment` plus the live comment's `likes`; most recent activity first; tombstoned layouts hidden; private, `no-store`; capped at the 500 most recent (no `/v1/me` list has a cursor to follow) |
| queue | `GET /v1/admin/comment-queue?status=` (default `pending`, each row carries `live_body`), `POST .../:id/approve`, `POST .../:id/reject {reason?}`, and `POST /v1/admin/comments/:id/remove {reason?}` for a live comment; every admin route is `if (!actor.admin) throw notAdmin()` |
| events | `comment_submitted`, `comment_approved`, `comment_rejected`, `comment_removed`, `comment_deleted`, one per action, written through `core/events.ts`; none carries comment text or a reason |
| webhook | a freshly pending comment is announced to the mod channel once, best effort, from the `PUT` path only: no `notified_at`, no cron sweep, no retry, a failed post is logged and dropped. A new comment shows its first 120 characters, an edit only its length |

## Why

- **One per user per layout.** A comment here is a person's note on a layout,
  not a thread: a single row to show, review and diff, and an edit replaces
  rather than piles up. Approving the new text retires the old row (`replaced`,
  text erased), so there is never more than one live text per person.
- **Edits keep the approved text live until approved.** An author fixing a typo
  must not make their comment disappear for the length of the review, and a
  mod needs the live text beside the new one to judge what changed
  (`live_body` in the queue).
- **Delete erases the text for good.** A person's right to take their words
  back beats an audit trail of them: the delete takes effect at once and
  clears the body of every row, rejected, superseded and removed ones
  included, so the
  text is in no table, no later dump and no event. The row stays (status,
  times) so moderation history still counts what happened.
- **The layout owner's comment comes first.** A layout has one owner
  (`layouts.owner`, no co-authors), and a reader wants the maker's own words
  before the crowd's: the approved comment whose `user_id` is the layout's
  current owner is pinned first under either sort and carries `is_author`.
  The pin follows the owner, so a transfer moves it (a transfer appends an
  event, which already moves the listing's ETag). No owner comment, no pin.
- **Likes belong to the slot, not the row.** A comment is edited by replacing
  its approved row; a like on the old row would vanish with it, so a like names
  `(layout, author)` and survives an approved edit. Deleting or removing the
  comment ends the slot, so its likes go with it (a like on nothing would be
  misleading, and a re-written comment is a new comment). A pending or
  rejected edit changes nothing live, so it changes no likes. An author cannot
  like their own comment, so the count is other people's. Like and unlike are
  idempotent (`204` either way) and write an event, `comment_liked` /
  `comment_unliked`, only when something actually changed. Likes are public
  like layout likes, so they are dumped whole.
- **Mods can remove, with a reason, and removal does not erase.** A live
  comment that should not stand is `removed`: it leaves the public list and
  its slot's likes go, but its text is KEPT, private to its author and mods
  exactly like a rejected one. The author reads the reason and the text back
  through `GET .../comment` (`decision: {status, reason, decided_at, body}`),
  so they can edit and resend rather than retype. It is a mod's act, recorded
  with the admin's `comment_removed` event; the text is in no event, no
  public read and no dump. Only the author's own delete erases it.
- **No event carries text.** `/v1/changes` and the dump are public and
  unfiltered, so an event holding a comment could outlive its delete. Events
  say *that* something happened (ids only); the text appears only in the
  approved list. `comment_submitted` and `comment_rejected` are also covered by
  the feed's read-time redaction (LDB-MD13) so a row stored with more could not
  leak.
- **Non-approved is private to admins**, same rule as links and speeds
  (LDB-MD13/MD14): the dump holds only approved rows, so a rehost loses the
  pending and rejected queue by design.
- **Comment text is plain text.** Line breaks are kept (CRLF and CR become
  `\n`), nothing is parsed: no markup, no markdown, no links. A client must
  render it literally, as text and never as HTML; a client with its own markup
  (the spark bot with Discord markdown) escapes it on its side.
- **Permissive validation.** akldb stores more and refuses less; whether a
  comment is welcome is for mods to judge.

## Consequences

`CHANGELOG-API.md` 1.22; invariants `LDB-CMT1`..`LDB-CMT13`; the nightly dump
gains `layout_comments` (approved rows only) and `comment_likes` (all rows); a
dump from before either table restores with it empty. Additive only: nothing existing changes meaning.
