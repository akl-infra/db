// The shadow feed follower (LDB-PV5/PV6, PV7): one call per tick. It reads production's public feed from the cursor in
// `shadow_follower`, applies each event with the applier (apply.ts) as ONE unit that also moves the cursor, and, when
// production has published a dump this database has not been checked against, applies exactly up to that dump's seq and
// runs the checkpoint (checkpoint.ts) there.
import { canonical } from "../../core/canonical";
import type { LatestJson } from "../../dump/write";
import type { Dump } from "../../dump/write";
import type { BlobStore } from "../../platform/port";
import { raise } from "../alarm";
import { FollowerRefusal, KINDS, eventStatements, type FeedEvent, type StateTable } from "./apply";
import { recordUnresynced, runCheckpoint, type CheckResult } from "./checkpoint";
import { UpstreamError, payloadFetcher, type Upstream } from "./upstream";

export interface FollowerState {
  cursor: number;
  seededDumpKey: string;
  seededDumpSeq: number;
  seededAt: string;
  checkedDumpKey: string | null;
  checkedDumpSeq: number | null;
  checkedAt: string | null;
  checkResult: CheckResult | null;
  appliedTotal: number;
  stale: Partial<Record<StateTable, number>>;
}

export async function readFollowerState(db: D1Database): Promise<FollowerState | null> {
  const r = await db.prepare("SELECT * FROM shadow_follower WHERE id = 1").first<Record<string, unknown>>();
  if (r === null) return null;
  return {
    cursor: r.cursor as number,
    seededDumpKey: r.seeded_dump_key as string,
    seededDumpSeq: r.seeded_dump_seq as number,
    seededAt: r.seeded_at as string,
    checkedDumpKey: (r.checked_dump_key as string | null) ?? null,
    checkedDumpSeq: (r.checked_dump_seq as number | null) ?? null,
    checkedAt: (r.checked_at as string | null) ?? null,
    checkResult: r.check_result === null || r.check_result === undefined ? null : (JSON.parse(r.check_result as string) as CheckResult),
    appliedTotal: r.applied_total as number,
    stale: JSON.parse(r.stale_json as string) as Partial<Record<StateTable, number>>,
  };
}

export interface FollowerDeps {
  db: D1Database;
  up: Upstream;
  buildDump: () => Promise<Dump>;
  blobs: BlobStore;
  logLine: (line: string) => void;
  now: () => number;
  /** Stop applying new events after this many ms (the tick's budget). Default 20 s. */
  budgetMs?: number;
  /** Events per feed page. Default 200. */
  pageLimit?: number;
  /** A checkpoint is not started with less than this left of the budget. Default 8 s. */
  checkpointMs?: number;
}

export interface FollowReport {
  status: "ok" | "not-seeded" | "refused" | "failed";
  /** Events applied by this call. */
  applied: number;
  cursor: number;
  /** The newest seq the feed showed (the lag is `head - cursor`). */
  head: number | null;
  stoppedAt?: string;
  checkpoint?: CheckResult;
}

const dumpLatest = (v: unknown): LatestJson | null => {
  const l = v as Partial<LatestJson> | null;
  return l !== null && typeof l === "object" && typeof l.key === "string" && typeof l.url === "string" && typeof l.sha256 === "string" && typeof l.seq === "number" && typeof l.date === "string" ? (l as LatestJson) : null;
};

/** Apply one event and advance the cursor in the same unit. Returns the new stale counts. */
export async function applyEventUnit(deps: FollowerDeps, state: FollowerState, ev: FeedEvent): Promise<void> {
  if (ev.seq !== state.cursor + 1) throw new FollowerRefusal(ev.seq, ev.kind, `the feed skipped from ${state.cursor} to ${ev.seq}`);
  const payload = payloadFetcher(deps.up);
  const { stmts } = await eventStatements({ db: deps.db, payload }, ev);
  const stale = { ...state.stale };
  for (const t of KINDS[ev.kind]?.state ?? []) stale[t] = (stale[t] ?? 0) + 1;
  stmts.push(
    deps.db
      .prepare("UPDATE shadow_follower SET cursor = ?, applied_total = applied_total + 1, stale_json = ? WHERE id = 1 AND cursor = ?")
      .bind(ev.seq, canonical(stale), state.cursor),
  );
  const results = await deps.db.batch(stmts);
  if ((results[results.length - 1]?.meta.changes ?? 0) !== 1) throw new Error(`cursor update at seq ${ev.seq} changed no row (another follower moved it?)`);
  state.cursor = ev.seq;
  state.appliedTotal += 1;
  state.stale = stale;
}

/** One tick of following. Never throws for a problem it reports as an alarm line; the report says what stopped it. */
export async function followFeed(deps: FollowerDeps): Promise<FollowReport> {
  const started = deps.now();
  const budget = deps.budgetMs ?? 20_000;
  const page = deps.pageLimit ?? 200;
  const state = await readFollowerState(deps.db);
  if (state === null) {
    deps.logLine("akldb-follower: not seeded (run the seed job first)");
    return { status: "not-seeded", applied: 0, cursor: 0, head: null };
  }
  const report: FollowReport = { status: "ok", applied: 0, cursor: state.cursor, head: null };
  const fail = (what: string, e: unknown): FollowReport => {
    raise(deps.logLine, "shadow-follower", `${what}: ${e instanceof Error ? e.message : String(e)}`);
    return { ...report, status: e instanceof FollowerRefusal ? "refused" : "failed", cursor: state.cursor, stoppedAt: what };
  };

  // Is there a public dump this database has not been checked against? Then apply up to its seq and stop there.
  let latest: LatestJson | null = null;
  let latestText = "";
  try {
    const raw = await deps.up.bytes("/v1/dump/latest.json");
    latestText = raw.text();
    latest = dumpLatest(JSON.parse(latestText));
  } catch (e) {
    return fail("reading latest.json", e);
  }
  let cap: number | undefined;
  let checkpointDue = false;
  // a dump is named by its key AND seq: a second dump on the same UTC day (catch-up) reuses the dated key
  if (latest !== null && (latest.key !== state.checkedDumpKey || latest.seq !== state.checkedDumpSeq)) {
    if (latest.seq < state.cursor) {
      // this database is already past the dump: the exact comparison is gone for this dump
      const r: CheckResult = { result: "missed", dumpKey: latest.key, dumpSeq: latest.seq, reason: `this database was already at seq ${state.cursor}` };
      raise(deps.logLine, "shadow-follower", `checkpoint missed for ${latest.key}: ${r.reason}`);
      await recordUnresynced(deps.db, r, new Date(deps.now()).toISOString());
      report.checkpoint = r;
    } else {
      cap = latest.seq;
      checkpointDue = true;
    }
  }

  // follow the feed
  let stop = false;
  while (!stop) {
    if (cap !== undefined && state.cursor >= cap) break;
    if (deps.now() - started > budget) {
      report.stoppedAt = "budget";
      break;
    }
    let feed: { next: number; items: FeedEvent[] };
    try {
      feed = (await deps.up.json(`/v1/changes?since=${state.cursor}&limit=${page}`)) as { next: number; items: FeedEvent[] };
    } catch (e) {
      return { ...fail("reading the feed", e), applied: report.applied };
    }
    if (!Array.isArray(feed.items)) return { ...fail("reading the feed", new Error("no items array")), applied: report.applied };
    if (feed.items.length > 0) report.head = Math.max(report.head ?? 0, feed.items[feed.items.length - 1]!.seq);
    if (feed.items.length === 0) break;
    for (const ev of feed.items) {
      if (cap !== undefined && ev.seq > cap) {
        stop = true;
        break;
      }
      try {
        await applyEventUnit(deps, state, ev);
      } catch (e) {
        if (e instanceof FollowerRefusal || e instanceof UpstreamError) return { ...fail(`apply seq ${ev.seq}`, e), applied: report.applied };
        return { ...fail(`apply seq ${ev.seq} (${ev.kind})`, e), applied: report.applied };
      }
      report.applied += 1;
      if (deps.now() - started > budget) {
        stop = true;
        report.stoppedAt = "budget";
        break;
      }
    }
    report.cursor = state.cursor;
    if (feed.items.length < page && !stop) break;
  }
  report.cursor = state.cursor;

  // the checkpoint, when the database stands exactly at the dump's seq
  if (checkpointDue && latest !== null && state.cursor === latest.seq) {
    if (budget - (deps.now() - started) < (deps.checkpointMs ?? 8_000)) {
      report.stoppedAt ??= "budget (checkpoint deferred to the next tick)";
    } else {
      try {
        report.checkpoint = await runCheckpoint(
          { db: deps.db, up: deps.up, buildDump: deps.buildDump, blobs: deps.blobs, logLine: deps.logLine, now: deps.now },
          latest,
          latestText,
        );
        if (report.checkpoint.result === "inconclusive") await recordUnresynced(deps.db, report.checkpoint, new Date(deps.now()).toISOString());
      } catch (e) {
        return { ...fail("checkpoint", e), applied: report.applied, cursor: state.cursor };
      }
    }
  }
  if (report.checkpoint !== undefined) {
    // one structured line per check: the gate report (scripts/lab/shadow/gate.mjs) reads these back from CloudWatch Logs
    const c = report.checkpoint;
    const tables = c.comparison === undefined ? undefined : Object.fromEntries(Object.entries(c.comparison.tables).map(([k, t]) => [k, t.equal]));
    deps.logLine(`akldb-checkpoint: ${JSON.stringify({ result: c.result, dumpKey: c.dumpKey, dumpSeq: c.dumpSeq, ...(c.reason !== undefined ? { reason: c.reason } : {}), ...(c.comparison !== undefined ? { feedEqual: c.comparison.feedEqual, stateEqual: c.comparison.stateEqual, tables } : {}), ms: c.ms ?? null })}`);
  }
  deps.logLine(`akldb-follower: applied=${report.applied} cursor=${state.cursor} head=${report.head ?? "?"}${report.checkpoint !== undefined ? ` checkpoint=${report.checkpoint.result}` : ""}`);
  return report;
}
