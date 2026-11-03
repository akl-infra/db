// A fake world for the cutover and rollback machines (scripts/cutover/*): D1 (node:sqlite databases by name), a Worker in front of
// it (the read_only flag of the cutover-modes branch, read from D1's import_state), the DNS record that decides who answers api.akldb.org, the AWS stack (the REAL
// Replica, memory commit log, memory object store and the REAL Lambda handler for migrate/warm), a mini HTTP API both sides serve
// from the same SQL, and wrangler/aws/http ports over all of it. No network, no process, a fake clock.
import { createHash } from "node:crypto";
// @ts-expect-error -- plain scripts, no .d.ts
import { copyDumps } from "../../scripts/cutover/dumps.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
// @ts-expect-error -- plain scripts, no .d.ts
import { main as runMain } from "../../scripts/cutover/run.mjs";
// @ts-expect-error -- plain scripts, no .d.ts
import { main as rollbackMain } from "../../scripts/cutover/rollback.mjs";
// @ts-expect-error -- plain scripts, no .d.ts
import { createOperator } from "../../scripts/cutover/operator.mjs";
// @ts-expect-error -- plain scripts, no .d.ts
import { dumpToSql, splitStatements } from "../../scripts/cutover/sqlfile.mjs";
import { createLambdaHandler } from "../../src/platform/lambda";
import type { Aws } from "../../src/platform/lambda-aws";
import { memoryBlobs } from "../../src/platform/node";
import { bootReplica } from "../../src/replica/boot";
import { appendImage } from "../../src/replica/image";
import { MemoryLog } from "../../src/replica/log-memory";
import { MemoryObjects } from "../../src/replica/objects";
import { Replica } from "../../src/replica/replica";
import { MemorySnapshotState, writeSnapshot } from "../../src/replica/snapshot";
import { createShimD1 } from "../../src/store/shim/d1";
import { FAST, MIGRATIONS_DIR, churn, world as replicaWorld } from "../replica/support";

export const PUBLIC = "https://api.akldb.org";
export const WORKER_DIRECT = "https://akl-db.akl-58a.workers.dev";
export const REHEARSAL_WORKER = "https://rehearsal.example";
export const STAGING_PUBLIC = "https://staging-api.akldb.org";
export const MINOR = 34;
const SECRET = "s3cret-origin-value-0123456789abcdef";

export interface Res {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** sha256 of the raw body bytes (the real port computes it from the response). */
  sha256?: string;
  raw?: Uint8Array;
}
type Blobs = Map<string, { bytes: Uint8Array; contentType: string }>;
const md5hex = (b: Uint8Array): string => createHash("md5").update(b).digest("hex");
type Row = Record<string, unknown>;
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/** What D1 hands JS: integers and reals as numbers, blobs as arrays of byte numbers. */
function d1Row(r: Row): Row {
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v instanceof Uint8Array ? Array.from(v) : v]));
}

interface Sqlx {
  select(sql: string): Promise<Row[]>;
  exec(sql: string, params?: unknown[]): Promise<void>;
}

/** The mini API, served identically from D1 and from the AWS replica. */
/** src/routes/dump.ts over a blob store: the route picks the Content-Type by key, never from the stored object; no Cache-Control; the object's own quoted md5 ETag. */
function dumpRoute(blobs: Blobs, path: string): Res | null {
  const out = (key: string, contentType: string): Res => {
    const o = blobs.get(key);
    if (o === undefined) return { status: 404, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "not_found" }) };
    return { status: 200, headers: { "content-type": contentType, etag: `"${md5hex(o.bytes)}"` }, body: new TextDecoder().decode(o.bytes), raw: o.bytes };
  };
  if (path === "/v1/dump/latest.json") return out("latest.json", "application/json");
  if (path === "/v1/dump") {
    const o = blobs.get("latest.json");
    if (o === undefined) return { status: 404, headers: { "content-type": "application/json" }, body: "{}" };
    return { status: 302, headers: { location: `/v1/dump/${(JSON.parse(new TextDecoder().decode(o.bytes)) as { key: string }).key}` }, body: "" };
  }
  const monthly = /^\/v1\/dump\/monthly\/(dump-\d{4}-\d{2}\.json\.gz)$/.exec(path);
  if (monthly) return out(`monthly/${monthly[1]}`, "application/gzip");
  const k = /^\/v1\/dump\/([^/]+)$/.exec(path)?.[1];
  if (k === undefined) return null;
  if (/^dump-\d{4}-\d{2}-\d{2}\.json\.gz$/.test(k)) return out(k, "application/gzip");
  if (/^latest\.[a-z][a-z0-9]*-[1-9]\d*\.json(\.sha256)?$/.test(k)) return out(k, k.endsWith(".sha256") ? "text/plain" : "application/json");
  return { status: 404, headers: { "content-type": "application/json" }, body: "{}" };
}

async function serve(db: Sqlx, req: { method: string; path: string; query: URLSearchParams; headers: Record<string, string>; body: string }, readOnly: boolean, now: number, quiet = false, blobs: Blobs = new Map()): Promise<Res> {
  if (req.method === "GET" && req.path.startsWith("/v1/dump")) {
    const d = dumpRoute(blobs, req.path);
    if (d !== null) return d;
  }
  const json = (status: number, v: unknown, extra: Record<string, string> = {}): Res => ({ status, headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(v) });
  const cond = (status: number, v: unknown, etag: string): Res => {
    if (req.headers["if-none-match"] === etag) return { status: 304, headers: { etag }, body: "" };
    return json(status, v, { etag });
  };
  const { method, path: p } = req;
  if (method === "GET" && p === "/v1/meta") {
    const seq = (await db.select("SELECT COALESCE(MAX(seq), 0) AS seq FROM events"))[0]!.seq;
    const n = (await db.select("SELECT count(*) AS n FROM churn"))[0]!.n;
    const stable = { seq, layout_count: n, api: { major: 1, minor: MINOR } };
    return cond(200, { ...stable, health: { dump: { age_s: Math.floor(now / 1000) % 1000 } } }, `"${sha(JSON.stringify(stable)).slice(0, 16)}"`);
  }
  if (method === "GET" && p === "/v1/layouts") {
    const limit = Number(req.query.get("limit") ?? 20);
    const rows = await db.select(`SELECT id, v, n FROM churn ORDER BY id LIMIT ${limit}`);
    const items = rows.map((r) => ({ id: String(r.id), name: String(r.v).slice(0, 12), rev: Number(r.n) + 1 }));
    return cond(200, { items, next_cursor: null }, `"${sha(JSON.stringify(items)).slice(0, 16)}"`);
  }
  const one = /^\/v1\/layouts\/([^/]+)$/.exec(p);
  if (one && (method === "GET" || method === "PATCH")) {
    const [r] = await db.select(`SELECT id, v, n FROM churn WHERE id = ${Number(one[1])}`);
    if (r === undefined) return json(404, { error: "not_found" });
    const wire = { id: String(r.id), name: String(r.v).slice(0, 12), rev: Number(r.n) + 1 };
    const etag = `"layout:${wire.rev}"`;
    if (method === "GET") return cond(200, wire, etag);
    if (readOnly) return json(503, { error: "read_only" }, { "retry-after": "5" });
    if (req.headers["x-akl-client"] === undefined) return json(401, { error: "unauthorized" });
    if (req.headers["if-match"] !== etag) return json(412, { error: "precondition_failed" });
    return json(200, wire, { etag });
  }
  if (method === "GET" && p === "/v1/changes") {
    const since = Number(req.query.get("since") ?? 0);
    const rows = await db.select(`SELECT seq, kind FROM events WHERE seq > ${since} ORDER BY seq LIMIT ${Number(req.query.get("limit") ?? 50)}`);
    return json(200, { next: rows.length === 0 ? since : Number(rows[rows.length - 1]!.seq), items: rows.map((r) => ({ seq: Number(r.seq), kind: r.kind })) });
  }
  if (method === "POST" && p === "/v1/layouts") return readOnly ? json(503, { error: "read_only" }, { "retry-after": "5" }) : json(400, { error: "bad_request" });
  if (method === "POST" && p === "/v1/admin/nightly/tick") {
    if (readOnly) return json(503, { error: "read_only" }, { "retry-after": "5" });
    if (req.headers["x-akl-client"] === undefined) return json(401, { error: "unauthorized" });
    if (quiet) return json(200, { ok: true });
    await db.exec("INSERT INTO events (at, kind, actor, via) VALUES (?, 'admin.nightly_ticked', 'ops', 'api')", [new Date(now).toISOString()]);
    return json(200, { ok: true });
  }
  return json(404, { error: "not_found" });
}

export interface Faults {
  /** The `crashNth`th (default 1st) port call made while this step runs throws once. */
  crashStep?: string;
  crashNth?: number;
  /** The DNS record moves after this many polls of the dns / dns-back step (default 2). */
  dnsFlipAfter?: number;
  /** The record never moves (saltorbit has not done it). */
  dnsNeverFlips?: boolean;
  /** One poll after the move still answers from the old side (a stale resolver): the consecutive count must restart. */
  dnsFlap?: boolean;
  /** The first poll fails to connect (the gap between removing the Worker's domain and the new record). */
  dnsErrorFirst?: boolean;
  /** The origin secret file is missing. */
  noOriginFile?: boolean;
  /** The Worker build has no modes: it ignores cutover.mode and answers a bad write with 400. */
  noModes?: boolean;
  /** The export omits the sqlite_sequence rows. */
  exportDropsSequence?: boolean;
  /** The import into a fresh D1 silently loses a row. */
  importDropsRow?: boolean;
  /** `wrangler d1 create` repoints the Worker at the new database at once (a PR merged and deployed in no time). */
  autoPoint?: boolean;
  /** The export lists CREATE TRIGGER before the rows (schema order, as D1 does). */
  exportTriggersFirst?: boolean;
  /** No R2 token in the environment. */
  noR2Token?: boolean;
  /** One R2 object arrives damaged. */
  r2CorruptKey?: string;
  /** The S3 side forgets content types. */
  s3LosesContentType?: boolean;
  /** The stack lacks one output. */
  missingOutput?: string;
  /** What the function says for AKLDB_AWAIT_IMAGE. */
  awaitImage?: "0" | "1";
  /** The AWS side answers the list page differently from D1. */
  awsListDiffers?: boolean;
  /** The AWS side forgets to say x-akldb-backend. */
  awsNoBackendHeader?: boolean;
  /** The feed after the signed write is empty (the write made no event). */
  signedWriteMakesNoEvent?: boolean;
}

export interface World {
  dir: string;
  now: number;
  calls: string[];
  /** Port calls per step, in order. */
  callsByStep: Record<string, string[]>;
  /** Who answers api.akldb.org: the Worker until the record moves. */
  dns: "worker" | "aws";
  dnsPolls: number;
  /** The D1 the cutover is about ("akl-db", or "scratch" in a rehearsal). */
  d1Name: string;
  /** Flags that make a run a staging rehearsal (empty for production). */
  baseArgs: string[];
  /** D1 databases by name; the Worker serves from `workerDb`. */
  dbs: Map<string, DatabaseSync>;
  workerDb: string;
  /** The dump history: R2 (the Worker) and S3 (the prod stack). */
  r2: Blobs;
  s3: Blobs;
  faults: Faults;
  currentStep: string | null;
  crashed: boolean;
  log: MemoryLog;
  blobs: MemoryObjects;
  snapshots: MemorySnapshotState;
  objects: MemoryObjects;
  operator: ReturnType<typeof createOperator>;
  lines: string[];
  ports: Record<string, any>;
  clock: { now(): number; sleep(ms: number): Promise<void> };
  /** Attempts to write to each side while it should be frozen. */
  d1(name?: string): DatabaseSync;
  awsReplica(): Promise<Replica>;
  /** Run run.mjs / rollback.mjs with the world's ports. `args` are CLI flags. */
  cutover(args?: string[]): Promise<{ code: number; out: string[] }>;
  rollback(args?: string[]): Promise<{ code: number; out: string[] }>;
  /** Run the cutover one step at a time (--only) up to and including `id`. */
  cutoverUntil(id: string): Promise<void>;
  stateFile: string;
  state(): any;
  /** Rows written to AWS by users after the cutover opened (for rollback tests). */
  userWriteOnAws(n: number): Promise<void>;
}

export const STEP_IDS = ["preflight", "copy-dumps", "freeze", "export", "load", "verify", "image", "serve", "dns", "open", "post-smoke", "report"];

export async function makeWorld(init: { faults?: Faults; events?: number; churnRows?: number; rehearsal?: boolean } = {}): Promise<World> {
  const d1Name = init.rehearsal ? "scratch" : "akl-db";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akldb-cutover-test-"));
  // D1 as it stands before the cutover: the real migrations, churned data, authors (their triggers), events with a gap at the top
  // (so sqlite_sequence is ahead of MAX(seq): the next-seq rule is real), an import_state row besides the mode flag.
  const src = await replicaWorld("2026-10-01T00:00:00Z");
  await churn(src.replica, init.churnRows ?? 40, 11);
  const shim = createShimD1(src.replica);
  for (const [i, name] of ["ada", "grace", "linus"].entries()) await shim.prepare("INSERT INTO authors (user_id, name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)").bind(`u${i}`, name, "2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z").run();
  for (let i = 0; i < (init.events ?? 14); i++) await shim.prepare("INSERT INTO events (at, kind, actor, via, detail_json) VALUES (?, 'layout.created', 'u0', 'api', ?)").bind(`2026-10-0${1 + (i % 8)}T00:00:00Z`, JSON.stringify({ i, note: "it's \"quoted\" é\n" })).run();
  await shim.prepare("DELETE FROM events WHERE seq > ?").bind((init.events ?? 14) - 2).run(); // sqlite_sequence stays at the old top
  await shim.prepare("INSERT INTO import_state (key, value) VALUES ('cmini.paused', '1')").run();
  const d1 = new DatabaseSync(":memory:");
  d1.deserialize(src.replica.serialize());

  const blobs = new MemoryObjects();
  const log = new MemoryLog({}, blobs);
  // dump history: R2 (the Worker's) is full, S3 (the stack's) starts empty
  const gz = (n: string) => ({ bytes: new Uint8Array(Buffer.from(`gzip bytes of ${n}`.repeat(50))), contentType: "application/gzip" });
  const r2: Blobs = new Map([
    ["latest.json", { bytes: new TextEncoder().encode(JSON.stringify({ key: "dump-2026-11-03.json.gz", seq: 12 })), contentType: "application/json" }],
    ["dump-2026-11-02.json.gz", gz("11-02")],
    ["dump-2026-11-03.json.gz", gz("11-03")],
    ["monthly/dump-2026-10.json.gz", gz("2026-10")],
    ["latest.spark-1.json", { bytes: new TextEncoder().encode('{"layouts":[]}'), contentType: "application/json" }],
    ["latest.spark-1.json.sha256", { bytes: new TextEncoder().encode("abc  latest.spark-1.json\n"), contentType: "text/plain" }],
  ]);
  const s3: Blobs = new Map();
  const objects = new MemoryObjects();
  const snapshots = new MemorySnapshotState();
  const operator = createOperator({ kit: { Replica, bootReplica, appendImage, writeSnapshot }, log, objects, state: snapshots, logLine: () => {} });

  const w = { now: Date.parse("2026-11-04T09:00:00Z"), calls: [] as string[], callsByStep: {} as Record<string, string[]>, dbs: new Map([[d1Name, d1]]), workerDb: d1Name, d1Name, dns: "worker", dnsPolls: 0, baseArgs: init.rehearsal ? ["--stage", "staging", "--d1", "scratch", "--worker-url", REHEARSAL_WORKER, "--public-url", STAGING_PUBLIC] : [], faults: init.faults ?? {}, currentStep: null as string | null, crashed: false, lines: [] as string[] } as unknown as World;
  Object.assign(w, { dir, log, blobs, snapshots, objects, operator, r2, s3, stateFile: path.join(dir, "state.json") });
  w.d1 = (name = d1Name) => w.dbs.get(name)!;
  w.state = () => JSON.parse(fs.readFileSync(w.stateFile, "utf8"));

  let serving: Replica | undefined;
  w.awsReplica = async () => {
    serving ??= new Replica(log, FAST);
    await serving.catchUp();
    return serving;
  };

  w.clock = {
    now: () => w.now,
    async sleep(ms) {
      w.now += ms;
    },
  };

  const crashGuard = (name: string): void => {
    if (name === "http.fresh") return; // the DNS poll tolerates connection failures by design: a crash there is a gap, not a crash
    if (w.currentStep !== null) (w.callsByStep[w.currentStep] ??= []).push(name);
    if (w.faults.crashStep !== undefined && w.faults.crashStep === w.currentStep && !w.crashed) {
      const nth = w.faults.crashNth ?? 1;
      if ((w.callsByStep[w.currentStep]?.length ?? 0) >= nth) {
        w.crashed = true;
        throw new Error(`injected crash in ${w.currentStep} (${name}, call ${nth})`);
      }
    }
  };
  const track = <T extends (...a: any[]) => any>(name: string, fn: T): T =>
    ((...a: any[]) => {
      w.calls.push(name);
      crashGuard(name);
      return fn(...a);
    }) as T;

  // ---- the Lambda: the real handler over the same log ----
  const fakeAws = {
    async invokeAsync() {},
    dumps: memoryBlobs(),
    async getParameters(names: string[]) {
      return { values: Object.fromEntries(names.filter((n) => n === "origin-secret").map((n) => [n, SECRET])), missing: [] };
    },
    async invokeLive() {
      return { ok: true, container: "other" };
    },
  } as unknown as Aws;
  const lambda = createLambdaHandler({
    env: { STAGE: "prod", AKLDB_AWAIT_IMAGE: "1", DISCORD_API_URL: "http://127.0.0.1:1/discord", MODQUEUE_DISCORD_COMPONENTS: "false", AWS_LAMBDA_FUNCTION_VERSION: "1" },
    aws: fakeAws,
    log,
    migrationsDir: MIGRATIONS_DIR,
    snapshots: { state: snapshots, objects },
    logError: () => {},
    logLine: () => {},
    now: () => w.now,
    sleep: async () => {},
  });

  // ---- HTTP ----
  const parse = (url: string, init: any) => {
    const u = new URL(url);
    return { method: (init?.method ?? "GET").toUpperCase(), path: u.pathname, query: u.searchParams, headers: Object.fromEntries(Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])), body: String(init?.body ?? "") };
  };
  const d1Sqlx = (db: DatabaseSync): Sqlx => ({
    async select(sql) {
      const st = db.prepare(sql);
      st.setReadBigInts(true);
      return (st.all() as Row[]).map(d1Row);
    },
    async exec(sql, params = []) {
      db.prepare(sql).run(...(params as never[]));
    },
  });
  const awsRequest = async (req: ReturnType<typeof parse>): Promise<Res> => {
    let res: Res;
    try {
      const r = await w.awsReplica();
      const sqlx: Sqlx = {
        async select(sql) {
          return (await r.runUnit([{ sql, params: [] }], { fresh: true }))[0]!.rows;
        },
        async exec(sql, params = []) {
          await r.runUnit([{ sql, params }]);
        },
      };
      const flag = await sqlx.select("SELECT value FROM import_state WHERE key = 'cutover.mode'");
      res = await serve(sqlx, req, flag.length > 0 && flag[0]!.value === "read_only", w.now, w.faults.signedWriteMakesNoEvent === true, s3);
      if (w.faults.awsListDiffers && req.path === "/v1/layouts" && req.method === "GET") res = { ...res, body: res.body.replace('"rev":', '"rev ":') };
    } catch (e) {
      res = { status: 503, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "awaiting_image", message: String(e) }) };
    }
    if (w.faults.awsNoBackendHeader !== true) res.headers["x-akldb-backend"] = "aws";
    return res;
  };
  const workerRequest = async (req: ReturnType<typeof parse>): Promise<Res> => {
    const db = w.dbs.get(w.workerDb)!;
    const sqlx = d1Sqlx(db);
    const mode = (await sqlx.select("SELECT value FROM import_state WHERE key = 'cutover.mode'"))[0]?.value ?? null;
    if (w.faults.noModes) return serve(sqlx, req, false, w.now, false, r2);
    return serve(sqlx, req, mode === "read_only", w.now, false, r2);
  };
  const finish = (res: Res): Res => {
    const bytes = res.raw ?? new TextEncoder().encode(res.body);
    return { ...res, sha256: createHash("sha256").update(bytes).digest("hex") };
  };
  const request = async (url: string, init: any = {}): Promise<Res> => {
    const req = parse(url, init);
    if (url.startsWith(WORKER_DIRECT) || url.startsWith(REHEARSAL_WORKER)) return finish(await workerRequest(req));
    if (url.startsWith(PUBLIC)) return finish(w.dns === "aws" ? await awsRequest(req) : await workerRequest(req));
    if (url.startsWith(STAGING_PUBLIC)) return finish(await awsRequest(req));
    throw new Error(`the fake world does not serve ${url}`);
  };
  /** A request on a fresh connection; during the dns / dns-back steps it is also where saltorbit's DNS change takes effect. */
  const fresh = async (url: string, init: any = {}): Promise<Res> => {
    if (url.startsWith(PUBLIC) && (w.currentStep === "dns" || w.currentStep === "dns-back")) {
      w.dnsPolls++;
      const f = w.faults;
      if (f.dnsErrorFirst && w.dnsPolls === 1) throw new Error("ECONNRESET");
      const flipAfter = f.dnsFlipAfter ?? 2;
      if (!f.dnsNeverFlips && w.dnsPolls > flipAfter) w.dns = w.currentStep === "dns" ? "aws" : "worker";
      if (f.dnsFlap && w.dnsPolls === flipAfter + 3) {
        const other = w.dns === "aws" ? await workerRequest(parse(url, init)) : await awsRequest(parse(url, init));
        return finish(other);
      }
    }
    return request(url, init);
  };

  // ---- ports ----
  w.ports = {
    clock: w.clock,
    d1: {
      timeTravelInfo: track("d1.timeTravelInfo", (db: string) => ({ bookmark: `00000085-0000024c-00004c6d-${sha(db).slice(0, 24)}`, timestamp: "2026-11-04T08:59:00Z" })),
      select: track("d1.select", (sql: string, db: string) => {
        if (!/^\s*select\b/i.test(sql)) throw new Error(`read-only port refused ${sql}`);
        const st = w.dbs.get(db)!.prepare(sql);
        st.setReadBigInts(true);
        return (st.all() as Row[]).map(d1Row);
      }),
      selectMany: track("d1.selectMany", (sqls: string[], db: string) =>
        sqls.map((sql) => {
          if (!/^\s*select\b/i.test(sql)) throw new Error(`read-only port refused ${sql}`);
          const st = w.dbs.get(db)!.prepare(sql);
          st.setReadBigInts(true);
          return (st.all() as Row[]).map(d1Row);
        }),
      ),
      write: track("d1.write", (sql: string, db: string) => {
        w.dbs.get(db)!.exec(sql);
      }),
      exportTo: track("d1.exportTo", (db: string, file: string) => {
        let sql: string = dumpToSql(w.dbs.get(db)!);
        if (w.faults.exportTriggersFirst) {
          // D1 emits CREATE TRIGGER in schema order: right after the tables, before any row
          const parts: string[] = splitStatements(sql);
          const trig = parts.filter((p) => /^CREATE TRIGGER/i.test(p));
          const rest = parts.filter((p) => !/^CREATE TRIGGER/i.test(p));
          const firstInsert = rest.findIndex((p) => /^INSERT/i.test(p));
          sql = [...rest.slice(0, firstInsert), ...trig, ...rest.slice(firstInsert)].map((p) => `${p};`).join("\n") + "\n";
        }
        if (w.faults.exportDropsSequence) sql = sql.split("\n").filter((l) => !/sqlite_sequence/.test(l)).join("\n");
        fs.writeFileSync(file, sql);
      }),
      create: track("d1.create", (name: string) => {
        if (w.dbs.has(name)) throw new Error(`a database with the name ${name} already exists`);
        w.dbs.set(name, new DatabaseSync(":memory:"));
        if (w.faults.autoPoint) w.workerDb = name;
        return { name, id: `${sha(name).slice(0, 8)}-0000-4000-8000-${sha(name).slice(8, 20)}` };
      }),
      info: track("d1.info", (name: string) => {
        if (!w.dbs.has(name)) throw new Error(`no database named ${name}`);
        return { name, id: `${sha(name).slice(0, 8)}-0000-4000-8000-${sha(name).slice(8, 20)}` };
      }),
      importFile: track("d1.importFile", (name: string, file: string) => {
        const sql = fs.readFileSync(file, "utf8");
        // what D1's import refuses
        if (/(^|;\n)\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|PRAGMA foreign_keys)\b/i.test(sql)) throw new Error("D1 import: transactions and PRAGMA foreign_keys are not supported");
        for (const stmt of sql.split(/;\n/)) if (stmt.length > 100_000) throw new Error("D1 import: statement too long");
        w.dbs.get(name)!.exec(sql);
        if (w.faults.importDropsRow) w.dbs.get(name)!.exec("DELETE FROM churn WHERE id = (SELECT MIN(id) FROM churn)");
      }),
    },
    http: {
      request: track("http.request", request),
      fresh: track("http.fresh", fresh),
      signed: track("http.signed", (method: string, url: string, o: { body?: string; headers?: Record<string, string> } = {}) => request(url, { method, body: o.body, headers: { "x-akl-client": "ops", ...(o.headers ?? {}) } })),
    },
    stack: {
      check: track("stack.check", () => (w.faults.noOriginFile ? ["the origin secret file /x/akldb-origin-prod.env is unusable: ENOENT"] : [])),
      request: track("stack.request", async (path: string, init: any = {}) => finish(await awsRequest(parse(`https://stack.invalid${path}`, init)))),
    },
    dumps: {
      check: track("dumps.check", () => (w.faults.noR2Token ? ["R2_KEY_ID in /x/akldb-r2-dumps-read.env", "R2_SECRET in /x/akldb-r2-dumps-read.env"] : [])),
      sync: track("dumps.sync", async () => {
        const src = {
          async list() {
            return [...r2].map(([key, o]) => ({ key, size: o.bytes.byteLength, etag: `"${md5hex(o.bytes)}"` }));
          },
          async get(key: string, opts: { headOnly?: boolean } = {}) {
            const o = r2.get(key)!;
            const bytes = w.faults.r2CorruptKey === key && opts.headOnly !== true ? Uint8Array.from(o.bytes, (b, i) => (i === 3 ? b ^ 1 : b)) : o.bytes;
            return { bytes: opts.headOnly ? new Uint8Array(0) : bytes, contentType: o.contentType, etag: `"${md5hex(o.bytes)}"`, size: o.bytes.byteLength };
          },
        };
        const dst = {
          async head(key: string) {
            const o = s3.get(key);
            return o === undefined ? null : { size: o.bytes.byteLength, etag: `"${md5hex(o.bytes)}"`, contentType: o.contentType };
          },
          async put(key: string, bytes: Uint8Array, contentType: string) {
            s3.set(key, { bytes: Uint8Array.from(bytes), contentType: w.faults.s3LosesContentType ? "binary/octet-stream" : contentType });
          },
        };
        return copyDumps({ src, dst });
      }),
    },
    aws: {
      stackOutputs: track("aws.stackOutputs", () => {
        const out: Record<string, string> = { ApiDomainTarget: "d-abc.execute-api.us-east-2.amazonaws.com", FunctionName: "akldb-prod-api", LogTable: "akldb-prod-log", DataBucket: "akldb-prod-data-335937358231" };
        if (w.faults.missingOutput) delete out[w.faults.missingOutput];
        return out;
      }),
      lambdaEnv: track("aws.lambdaEnv", () => ({ AKLDB_AWAIT_IMAGE: w.faults.awaitImage ?? "1" })),
      invoke: track("aws.invoke", (payload: unknown) => lambda(payload)),
      logHead: track("aws.logHead", () => operator.head()),
      firstEntry: track("aws.firstEntry", () => operator.firstEntry()),
      operator: {
        appendImage: track("aws.operator.appendImage", (a: unknown) => operator.appendImage(a)),
        tail: track("aws.operator.tail", () => operator.tail()),
        snapshot: track("aws.operator.snapshot", () => operator.snapshot()),
        runUnit: track("aws.operator.runUnit", (sql: string, params?: unknown[]) => operator.runUnit(sql, params)),
        readFlag: track("aws.operator.readFlag", () => operator.readFlag()),
        capture: track("aws.operator.capture", () => operator.capture()),
      },
    },
  };

  const outFn = (line: string): void => {
    w.lines.push(line);
    const m = /^\[([a-z0-9-]+)\] (?!already|skipped)/.exec(line);
    if (m) {
      w.currentStep = m[1]!;
      if (m[1] === "dns" || m[1] === "dns-back") w.dnsPolls = 0;
    }
  };
  const common = (prefix: string) => ["--state", path.join(dir, prefix === "run" ? "state.json" : "rollback-state.json"), "--work", path.join(dir, "work"), "--report", path.join(dir, prefix === "run" ? "report.md" : "rollback-report.md")];
  const exec = async (fn: any, prefix: string, args: string[]) => {
    const out: string[] = [];
    const code = await fn([...args, ...w.baseArgs, ...common(prefix)], { ports: w.ports, clock: w.clock, out: (l: string) => (out.push(l), outFn(l)), env: {} });
    return { code: code as number, out };
  };
  w.cutover = (args = ["--execute"]) => exec(runMain, "run", args);
  w.rollback = (args = ["--execute"]) => exec(rollbackMain, "rollback", args);
  w.cutoverUntil = async (id) => {
    for (const s of STEP_IDS.slice(0, STEP_IDS.indexOf(id) + 1)) {
      const r = await w.cutover(["--execute", "--only", s]);
      if (r.code !== 0) throw new Error(`step ${s} failed in the setup: ${r.out.join("\n")}`);
    }
  };
  w.userWriteOnAws = async (n) => {
    const r = await w.awsReplica();
    const db = createShimD1(r);
    for (let i = 0; i < n; i++) await db.prepare("INSERT INTO churn (v) VALUES (?)").bind(`user write ${i}`).run();
  };
  return w;
}

export function cleanup(w: World): void {
  fs.rmSync(w.dir, { recursive: true, force: true });
}
