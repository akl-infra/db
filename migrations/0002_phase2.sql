CREATE TABLE auth_cache (
  token_hash TEXT PRIMARY KEY,       -- hex sha256 of the bearer; the token itself is never stored
  user_id    TEXT,                   -- NULL on a cached failure
  name       TEXT,
  ok         INTEGER NOT NULL,       -- 1 = Discord said 200 (5 min); 0 = Discord said 401 (60 s)
  expires_at TEXT NOT NULL
);
CREATE INDEX auth_cache_expires ON auth_cache(expires_at);

CREATE TABLE ratelimit (
  key          TEXT PRIMARY KEY,     -- 'write:<user_id>'
  window_start INTEGER NOT NULL,     -- epoch seconds, floor(now/600)*600
  n            INTEGER NOT NULL
);

-- Second admin (00 §6.4). Data, not code (LDB-G2).
-- TODO(saltorbit): INSERT INTO admins VALUES ('<discord id>', '184412255822020608', '<iso>', 'bootstrap: <name>');
