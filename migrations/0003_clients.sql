-- The client lane (02 §3, 10 C1): registered bots signing Ed25519 requests
-- that assert a Discord user id. `clients` is admin-managed data (LDB-G2 --
-- no client id is ever a constant in code); `nonces` is the replay guard --
-- its PRIMARY KEY *is* the check (src/auth/client.ts step 5), not a
-- separate SELECT-then-INSERT.
CREATE TABLE clients (
  id             TEXT PRIMARY KEY,        -- ULID minted at registration
  name           TEXT NOT NULL,
  pubkey         TEXT NOT NULL,           -- base64url of the raw 32-byte Ed25519 public key
  owner_user_id  TEXT NOT NULL,           -- Discord id of the maintainer
  caps           TEXT NOT NULL,           -- 'act-as-user' | 'act-as-owner-only'
  discord_app_id TEXT,                    -- recorded for the human check (02 §3.3), never verified at runtime
  status         TEXT NOT NULL,           -- 'active' | 'revoked'
  created_at     TEXT NOT NULL, revoked_at TEXT
);
CREATE TABLE nonces (
  client_id TEXT NOT NULL, nonce TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (client_id, nonce)         -- the PK IS the replay check (below)
);
CREATE INDEX nonces_at ON nonces(at);
