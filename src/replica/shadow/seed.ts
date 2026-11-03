// The shadow seed job (LDB-PV2): `{"akldb":"seed","dumpUrl":"https://api.akldb.org/v1/dump/latest.json"[,"reset":true]}`.
// Loads the latest PUBLIC dump into an empty shadow database through the normal commit log (the restore's batches of up to
// 100 statements are log units; the large ones spill to S3, RP7), then writes the follower row in the last unit.
//
// What it seeds: every table the public dump covers, as the dump has them (restoreSql). What it does NOT: the private
// tables (auth_cache, ratelimit, nonces, idempotency, discord_*, modqueue_notifications, moderation_review_history,
// discord_users, ...) stay empty, and nothing synthetic is added: the replay is GETs on public routes, which read none of them.
//
// Idempotent: a database that already holds events or layouts, or a follower row, is refused. `reset: true` restores over it
// anyway (the restore deletes every dumped table first and the follower row is rewritten), which is the way out of a seed that
// stopped half way; it keeps the log's history, so a database that must also forget its history is a deleted and recreated stack.
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { canonical } from "../../core/canonical";
import type { Dump, LatestJson } from "../../dump/write";
import type { BlobStore } from "../../platform/port";
import { createD1Store } from "../../store/d1";
import { dumpEventSeq } from "./checksum";
import { UPSTREAM_BASE, UpstreamError, type Upstream } from "./upstream";

export interface SeedRequest {
  dumpUrl?: string;
  reset?: boolean;
}

export class SeedRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedRefused";
  }
}

export interface SeedDeps {
  db: D1Database;
  up: Upstream;
  blobs: BlobStore;
  now: () => number;
  logLine: (line: string) => void;
}

export interface SeedReport {
  ok: true;
  dumpKey: string;
  seq: number;
  layouts: number;
  events: number;
  /** The newest event in the dump is past `meta.seq` (a skewed dump read in pages while a write landed): the cursor starts at that event, and the first checkpoint tells whether the tables agree. Seed again from a later dump if they do not. */
  skewed: boolean;
  reset: boolean;
}

/** Where `dumpUrl` points: `${UPSTREAM_BASE}/v1/dump/latest.json` (or /v1/dump) only. Anything else is refused before a byte is fetched. */
export function latestPathOf(dumpUrl: string | undefined, base: string = UPSTREAM_BASE): string {
  const url = dumpUrl ?? `${base}/v1/dump/latest.json`;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new SeedRefused(`dumpUrl '${url}' is not a URL`);
  }
  if (u.origin !== base || (u.pathname !== "/v1/dump/latest.json" && u.pathname !== "/v1/dump") || u.search !== "") {
    throw new SeedRefused(`dumpUrl must be ${base}/v1/dump/latest.json (got ${u.origin}${u.pathname}${u.search})`);
  }
  return u.pathname;
}

async function isEmpty(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare("SELECT (SELECT COUNT(*) FROM events) AS e, (SELECT COUNT(*) FROM layouts) AS l, (SELECT COUNT(*) FROM shadow_follower) AS f")
    .first<{ e: number; l: number; f: number }>();
  return row !== null && row.e === 0 && row.l === 0 && row.f === 0;
}

export async function seedShadow(deps: SeedDeps, req: SeedRequest): Promise<SeedReport> {
  const latestPath = latestPathOf(req.dumpUrl, deps.up.base);
  const reset = req.reset === true;
  if (!reset && !(await isEmpty(deps.db))) {
    throw new SeedRefused("the shadow database is not empty (it holds events, layouts or a follower row); pass reset:true to restore over it, or delete and recreate the stack for a fresh log");
  }

  const latestRaw = await deps.up.bytes(latestPath);
  const latest = JSON.parse(latestRaw.text()) as LatestJson;
  if (typeof latest.url !== "string" || !latest.url.startsWith("/v1/dump/") || typeof latest.sha256 !== "string" || typeof latest.seq !== "number") throw new SeedRefused("latest.json does not describe a dump");
  const got = await deps.up.bytes(latest.url);
  const sha = createHash("sha256").update(got.bytes).digest("hex");
  if (sha !== latest.sha256) throw new SeedRefused(`the dump ${latest.key} has sha256 ${sha.slice(0, 12)}..., latest.json says ${latest.sha256.slice(0, 12)}...`);
  const dump = JSON.parse(new TextDecoder().decode(gunzipSync(got.bytes))) as Dump;
  if (dump.version !== 1 || dump.meta.seq !== latest.seq) throw new SeedRefused(`the dump ${latest.key} is not a version-1 dump at seq ${latest.seq}`);
  const newest = dumpEventSeq(dump);

  // restore through the normal log: DELETE every dumped table, INSERT the dump's rows, chunks of 100 statements
  await createD1Store(deps.db).dump.restore(dump);
  const nowIso = new Date(deps.now()).toISOString();
  await deps.db.batch([
    deps.db.prepare("DELETE FROM shadow_follower"),
    deps.db
      .prepare(
        "INSERT INTO shadow_follower (id, cursor, seeded_dump_key, seeded_dump_seq, seeded_at, checked_dump_key, checked_dump_seq, checked_at, check_result) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(Math.max(newest, dump.meta.seq), latest.key, latest.seq, nowIso, latest.key, latest.seq, nowIso, canonical({ result: "equal", dumpKey: latest.key, dumpSeq: latest.seq, reason: "seeded from this dump" })),
  ]);
  // so that shadow's own /v1/dump/latest.json names the dump its state tables came from
  await deps.blobs.put(latest.key, got.bytes, "application/gzip");
  await deps.blobs.put("latest.json", latestRaw.text(), "application/json");

  const report: SeedReport = { ok: true, dumpKey: latest.key, seq: latest.seq, layouts: dump.records.length, events: dump.events.length, skewed: newest !== dump.meta.seq, reset };
  deps.logLine(`akldb-seed: dump=${latest.key} seq=${latest.seq} layouts=${report.layouts} events=${report.events} skewed=${report.skewed} reset=${reset}`);
  return report;
}

export { UpstreamError };
