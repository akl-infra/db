-- Author-name churn fix (db/INVARIANTS.md LDB-I15..I17, src/import/
-- authors.ts): where the ONE name `authors` stores for an id came from.
-- Upstream cmini's `/authors` maps one Discord id to several names (it
-- keeps every name a user ever had on file); the import used to rewrite
-- the row for every name that differed, walking each multi-name id through
-- all of them on every pass. It now keeps a stored name while that name is
-- still one of upstream's names for the id, and never renames a row whose
-- name arrived through the user lane.
--   'import' -- chosen by the cmini import (the default: every row the
--               import seeded before this column existed)
--   'user'   -- the user lane (`auth/discord.ts`'s `resolveBearer`): the
--               user's own Discord display name; the import never
--               overwrites it
--   'client' -- the client lane's first-sight placeholder (`auth/client.ts`
--               step 7: name = the user id); the import may replace it
ALTER TABLE authors ADD COLUMN name_source TEXT NOT NULL DEFAULT 'import';

-- Backfill, best effort (LDB-I17): a row still holding its own id is the
-- client lane's placeholder; a row whose name equals a successful
-- auth-cache entry for the same user came through the user lane. Anything
-- else stays 'import' -- a user-lane name the old import already
-- overwrote comes back (as 'user') on that user's next sign-in.
UPDATE authors SET name_source = 'client' WHERE name = user_id;
UPDATE authors SET name_source = 'user'
  WHERE EXISTS (SELECT 1 FROM auth_cache a WHERE a.ok = 1 AND a.user_id = authors.user_id AND a.name = authors.name);
