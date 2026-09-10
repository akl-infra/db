// Admins as data (09 §3 T3): list/add/remove, and the cmini import's
// pause/resume switch. Every admin action is an event (`appendAdmin`,
// `core/events.ts`) so the public changelog sees it (03 §7) the same way it
// sees any other write. `src/routes/admin.ts` is glue only -- every D1
// statement for these verbs lives here.
import type { Bindings } from "../env";
import { canonical } from "./canonical";
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

// `import/cmini.ts`'s `tick()` reads exactly this key ('1' = paused) before
// doing anything else -- this is the whole of what pause/resume do to the
// import; T3 does not touch tick() itself.
const PAUSE_KEY = "cmini.paused";

export async function setImportPaused(db: Bindings["DB"], now: Clock, actorId: string, paused: boolean): Promise<{ seq: number }> {
  if (paused) {
    await db
      .prepare("INSERT INTO import_state (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = '1'")
      .bind(PAUSE_KEY)
      .run();
  } else {
    await db.prepare("DELETE FROM import_state WHERE key = ?").bind(PAUSE_KEY).run();
  }
  const kind: InfoKind = paused ? "admin.import_paused" : "admin.import_resumed";
  const { seq } = await appendAdmin(db, now, { kind, actor: actorId });
  return { seq };
}

// X4 follow-up: `POST /v1/admin/import/tick`'s own pre-check -- reads the
// exact same key `tick()` itself reads (07 §6 S5's own first check), so a
// manual kick answers `409 import_paused` immediately rather than paying
// for a tick call that would have quietly no-op'd anyway.
export async function isImportPaused(db: Bindings["DB"]): Promise<boolean> {
  const row = await db.prepare("SELECT value FROM import_state WHERE key = ?").bind(PAUSE_KEY).first<{ value: string }>();
  return row?.value === "1";
}

// X4 follow-up: the manual-trigger routes (`POST /v1/admin/import/tick`,
// `POST /v1/admin/diff/tick`, and -- X4 follow-up 3 -- `POST /v1/admin/
// nightly/tick`) are event-logged the same way pause/resume are -- an
// operator manually kicking a cron is an admin action worth the public
// changelog seeing, same posture as everything else in this file. `detail`
// carries the tick's own summary (`TickStats`/`LastDiffRecord`/
// `{at, jobs, dump}`) -- already the exact shape `cmini.last_tick`/
// `cmini.last_diff` store uncapped (or, for `nightly`, small: `jobs` is
// four one-word statuses and `dump` is `{key, latest}`, never the dump's
// own multi-MB body), so no new size concern here.
// M1: `which: "strip_cmini_magic"` (`admin.magic_stripped`) is the fourth
// manual-trigger kind, same posture as the other three -- `POST /v1/admin/
// import/strip-cmini-magic`'s own audit event.
// 20-spark.md S4 (LDB-A5 amended): `which: "migrate"` (`admin.migrate_ticked`)
// is the fifth -- `POST /v1/admin/migrate/tick`'s own audit event, `detail`
// carrying the full `MigrateReport` (`core/migrate.ts`), same posture as
// `diff`'s own full record.
const MANUAL_TICK_KIND: Record<"import" | "diff" | "nightly" | "strip_cmini_magic" | "migrate", InfoKind> = {
  import: "admin.import_ticked",
  diff: "admin.diff_ticked",
  nightly: "admin.nightly_ticked",
  strip_cmini_magic: "admin.magic_stripped",
  migrate: "admin.migrate_ticked",
};

export async function recordManualTick(
  db: Bindings["DB"],
  now: Clock,
  actorId: string,
  which: "import" | "diff" | "nightly" | "strip_cmini_magic" | "migrate",
  detail: object,
): Promise<{ seq: number }> {
  const { seq } = await appendAdmin(db, now, { kind: MANUAL_TICK_KIND[which], actor: actorId, detail });
  return { seq };
}

// The drill result (12 §3 X4): the Fly container that RUNS the rehost drill
// against the deployed dump is saltorbit's own infrastructure (⚠, `08 §2` item
// 2) -- this is only the accept-and-store half, `POST /v1/admin/drill`'s
// glue. No event (12 §6.4: ops state, not governance, same posture as
// webhook CRUD -- neither is about a layout or an admin action a public
// changelog reader would care about); `detail` is caller-supplied and
// capped by the route's own schema (`routes/schemas.ts`), not here.
const DRILL_KEY = "drill.last";

export interface DrillRecord {
  at: string;
  ok: boolean;
  actor: string;
  detail?: object;
}

export async function recordDrill(db: Bindings["DB"], now: Clock, actorId: string, ok: boolean, detail?: object): Promise<DrillRecord> {
  const record: DrillRecord = { at: now(), ok, actor: actorId, ...(detail !== undefined ? { detail } : {}) };
  await db
    .prepare("INSERT INTO import_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(DRILL_KEY, canonical(record))
    .run();
  return record;
}

export async function lastDrill(db: Bindings["DB"]): Promise<DrillRecord | null> {
  const row = await db.prepare("SELECT value FROM import_state WHERE key = ?").bind(DRILL_KEY).first<{ value: string }>();
  return row === null ? null : (JSON.parse(row.value) as DrillRecord);
}
