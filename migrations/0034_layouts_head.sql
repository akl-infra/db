-- `/v1/meta.layout_count` as a counter (db/INVARIANTS.md LDB-R15).
--
-- It used to be `SELECT COUNT(*) FROM layouts WHERE deleted = 0` on every
-- non-304 `/v1/meta`: a scan of every live row (~4.4k) per call. Same shape
-- as `authors_head` (0007): one row, moved by triggers in the SAME
-- statement/transaction as every change to `layouts`, so no writer (the
-- event fold, a restore, a transfer, one not written yet) can forget to.
--
--   live -- the number of rows with `deleted = 0`, exactly what the old
--           COUNT(*) returned: +1 on an INSERT of a live row, -1 on a
--           DELETE of a live row, and +/-1 when an UPDATE flips `deleted`
--           (soft-delete, restore). Any other update (rename, transfer,
--           like_count, rev bumps) leaves it alone.
--
-- `restoreSql` never deletes this row (its `layouts` deletes and inserts
-- move it by trigger, ending at the dumped count).
CREATE TABLE layouts_head (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  live INTEGER NOT NULL
);

INSERT INTO layouts_head (id, live) VALUES (1, (SELECT COUNT(*) FROM layouts WHERE deleted = 0));

CREATE TRIGGER layouts_head_on_insert AFTER INSERT ON layouts
WHEN NEW.deleted = 0
BEGIN
  UPDATE layouts_head SET live = live + 1 WHERE id = 1;
END;

CREATE TRIGGER layouts_head_on_delete AFTER DELETE ON layouts
WHEN OLD.deleted = 0
BEGIN
  UPDATE layouts_head SET live = live - 1 WHERE id = 1;
END;

CREATE TRIGGER layouts_head_on_deleted_flip AFTER UPDATE OF deleted ON layouts
WHEN (OLD.deleted = 0) <> (NEW.deleted = 0)
BEGIN
  UPDATE layouts_head SET live = live + (CASE WHEN NEW.deleted = 0 THEN 1 ELSE -1 END) WHERE id = 1;
END;
