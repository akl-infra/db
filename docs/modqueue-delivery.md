# Discord moderation delivery

Invariant LDB-MD24: concurrent delivery is fenced, cooldown survives callers,
dirty work remains eligible, and unresponsive response cancellation cannot
hold a delivery lease beyond its bounded request/body handling.

Migration 0033 must be applied before deploying the delivery gate code. It adds
one D1 row shared by link/WPM announcement POSTs and all tracked notification
GET/PATCH reconciliation, including comment status edits. A 30-second fenced
lease serializes these operations across requests, cron invocations, and isolate
replacement. Discord JSON bodies have a 256 KiB limit and five-second read
deadline; each fetch also has a five-second abort signal.

A 429 persists the maximum valid Retry-After (seconds or HTTP date), JSON
retry_after (seconds), and reset-after delay, with a one-second fallback. A
successful exhausted bucket also persists its reset delay. Deferred edits keep
their source/shown mismatch and release their reconciliation lease; cron retries
without another user decision. Deferred link/WPM announcements release their
existing notified_at claim and are eligible for a later sweep. There are no
immediate network retries or sleeps, and stale gate owners cannot release or
change a newer owner's cooldown. Transient delivery failures retain the existing
failed-attempt ordering; 404 removes tracking for the deleted Discord message.

Comment creation remains the existing request-only best-effort operation, outside
this gate. Making its announcements defer safely requires a durable announcement
outbox; otherwise a busy gate would lose a comment's only delivery attempt.
Other Discord integrations are also outside this gate. Link/WPM POSTs retain the
existing ambiguous-network-error claim release policy, so an accepted POST whose
response is lost can still be duplicated on a later sweep. PATCH retries are
idempotent and never advance shown state without a successful response.

The gate conservatively shares cooldown across configured transports/channels;
this can delay an independent destination until a later five-minute cron sweep.
It stores no webhook URL or token. No public API, signature validation, or D1
write retry policy changes.

## Parked cards (LDB-MD25)

A status edit that Discord permanently refuses (400/403) is parked after one attempt; transient failures back off (5 min doubling to 6 h) and park on the 8th. Parked rows carry `parked_at`, `parked_key` (the source state `status:review_version:source_message_url` they stopped at) and `parked_error` (Discord's answer). The sweep skips a row while the source still equals `parked_key`; any new decision, reopen or receipt binding un-parks it with a fresh budget. To count or list them: `SELECT kind, submission_id, parked_at, parked_error FROM modqueue_notifications WHERE parked_at IS NOT NULL`. The log line is `modqueue status edit parked for <kind> submission '<id>' ...`, once per park.
