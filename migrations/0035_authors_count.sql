-- `/v1/meta.author_count` as a counter (db/INVARIANTS.md LDB-R16), the
-- companion of `layouts_head` (0034): `SELECT COUNT(*) FROM authors` read
-- every author row on each non-304 `/v1/meta`.
--
--   count -- the number of `authors` rows, on `authors_head`'s one row:
--            +1 on INSERT, -1 on DELETE (a rename or `last_seen_at` write
--            changes neither). Separate triggers from 0007's, which stay
--            as applied.
ALTER TABLE authors_head ADD COLUMN count INTEGER NOT NULL DEFAULT 0;

UPDATE authors_head SET count = (SELECT COUNT(*) FROM authors) WHERE id = 1;

CREATE TRIGGER authors_head_count_on_insert AFTER INSERT ON authors
BEGIN
  UPDATE authors_head SET count = count + 1 WHERE id = 1;
END;

CREATE TRIGGER authors_head_count_on_delete AFTER DELETE ON authors
BEGIN
  UPDATE authors_head SET count = count - 1 WHERE id = 1;
END;
