-- design/layout-db/26-no-board.md: spark/1 has no `board` field any more.
-- Strip the key from every stored spark payload (the current row AND every
-- historical rev, so a `revert` never re-validates a payload the schema
-- now refuses) in place. `payload_json` is `canonical()` output -- sorted
-- keys, no whitespace -- and `json_remove` returns minified JSON with the
-- remaining keys in their original order, so the result is byte-identical
-- to what `canonical()` would produce for the same board-less payload
-- (asserted by tests/api/migration-0016.test.ts). Revs are NOT bumped:
-- nothing a client can see has changed except that a key it is told to
-- ignore is gone (WIRE_VERSION 12 invalidates every cached body anyway).
UPDATE layout_formats
   SET payload_json = json_remove(payload_json, '$.board')
 WHERE lineage = 'spark' AND json_type(payload_json, '$.board') IS NOT NULL;

UPDATE layout_revs
   SET payload_json = json_remove(payload_json, '$.board')
 WHERE lineage = 'spark' AND payload_json IS NOT NULL AND json_type(payload_json, '$.board') IS NOT NULL;
