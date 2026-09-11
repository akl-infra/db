-- design/layout-db/21-formats.md F2: several formats per layout. Drops and
-- recreates `layouts`, `layout_formats` (new), `layout_revs` and `events`
-- with the S2.1 shape; empties `likes`/`import_map`/`import_state` (they
-- point at ids this wipe discards) and resets every webhook cursor to 0
-- (D8: layoutdb is disposable, wiped and rebuilt from cmini/akl.gg after a
-- schema change). `clients`, `admins`, `webhooks` (rows) and `authors`
-- survive untouched.
--
-- `layouts.n` is the internal write counter (21-formats.md S2.1): +1 on
-- EVERY rev-bumping write to this layout, whatever its scope. It is what
-- `layout_revs`' PK (layout_id, n) serializes on -- the one guard a format
-- write and a layout-level write on the same layout both go through, so a
-- format write can never land on a tombstone or for a former owner (S2.2).
-- `n` never leaves the Worker; clients see `layout_rev` and each format's
-- own `rev`.
DROP INDEX IF EXISTS layouts_name_live;
DROP INDEX IF EXISTS layouts_owner;
DROP INDEX IF EXISTS layouts_modified;
DROP TABLE events;
DROP TABLE layout_revs;
DROP TABLE layouts;

CREATE TABLE layouts (
  id              TEXT PRIMARY KEY,                 -- ULID
  name            TEXT NOT NULL COLLATE NOCASE,     -- ASCII case-insensitive; live-unique only (layouts_name_live)
  owner           TEXT NOT NULL,                    -- Discord user id, as text
  n               INTEGER NOT NULL,                 -- internal write counter (see header note); never on the wire
  layout_rev      INTEGER NOT NULL,                 -- layout-scope rev: name/owner/deletion (S2.2)
  created_at      TEXT NOT NULL, modified_at TEXT NOT NULL,
  deleted         INTEGER NOT NULL DEFAULT 0,
  like_count      INTEGER NOT NULL DEFAULT 0,
  upstream_source TEXT NULL,                        -- 'cmini' | NULL
  upstream_id     TEXT NULL,
  upstream_state  TEXT NULL,                        -- 'following' | 'forked'
  source_client   TEXT NULL,                        -- latest LAYOUT-SCOPE write's source (S2.2: source_client/version)
  source_version  TEXT NULL
);
CREATE UNIQUE INDEX layouts_name_live ON layouts(name) WHERE deleted = 0;
CREATE INDEX layouts_owner ON layouts(owner);
CREATE INDEX layouts_modified ON layouts(modified_at);

-- One row per (layout, lineage) -- D3: a layout name holds several formats,
-- each with its own payload/rev/timestamps/history; a future spark/2
-- migrates THIS row forward (same lineage), never adds a second one.
CREATE TABLE layout_formats (
  layout_id     TEXT NOT NULL,
  lineage       TEXT NOT NULL,                     -- the `<name>` half of `format` (registry.ts's lineage())
  format        TEXT NOT NULL,                     -- full id, e.g. 'spark/1'
  rev           INTEGER NOT NULL,                  -- this format's own rev, from 1
  created_at    TEXT NOT NULL, modified_at TEXT NOT NULL,
  payload_json  TEXT NOT NULL,                     -- canonical()
  has_magic     INTEGER NOT NULL DEFAULT 0,
  source_client TEXT NULL,                         -- latest write to THIS format's source
  source_version TEXT NULL,
  PRIMARY KEY (layout_id, lineage)
);
CREATE INDEX layout_formats_layout ON layout_formats(layout_id);
-- `since=`/`sort=modified_at` for `?format=F` use max(layouts.modified_at,
-- F.modified_at) (S2.2) -- indexed per lineage so that scan stays cheap.
CREATE INDEX layout_formats_modified ON layout_formats(lineage, modified_at);
CREATE INDEX layout_formats_has_magic ON layout_formats(lineage, has_magic);

CREATE TABLE layout_revs (                          -- every rev, never compacted, either scope
  layout_id  TEXT NOT NULL,
  n          INTEGER NOT NULL,                      -- the concurrency guard (S2.1): gapless per layout, PK below
  lineage    TEXT NULL,                              -- NULL for a layout-level write
  rev        INTEGER NOT NULL,                       -- layout_rev when lineage IS NULL, else that format's rev
  event_seq  INTEGER NOT NULL,
  format     TEXT NULL,                              -- NULL for a layout-level write
  payload_json TEXT NULL,                            -- NULL for a layout-level write
  PRIMARY KEY (layout_id, n),
  UNIQUE (layout_id, lineage, rev)                    -- a format's own history is gapless from 1 (MF-2)
);
CREATE INDEX layout_revs_lineage ON layout_revs(layout_id, lineage, rev);

CREATE TABLE events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,     -- first event is seq 1; /v1/changes?since=0 returns it
  at         TEXT NOT NULL,
  kind       TEXT NOT NULL,
  layout_id  TEXT, name TEXT, owner TEXT,
  format     TEXT,                                   -- NULL for a layout-level event, else the full format id
  rev        INTEGER,                                -- layout_rev when format IS NULL, else that format's rev; NULL = informational
  actor      TEXT NOT NULL,                           -- user id | 'system:cmini-import'
  via        TEXT NOT NULL,
  admin      INTEGER NOT NULL DEFAULT 0,
  detail_json TEXT,
  before_json TEXT, after_json TEXT,                  -- record-minus-payload (scoped, see core/events.ts), or NULL
  source_client TEXT NULL,
  source_version TEXT NULL
);
CREATE INDEX events_layout ON events(layout_id, seq);
CREATE INDEX events_kind ON events(kind, seq);

-- D8: every row here points at a layout id the drop above just discarded.
DELETE FROM likes;
DELETE FROM import_map;
DELETE FROM import_state;
-- D8: a webhook subscription's cursor is a position in the (now-reset)
-- event log; the subscription itself (url/secret/kinds/owner_filter)
-- survives, same posture LDB-H4 already takes toward a rehost.
UPDATE webhooks SET cursor = 0, failures = 0, failing_since = NULL, next_at = created_at, last_error = NULL, lease_id = NULL, lease_until = NULL;
