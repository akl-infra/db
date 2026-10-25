// The Cloudflare Workers platform (src/platform/port.ts): D1 store, R2
// blobs, caches.default, waitUntil. Behaviour is exactly today's: the cache
// and blob code below is what core/etag.ts and routes/dump.ts do inline.
import { ulid } from "ulidx";
import type { Bindings } from "../env";
import { systemClock, type Clock } from "../core/time";
import { toStore } from "../store/arg";
import type { BlobStore, Platform, ResponseCache } from "./port";

function r2Blobs(bucket: R2Bucket): BlobStore {
  return {
    async get(key) {
      const obj = await bucket.get(key);
      if (obj === null) return null;
      return { body: obj.body, httpEtag: obj.httpEtag, contentType: obj.httpMetadata?.contentType ?? null, size: obj.size };
    },
    async put(key, body, contentType) {
      await bucket.put(key, body, { httpMetadata: { contentType } });
    },
  };
}

// `caches.default` is inert on *.workers.dev (07 §0.1): both calls are
// best-effort, exactly as core/etag.ts's conditional()/cachePut().
const edgeCache: ResponseCache = {
  async match(request) {
    try {
      return await caches.default.match(request);
    } catch {
      return undefined;
    }
  },
  async put(request, response) {
    try {
      await caches.default.put(request, response);
    } catch {
      // best-effort only
    }
  },
};

/** The platform for one request (or one scheduled run) on Workers. */
export function workersPlatform(env: Bindings, ctx: { waitUntil(p: Promise<unknown>): void } | undefined): Platform {
  const now: Clock = (env as unknown as { TEST_CLOCK?: Clock }).TEST_CLOCK ?? systemClock;
  return {
    // `toStore` is createD1Store(env.DB), plus the production mirror's recorder when the unit of work carries one.
    store: toStore(env.DB),
    blobs: r2Blobs(env.DUMPS),
    cache: edgeCache,
    config: env,
    now,
    ulid: () => ulid(),
    fetch: (input, init) => fetch(input, init),
    background(task) {
      const guarded = task.catch((e: unknown) => console.error(`background task failed: ${e instanceof Error ? e.message : String(e)}`));
      if (ctx !== undefined) ctx.waitUntil(guarded);
    },
  };
}
