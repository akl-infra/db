-- The authors validator (db/INVARIANTS.md LDB-R9..R11): one row that moves
-- exactly when what `GET /v1/authors` and `/v1/meta`'s author fields show
-- moves, and never otherwise.
--
-- Why a counter: an author-only change (a new id from the cmini import, a
-- sign-in that renames a user, the import replacing a client-lane
-- placeholder) appends no event, so an ETag keyed on the event seq alone
-- let a conditional request -- and the edge cache -- keep answering the OLD
-- body until some unrelated event moved the seq; the spark bot trusts that
-- 304 (design/HARD-REQUIREMENTS.md R1). `MAX(last_seen_at)` can't be the
-- validator either: it moves on every sign-in and bot write (bookkeeping,
-- not content), and a wall-clock value can't prove freshness anyway (R1's
-- "never by wall-clock timestamps").
--
--   version     -- +1 on every INSERT, DELETE, or `user_id`/`name` change
--                  of an `authors` row. Moved by the triggers below, so no
--                  writer (the import, either auth lane, a restore, one not
--                  written yet) can forget to. A write that only moves
--                  `last_seen_at`/`name_source`, or sets `name` to the value
--                  it already had, leaves it alone.
--   modified_at -- `/v1/meta.authors_modified_at`: the `last_seen_at` (the
--                  writer's own clock) of the latest insert or rename.
--                  Informational only; `version` is the proof.
CREATE TABLE authors_head (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  modified_at TEXT
);

-- Seeded with what `authors_modified_at` read the moment before this
-- migration, so the field doesn't jump at deploy.
INSERT INTO authors_head (id, version, modified_at) VALUES (1, 0, (SELECT MAX(last_seen_at) FROM authors));

CREATE TRIGGER authors_head_on_insert AFTER INSERT ON authors
BEGIN
  UPDATE authors_head SET version = version + 1, modified_at = NEW.last_seen_at WHERE id = 1;
END;

CREATE TRIGGER authors_head_on_rename AFTER UPDATE OF user_id, name ON authors
WHEN OLD.name IS NOT NEW.name OR OLD.user_id IS NOT NEW.user_id
BEGIN
  UPDATE authors_head SET version = version + 1, modified_at = NEW.last_seen_at WHERE id = 1;
END;

CREATE TRIGGER authors_head_on_delete AFTER DELETE ON authors
BEGIN
  UPDATE authors_head SET version = version + 1 WHERE id = 1;
END;
