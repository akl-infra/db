// tick() (07 §6 S5): meta gate -> plan -> fetch -> apply -> authors ->
// state. A thrown error anywhere in here leaves `cmini.meta_token`
// unchanged, so the next cron invocation reruns the whole tick.
import { ulid } from "ulidx";
import type { Bindings } from "../env";
import { canonical } from "../core/canonical";
import { RevConflictError } from "../core/events";
import type { Clock } from "../core/time";
import { applyAuthors, applyDeleteAction, applyFetchedId, recordImportError } from "./apply";
import { planTick, type LocalMapRow } from "./plan";
import { UpstreamClient, type FetchImpl, type RawUpstreamDetail, type SleepImpl } from "./upstream";

const FULL_THRESHOLD = 50; // 07 §6 S5: ?full=1 when more than this many ids need fetching

// B4 (design/layout-db/review/audit-db.md B4): overlapping ticks (the
// `*/5` cron and a manual `POST /v1/admin/import/tick` both landing while
// a slow tick -- up to 500 per-id GETs with 1/2/4s backoff -- is still
// running) had no lock at all. `import_state['cmini.running']` is a plain
// CAS: an INSERT wins outright; if the row is already there, an UPDATE
// only wins if it still matches the exact stale value this reader just
// saw (so a second expiry-recovery attempt racing the first can't also
// win) AND the held lock is actually past its TTL. `release` deletes the
// row only if it still holds OUR OWN value, so a lock this invocation lost
// to an expiry-recovery elsewhere is never yanked out from under the
// invocation that legitimately holds it now.
const LOCK_KEY = "cmini.running";
const LOCK_TTL_MS = 10 * 60 * 1000;

interface RunningLock {
  at: string;
  id: string;
}

async function tryAcquireRunningLock(db: Bindings["DB"], nowIso: string): Promise<string | null> {
  const value = canonical({ at: nowIso, id: ulid() } satisfies RunningLock);

  const insert = await db
    .prepare("INSERT INTO import_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING")
    .bind(LOCK_KEY, value)
    .run();
  if ((insert.meta.changes ?? 0) > 0) return value;

  const row = await db.prepare("SELECT value FROM import_state WHERE key = ?").bind(LOCK_KEY).first<{ value: string }>();
  if (row === null) {
    // The holder released between our failed INSERT and this read -- one
    // more try; if that also loses, someone else got in first.
    const retry = await db
      .prepare("INSERT INTO import_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING")
      .bind(LOCK_KEY, value)
      .run();
    return (retry.meta.changes ?? 0) > 0 ? value : null;
  }

  const held = JSON.parse(row.value) as RunningLock;
  if (Date.parse(nowIso) - Date.parse(held.at) < LOCK_TTL_MS) {
    return null; // still held, not expired
  }

  const cas = await db
    .prepare("UPDATE import_state SET value = ? WHERE key = ? AND value = ?")
    .bind(value, LOCK_KEY, row.value)
    .run();
  return (cas.meta.changes ?? 0) > 0 ? value : null;
}

async function releaseRunningLock(db: Bindings["DB"], value: string): Promise<void> {
  await db.prepare("DELETE FROM import_state WHERE key = ? AND value = ?").bind(LOCK_KEY, value).run();
}

async function getState(db: Bindings["DB"], key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM import_state WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

async function setState(db: Bindings["DB"], key: string, value: string): Promise<void> {
  await db
    .prepare("INSERT INTO import_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}

async function clearState(db: Bindings["DB"], key: string): Promise<void> {
  await db.prepare("DELETE FROM import_state WHERE key = ?").bind(key).run();
}

// `import_map` joined to its record's (name, modified_at, like_count,
// deleted) -- exactly planTick's `local` input (07 §6 S5).
async function loadLocalMap(db: Bindings["DB"]): Promise<LocalMapRow[]> {
  const { results } = await db
    .prepare(
      `SELECT m.upstream_id AS upstreamId, m.layout_id AS layoutId, m.upstream_name AS upstreamName, l.name AS name,
              l.modified_at AS modified_at, l.like_count AS like_count, l.deleted AS deleted
       FROM import_map m JOIN layouts l ON l.id = m.layout_id`,
    )
    .all<{ upstreamId: string; layoutId: string; upstreamName: string | null; name: string; modified_at: string; like_count: number; deleted: number }>();
  return results.map((r) => ({
    upstreamId: r.upstreamId,
    layoutId: r.layoutId,
    upstreamName: r.upstreamName,
    name: r.name,
    modified_at: r.modified_at,
    like_count: r.like_count,
    deleted: r.deleted !== 0,
  }));
}

export interface TickStats {
  at: string;
  quiet: boolean;
  collapsed?: boolean;
  reason?: string;
  planned_fetch?: number;
  processed?: number;
  used_full?: boolean;
  applied?: number;
  errors?: { id: string; path: string; message: string }[];
  deletes_planned?: number;
  deletes_applied?: number;
  delete_stalled?: string | null;
  full_pass?: boolean;
  fully_applied?: boolean;
  // 20-spark.md S3b (LDB-P14): a system write's `expectRev` lost the race
  // to a concurrent user write -- caught per id, counted here, never
  // thrown out of `tick()`. The record itself is untouched (whatever the
  // user write left it at); the next tick re-evaluates it from scratch.
  raced?: number;
  // B5 (design/layout-db/review/audit-db.md B5): a non-conflict error from
  // one id's apply -- caught, recorded as an `import_error` info event
  // (`recordImportError`), counted here, never thrown out of `tick()`.
  errored?: number;
  // B4: this invocation found `import_state['cmini.running']` already
  // held (and not expired) and skipped the whole tick body rather than
  // race the holder.
  skipped_locked?: boolean;
}

export interface TickResult {
  quiet: boolean;
  stats: TickStats;
}

export async function tick(
  env: Bindings,
  now: Clock,
  fetchImpl: FetchImpl = fetch.bind(globalThis) as FetchImpl,
  sleepImpl?: SleepImpl,
): Promise<TickResult> {
  const db = env.DB;

  if ((await getState(db, "cmini.paused")) === "1") {
    return { quiet: true, stats: { at: now(), quiet: true } };
  }

  const client = new UpstreamClient(env.IMPORT_SOURCE_URL, env.IMPORT_UA, fetchImpl, sleepImpl);

  const metaToken = canonical(await client.meta());
  const storedToken = await getState(db, "cmini.meta_token");
  if (storedToken !== null && storedToken === metaToken) {
    return { quiet: true, stats: { at: now(), quiet: true } };
  }

  // B4: only the real (non-quiet) tick body needs the lock -- a quiet
  // "the token hasn't moved" return above touches no table.
  const lockValue = await tryAcquireRunningLock(db, now());
  if (lockValue === null) {
    console.log(`import tick: skipped_locked ('${LOCK_KEY}' already held)`);
    return { quiet: true, stats: { at: now(), quiet: true, skipped_locked: true } };
  }

  try {
    return await runTick(env, db, now, client, metaToken);
  } finally {
    await releaseRunningLock(db, lockValue);
  }
}

async function runTick(env: Bindings, db: Bindings["DB"], now: Clock, client: UpstreamClient, metaToken: string): Promise<TickResult> {
  const listEntries = await client.list();
  const local = await loadLocalMap(db);
  const lastFull = await getState(db, "cmini.last_full");
  const fullPassCursor = await getState(db, "cmini.full_pass_cursor");
  const plan = planTick({ list: listEntries, local, lastFull, fullPassCursor, now: now() });

  if (plan.kind === "collapsed") {
    const stats: TickStats = { at: now(), quiet: false, collapsed: true, reason: plan.reason };
    await setState(db, "cmini.stalled", canonical({ at: now(), reason: plan.reason }));
    await setState(db, "cmini.last_tick", canonical(stats));
    return { quiet: false, stats };
  }

  const maxWrites = Number(env.IMPORT_MAX_WRITES_PER_TICK) || 500;
  // Priority (new/changed/tombstoned) ids first, full-pass-only
  // re-verification last -- a write-capped tick must drain real backlog
  // before spending budget re-checking content that has no other reason to
  // be fetched (plan.ts's own comment explains why the split exists).
  const allPlanned = [...plan.fetch, ...plan.fetchFullPassOnly];
  const toProcess = allPlanned.slice(0, maxWrites);
  const fullyProcessedFetch = toProcess.length === allPlanned.length;

  // Resolve details: one ?full=1 batch when more than FULL_THRESHOLD ids
  // are to be fetched, per-id GETs otherwise; a ?full=1 miss (no
  // unambiguous name join) falls back to a per-id GET (07 §6 S5).
  const detailsById = new Map<string, RawUpstreamDetail | "notfound">();
  let usedFull = false;
  if (toProcess.length > FULL_THRESHOLD) {
    usedFull = true;
    const { byName, dupNames } = await client.full();
    const idToName = new Map(listEntries.map((e) => [e.id, e.name]));
    const leftovers: string[] = [];
    for (const id of toProcess) {
      const name = idToName.get(id);
      if (name === undefined || dupNames.has(name) || !byName.has(name)) {
        leftovers.push(id);
        continue;
      }
      detailsById.set(id, byName.get(name)!);
    }
    for (const id of leftovers) {
      const r = await client.detail(id);
      detailsById.set(id, r.ok ? r.detail : "notfound");
    }
  } else {
    for (const id of toProcess) {
      const r = await client.detail(id);
      detailsById.set(id, r.ok ? r.detail : "notfound");
    }
  }

  const errors: { id: string; path: string; message: string }[] = [];
  let applied = 0;
  let raced = 0;
  let errored = 0;
  for (const id of toProcess) {
    const raw = detailsById.get(id)!;
    try {
      const result = await applyFetchedId(db, now, id, raw);
      errors.push(...result.errors);
    } catch (e) {
      if (e instanceof RevConflictError) {
        // 20-spark.md S3b (LDB-P14, §8 R-H4): a user write landed between
        // this system write's read and its own write -- caught per id,
        // counted, never thrown out of the tick; the next tick
        // re-evaluates this id from a fresh read.
        raced++;
      } else {
        // B5: any OTHER error from this one id (a real bug, a D1 hiccup,
        // an unhandled `name_taken` outside apply.ts's own B2 handling)
        // must not strand every id queued behind it -- recorded, counted,
        // the loop continues.
        await recordImportError(db, now, id, e instanceof Error ? e.message : String(e));
        errored++;
      }
    }
    applied++;
  }

  let deletesApplied = 0;
  if (plan.deleteStalled === null) {
    for (const del of plan.delete) {
      try {
        await applyDeleteAction(db, now, del);
        deletesApplied++;
      } catch (e) {
        if (e instanceof RevConflictError) {
          raced++;
        } else {
          await recordImportError(db, now, del.upstreamId, e instanceof Error ? e.message : String(e));
          errored++;
        }
      }
    }
    await clearState(db, "cmini.stalled");
  } else {
    await setState(db, "cmini.stalled", canonical({ at: now(), reason: plan.deleteStalled.reason }));
  }

  const authors = await client.authors();
  await applyAuthors(db, now, authors);

  const fullyApplied = fullyProcessedFetch && plan.deleteStalled === null;

  // Sweep progress: decoupled from `fullyApplied` on purpose. A full pass
  // is "the re-verification of already-imported records", not "the whole
  // tick, including any unrelated new-id backlog" -- so it can (and, under
  // a small write cap with a growing corpus, must) finish across several
  // ticks that also do ordinary priority work, by advancing a cursor
  // instead of restarting from the top every time (plan.ts's own comment
  // on `fullPassCursor` explains why an un-cursored design never converges).
  const sweepProcessed = Math.max(0, toProcess.length - plan.fetch.length);
  if (plan.isFullPass) {
    if (sweepProcessed >= plan.fetchFullPassOnly.length) {
      await setState(db, "cmini.last_full", now());
      await clearState(db, "cmini.full_pass_cursor");
    } else if (sweepProcessed > 0) {
      await setState(db, "cmini.full_pass_cursor", plan.fetchFullPassOnly[sweepProcessed - 1]!);
    }
  } else {
    await clearState(db, "cmini.full_pass_cursor");
  }

  const stats: TickStats = {
    at: now(),
    quiet: false,
    planned_fetch: allPlanned.length,
    processed: toProcess.length,
    used_full: usedFull,
    applied,
    errors,
    deletes_planned: plan.delete.length,
    deletes_applied: deletesApplied,
    delete_stalled: plan.deleteStalled?.reason ?? null,
    full_pass: plan.isFullPass,
    fully_applied: fullyApplied,
    raced,
    errored,
  };
  await setState(db, "cmini.last_tick", canonical(stats));

  // The meta token is only stored once a tick has applied everything it
  // planned -- a write-capped tick recomputes the same plan next time
  // instead of skipping the remainder (07 §6 S5).
  if (fullyApplied) {
    await setState(db, "cmini.meta_token", metaToken);
  }

  return { quiet: false, stats };
}
