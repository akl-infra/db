-- 20-spark.md S3a: the `upstream` field (decision 5, LDB-I14). Plumbing
-- only -- nothing is backfilled here. The legacy rule needs the event
-- walk (`core/upstream.ts`'s `upstreamOf` fallback), and the record
-- migration (S4) is what actually populates these columns for existing
-- rows. All three NULL together (no known link) or set together
-- (source/id/state) -- never a partial set. `import_map` stays the lookup
-- index; these columns are the record's own folded belief, read straight
-- off `layouts` without a join.
--
ALTER TABLE layouts ADD COLUMN upstream_source TEXT NULL; -- 'cmini' | NULL
ALTER TABLE layouts ADD COLUMN upstream_id TEXT NULL;      -- the upstream (cmini) id, as text
ALTER TABLE layouts ADD COLUMN upstream_state TEXT NULL;   -- 'following' | 'forked'

-- 20-spark.md S3s (decision 14, LDB-P15): every edit carries its source
-- client. `events.source_client`/`source_version` record what wrote THAT
-- event (every kind: rev-bumping, informational, like); `layouts.
-- source_client`/`source_version` are the fold -- only a rev-bumping write
-- moves them (core/events.ts's `appendWrite`; `appendInfo`/`appendLike`
-- never touch `layouts`, same as they never touched `upstream_*`).
-- `auth_cache.app_id` is the Discord OAuth2 application id the bearer
-- token was issued to (`GET /oauth2/@me`'s `application.id`), cached
-- alongside `user_id` so a cached row answers `Actor.source_client` with
-- no extra Discord call. All three -- `source_client`/`source_version` on
-- either table, `app_id` on `auth_cache` -- are NULL on any row written
-- before this migration; nothing is backfilled here (`core/records.ts`'s
-- `sourceFromRow` and `auth/discord.ts`'s cache-miss check are the
-- read-side treatment).
ALTER TABLE events ADD COLUMN source_client TEXT NULL;
ALTER TABLE events ADD COLUMN source_version TEXT NULL;
ALTER TABLE layouts ADD COLUMN source_client TEXT NULL;
ALTER TABLE layouts ADD COLUMN source_version TEXT NULL;
ALTER TABLE auth_cache ADD COLUMN app_id TEXT NULL;
