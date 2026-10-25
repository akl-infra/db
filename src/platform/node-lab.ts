// The Node platform for the lab (design/aws-port.md §4.1, §5.1; lane L): the
// store as given, an in-memory BlobStore, a validated in-memory LRU
// ResponseCache, `now` from the test clock on the env, else the system clock, `ulid`, an
// outbound `fetch` that refuses any host but 127.0.0.1, and `background`
// collecting promises so a test can await them (`waitOnExecutionContext`).
// Used by the `ddb` vitest project (tests/harness/ddb.ts) and the lab
// server (scripts/lab/serve-ddb.mjs). No cloud: nothing here can reach one.
import { createHash } from "node:crypto";
import { ulid } from "ulidx";
import type { Bindings } from "../env";
import { systemClock, type Clock } from "../core/time";
import type { PlatformFactory } from "../app";
import type { BlobObject, BlobStore, ResponseCache } from "./port";
import type { Store } from "../store/port";
import { toStore } from "../store/arg";

/** An in-memory BlobStore (S3/R2 stand-in). `etag` is the quoted md5, as R2 serves it. */
export function memoryBlobs(): BlobStore & { readonly objects: ReadonlyMap<string, { bytes: Uint8Array; contentType: string }> } {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  return {
    objects,
    async get(key): Promise<BlobObject | null> {
      const o = objects.get(key);
      if (o === undefined) return null;
      const bytes = o.bytes;
      return {
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(bytes);
            c.close();
          },
        }),
        httpEtag: `"${createHash("md5").update(bytes).digest("hex")}"`,
        contentType: o.contentType,
        size: bytes.byteLength,
      };
    },
    async put(key, body, contentType) {
      objects.set(key, { bytes: typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body), contentType });
    },
  };
}

/** A validated LRU response cache (GET only, keyed by URL); the caller compares the ETag, so staleness cannot be served. */
export function lruResponseCache(max = 256): ResponseCache {
  const entries = new Map<string, { status: number; headers: [string, string][]; body: Uint8Array }>();
  return {
    async match(request) {
      const key = request.url;
      const e = entries.get(key);
      if (e === undefined || request.method !== "GET") return undefined;
      entries.delete(key);
      entries.set(key, e);
      return new Response(e.body.slice(), { status: e.status, headers: e.headers });
    },
    async put(request, response) {
      if (request.method !== "GET") return;
      const body = new Uint8Array(await response.arrayBuffer());
      entries.delete(request.url);
      entries.set(request.url, { status: response.status, headers: [...response.headers], body });
      while (entries.size > max) entries.delete(entries.keys().next().value as string);
    },
  };
}

const realFetch = globalThis.fetch;

/**
 * `fetch` for the lab: only 127.0.0.1 is reachable. A test that stubs
 * `globalThis.fetch` (the fake Discord) is served by its stub for any host,
 * since a stub cannot reach a network; only the real `fetch` is guarded.
 */
export function loopbackOnlyFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const current = globalThis.fetch;
  if (current !== realFetch) return current(input, init);
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== "127.0.0.1") return Promise.reject(new Error(`lab fetch refused: ${url.origin} is not 127.0.0.1`));
  return realFetch(input, init);
}

export interface NodeLabOptions {
  /** The store. Default: `toStore(env.DB)`, so `env.DB` may hold the Store itself. */
  store?: Store;
  /** Shared across requests, so a dump written by a job is served by the next request. Default: a new memory store. */
  blobs?: BlobStore;
  cache?: ResponseCache;
  ulid?: () => string;
  /** Outbound fetch. Default: loopbackOnlyFetch. */
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

/** What `waitOnExecutionContext` awaits: every task handed to `background` or `waitUntil` since the last drain. */
export interface BackgroundTasks {
  drain(): Promise<void>;
}

/** The PLATFORM factory to put on the env (src/app.ts `platformFor`). */
export function createNodeLabPlatform(opts: NodeLabOptions = {}): PlatformFactory & BackgroundTasks {
  const blobs = opts.blobs ?? memoryBlobs();
  const cache = opts.cache ?? lruResponseCache();
  const pending = new Set<Promise<unknown>>();
  const factory: PlatformFactory = (env: Bindings, ctx) => {
    const now: Clock = (env as unknown as { TEST_CLOCK?: Clock }).TEST_CLOCK ?? systemClock;
    return {
      store: opts.store ?? toStore(env.DB),
      blobs,
      cache,
      config: env,
      now,
      ulid: opts.ulid ?? (() => ulid()),
      fetch: opts.fetch ?? loopbackOnlyFetch,
      background(task) {
        const guarded = task.catch((e: unknown) => console.error(`background task failed: ${e instanceof Error ? e.message : String(e)}`));
        pending.add(guarded);
        void guarded.finally(() => pending.delete(guarded));
        ctx?.waitUntil(guarded);
      },
    };
  };
  return Object.assign(factory, {
    async drain() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  });
}
