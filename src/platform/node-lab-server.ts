// The Node lab server (design A, phase A): src/index.ts over the D1 shim, a
// replica and a commit log (in memory, or on DynamoDB Local), behind a plain
// HTTP server, for the differential fuzzer (scripts/lab/fuzz, `--mode shim`).
// scripts/lab/serve-shim.mjs bundles and runs it. It applies the same
// determinism overrides as scripts/lab/fuzz/d1-lab-entry.ts (the D1 oracle),
// keyed on `x-lab-now` / `x-lab-seed`, so a request sent to the oracle and to
// this server mints the same ULIDs, nonces and timestamps. No edge cache, as in
// the oracle. Loopback only.
//
// Besides the app it serves `/__lab/*` control routes (never part of the app):
//   GET  /__lab/health   {ok, log}
//   POST /__lab/reset    body {statements, snapshots?}: a brand-new log and replica, then the oracle's reset script as one unit
//   POST /__lab/restart  body {mode?, fresh?, variant?}: a cold container: a new replica over the same log, built by the real
//                        bootReplica (src/replica/boot.ts). mode "replay" (default): no snapshot, replay from seq 0.
//                        "pointer": the snapshot writer's rolling slot + POINTER (a fresh snapshot, or with fresh:false the one
//                        already there, so the tail is replayed), boot from POINTER. "prev": POINTER's object is damaged for the
//                        boot, so boot takes PREV. "daily": a daily snapshot is written through the daily path, POINTER's and
//                        PREV's objects are damaged for the boot, so boot takes the newest verified daily. `variant` (0..15)
//                        picks how each object is damaged. The damage is undone after the boot. Needs /__lab/reset with
//                        {snapshots: true} (the world then holds a seq-0 and a post-reset snapshot, so PREV always exists).
//                        The answer says which path the boot actually took, the alarm lines it raised and whether the state
//                        (image digest and seq) is the same before and after; `match` is false (and stats count it) if not.
//   GET  /__lab/export   every table's rows (the oracle's `readSqliteState` shape)
//   GET  /__lab/check    the replica equals a fresh replica replaying the log; the log is gap-free
//   GET  /__lab/stats    injected-fault counts, replica stats, restarts by requested mode and by boot path actually taken
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { parse as parseToml } from "smol-toml";
import { ulid as ulidx } from "ulidx";
import type { Bindings } from "../env";
import worker from "../index";
import { bootReplica, bootReportOf, type BootPath } from "../replica/boot";
import { ALARM_PREFIX } from "../replica/alarm";
import { createDdbLog, createDdbSnapshotState, createLogTable, dropLogTable } from "../replica/log-ddb";
import { withLogFaults } from "../replica/log-faults";
import { MemoryLog } from "../replica/log-memory";
import type { CommitLog } from "../replica/log";
import { MemoryObjects, type StoredObject } from "../replica/objects";
import { Replica, imageDigest } from "../replica/replica";
import { MemorySnapshotState, dailySlot, dayOf, writeSnapshot, type SnapshotDeps, type SnapshotState } from "../replica/snapshot";
import { createShimD1 } from "../store/shim/d1";
import { createNodePlatform, loopbackOnlyFetch, memoryBlobs, r2Binding } from "./node";

export interface LabServerOptions {
  port: number;
  repoRoot: string;
  /** Extra [vars] (DISCORD_API_URL, STREAM_*). */
  vars?: Record<string, string>;
  /** Total rate of injected log faults (conflict, throttle, timeout before, timeout after, evenly). */
  faultRate?: number;
  faultSeed?: number;
  /** "memory" or DynamoDB Local (one fresh table per reset). */
  log?: "memory" | { ddb: string; tablePrefix: string };
}

// ---------------------------------------------------------------------------
// Determinism, as d1-lab-entry.ts does it on workerd
// ---------------------------------------------------------------------------

const RealDate = Date;
let frozenMs = RealDate.parse("2026-10-25T12:00:00.000Z");
let prngState = 1;

function nextRandom(): number {
  prngState = (prngState + 0x6d2b79f5) | 0;
  let t = Math.imul(prngState ^ (prngState >>> 15), 1 | prngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return (t ^ (t >>> 14)) >>> 0;
}

function fillRandom<T extends ArrayBufferView>(arr: T): T {
  const u8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  for (let i = 0; i < u8.length; i++) u8[i] = nextRandom() & 0xff;
  return arr;
}

let installed = false;
function installLabOverrides(): void {
  if (installed) return;
  installed = true;
  class LabDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(frozenMs);
      else super(...(args as [number]));
    }
    static override now(): number {
      return frozenMs;
    }
  }
  (globalThis as { Date: DateConstructor }).Date = LabDate as unknown as DateConstructor;
  const webcrypto = (globalThis as unknown as { crypto: Crypto }).crypto;
  Object.defineProperty(webcrypto, "getRandomValues", { configurable: true, writable: true, value: <T extends ArrayBufferView>(a: T): T => fillRandom(a) });
  Object.defineProperty(webcrypto, "randomUUID", {
    configurable: true,
    writable: true,
    value: () => {
      const b = new Uint8Array(16);
      fillRandom(b);
      b[6] = (b[6]! & 0x0f) | 0x40;
      b[8] = (b[8]! & 0x3f) | 0x80;
      const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    },
  });
}

function arm(headers: Headers): void {
  const n = headers.get("x-lab-now");
  if (n !== null) frozenMs = RealDate.parse(n);
  const s = headers.get("x-lab-seed");
  if (s !== null) prngState = Number(s) >>> 0;
}

/** The replica's unit ids must not draw from the seeded stream the app's ULIDs come from. */
const replicaUlid = (): string => ulidx(RealDate.now(), () => randomBytes(1)[0]! / 256);

// ---------------------------------------------------------------------------

export const RESTART_MODES = ["pointer", "prev", "daily", "replay"] as const;
export type RestartMode = (typeof RESTART_MODES)[number];
/** The alarm lines a boot raises: one per snapshot that was unusable (boot.ts raises one per fallback taken). */
const EXPECTED_ALARMS: Record<RestartMode, number> = { pointer: 0, prev: 1, daily: 2, replay: 0 };
const DAMAGE = ["flip", "truncate", "missing", "meta"] as const;
type Damage = (typeof DAMAGE)[number];
/** The lab's zstd level for snapshots (the production default, 12, only costs the fuzzer time). */
const LAB_ZSTD = 3;

/** Damage one object in the store the way S3 never should; returns the undo. */
function damageObject(objects: MemoryObjects, key: string, kind: Damage): () => void {
  const orig = objects.objects.get(key);
  if (orig === undefined) throw new Error(`lab restart: no object ${key} to damage`);
  const bad: StoredObject = { bytes: Uint8Array.from(orig.bytes), meta: { ...orig.meta } };
  if (kind === "flip") bad.bytes[bad.bytes.length >> 1]! ^= 0xff;
  else if (kind === "truncate") bad.bytes = bad.bytes.slice(0, bad.bytes.length >> 1);
  else if (kind === "meta") bad.meta.sha256 = "0".repeat(64);
  if (kind === "missing") objects.objects.delete(key);
  else objects.objects.set(key, bad);
  return () => void objects.objects.set(key, orig);
}

const NON_TABLES = /^(sqlite_|_cf_|d1_migrations$|mirror_queue$)/;
const DDB_CREDS = { accessKeyId: "local", secretAccessKey: "local" };

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export async function startLabServer(opts: LabServerOptions): Promise<{ url: string; close(): Promise<void>; /** The current world's database (tests write through it). */ db(): D1Database }> {
  installLabOverrides();
  const wrangler = parseToml(fs.readFileSync(path.join(opts.repoRoot, "wrangler.toml"), "utf8")) as { vars?: Record<string, string> };
  const rate = opts.faultRate ?? 0;
  const faults = { conflict: rate / 4, throttle: rate / 4, timeoutBefore: rate / 4, timeoutAfter: rate / 4, seed: opts.faultSeed ?? 1 };
  const logKind = opts.log ?? "memory";

  let worldNo = 0;
  let log!: CommitLog;
  /** The log without injected faults: the control routes read it directly (a check must not be a fault target). */
  let cleanLog!: CommitLog;
  let faulty: ReturnType<typeof withLogFaults> | undefined;
  let replica!: Replica;
  let db!: D1Database;
  const blobs = memoryBlobs();
  let table: string | undefined;
  /** Phase B: the snapshot objects and state of the current world (the pointer, PREV and daily index live in the log table on DynamoDB). */
  let objects = new MemoryObjects();
  let snapState!: SnapshotState;
  let snapshotsOn = false;
  const restarts = { requested: { pointer: 0, prev: 0, daily: 0, replay: 0 }, path: { pointer: 0, prev: 0, daily: 0, replay: 0 }, mismatches: 0, bootAttempts: 0, last: null as unknown };
  const snapDeps = (): SnapshotDeps => ({ objects, state: snapState, logLine: () => {}, now: () => frozenMs, zstdLevel: LAB_ZSTD });

  /** A brand-new log (a new DynamoDB table when on DynamoDB Local) and a replica on it. */
  async function newWorld(): Promise<void> {
    let inner: CommitLog;
    if (logKind === "memory") inner = new MemoryLog();
    else {
      if (table !== undefined) await dropLogTable({ endpoint: logKind.ddb, table, credentials: DDB_CREDS }).catch(() => {});
      table = `${logKind.tablePrefix}-${RealDate.now()}-${worldNo}`; // the real clock: the lab Date is frozen
      await createLogTable({ endpoint: logKind.ddb, table, credentials: DDB_CREDS });
      inner = createDdbLog({ table, endpoint: logKind.ddb, region: "us-east-2", credentials: DDB_CREDS });
    }
    worldNo++;
    objects = new MemoryObjects();
    snapshotsOn = false;
    snapState = logKind === "memory" ? new MemorySnapshotState() : createDdbSnapshotState({ table: table!, endpoint: logKind.ddb, region: "us-east-2", credentials: DDB_CREDS });
    cleanLog = inner;
    faulty = rate > 0 ? withLogFaults(inner, faults) : undefined;
    log = faulty ?? inner;
    replica?.close();
    replica = new Replica(log, { ulid: replicaUlid, backoffMs: 1 });
    db = createShimD1(replica);
    blobs.objects instanceof Map && blobs.objects.clear();
  }
  await newWorld();

  const cache = { match: async () => undefined, put: async () => {} }; // the oracle has no edge cache
  const platform = createNodePlatform({
    d1: () => createShimD1(replica, { requestScoped: true }),
    blobs,
    cache,
    fetch: loopbackOnlyFetch,
    ulid: () => ulidx(),
  });
  // env.DB / env.DUMPS stay valid across resets: they delegate to the current world.
  const dbProxy = new Proxy({} as D1Database, {
    get: (_t, p) => {
      const v = (db as unknown as Record<string | symbol, unknown>)[p];
      return typeof v === "function" ? v.bind(db) : v;
    },
  });
  const env = { ...wrangler.vars, ...opts.vars, DB: dbProxy, DUMPS: r2Binding(blobs), PLATFORM: platform } as unknown as Bindings;

  const json = (res: http.ServerResponse, status: number, body: unknown): void => {
    const s = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
    res.end(s);
  };

  /**
   * A cold container, through the real boot path. Every mode builds the new replica with bootReplica over the same log and
   * object store; "prev" and "daily" first damage the snapshot objects the earlier paths would have used (and undo the damage
   * after the boot), so the fallbacks they take are the production ones. Boot runs on the faulty log, like the handler's
   * boot does, and is retried on a thrown failure (the Lambda handler retries once); only the last attempt's lines count.
   */
  async function restart(mode: RestartMode, fresh: boolean, variant: number) {
    await replica.catchUp();
    const before = { seq: replica.seq, digest: imageDigest(replica.serialize()) };
    const undo: (() => void)[] = [];
    const lines: string[] = [];
    let booted: Replica | undefined;
    let attempts = 0;
    try {
      if (mode !== "replay") {
        const deps = snapDeps();
        if (mode !== "pointer" || fresh) await writeSnapshot(replica, deps);
        if (mode === "daily") await writeSnapshot(replica, deps, { type: "daily", slot: dailySlot(frozenMs), day: dayOf(frozenMs) });
        const pointer = await snapState.pointer();
        const prev = await snapState.previous();
        if (pointer === null) throw new Error("lab restart: no POINTER after the snapshot");
        if (mode === "prev" || mode === "daily") undo.push(damageObject(objects, pointer.key, DAMAGE[variant & 3]!));
        if (mode === "daily") {
          if (prev === null) throw new Error("lab restart: no PREV to damage");
          undo.push(damageObject(objects, prev.key, DAMAGE[(variant >> 2) & 3]!));
        }
      }
      let lastError: unknown;
      for (; attempts < 8 && booted === undefined; ) {
        attempts++;
        lines.length = 0;
        try {
          booted = await bootReplica(log, { ulid: replicaUlid, backoffMs: 1, logLine: (l) => void lines.push(l), ...(mode === "replay" ? {} : { snapshots: { state: snapState, objects } }) });
        } catch (e) {
          lastError = e;
        }
      }
      if (booted === undefined) throw new Error(`lab restart: boot failed ${attempts} times: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    } finally {
      for (const u of undo.reverse()) u();
    }
    const old = replica;
    replica = booted;
    db = createShimD1(replica);
    old.close();
    const report = bootReportOf(replica)!;
    const alarms = lines.filter((l) => l.startsWith(ALARM_PREFIX));
    const after = { seq: replica.seq, digest: imageDigest(replica.serialize()) };
    const problems: string[] = [];
    if (report.path !== mode) problems.push(`requested ${mode}, boot took ${report.path}`);
    if (alarms.length !== EXPECTED_ALARMS[mode]) problems.push(`${alarms.length} alarm lines, expected ${EXPECTED_ALARMS[mode]}: ${JSON.stringify(alarms)}`);
    if (after.seq !== before.seq) problems.push(`seq ${before.seq} before, ${after.seq} after`);
    if (after.digest !== before.digest) problems.push("the database image differs before and after the restart");
    restarts.requested[mode]++;
    restarts.path[report.path as BootPath]++;
    restarts.bootAttempts += attempts;
    if (problems.length > 0) restarts.mismatches++;
    const answer = { ok: true, match: problems.length === 0, problems, requested: mode, path: report.path, snapshot: report.snapshot?.key ?? null, snapshotSeq: report.snapshot?.seq ?? null, seq: after.seq, fallbacks: report.fallbacks, alarms, attempts };
    restarts.last = answer;
    return answer;
  }

  const labRoute = async (req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> => {
    switch (`${req.method} ${pathname}`) {
      case "GET /__lab/health":
        return json(res, 200, { ok: true, log: logKind === "memory" ? "memory" : logKind.ddb, faultRate: rate });
      case "POST /__lab/reset": {
        const { statements, snapshots } = JSON.parse((await readBody(req)).toString("utf8")) as { statements: string[]; snapshots?: boolean };
        await newWorld();
        if (snapshots === true) {
          // A snapshot of the empty database (seq 0), then one after the reset script: POINTER and PREV both exist from the start.
          await writeSnapshot(replica, snapDeps());
          snapshotsOn = true;
        }
        await db.batch(statements.map((s) => db.prepare(s)));
        if (snapshotsOn) await writeSnapshot(replica, snapDeps());
        return json(res, 200, { ok: true });
      }
      case "POST /__lab/restart": {
        const raw = (await readBody(req)).toString("utf8");
        const body = (raw === "" ? {} : JSON.parse(raw)) as { mode?: RestartMode; fresh?: boolean; variant?: number };
        const mode = body.mode ?? "replay";
        if (!RESTART_MODES.includes(mode)) return json(res, 400, { error: `unknown restart mode '${mode}'` });
        if (mode !== "replay" && !snapshotsOn) return json(res, 409, { error: "this world has no snapshots: reset with {snapshots: true}" });
        return json(res, 200, await restart(mode, body.fresh !== false, body.variant ?? 0));
      }
      case "GET /__lab/export": {
        await replica.catchUp();
        const out: Record<string, unknown[]> = {};
        const tables = (replica.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name).filter((n) => !NON_TABLES.test(n));
        for (const t of tables) out[t] = (replica.db.prepare(`SELECT * FROM "${t}"`).all() as Record<string, unknown>[]).map((r) => ({ ...r }));
        return json(res, 200, out);
      }
      case "GET /__lab/check": {
        const problems: string[] = [];
        await replica.catchUp();
        const head = await cleanLog.head();
        if (replica.seq !== head) problems.push(`replica at ${replica.seq}, log head ${head}`);
        const entries = await cleanLog.read(0, head);
        if (entries.some((e, i) => e.seq !== i + 1)) problems.push("the log has a gap or is out of order");
        const fresh = new Replica(cleanLog, { ulid: replicaUlid, backoffMs: 1 });
        try {
          await fresh.catchUp();
          // imageDigest, as the nightly proof (RP4): a replica booted from a snapshot is a deserialized database, whose per-connection header counters differ from a replayed one's
          if (imageDigest(fresh.serialize()) !== imageDigest(replica.serialize())) problems.push("the replica differs from a fresh replay of the log");
        } catch (e) {
          problems.push(`a fresh replay failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          fresh.close();
        }
        return json(res, 200, { ok: problems.length === 0, problems });
      }
      case "GET /__lab/stats":
        return json(res, 200, { injected: faulty?.injected ?? null, replica: replica.stats, seq: replica.seq, restarts });
      default:
        return json(res, 404, { error: `no lab route ${req.method} ${pathname}` });
    }
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${opts.port}`);
        if (url.pathname.startsWith("/__lab/")) return await labRoute(req, res, url.pathname);
        const headers = new Headers();
        for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
        const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
        arm(headers);
        const tasks: Promise<unknown>[] = [];
        const ctx = { waitUntil: (p: Promise<unknown>) => void tasks.push(p), passThroughOnException() {} };
        const response = await worker.fetch(new Request(url, { method: req.method, headers, body }), env, ctx as unknown as ExecutionContext);
        const bytes = Buffer.from(await response.arrayBuffer());
        while (tasks.length > 0) await Promise.allSettled(tasks.splice(0));
        await platform.drain();
        const out: [string, string][] = [];
        response.headers.forEach((v, k) => {
          if (k !== "set-cookie" && k !== "content-length") out.push([k, v]);
        });
        for (const c of response.headers.getSetCookie()) out.push(["set-cookie", c]);
        if (response.status !== 204 && response.status !== 304) out.push(["content-length", String(bytes.length)]);
        res.writeHead(response.status, out.flat());
        res.end(req.method === "HEAD" ? undefined : bytes);
      } catch (e) {
        console.error("lab server error:", e);
        if (!res.headersSent) json(res, 500, { error: "lab server error", message: e instanceof Error ? e.message : String(e) });
        else res.destroy();
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => resolve());
  });
  return {
    url: `http://127.0.0.1:${opts.port}`,
    db: () => db,
    close: async () => {
      if (table !== undefined && logKind !== "memory") await dropLogTable({ endpoint: logKind.ddb, table, credentials: DDB_CREDS }).catch(() => {});
      await new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve())));
    },
  };
}
