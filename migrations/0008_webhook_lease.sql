-- LDB-H6: claim-before-send lease per hook. `drain()` runs from the
-- after-write nudge on EVERY write AND from the cron -- overlap is routine,
-- not an edge case. Before this migration, `commitOutcome()`'s
-- compare-and-set was keyed on `cursor`, which let two overlapping drains
-- both read the same starting cursor and both POST the same range
-- concurrently (interleaved delivery, a lost `failures` increment when
-- both failed with no progress, and a successful long batch getting voided
-- by a concurrent short failing one that committed first). A lease makes
-- "claim the hook, deliver, commit-and-release" one hook's business at a
-- time: `commitOutcome()` now CASes on `lease_id`, not `cursor`.
ALTER TABLE webhooks ADD COLUMN lease_id TEXT;    -- set by the drain currently claiming/delivering this hook; NULL when free
ALTER TABLE webhooks ADD COLUMN lease_until TEXT; -- lease expiry (ISO 8601); a lease past this instant is free to reclaim even if never released (the drain that held it died)
