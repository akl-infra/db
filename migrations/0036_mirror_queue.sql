-- The reverse mirror's queue (design/aws-port.md §5.2 "Rollback", lane Z): batches of recorded storage writes that AWS sends back
-- to D1 after the cutover, held until the applier replays them in order. Empty (and unread) until the /__mirror route is switched on
-- by MIRROR_SECRET. Not a dumped table. `sk` sorts as src/mirror/queue.ts describes: B# dedupe markers, E# event calls, N# other
-- calls, S the applier state, H the kept divergent record.
CREATE TABLE mirror_queue (
  sk   TEXT PRIMARY KEY,
  body TEXT NOT NULL
);
