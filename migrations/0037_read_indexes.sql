-- Two partial indexes that cut D1 rows read on hot validators without
-- adding writes on hot tables (a partial index is maintained only for rows
-- matching its WHERE). Additive (LDB-G15); nothing else changes.
--
-- [LDB-R17] `/v1/meta`'s head counts `upstream_deleted` events of the last
-- 24 hours (health.import.deletes_24h). Through `events_kind` (kind, seq) it
-- read every such event ever (11 rows read per call, 2026-11-01, of the
-- head's 17); this index answers the time range directly. Nothing appends
-- `upstream_deleted` any more (the cmini importer is gone, LDB-X2), so the
-- index costs no write at all.
CREATE INDEX events_upstream_deleted_at ON events(at) WHERE kind = 'upstream_deleted';

-- [LDB-R17] `/v1/meta`'s `health.clients` lists suspended clients: a scan of
-- every client row (11 rows read per uncached call). Clients change only by
-- admin action.
CREATE INDEX clients_suspended ON clients(id) WHERE status = 'suspended';
