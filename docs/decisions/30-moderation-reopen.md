# Reopening moderation review

An administrator can return an approved or rejected comment or WPM submission
to pending review, from either the akldb inbox or its tracked Discord message.
Reopening is a new moderation action. It never deletes or rewinds an event.

## Meaning of reopening

- A rejected submission becomes pending and remains private.
- An approved comment becomes pending and leaves the public comment list and
  count. Its text is retained for review. Reopening does not recover a previous
  comment version erased when an edit was approved.
- An approved WPM submission becomes pending and leaves the public records.
  The existing best-approved-record query chooses the next eligible result.
- Comment likes belong to the author's slot. Reopening does not destroy them;
  they become visible again if that slot receives an approved comment.
- Links, erased comments, replaced or superseded submissions, and moderator
  removals are outside this operation. A new submission remains the way to
  submit revised content.

Both interfaces ask for confirmation before reopening an approval because it
withdraws published content. Reopening a rejection needs no extra confirmation.
After success, the site returns to the pending queue and Discord updates the
same message with Approve and Deny controls.

## Stale decisions and concurrency

Each comment and WPM submission has a `review_version`, initially zero.
Reopening increments it. Approve and reject name the pending review version;
reopen names both the decided status and its review version. The conditional
write is the authority, not the client's displayed status or a timestamp.

This distinguishes an old approval from a later approval of the same submission
after reopening. It also makes old buttons, deny modals, and queued Discord
actions unusable in a new review cycle. Missing versions on legacy approval or
rejection requests mean version zero, preserving their behavior for original
reviews without letting them decide reopened ones.

A reopen is refused when another pending or newer submission exists for the
same layout and user, when the layout is deleted, or when the text has been
erased. These conditions are checked inside the database transaction so an old
review never supersedes newer user work.

## History and public reads

The current row transition, its event, and private moderation history commit
together. A failed transaction leaves all of them unchanged. History retains
the original decision's actor, time and reason, including an existing decision
made before this feature was installed. Subsequent decisions and reopening
actions are added in order.

Public `comment_reopened` and `wpm_reopened` events contain identifiers needed to
invalidate current records, never comment text or private reasons. Clients
maintaining their own approved lists must refresh affected records on those
events. The API's ordinary public read queries and event-based ETags reflect the
new state. Cached pages already open in a client continue to follow that
client's existing refresh policy.

Private review history is available only through administrator endpoints and
does not enter the public dump. Restore clears private workflow state rather
than replaying pending work. The public event log remains intact.

## Discord and submitter notifications

Reopen confirmations bind the moderator, submission, version, status, message,
channel, guild, and expiry. Deferred actions recheck the current role and review
version when executing. Retrying a durable action must establish that its own
decision committed, not merely find a similar decision by the same moderator.

Message reconciliation tracks both status and review version. A sequence such
as approved → pending → approved still requires an update to replace stale
controls. Interactive controls are restricted to bot-owned messages and the
existing action feature flag; legacy messages retain their site link.

Reopening expires unsent rejection notification jobs. A subsequent rejection
in a new cycle has a distinct delivery identity, so it can notify the submitter
without reviving an old job. Delivery checks that its cycle is still eligible.
A Discord request already in flight cannot be recalled, and a delivered DM is
not erased or followed by an automatic correction message.
