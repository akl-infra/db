// The Node lab server (design/aws-port.md §5.1; lane L): the app on the
// DynamoDB store behind a plain HTTP server, for the differential fuzzer and
// the later proving-ground tools. scripts/lab/serve-ddb.mjs bundles and runs
// it. It applies the same determinism overrides as p1-crawl-diff.mjs's
// `.lab-entry.ts`, keyed on `x-lab-now` / `x-lab-seed`, so a request sent to
// the D1 Worker and to this server mints the same ULIDs, nonces and
// timestamps. Loopback only; DynamoDB Local only.
//
// Besides the app it serves `/__lab/*` control routes (never part of the app):
//   GET  /__lab/health   {ok, tables}
//   POST /__lab/reset    drop and recreate the tables, fresh store
//   POST /__lab/restart  a fresh store and catalog over the same tables (a cold container)
//   POST /__lab/import   body: RowsByTable (D1-shaped rows) -> importRows
//   GET  /__lab/export   exportRows
//   GET  /__lab/check    catalog.current() == rebuildFromScan(), and the index checker
//   GET  /__lab/stats    injected-fault and call counts
import { AsyncLocalStorage } from "node:async_hooks";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { Bindings } from "../env";
import worker from "../index";
import { createDdbStore } from "../store/ddb";
import { createCatalog } from "../store/ddb/catalog";
import { createDocClient } from "../store/ddb/client";
import type { CatalogView, DdbContext, DdbTables, RowsByTable } from "../store/ddb/contracts";
import { withCallCounter } from "../store/ddb/counting";
import { withFaults } from "../store/ddb/faults";
import { createTables, deleteTables } from "../store/ddb/tables";
import type { Store } from "../store/port";
import { createNodeLabPlatform, memoryBlobs } from "./node-lab";
import { ulid as ulidx } from "ulidx";

/** What the codec and the index checker (lane N) provide; absent until merged. */
export interface LabHooks {
  exportRows?: (ctx: DdbContext) => Promise<RowsByTable>;
  importRows?: (ctx: DdbContext, rows: RowsByTable) => Promise<void>;
  checkIndexes?: (ctx: DdbContext) => Promise<{ ok: boolean; problems: string[] }>;
}

export interface LabServerOptions {
  port: number;
  /** DynamoDB Local, e.g. http://127.0.0.1:18318 */
  endpoint: string;
  tables: DdbTables;
  repoRoot: string;
  /** Extra [vars] (DISCORD_API_URL, STREAM_*). */
  vars?: Record<string, string>;
  faultRate?: number;
  faultSeed?: number;
}

// ---------------------------------------------------------------------------
// Determinism, as p1-crawl-diff.mjs's LAB_ENTRY does it on workerd
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

// The AWS SDK mints its own request ids and idempotency tokens with
// crypto.randomUUID. Those must not draw from the seeded stream, or the app's
// ULIDs would drift from the D1 Worker's (which has no SDK). Everything the
// document client does runs inside this scope and gets the real generators.
const insideSdk = new AsyncLocalStorage<true>();

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
  const realGetRandomValues = webcrypto.getRandomValues.bind(webcrypto);
  const realRandomUUID = webcrypto.randomUUID.bind(webcrypto);
  Object.defineProperty(webcrypto, "getRandomValues", { configurable: true, writable: true, value: <T extends ArrayBufferView>(a: T): T => (insideSdk.getStore() === true ? (realGetRandomValues(a as never) as T) : fillRandom(a)) });
  Object.defineProperty(webcrypto, "randomUUID", {
    configurable: true,
    writable: true,
    value: () => {
      if (insideSdk.getStore() === true) return realRandomUUID();
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

// ---------------------------------------------------------------------------

function canonView(v: CatalogView): string {
  const layouts = [...v.layouts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, l]) => [id, l.layout, [...l.formats.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)), [...l.likers]]);
  return JSON.stringify({ seq: v.seq, layouts });
}

function firstDifference(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return `at char ${i}: ${JSON.stringify(a.slice(Math.max(0, i - 60), i + 120))} vs ${JSON.stringify(b.slice(Math.max(0, i - 60), i + 120))}`;
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export async function startLabServer(opts: LabServerOptions, hooks: LabHooks = {}): Promise<{ url: string; close(): Promise<void> }> {
  installLabOverrides();
  const wrangler = parseToml(fs.readFileSync(path.join(opts.repoRoot, "wrangler.toml"), "utf8")) as { vars?: Record<string, string> };

  const raw = createDocClient({ endpoint: opts.endpoint, region: "us-east-2" });
  const shielded = new Proxy(raw, {
    get(target, prop) {
      if (prop === "send") return (cmd: unknown, ...rest: unknown[]) => insideSdk.run(true, () => (target as unknown as { send(c: unknown, ...r: unknown[]): Promise<unknown> }).send(cmd, ...rest));
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const faulty = withFaults(shielded, { rate: opts.faultRate ?? 0, seed: opts.faultSeed ?? 1, tables: opts.tables });
  const counted = withCallCounter(faulty);
  let blobs = memoryBlobs();

  const ctxBase = (): Omit<DdbContext, "catalog"> => ({ doc: counted, tables: opts.tables, blobs });
  let store: Store = createDdbStore(ctxBase());
  // A catalog of the server's own, long-lived like a container's, advanced by every /__lab/check.
  let labCatalog = createCatalog(ctxBase());
  const fullCtx = (): DdbContext => ({ ...ctxBase(), catalog: labCatalog });

  const storeProxy = new Proxy({} as Store, { get: (_t, p) => (store as unknown as Record<string | symbol, unknown>)[p] });
  const labUlid = (): string => ulidx(frozenMs);
  let currentPlatform = createNodeLabPlatform({ store: () => store, blobs, ulid: labUlid });
  const platformFactory = Object.assign((env: Bindings, ctx: { waitUntil(p: Promise<unknown>): void } | undefined) => currentPlatform(env, ctx), {
    drain: () => currentPlatform.drain(),
  });

  const env = {
    ...wrangler.vars,
    ...opts.vars,
    DB: storeProxy as unknown as D1Database,
    PLATFORM: platformFactory,
  } as unknown as Bindings;

  const rebuild = (fresh: boolean): void => {
    if (fresh) blobs = memoryBlobs();
    store = createDdbStore(ctxBase());
    labCatalog = createCatalog(ctxBase());
    currentPlatform = createNodeLabPlatform({ store: () => store, blobs, ulid: labUlid });
  };
  const json = (res: http.ServerResponse, status: number, body: unknown): void => {
    const s = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
    res.end(s);
  };

  const labRoute = async (req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> => {
    switch (`${req.method} ${pathname}`) {
      case "GET /__lab/health":
        return json(res, 200, { ok: true, tables: opts.tables });
      case "POST /__lab/reset": {
        await deleteTables(raw, opts.tables).catch(() => {});
        await createTables(raw, opts.tables);
        rebuild(true);
        return json(res, 200, { ok: true });
      }
      case "POST /__lab/restart":
        rebuild(false);
        return json(res, 200, { ok: true });
      case "POST /__lab/import": {
        if (hooks.importRows === undefined) return json(res, 501, { error: "lane N's importRows is not merged" });
        const rows = JSON.parse((await readBody(req)).toString("utf8")) as RowsByTable;
        await hooks.importRows(fullCtx(), rows);
        rebuild(false);
        return json(res, 200, { ok: true });
      }
      case "GET /__lab/export": {
        if (hooks.exportRows === undefined) return json(res, 501, { error: "lane N's exportRows is not merged" });
        return json(res, 200, await hooks.exportRows(fullCtx()));
      }
      case "GET /__lab/check": {
        const problems: string[] = [];
        const ctx = fullCtx();
        const cur = canonView(await labCatalog.current());
        const scan = canonView(await labCatalog.rebuildFromScan());
        if (cur !== scan) problems.push(`catalog.current() != rebuildFromScan() ${firstDifference(cur, scan)}`);
        if (hooks.checkIndexes !== undefined) {
          const r = await hooks.checkIndexes(ctx);
          if (!r.ok) problems.push(...r.problems.map((p) => `index checker: ${p}`));
        }
        return json(res, 200, { ok: problems.length === 0, problems, indexChecker: hooks.checkIndexes !== undefined });
      }
      case "GET /__lab/stats":
        return json(res, 200, { faults: faulty.faultStats(), calls: counted.calls.snapshot() });
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
        await currentPlatform.drain();
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
    close: () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  };
}
