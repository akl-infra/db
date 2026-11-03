// The nightly checkpoint (LDB-PV4): when production publishes a new public dump at seq D and this database has applied
// exactly up to D, compare the two table by table, then replace the STATE tables from that dump (the only way they can be
// brought to production's state, apply.ts) and mirror the dump into this stage's own `dumps/` so `/v1/dump/latest.json` on
// shadow names the seq the state tables were last synchronized at (the replay differ reads it).
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { canonical } from "../../core/canonical";
import type { Dump, LatestJson } from "../../dump/write";
import type { BlobStore } from "../../platform/port";
import { restoreSql } from "../../store/d1/dump";
import { raise } from "../alarm";
import { STATE_TABLES } from "./apply";
import { compareDumps, differingTables, dumpEventSeq, type DumpComparison } from "./checksum";
import type { Upstream } from "./upstream";

export type CheckOutcome = "equal" | "differs" | "inconclusive" | "missed";

export interface CheckResult {
  result: CheckOutcome;
  dumpKey: string;
  dumpSeq: number;
  /** Why the check could not decide (inconclusive/missed). */
  reason?: string;
  /** The comparison when one was made. `stateEqual` is read BEFORE the resync. */
  comparison?: Pick<DumpComparison, "feedEqual" | "stateEqual" | "tables" | "meta">;
  ms?: number;
}

export interface CheckpointDeps {
  db: D1Database;
  up: Upstream;
  /** The database's own dump (src/dump/write.ts buildDump over this database). */
  buildDump: () => Promise<Dump>;
  /** This stage's `dumps/` store. */
  blobs: BlobStore;
  logLine: (line: string) => void;
  now: () => number;
}

const STATE = new Set<string>([...STATE_TABLES, "authors_head"]);

/** The statements of `restoreSql(dump)` that touch only the STATE tables (and `authors_head`, which follows `authors`), in order. */
export function stateRestoreSql(dump: Dump): string[] {
  return restoreSql(dump).filter((s) => {
    const m = /^(?:DELETE FROM|INSERT INTO) (\w+)/.exec(s);
    return m !== null && STATE.has(m[1]!);
  });
}

export async function loadPublicDump(up: Upstream, latest: LatestJson): Promise<{ dump: Dump; gz: Uint8Array } | { problem: string }> {
  const got = await up.bytes(latest.url);
  const sha = createHash("sha256").update(got.bytes).digest("hex");
  if (sha !== latest.sha256) return { problem: `the dump ${latest.key} has sha256 ${sha.slice(0, 12)}..., latest.json says ${latest.sha256.slice(0, 12)}...` };
  let dump: Dump;
  try {
    dump = JSON.parse(new TextDecoder().decode(gunzipSync(got.bytes))) as Dump;
  } catch (e) {
    return { problem: `the dump ${latest.key} does not decompress to JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (dump.version !== 1 || typeof dump.meta?.seq !== "number") return { problem: `the dump ${latest.key} is not a version-1 dump` };
  return { dump, gz: got.bytes };
}

/**
 * Run the checkpoint for `latest` (whose seq the database has applied to exactly). Never throws for a data problem: it
 * returns `inconclusive`. Throws for an infrastructure failure (the caller alarms and retries next tick); in that case nothing
 * has been recorded, so the whole checkpoint repeats.
 */
export async function runCheckpoint(deps: CheckpointDeps, latest: LatestJson, latestText: string): Promise<CheckResult> {
  const started = deps.now();
  const base = { dumpKey: latest.key, dumpSeq: latest.seq };
  const loaded = await loadPublicDump(deps.up, latest);
  if ("problem" in loaded) {
    raise(deps.logLine, "shadow-follower", `checkpoint: ${loaded.problem}`);
    return { ...base, result: "inconclusive", reason: loaded.problem, ms: deps.now() - started };
  }
  const { dump: pub, gz } = loaded;
  const eventSeq = dumpEventSeq(pub);
  if (pub.meta.seq !== latest.seq || eventSeq !== pub.meta.seq) {
    // read in pages at different instants (src/dump/write.ts): the tables may hold writes past meta.seq
    const reason = `the public dump is skewed (latest.json seq ${latest.seq}, meta.seq ${pub.meta.seq}, newest event ${eventSeq})`;
    return { ...base, result: "inconclusive", reason, ms: deps.now() - started };
  }
  const mine = await deps.buildDump();
  if (mine.meta.seq !== pub.meta.seq) {
    const reason = `this database is at seq ${mine.meta.seq}, the dump at ${pub.meta.seq}`;
    raise(deps.logLine, "shadow-follower", `checkpoint: ${reason}`);
    return { ...base, result: "inconclusive", reason, ms: deps.now() - started };
  }
  const cmp = compareDumps(mine, pub);
  const comparison = { feedEqual: cmp.feedEqual, stateEqual: cmp.stateEqual, tables: cmp.tables, meta: cmp.meta };
  const result: CheckResult = { ...base, result: cmp.feedEqual ? "equal" : "differs", comparison };
  if (!cmp.feedEqual) raise(deps.logLine, "shadow-follower", `checksum mismatch at seq ${pub.meta.seq} against ${latest.key}: ${differingTables(cmp).filter((t) => !t.endsWith("(state)")).join(", ")}`);

  // mirror the dump (idempotent), then replace the state tables and record the check in the last unit
  await deps.blobs.put(latest.key, gz, "application/gzip");
  if (latest.date.slice(8, 10) === "01") await deps.blobs.put(`monthly/dump-${latest.date.slice(0, 7)}.json.gz`, gz, "application/gzip");
  await deps.blobs.put("latest.json", latestText, "application/json");

  const stmts = stateRestoreSql(pub);
  const finish = (r: CheckResult): D1PreparedStatement =>
    deps.db
      .prepare("UPDATE shadow_follower SET checked_dump_key = ?, checked_dump_seq = ?, checked_at = ?, check_result = ?, stale_json = '{}' WHERE id = 1")
      .bind(latest.key, latest.seq, new Date(deps.now()).toISOString(), canonical(r));
  const CHUNK = 100;
  for (let i = 0; i < stmts.length; i += CHUNK) {
    const chunk = stmts.slice(i, i + CHUNK).map((s) => deps.db.prepare(s));
    result.ms = deps.now() - started;
    if (i + CHUNK >= stmts.length) chunk.push(finish(result));
    await deps.db.batch(chunk);
  }
  if (stmts.length === 0) await deps.db.batch([finish(result)]);
  result.ms = deps.now() - started;
  return result;
}

/** Record a check that decided nothing (inconclusive or missed) without touching any table. */
export async function recordUnresynced(db: D1Database, r: CheckResult, nowIso: string): Promise<void> {
  await db
    .prepare("UPDATE shadow_follower SET checked_dump_key = ?, checked_dump_seq = ?, checked_at = ?, check_result = ? WHERE id = 1")
    .bind(r.dumpKey, r.dumpSeq, nowIso, canonical(r))
    .run();
}
