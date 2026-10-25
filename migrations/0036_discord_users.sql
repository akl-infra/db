-- Discord names for WPM typists (docs/decisions/28-wpm-records.md,
-- LDB-WPM18..): `user_name` used to be joined from `authors` alone, so a
-- typist without an `authors` row had none. This table is the fallback: the
-- Discord username (and display name) of a user id, written by the typist's
-- own submit, by the admin on-behalf entry (resolved with the akldb bot) and
-- by the admin backfill. PURELY ADDITIVE: new tables and triggers only, no
-- existing column or row is touched.
--
--   id          -- the Discord snowflake
--   username    -- the account name, always present
--   global_name -- the display name, NULL when the user has none
--   updated_at  -- the writer's clock; moves only when a name changed
CREATE TABLE discord_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  global_name TEXT,
  updated_at TEXT NOT NULL
);

-- The validator `GET /v1/wpm`'s ETag folds in (the companion of
-- `authors_head`, 0007): +1 whenever a name is inserted or really changes,
-- never on a write that stores what is already there.
CREATE TABLE discord_users_head (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
);

INSERT INTO discord_users_head (id, version) VALUES (1, 0);

CREATE TRIGGER discord_users_head_on_insert AFTER INSERT ON discord_users
BEGIN
  UPDATE discord_users_head SET version = version + 1 WHERE id = 1;
END;

CREATE TRIGGER discord_users_head_on_rename AFTER UPDATE OF username, global_name ON discord_users
WHEN OLD.username IS NOT NEW.username OR OLD.global_name IS NOT NEW.global_name
BEGIN
  UPDATE discord_users_head SET version = version + 1 WHERE id = 1;
END;
