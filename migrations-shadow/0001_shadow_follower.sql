-- Shadow-only schema (design A phase D, LDB-PV2/PV5). NOT in migrations/: production and staging never get this table.
-- scripts/deploy-aws.sh ships this directory only in the shadow stage's zip, and src/replica/shadow/schema.ts applies it
-- through the commit log (a normal `migration` entry, recorded in d1_migrations under its own `shadow-` name) the first time
-- the shadow stage seeds or ticks.
--
-- Why a table in the database and not a state item in the DynamoDB log table: the follower's cursor must move in the SAME
-- commit unit as the events it applied (SH3: a unit is atomic and is the replication unit), or a crash between "apply" and
-- "advance" would apply an event twice or lose it. A second store means a second write and exactly that window. Every
-- replica, snapshot and point-in-time restore also carries the cursor with the rows it describes.
--
-- One row (id = 1), created by the seed job in its last unit; its absence means "not seeded".
CREATE TABLE shadow_follower (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- the last production events.seq this database has applied (the next feed read is /v1/changes?since=<cursor>)
  cursor INTEGER NOT NULL,
  -- what the seed loaded
  seeded_dump_key TEXT NOT NULL,
  seeded_dump_seq INTEGER NOT NULL,
  seeded_at TEXT NOT NULL,
  -- the last public dump this database was checked against (nightly checksums) and resynced its state tables from
  checked_dump_key TEXT,
  checked_dump_seq INTEGER,
  checked_at TEXT,
  -- JSON: {"result":"equal|differs|inconclusive|missed", "tables": {...}} of that check
  check_result TEXT,
  applied_total INTEGER NOT NULL DEFAULT 0,
  -- JSON {table: count}: state events applied since the last resync whose table effect is NOT reproduced (see apply.ts)
  stale_json TEXT NOT NULL DEFAULT '{}'
);
