-- design/alts/07-format.md (round 4, slice D): spark/1 gains two additive
-- optional top-level fields, `alts` and `combos`. `has_alts`/`has_combos`
-- are stored columns beside `has_magic` (migrations/0009_formats.sql),
-- written wherever `has_magic` is written and filterable the same way
-- (`?has_alts=`/`?has_combos=`, mirroring `?has_magic=`).
--
-- Additive (LDB-G15/`tests/tools/migrations-additive.test.ts`: `ALTER
-- TABLE ... ADD COLUMN`, `CREATE INDEX` and a plain `UPDATE` are all fine --
-- only `DROP TABLE`/`DELETE FROM`/`TRUNCATE`/`DROP COLUMN`/recreating
-- `events` are forbidden). The backfill below is a no-op today (no stored
-- row could ever carry `alts`/`combos` before this slice -- the schema's
-- `additionalProperties: false` refused both as unknown keys), same as
-- `0016_no_board.sql`/`0017_magic_emit.sql`'s own style of recomputing a
-- derived column from `payload_json` rather than trusting a bare default.
ALTER TABLE layout_formats ADD COLUMN has_alts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE layout_formats ADD COLUMN has_combos INTEGER NOT NULL DEFAULT 0;
CREATE INDEX layout_formats_has_alts ON layout_formats(lineage, has_alts);
CREATE INDEX layout_formats_has_combos ON layout_formats(lineage, has_combos);

UPDATE layout_formats
   SET has_alts = 1
 WHERE lineage = 'spark' AND json_type(payload_json, '$.alts') = 'array' AND json_array_length(payload_json, '$.alts') > 0;

UPDATE layout_formats
   SET has_combos = 1
 WHERE lineage = 'spark' AND json_type(payload_json, '$.combos') = 'array' AND json_array_length(payload_json, '$.combos') > 0;
