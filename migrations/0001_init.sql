CREATE TABLE layouts (
  id            TEXT PRIMARY KEY,                 -- ULID
  name          TEXT NOT NULL COLLATE NOCASE UNIQUE,   -- ASCII case-insensitive (SQLite NOCASE); upstream names are ASCII (0.1)
  owner         TEXT NOT NULL,                    -- Discord user id, as text
  rev           INTEGER NOT NULL,
  created_at    TEXT NOT NULL, modified_at TEXT NOT NULL,
  deleted       INTEGER NOT NULL DEFAULT 0,
  format        TEXT NOT NULL,                    -- 'cmini/1' | 'akl/1'
  payload_json  TEXT NOT NULL,                    -- canonical()
  like_count    INTEGER NOT NULL DEFAULT 0,
  has_magic     INTEGER NOT NULL DEFAULT 0        -- lower(payload).length > 0
);
CREATE INDEX layouts_owner ON layouts(owner);
CREATE INDEX layouts_modified ON layouts(modified_at);

CREATE TABLE layout_revs (                        -- every rev, never compacted in phase 1
  layout_id TEXT NOT NULL, rev INTEGER NOT NULL, event_seq INTEGER NOT NULL,
  format TEXT NOT NULL, payload_json TEXT NOT NULL,
  PRIMARY KEY (layout_id, rev)
);

CREATE TABLE likes (layout_id TEXT NOT NULL, user_id TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (layout_id, user_id));
CREATE INDEX likes_user ON likes(user_id);

CREATE TABLE authors (user_id TEXT PRIMARY KEY, name TEXT NOT NULL,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);

CREATE TABLE events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,   -- first event is seq 1; /v1/changes?since=0 returns it
  at         TEXT NOT NULL,
  kind       TEXT NOT NULL,
  layout_id  TEXT, name TEXT, owner TEXT,
  rev        INTEGER,                             -- the record's rev AFTER this event; NULL = informational (no rev bump)
  actor      TEXT NOT NULL,                       -- user id | 'system:cmini-import'
  via        TEXT NOT NULL,                       -- 'import:cmini' in phase 1; 'discord' | 'client:<id>' in phase 2
  admin      INTEGER NOT NULL DEFAULT 0,
  detail_json TEXT,                               -- imported: {source, upstream_id, shadowed?}; upstream_changed: the upstream cmini/1 detail
  before_json TEXT, after_json TEXT               -- record minus payload, or NULL
);
CREATE INDEX events_layout ON events(layout_id, seq);
CREATE INDEX events_kind ON events(kind, seq);

CREATE TABLE admins (user_id TEXT PRIMARY KEY, added_by TEXT, added_at TEXT NOT NULL, note TEXT);
INSERT INTO admins VALUES ('184412255822020608', NULL, '2026-09-08T00:00:00Z', 'bootstrap: deeroh');

CREATE TABLE import_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  -- keys: 'cmini.meta_token' (canonical /meta response), 'cmini.last_full' (iso),
  --       'cmini.paused' ('1'), 'cmini.stalled' (json {at, reason}), 'cmini.last_tick' (json stats)
CREATE TABLE import_map (upstream_id TEXT PRIMARY KEY, layout_id TEXT NOT NULL UNIQUE);
