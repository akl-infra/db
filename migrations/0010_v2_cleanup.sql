-- v2 cleanup (design/layout-db/review/PROPOSAL.md §2.1, LEDGER.md L4):
-- layoutdb is disposable (design/HARD-REQUIREMENTS.md, layoutdb-is-
-- disposable memo) -- a drop is fine, no backfill/migration path needed.
-- Removes the webhook subsystem (no consumer: neither the bot nor akl.gg
-- ever registered a hook; the bot's keep-warm moves to the long-poll
-- `GET /v1/changes?wait=`, LDB-CH1..CH5) and its lease columns (0004,
-- 0008). The SSE stream (`routes/stream.ts`, deleted) and the Fly drill
-- (`drill/`, deleted) never had their own tables -- nothing to drop for
-- either.
DROP TABLE webhooks;
