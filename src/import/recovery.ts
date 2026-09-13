// Hostile/vanished-upstream recovery tooling (saltorbit 2026-09-13: "i am
// concerned about the cmini owner crashing out and deleting their db when
// this goes live"). The automatic guards (LDB-I3/I6/I22/I23) stop the
// importer from doing damage on its own; these two functions back the
// manual admin routes an operator uses once they've looked at the
// situation -- `routes/admin.ts` stays glue only, every D1 statement for
// them lives here (the same discipline `core/admins.ts` follows for the
// plain admin verbs, LDB-W1's own spirit for routes/*.ts).
import type { Bindings } from "../env";
import { appendAdmin } from "../core/events";
import type { Clock } from "../core/time";
import { STALLED_STATE_KEY } from "./cmini";

export interface StalledState {
  at: string;
  reason: string;
}

export async function readStalled(db: Bindings["DB"]): Promise<StalledState | null> {
  const row = await db.prepare("SELECT value FROM import_state WHERE key = ?").bind(STALLED_STATE_KEY).first<{ value: string }>();
  if (row === null) return null;
  return JSON.parse(row.value) as StalledState;
}

// LDB-I25: `POST /v1/admin/import/unstall` -- clears `cmini.stalled`
// deliberately and logs the action (`admin.import_unstalled`, admin lane,
// `admin: 1`). This is a MANUAL OVERRIDE, not a fix: the very next tick
// re-plans from the SAME inputs LDB-I3/I6/I22 always use (the current
// listing, the current local state, the current rolling-24h count) -- an
// upstream that is STILL short-listing or STILL mass-deleting re-stalls
// on that very next tick, immediately, with no grace period. Idempotent:
// unstalling when nothing is stalled clears nothing and still logs (an
// operator's explicit action is worth recording either way), returning
// `wasStalled: null` so the caller can tell the two cases apart.
export async function unstallImport(db: Bindings["DB"], now: Clock, actorId: string, via: string): Promise<{ wasStalled: StalledState | null; seq: number }> {
  const wasStalled = await readStalled(db);
  await db.prepare("DELETE FROM import_state WHERE key = ?").bind(STALLED_STATE_KEY).run();
  const { seq } = await appendAdmin(db, now, {
    kind: "admin.import_unstalled",
    actor: actorId,
    via,
    detail: wasStalled === null ? undefined : { was_stalled: wasStalled },
  });
  return { wasStalled, seq };
}

export interface RestorableRecord {
  layoutId: string;
  name: string;
  deletedAt: string;
}

// LDB-I26: the bulk-restore candidate list for `POST /v1/admin/import/
// restore-deleted` -- layouts whose CURRENT tombstone (`layouts.deleted =
// 1`, `layouts.layout_rev` at its own latest layout-scope rev-bumping
// event) was caused by the IMPORTER (`kind = 'upstream_deleted'`, the real
// tombstone -- `rev` is never NULL on a row this join can even reach,
// since `le.rev = l.layout_rev` only matches a rev-bumping event) at or
// after `sinceIso`. The join is what makes this "never touches a record
// the OWNER deleted" (`kind = 'deleted'`): if the layout was force-
// restored and the owner deleted it again themselves, THAT later write is
// now the one at `l.layout_rev`, its `kind` is `'deleted'`, and the `WHERE
// le.kind = 'upstream_deleted'` clause excludes it -- regardless of any
// older `upstream_deleted` event still sitting in the layout's history.
// Naturally idempotent across repeated calls too: a layout this route
// already restored has `deleted = 0` and drops out of the `l.deleted = 1`
// filter on its own, no extra bookkeeping needed.
export async function listRestorableUpstreamDeleted(db: Bindings["DB"], sinceIso: string, limit: number): Promise<RestorableRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT l.id AS layoutId, l.name AS name, le.at AS deletedAt
       FROM layouts l
       JOIN events le ON le.layout_id = l.id AND le.rev = l.layout_rev AND le.format IS NULL
       WHERE l.deleted = 1 AND le.kind = 'upstream_deleted' AND le.at >= ?
       ORDER BY le.at ASC
       LIMIT ?`,
    )
    .bind(sinceIso, limit)
    .all<{ layoutId: string; name: string; deletedAt: string }>();
  return results;
}
