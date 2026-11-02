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
//   POST /__lab/reset    body {statements}: a brand-new log and replica, then the oracle's reset script as one unit
//   POST /__lab/restart  a cold container: a new replica over the same log, replaying it from 0
//   GET  /__lab/export   every table's rows (the oracle's `readSqliteState` shape)
//   GET  /__lab/check    the replica equals a fresh replica replaying the log; the log is gap-free
//   GET  /__lab/stats    injected-fault counts and replica stats
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { parse as parseToml } from "smol-toml";
import { ulid as ulidx } from "ulidx";
import type { Bindings } from "../env";
import worker from "../index";
import { createDdbLog, createLogTable, dropLogTable } from "../replica/log-ddb";
import { withLogFaults } from "../replica/log-faults";
import { MemoryLog } from "../replica/log-memory";
import type { CommitLog } from "../replica/log";
import { Replica } from "../replica/replica";
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

const NON_TABLES = /^(sqlite_|_cf_|d1_migrations$|mirror_queue$)/;
const DDB_CREDS = { accessKeyId: "local", secretAccessKey: "local" };

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export async function startLabServer(opts: LabServerOptions): Promise<{ url: string; close(): Promise<void> }> {
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

  const labRoute = async (req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> => {
    switch (`${req.method} ${pathname}`) {
      case "GET /__lab/health":
        return json(res, 200, { ok: true, log: logKind === "memory" ? "memory" : logKind.ddb, faultRate: rate });
      case "POST /__lab/reset": {
        const { statements } = JSON.parse((await readBody(req)).toString("utf8")) as { statements: string[] };
        await newWorld();
        await db.batch(statements.map((s) => db.prepare(s)));
        return json(res, 200, { ok: true });
      }
      case "POST /__lab/restart": {
        replica.close();
        replica = new Replica(log, { ulid: replicaUlid, backoffMs: 1 });
        db = createShimD1(replica);
        await replica.catchUp(); // a cold container: boot and replay the whole log, hash-checked
        return json(res, 200, { ok: true });
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
          if (!Buffer.from(fresh.serialize()).equals(Buffer.from(replica.serialize()))) problems.push("the replica differs from a fresh replay of the log");
        } catch (e) {
          problems.push(`a fresh replay failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          fresh.close();
        }
        return json(res, 200, { ok: problems.length === 0, problems });
      }
      case "GET /__lab/stats":
        return json(res, 200, { injected: faulty?.injected ?? null, replica: replica.stats, seq: replica.seq });
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
    close: async () => {
      if (table !== undefined && logKind !== "memory") await dropLogTable({ endpoint: logKind.ddb, table, credentials: DDB_CREDS }).catch(() => {});
      await new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve())));
    },
  };
}
