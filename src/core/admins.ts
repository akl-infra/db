// Admins as data (09 §3 T3): list/add/remove. Every admin action is an
// event (`appendAdmin`, `core/events.ts`) so the public changelog sees it
// (03 §7) the same way it sees any other write. `src/routes/admin.ts` is
// glue only -- every D1 statement for these verbs lives here.
import type { Bindings } from "../env";
import { appendAdmin, type InfoKind } from "./events";
import { lastAdmins, notFound } from "./errors";
import type { Clock } from "./time";

export interface AdminRow {
  user_id: string;
  added_by: string | null;
  added_at: string;
  note: string | null;
}

// One read, never cached (mirrors `auth/discord.ts`'s own `isAdmin` --
// there are now two copies of this exact query for two different callers:
// this one backs the admin routes' own authorization, discord.ts's backs
// `Actor.admin`. Both read the same table live on every call.)
export async function isAdmin(db: Bindings["DB"], userId: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 FROM admins WHERE user_id = ? LIMIT 1").bind(userId).first();
  return row !== null;
}

export async function list(db: Bindings["DB"]): Promise<AdminRow[]> {
  const { results } = await db
    .prepare("SELECT user_id, added_by, added_at, note FROM admins ORDER BY added_at ASC, user_id ASC")
    .all<AdminRow>();
  return results;
}

// Idempotent (09 §3 T3): re-adding a current admin answers 200 (not 201)
// and appends no event -- `created: false` is what `routes/admin.ts` reads
// to pick the status.
export async function add(
  db: Bindings["DB"],
  now: Clock,
  actorId: string,
  userId: string,
  note?: string,
): Promise<{ row: AdminRow; created: boolean }> {
  const existing = await db
    .prepare("SELECT user_id, added_by, added_at, note FROM admins WHERE user_id = ?")
    .bind(userId)
    .first<AdminRow>();
  if (existing !== null) return { row: existing, created: false };

  const row: AdminRow = { user_id: userId, added_by: actorId, added_at: now(), note: note ?? null };
  await db
    .prepare("INSERT INTO admins (user_id, added_by, added_at, note) VALUES (?, ?, ?, ?)")
    .bind(row.user_id, row.added_by, row.added_at, row.note)
    .run();
  await appendAdmin(db, now, { kind: "admin.added", actor: actorId, detail: { user_id: userId, note: row.note } });
  return { row, created: true };
}

// The A6 guard (09 §3 T3): the count check and the delete are ONE
// statement -- no TOCTOU window for two concurrent removes to both read
// "3 rows, safe to drop one" and both commit, which would leave 1. A
// `changes = 0` result means either "not an admin at all" or "would leave
// < 2" (a bare DELETE can't tell those apart); the follow-up SELECTs below
// only pick the right error body -- they play no part in the safety
// guarantee, which the DELETE's own WHERE clause already provides.
export async function remove(db: Bindings["DB"], now: Clock, actorId: string, userId: string): Promise<{ seq: number }> {
  const result = await db
    .prepare("DELETE FROM admins WHERE user_id = ? AND (SELECT COUNT(*) FROM admins) > 2")
    .bind(userId)
    .run();

  if (result.meta.changes === 0) {
    const stillThere = await db.prepare("SELECT 1 FROM admins WHERE user_id = ?").bind(userId).first();
    if (stillThere === null) throw notFound(`'${userId}' is not an admin`, userId);
    const countRow = await db.prepare("SELECT COUNT(*) AS n FROM admins").first<{ n: number }>();
    throw lastAdmins(countRow?.n ?? 2);
  }

  const { seq } = await appendAdmin(db, now, { kind: "admin.removed", actor: actorId, detail: { user_id: userId } });
  return { seq };
}

// X4 follow-up: the manual-trigger route (`POST /v1/admin/nightly/tick`,
// X4 follow-up 3) is event-logged -- an operator manually kicking a cron
// is an admin action worth the public changelog seeing, same posture as
// everything else in this file. `detail` carries the tick's own summary
// (`{at, jobs, dump}`), small: `jobs` is four one-word statuses and `dump`
// is `{key, latest}`, never the dump's own multi-MB body.
//
// [LDB-X2] `import`/`diff` used to be two more `which` values here (the
// cmini import tick and the upstream diff tick's own manual-kick routes,
// `POST /v1/admin/import/tick`/`POST /v1/admin/diff/tick`) -- both deleted
// along with the importer (pine's own upstream has been permanently dead
// since 2026-09-15, LDB-I27). `admin.import_ticked`/`admin.diff_ticked`
// stay valid `InfoKind` values (`core/events.ts`'s `KNOWN_KINDS`) purely
// as history: real events from before this change still fold and replay
// correctly; nothing emits either kind any more.
const MANUAL_TICK_KIND: Record<"nightly", InfoKind> = {
  nightly: "admin.nightly_ticked",
};

export async function recordManualTick(db: Bindings["DB"], now: Clock, actorId: string, which: "nightly", detail: object): Promise<{ seq: number }> {
  const { seq } = await appendAdmin(db, now, { kind: MANUAL_TICK_KIND[which], actor: actorId, detail });
  return { seq };
}
