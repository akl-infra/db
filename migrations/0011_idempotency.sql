-- L3 (design/layout-db/review/LEDGER.md, review/PROPOSAL.md §2.1):
-- optional `Idempotency-Key` header on every mutating /v1/layouts route
-- (writes, likes, restore, transfer). Keyed on (scope, key): `scope` is
-- the acting Ed25519 client's own id, or the Discord user id on the
-- bearer lane (`core/idempotency.ts`'s `idempotencyScope`) -- two
-- different callers reusing the same key never collide, and neither can
-- replay the other's stored response. A row younger than 24h whose
-- method+path+request_hash match the incoming request is a replay
-- (`status`/`response_body` returned verbatim, nothing written, `Idempotency-
-- Replayed: true`); a mismatch on any of the three is `422
-- idempotency_mismatch`, also writing nothing; a row 24h or older is
-- ignored (and eligible for `pruneIdempotency`, called nightly and
-- opportunistically overwritten on next use of that same key).
CREATE TABLE idempotency (
  scope         TEXT NOT NULL,
  key           TEXT NOT NULL,
  method        TEXT NOT NULL,
  path          TEXT NOT NULL,
  request_hash  TEXT NOT NULL,
  status        INTEGER NOT NULL,
  response_body TEXT NOT NULL,   -- the exact JSON body served, byte-for-byte replayed
  at            TEXT NOT NULL,   -- ISO; the 24h window is computed from this
  PRIMARY KEY (scope, key)
);
-- `pruneIdempotency`'s own DELETE, and the opportunistic per-lookup
-- expiry check, both filter on `at` alone.
CREATE INDEX idempotency_at ON idempotency(at);
