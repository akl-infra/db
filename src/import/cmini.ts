// tick() (07 §6 S5): meta gate -> plan -> fetch -> apply -> authors ->
// state. A thrown error anywhere in here leaves `cmini.meta_token`
// unchanged, so the next cron invocation reruns the whole tick.
import type { Bindings } from "../env";
import { canonical } from "../core/canonical";
import { RevConflictError } from "../core/events";
import type { Clock } from "../core/time";
import { applyAuthors, applyDeleteAction, applyFetchedId } from "./apply";
import { planTick, type LocalMapRow } from "./plan";
import { UpstreamClient, type FetchImpl, type RawUpstreamDetail, type SleepImpl } from "./upstream";

const FULL_THRESHOLD = 50; // 07 §6 S5: ?full=1 when more than this many ids need fetching

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
      `SELECT m.upstream_id AS upstreamId, m.layout_id AS layoutId, l.name AS name,
              l.modified_at AS modified_at, l.like_count AS like_count, l.deleted AS deleted
       FROM import_map m JOIN layouts l ON l.id = m.layout_id`,
    )
    .all<{ upstreamId: string; layoutId: string; name: string; modified_at: string; like_count: number; deleted: number }>();
  return results.map((r) => ({
    upstreamId: r.upstreamId,
    layoutId: r.layoutId,
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
  for (const id of toProcess) {
    const raw = detailsById.get(id)!;
    try {
      const result = await applyFetchedId(db, now, id, raw);
      errors.push(...result.errors);
    } catch (e) {
      // 20-spark.md S3b (LDB-P14, §8 R-H4): a user write landed between this
      // system write's read and its own write -- caught per id, counted,
      // never thrown out of the tick; the next tick re-evaluates this id
      // from a fresh read.
      if (!(e instanceof RevConflictError)) throw e;
      raced++;
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
        if (!(e instanceof RevConflictError)) throw e;
        raced++;
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
