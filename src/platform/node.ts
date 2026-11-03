// The Node platform (design A, phase A): what the shim test project, the
// differential fuzzer's candidate and the Lambda harness run the app on.
// The store is store/d1 over a request-scoped shim D1 (src/store/shim) on a
// Replica; blobs are in memory (an S3 stand-in); the response cache is a
// validated in-memory LRU with the same contract as the `caches.default` use
// in platform/workers.ts (a hit counts only when its ETag equals the one the
// caller just computed, so it can never serve stale data). No cloud in here.
import { createHash } from "node:crypto";
import { ulid } from "ulidx";
import type { PlatformFactory } from "../app";
import { systemClock, type Clock } from "../core/time";
import type { Bindings } from "../env";
import type { Replica } from "../replica/replica";
import { createShimD1 } from "../store/shim/d1";
import { createD1Store } from "../store/d1";
import type { BlobObject, BlobStore, Platform, ResponseCache } from "./port";

/** An in-memory BlobStore (S3/R2 stand-in). `httpEtag` is the quoted md5, as R2 serves it. */
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
            c.enqueue(bytes.slice());
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

/** The `DUMPS` R2 binding over a BlobStore: `get` answers R2-like objects (or null), `put` stores. platform/workers.ts and routes read it that way. */
export function r2Binding(blobs: BlobStore): R2Bucket {
  return {
    async get(key: string) {
      const o = await blobs.get(key);
      if (o === null) return null;
      const bytes = new Uint8Array(await new Response(o.body).arrayBuffer());
      return {
        key,
        size: bytes.byteLength,
        httpEtag: o.httpEtag,
        httpMetadata: { contentType: o.contentType ?? undefined },
        get body() {
          return new Response(bytes).body;
        },
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        text: async () => new TextDecoder().decode(bytes),
        json: async () => JSON.parse(new TextDecoder().decode(bytes)),
      };
    },
    async put(key: string, value: string | ArrayBuffer | ArrayBufferView, options?: { httpMetadata?: { contentType?: string } }) {
      const bytes = typeof value === "string" ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      await blobs.put(key, bytes, options?.httpMetadata?.contentType ?? "application/octet-stream");
      return null;
    },
  } as unknown as R2Bucket;
}

/** A validated LRU response cache (GET only, keyed by URL); the caller compares the ETag, so staleness cannot be served. */
export function lruResponseCache(max = 256): ResponseCache & { clear(): void } {
  const entries = new Map<string, { status: number; headers: [string, string][]; body: Uint8Array }>();
  return {
    async match(request) {
      const e = entries.get(request.url);
      if (e === undefined || request.method !== "GET") return undefined;
      entries.delete(request.url);
      entries.set(request.url, e);
      return new Response(e.body.slice(), { status: e.status, headers: e.headers });
    },
    async put(request, response) {
      if (request.method !== "GET") return;
      const body = new Uint8Array(await response.arrayBuffer());
      entries.delete(request.url);
      entries.set(request.url, { status: response.status, headers: [...response.headers], body });
      while (entries.size > max) entries.delete(entries.keys().next().value as string);
    },
    clear() {
      entries.clear();
    },
  };
}

const realFetch = globalThis.fetch;

/**
 * `fetch` for tests and the fuzzer: only 127.0.0.1 is reachable. A test that stubs `globalThis.fetch` (the fake
 * Discord) is served by its stub for any host; only the real `fetch` is guarded.
 */
export function loopbackOnlyFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const current = globalThis.fetch;
  if (current !== realFetch) return current(input, init);
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== "127.0.0.1") return Promise.reject(new Error(`fetch refused: ${url.origin} is not 127.0.0.1`));
  return realFetch(input, init);
}

export interface NodePlatformOptions {
  /** The replica one request's shim reads and writes. Required unless `d1` supplies the database. */
  replica?: Replica;
  /** The D1Database one request's store runs on. Default: a new request-scoped shim over `replica` (SH7). A harness whose tests swap `env.DB` for a spy returns that here. */
  d1?: (env: Bindings) => D1Database;
  /** Shared across requests, so a dump written by a job is served by the next request. Default: a new memory store. */
  blobs?: BlobStore;
  cache?: ResponseCache;
  ulid?: () => string;
  /** Outbound fetch. Default: the global fetch at call time (tests stub it). */
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Platform.handOff. Default: none (the job runs in `background`). */
  handOff?: (job: "discord") => Promise<void>;
}

/** What `waitOnExecutionContext` awaits: every task handed to `background` or `waitUntil` since the last drain. */
export interface BackgroundTasks {
  drain(): Promise<void>;
  readonly blobs: BlobStore;
  readonly cache: ResponseCache;
}

/** The PLATFORM factory to put on the env (src/app.ts `platformFor`): each call builds a request-scoped store (SH7). */
export function createNodePlatform(opts: NodePlatformOptions): PlatformFactory & BackgroundTasks {
  const blobs = opts.blobs ?? memoryBlobs();
  const cache = opts.cache ?? lruResponseCache();
  const pending = new Set<Promise<unknown>>();
  const database = (env: Bindings): D1Database => {
    if (opts.d1 !== undefined) return opts.d1(env);
    if (opts.replica === undefined) throw new Error("createNodePlatform needs a replica or a d1 factory");
    return createShimD1(opts.replica, { requestScoped: true });
  };
  const factory: PlatformFactory = (env: Bindings, ctx): Platform => {
    const now: Clock = (env as unknown as { TEST_CLOCK?: Clock }).TEST_CLOCK ?? systemClock;
    return {
      store: createD1Store(database(env)),
      blobs,
      cache,
      config: env,
      now,
      ulid: opts.ulid ?? (() => ulid()),
      fetch: opts.fetch ?? ((input, init) => globalThis.fetch(input, init)),
      ...(opts.handOff !== undefined ? { handOff: opts.handOff } : {}),
      background(task) {
        const guarded = task.catch((e: unknown) => console.error(`background task failed: ${e instanceof Error ? e.message : String(e)}`));
        pending.add(guarded);
        void guarded.finally(() => pending.delete(guarded));
        ctx?.waitUntil(guarded);
        // Test-only hatch, the same as the Workers platform's: a test that sets this array awaits the background work.
        (env as unknown as { TEST_BACKGROUND?: Promise<unknown>[] }).TEST_BACKGROUND?.push(guarded);
      },
    };
  };
  return Object.assign(factory, {
    blobs,
    cache,
    async drain() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  });
}
