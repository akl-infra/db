// The Node platform for local development (design/aws-port.md §4.1, §6; lane M):
// the DynamoDB store as given, blobs as files under a directory (`.dev/blobs`),
// the real outbound `fetch`, an in-process 5-minute tick standing in for the
// Cron Trigger, and background work awaited after the response is sent.
// Unlike platform/node-lab.ts this host pins no clock and no PRNG: it is for
// a developer's `npm run dev`, not the proving ground. Fake credentials, one
// local DynamoDB endpoint (the document client refuses any other).
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { parse as parseToml } from "smol-toml";
import { ulid } from "ulidx";
import type { PlatformFactory } from "../app";
import type { Bindings } from "../env";
import worker from "../index";
import { systemClock, type Clock } from "../core/time";
import type { ClientRow } from "../core/clients";
import { createDdbStore } from "../store/ddb";
import { seedBootstrap } from "../store/ddb/codec";
import { createDocClient } from "../store/ddb/client";
import type { DdbTables } from "../store/ddb/contracts";
import { createTables, deleteTables } from "../store/ddb/tables";
import type { Store } from "../store/port";
import type { Dump } from "../dump/write";
import { lruResponseCache } from "./node-lab";
import type { BlobObject, BlobStore } from "./port";

/** The Worker's cron string (src/index.ts `scheduled`). */
const TICK_CRON = "*/5 * * * *";

/** Blobs as files: `<dir>/<key>` holds the bytes, `<dir>/<key>.type` the content type. A key may not climb out of `dir`. */
export function fileBlobs(dir: string): BlobStore {
  const root = path.resolve(dir);
  const fileOf = (key: string): string => {
    const f = path.resolve(root, key);
    if (f !== root && !f.startsWith(root + path.sep)) throw new Error(`blob key escapes the blob directory: ${key}`);
    return f;
  };
  return {
    async get(key): Promise<BlobObject | null> {
      const f = fileOf(key);
      let bytes: Buffer;
      try {
        bytes = await fs.promises.readFile(f);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "EISDIR") return null;
        throw e;
      }
      const contentType = await fs.promises.readFile(`${f}.type`, "utf8").catch(() => null);
      return {
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array(bytes));
            c.close();
          },
        }),
        httpEtag: `"${createHash("md5").update(bytes).digest("hex")}"`,
        contentType,
        size: bytes.byteLength,
      };
    },
    async put(key, body, contentType) {
      const f = fileOf(key);
      await fs.promises.mkdir(path.dirname(f), { recursive: true });
      // Write beside, then rename: a reader never sees half an object.
      const tmp = `${f}.tmp-${process.pid}`;
      await fs.promises.writeFile(tmp, typeof body === "string" ? body : Buffer.from(body));
      await fs.promises.rename(tmp, f);
      await fs.promises.writeFile(`${f}.type`, contentType);
    },
  };
}

export interface NodePlatformOptions {
  store: Store;
  blobs: BlobStore;
  /** Default: the global `fetch`. */
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

/** The PLATFORM factory to put on the env, plus `drain()` for the tasks handed to `background` so far. */
export function createNodePlatform(opts: NodePlatformOptions): PlatformFactory & { drain(): Promise<void> } {
  const cache = lruResponseCache();
  const pending = new Set<Promise<unknown>>();
  const factory: PlatformFactory = (env) => {
    const now: Clock = (env as unknown as { TEST_CLOCK?: Clock }).TEST_CLOCK ?? systemClock;
    return {
      store: opts.store,
      blobs: opts.blobs,
      cache,
      config: env,
      now,
      ulid: () => ulid(),
      fetch: opts.fetch ?? ((input, init) => fetch(input, init)),
      background(task) {
        const guarded = task.catch((e: unknown) => console.error(`background task failed: ${e instanceof Error ? e.message : String(e)}`));
        pending.add(guarded);
        void guarded.finally(() => pending.delete(guarded));
      },
    };
  };
  return Object.assign(factory, {
    async drain() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  });
}

/** `empty`: the rows the D1 migrations seed. `{ dump }`: a dump restored into the empty store (the fixture, or a file). */
export type DevSeed = "empty" | { dump: Dump };

export interface DevClient {
  id: string;
  /** base64url raw Ed25519 public key. */
  pubkey: string;
  ownerUserId: string;
}

export interface DevServerOptions {
  /** Repo root: wrangler.toml's `[vars]` are the defaults. */
  repoRoot: string;
  /** DynamoDB Local, e.g. http://127.0.0.1:18502. */
  endpoint: string;
  /** Table name prefix; `<prefix>-main` and `<prefix>-eph`. */
  prefix: string;
  port: number;
  host?: string;
  blobsDir: string;
  seed: DevSeed;
  /** A client to register after the seed, so the dev API accepts signed writes. */
  client?: DevClient;
  /** ms between ticks (default 300000, the production cadence). 0 = no tick. */
  tickMs?: number;
  /** Extra vars over wrangler.toml's. */
  vars?: Record<string, string>;
}

export interface DevServer {
  url: string;
  port: number;
  tables: DdbTables;
  /** Number of ticks completed. */
  ticks(): number;
  close(): Promise<void>;
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** Create the tables, seed them, register the dev client and serve the app. */
export async function startDevServer(opts: DevServerOptions): Promise<DevServer> {
  const wrangler = parseToml(fs.readFileSync(path.join(opts.repoRoot, "wrangler.toml"), "utf8")) as { vars?: Record<string, string> };
  const tables: DdbTables = { main: `${opts.prefix}-main`, ephemeral: `${opts.prefix}-eph` };
  const doc = createDocClient({ endpoint: opts.endpoint, region: "us-east-2" });
  await deleteTables(doc, tables).catch(() => {});
  await createTables(doc, tables, { ttl: false });
  const blobs = fileBlobs(opts.blobsDir);
  const store = createDdbStore({ doc, tables, blobs });
  if (opts.seed === "empty") await seedBootstrap({ doc, tables, blobs });
  else await store.dump.restore(opts.seed.dump);
  if (opts.client !== undefined) {
    const row: ClientRow = {
      id: opts.client.id,
      name: "dev",
      pubkey: opts.client.pubkey,
      owner_user_id: opts.client.ownerUserId,
      caps: "act-as-user",
      discord_app_id: null,
      status: "active",
      created_at: systemClock(),
      revoked_at: null,
    };
    await store.admin.insertClient(row);
  }

  const platform = createNodePlatform({ store, blobs });
  const env = {
    ...wrangler.vars,
    ...opts.vars,
    DB: store as unknown as D1Database, // toStore() accepts the Store itself
    PLATFORM: platform,
  } as unknown as Bindings;

  // ctx.waitUntil and platform.background share one pending set (drained after the response).
  const pendingCtx = (): { waitUntil(p: Promise<unknown>): void; passThroughOnException(): void } => ({
    waitUntil: (p) => platform(env, undefined).background(p),
    passThroughOnException() {},
  });

  const sockets = new Set<http.ServerResponse>();
  const server = http.createServer((req, res) => {
    void (async () => {
      sockets.add(res);
      res.once("close", () => sockets.delete(res));
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `127.0.0.1:${opts.port}`}`);
        const headers = new Headers();
        for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
        const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
        const response = await worker.fetch(new Request(url, { method: req.method, headers, body }), env, pendingCtx() as unknown as ExecutionContext);
        const out: [string, string][] = [];
        response.headers.forEach((v, k) => {
          if (k !== "set-cookie") out.push([k, v]);
        });
        for (const c of response.headers.getSetCookie()) out.push(["set-cookie", c]);
        res.writeHead(response.status, out.flat());
        if (response.body === null || req.method === "HEAD" || response.status === 204 || response.status === 304) {
          res.end();
        } else {
          // Streamed as it comes (the change feed holds a response open); a client that goes away cancels the read.
          const stream = Readable.fromWeb(response.body as never);
          res.once("close", () => stream.destroy());
          stream.pipe(res);
          await new Promise<void>((resolve) => stream.once("close", () => resolve()));
        }
        await platform.drain();
      } catch (e) {
        console.error("dev server error:", e);
        if (!res.headersSent) {
          const s = JSON.stringify({ error: "dev server error", message: e instanceof Error ? e.message : String(e) });
          res.writeHead(500, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
          res.end(s);
        } else res.destroy();
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host ?? "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : opts.port;

  let ticks = 0;
  let ticking = false;
  const tickMs = opts.tickMs ?? 300_000;
  const timer =
    tickMs > 0
      ? setInterval(() => {
          if (ticking) return; // a slow tick is not stacked
          ticking = true;
          const ctx = pendingCtx();
          const event = { cron: TICK_CRON, scheduledTime: Date.now(), noRetry() {} } as unknown as ScheduledController;
          void (async () => {
            try {
              await worker.scheduled(event, env, ctx as unknown as ExecutionContext);
              await platform.drain();
            } catch (e) {
              console.error(`tick failed: ${e instanceof Error ? e.message : String(e)}`);
            } finally {
              ticks++;
              ticking = false;
            }
          })();
        }, tickMs)
      : undefined;
  timer?.unref();

  return {
    url: `http://${opts.host ?? "127.0.0.1"}:${port}`,
    port,
    tables,
    ticks: () => ticks,
    close: () =>
      new Promise<void>((resolve) => {
        if (timer !== undefined) clearInterval(timer);
        for (const r of sockets) r.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
