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
| events | `wpm_submitted`, `wpm_approved`, `wpm_rejected`, one per action, written through `core/events.ts` |
| webhook | `notifyPending` sweeps both queue tables with the same at-most-once claim; the message names the layout, user and speed and links the admin Inbox |

## Why

- **Top speed only.** A leaderboard needs each person's best, not their
  history; deriving "best" on read (`NOT EXISTS` a better approved row) means
  approving a slower run later can never lower a record, and no second table
  has to be kept in step.
- **Proof is kept forever.** Rows are never deleted and a rejected or
  superseded row stays queryable: a mod can always see what a record rested
  on, and a dispute can be re-read after the fact. `status` is the only thing
  that moves.
- **Permissive validation.** akldb stores more and refuses less; whether 900
  wpm is believable is for mods and clients to judge. The server only
  refuses what is not a speed or not a link at all. The proof is not
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
