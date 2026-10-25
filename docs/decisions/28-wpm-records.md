# 28 — WPM records: a user's best typing speed per layout

*2026-10-18 · scope: akldb's HTTP API, `migrations/0022_wpm_submissions.sql`,
the moderation queue and its Discord notifier, the dump, and the admin
console's Inbox. Clients (the site, the spark bot) read this API; none is
privileged.*

## Decision

A user submits their best typing speed on a layout with a proof link. It
goes through the same moderation queue pattern as a layout's `link`
(`core/links.ts`), and only approved records are public. Readers care about
one number per person and layout: their **top approved speed**.

| piece | rule |
|---|---|
| table | `wpm_submissions`: `id` (ULID), `layout_id`, `user_id` (whose speed it is), `wpm`, `proof`, `submitted_by` (the actor; differs from `user_id` only for an admin's on-behalf entry), `via` (`discord` / `client:<id>`), `submitted_at`, `status` (`pending` / `approved` / `rejected` / `superseded`), `decided_by`, `decided_at`, `reason`, `notified_at` |
| validation | `wpm` an integer 1..1000; `proof` any absolute `http`/`https` URL with a host, at most 512 characters after trim. One validator in `core/wpm.ts`, shared by every route |
| submit | `POST /v1/wpm {layout, wpm, proof}`: `202` queued for everyone: an admin's own speed is queued too and approved in the Inbox (no short circuit for mods, API 1.23). A new pending submission from the same user for the same layout supersedes their older pending one (silently). No withdraw |
| on behalf | `POST /v1/admin/wpm {user_id, layout, wpm, proof}`: `201`, approved at once, `submitted_by` the admin. `user_id` is any 17-20 digit Discord id; it need not have an `authors` row |

The mod-channel webhook records its Discord message id and original content in
the private `modqueue_notifications` table. Approval and rejection edit that
message with a status prefix; the normal notification sweep retries failed
edits and reconciles later queue statuses. This bookkeeping is intentionally
not included in the public dump.
| read | `GET /v1/wpm?layout=&user=`: public, `{records}`, one row per (layout, user) = their approved row with the highest `wpm` (a tie goes to the earliest `decided_at`), sorted `wpm` desc then `approved_at` asc, no pagination. Deleted layouts' records are hidden |
| queue | `GET /v1/admin/wpm-queue?status=` (default `pending`), `POST .../:id/approve`, `POST .../:id/reject {reason?}`: the link queue's shapes and checks; every admin route is `if (!actor.admin) throw notAdmin()` |
| names | `discord_users` (migrations/0036; `id`, `username`, `global_name`, `updated_at`; read and written only by `store/d1/discord-users.ts`) gives every typist a name. `user_name` on every WPM read is `authors.name` (when non-blank and not the id), else `global_name`, else `username`, else `null`. Written by `POST /v1/wpm` (the actor's own name, looked up with the bot after the 202 via the background hook, only when none was stored within 7 days), by `POST /v1/admin/wpm` (the akldb bot's `GET /users/{id}`, best effort within 3 s, never blocking or failing the save) and by the idempotent backfill `POST /v1/admin/discord-users/refresh {limit?}` -> `{resolved, failed, remaining}`. `GET /v1/wpm`'s ETag folds in `discord_users_head.version` (trigger-kept, moves only on a real name change). API 1.31 |
| events | `wpm_submitted`, `wpm_approved`, `wpm_rejected`, one per action, written through `core/events.ts` |
| webhook | `notifyPending` sweeps both queue tables with the same at-most-once claim; the message names the layout, user and speed and links the admin Inbox |

## Why

### Discord proof authorship

New submissions using Discord proof must link to a server message written by
the typist. The database API reads the message using the dedicated akldb bot
before inserting or superseding any WPM row or writing WPM events/history.
On `/v1/wpm`, its author must match the authenticated actor. On the admin
on-behalf route, it must match `user_id`, not the moderator submitting it.
Bot and webhook messages are refused. This checks who posted the message;
moderators still judge whether its contents prove the claimed typing result.

The only refusal is a Discord message link the akldb bot can read whose author is not the
typist (`400 invalid_proof`; a bot or webhook message counts as not the typist's). Everything
else is accepted unverified for moderators to judge: non-Discord links, Discord CDN, invite and
channel links, and message links the bot cannot read (missing bot credentials or channel access,
a deleted message, Discord failures, or the 800 ms request/body deadline). Existing submissions
are not revalidated or removed. This policy is API 1.26 (LDB-WPM15).

### Discord proof previews

The background notifier enriches new WPM moderation messages after claiming
the submission. A Discord message link is resolved using the dedicated akldb
bot; supported image attachments are downloaded and uploaded onto the queue
message as a Media Gallery. Legacy submissions with direct Discord attachment
URLs can still be previewed while their signatures remain valid; new submissions
require message links as above. The original proof URL stays in the database
and in the message. No client wire format changes are needed.

This is a best-effort snapshot at notification time, not a guaranteed archive
at the instant of submission. Only HTTPS Discord API/CDN destinations are
used, redirects are refused, and the bot token is sent only to the API.
Downloads allow PNG/JPEG/GIF/WebP with matching file signatures, at most three
images, 4 MiB each and 8 MiB total. Message metadata is capped at 256 KiB;
one preview gets at most four seconds and all previews in one sweep share six
seconds. Missing access, empty attachments (including missing Message Content
Intent), expired URLs, unsupported files or size limits leave the original
link usable and identify unavailable/partial previews. A definitive 400/413
upload refusal (or 403 for missing upload permission) falls back to a link-only card; ambiguous/rate-limited posts
retain the existing notification retry behavior.

The images live only as attachments on the Discord moderation message. There
is no new R2/D1 image archive, retention timer or public image API. Approving,
denying, superseding or reopening preserves that same copy and never downloads
the original again. Deleting the queue message loses this service's copy;
Discord controls its own underlying storage. Existing queue messages are not
backfilled. The stored proof URL is retained under the normal WPM history
policy, which does not guarantee that its external content remains available.

YouTube watch, share, shorts, live and embed URLs keep the Components V2 card
with the video's thumbnail and an explicit “Watch on YouTube” link. Recognized
timestamps are kept on the watch link; the original proof URL is kept too.
The Worker makes no YouTube requests and archives neither thumbnails nor video.
Discord displays YouTube's externally hosted thumbnail, which can change or
become unavailable. If Discord refuses the preview, the notifier retries without
the thumbnail and keeps the Watch link. Review status edits preserve the preview and normal controls.
This is a thumbnail preview, not an inline video player.

### Record policy

- **Top speed only.** A leaderboard needs each person's best, not their
  history; deriving "best" on read (`NOT EXISTS` a better approved row) means
  approving a slower run later can never lower a record, and no second table
  has to be kept in step.
- **The proof URL is kept forever.** Rows are never deleted and a rejected or
  superseded row stays queryable: a mod can always see what a record rested
  on, and a dispute can be re-read after the fact. `status` is the only thing
  that moves.
- **Permissive validation.** akldb stores more and refuses less; whether 900
  wpm is believable is for mods and clients to judge. The server only
  refuses invalid speed/link values and Discord proofs whose authorship cannot
  be verified as above. The proof is not
  restricted to Discord: a video, a monkeytype result and a screenshot host
  are all fine.
- **On-behalf only through an admin.** A user can only ever submit their own
  speed (the actor *is* the `user_id`). Entering someone else's is an
  explicit admin act, recorded with `submitted_by` and the admin's `wpm_approved`
  event, so a record is never attributed to a person by anyone but a mod.
- **Non-approved is private to admins** (saltorbit 2026-10-18, same rule as
  link submissions, LDB-MD13/MD14). `/v1/changes` and the dump are public and
  unfiltered, so privacy is enforced in both: `wpm_submitted` and
  `wpm_rejected` carry only the submission id (redacted on read, rows stored
  with more included), the speed and proof first appear publicly on
  `wpm_approved`, and the dump holds only approved `wpm_submissions` rows.
  A rehost therefore loses the non-approved queue by design.

## Consequences

`CHANGELOG-API.md` 1.21; invariants `LDB-WPM1`..`LDB-WPM10`; the nightly dump
gains `wpm_submissions` (approved rows only, since the dump is public: pending, rejected and
superseded submissions are never dumped; a dump from before the table
restores with it empty). Additive only: nothing existing changes meaning.


## Reopening (API 1.25, LDB-MD20)

An approved or rejected submission may return to pending through the admin
queue's `reopen` endpoint, provided no newer submission or another pending
submission exists for that layout/user and the layout is live. `review_version`
identifies each review cycle; reopening increments it, and a later decision must
supply that expected version. Reopening an approved best removes it from public
records immediately, allowing the next-best approved row to take its place.
The event log is append-only: `wpm_reopened` contains only the submission ID.
Private decision history retains moderator, time and reason without entering
public dumps. See [the API contract](../adoption.md#reopening-a-comment-or-wpm-decision-api-125)
for the request shapes and delivery behavior.

## Discord presentation

WPM queue cards match comment cards: a normal-sized bold context line with the
linked layout and submitter, then the speed and a View proof link. A divider
separates the submission from its controls. Pending cards have no status label;
approved and denied cards share an emoji decision footer with moderator and,
for denials, the reason. Reopening restores Approve/Deny without a private
confirmation or success message. Errors still appear privately.

Escaped link targets and future decision text count toward the message budget.
An unusually long escaped proof URL is attached intact rather than truncated.
Older cards remain editable in their existing format.
