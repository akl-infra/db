-- Two read-path indexes (2026-10-05, the D1 usage review: 31M rows read a
-- day, 80% of them one query). Additive (LDB-G15): `CREATE INDEX` only.
--
-- layouts_owner_name: `GET /v1/layouts?owner=` (akl.gg's signed-in tabs poll
-- it once a minute) read the whole catalog per call -- about 9,100 rows to
-- return a handful -- because the list query started from a `(lineage, ...)`
-- index on `layout_formats`, and with one lineage that matches every row.
-- `core/records.ts`'s `list()` now drives the join from `layouts` (LDB-R12),
-- and this index hands it one owner's live rows already in the default sort
-- order (`name COLLATE NOCASE, id`), so the call reads about two rows per
-- owned layout and never sorts. Partial on `deleted = 0`, like
-- `layouts_name_live`: a list never shows a tombstone.
CREATE INDEX layouts_owner_name ON layouts(owner, name COLLATE NOCASE, id) WHERE deleted = 0;

-- events_at: `/v1/meta` reads `MAX(at)` (`core/meta.ts`), which scanned every
-- event (12,351 on 2026-10-05) for one value. With this index it is one
-- covering lookup and the value is the same (LDB-R14). One extra index entry
-- per event written.
CREATE INDEX events_at ON events(at);
