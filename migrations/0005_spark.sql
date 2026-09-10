-- 20-spark.md S3a: the `upstream` field (decision 5, LDB-I14). Plumbing
-- only -- nothing is backfilled here. The legacy rule needs the event
-- walk (`core/upstream.ts`'s `upstreamOf` fallback), and the record
-- migration (S4) is what actually populates these columns for existing
-- rows. All three NULL together (no known link) or set together
-- (source/id/state) -- never a partial set. `import_map` stays the lookup
-- index; these columns are the record's own folded belief, read straight
-- off `layouts` without a join.
--
-- (S3s adds source-client columns to this same file, before it is applied
-- anywhere; nothing for that slice lands here yet.)
ALTER TABLE layouts ADD COLUMN upstream_source TEXT NULL; -- 'cmini' | NULL
ALTER TABLE layouts ADD COLUMN upstream_id TEXT NULL;      -- the upstream (cmini) id, as text
ALTER TABLE layouts ADD COLUMN upstream_state TEXT NULL;   -- 'following' | 'forked'
