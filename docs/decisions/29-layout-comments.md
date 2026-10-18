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
| table | `layout_comments`: `id` (ULID), `layout_id`, `user_id`, `body` (NULL = erased), `via`, `submitted_at`, `status` (`pending` / `approved` / `rejected` / `superseded` / `replaced` / `deleted` / `removed`), `decided_by`, `decided_at`, `reason` |
| validation | `body` a string; `\r\n` and `\r` become `\n`, trimmed, 1..2000 Unicode code points, else `400 invalid_comment`. Nothing else is refused. One validator in `core/comments.ts` |
| write | `PUT /v1/layouts/:ref/comment {body}`: `202` queued; an admin's own comment is `201` approved. A new pending comment supersedes the same user's older pending one (silently). The old approved text stays live until the new one is approved |
| delete | `DELETE /v1/layouts/:ref/comment`: immediate, `204`. Erases the text of every comment the caller has on that layout; `404` if they had no approved or pending one |
| read | `GET /v1/layouts/:ref/comments`: public, `{comments}`, one approved comment per user, newest approval first, `edited` flag, deleted layouts hidden. `GET /v1/layouts/:ref/comment`: the caller's own `{live, pending, decision}`, never publicly cached |
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
  clears the body of every row, rejected and superseded ones included, so the
  text is in no table, no later dump and no event. The row stays (status,
  times) so moderation history still counts what happened.
- **Mods can remove, with a reason.** A live comment that should not stand is
  `removed` (text erased, reason kept for its author, who reads it through
  `GET .../comment`), the same erasure as a delete but a mod's act, recorded
  with the admin's `comment_removed` event.
- **No event carries text.** `/v1/changes` and the dump are public and
  unfiltered, so an event holding a comment could outlive its delete. Events
  say *that* something happened (ids only); the text appears only in the
  approved list. `comment_submitted` and `comment_rejected` are also covered by
  the feed's read-time redaction (LDB-MD13) so a row stored with more could not
  leak.
- **Non-approved is private to admins**, same rule as links and speeds
  (LDB-MD13/MD14): the dump holds only approved rows, so a rehost loses the
  pending and rejected queue by design.
- **Permissive validation.** akldb stores more and refuses less; whether a
  comment is welcome is for mods to judge.

## Consequences

`CHANGELOG-API.md` 1.22; invariants `LDB-CMT1`..`LDB-CMT10`; the nightly dump
gains `layout_comments` (approved rows only; a dump from before the table
restores with it empty). Additive only: nothing existing changes meaning.
