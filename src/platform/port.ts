// The platform port (design/aws-port.md §4.1). FROZEN at P1 start with
// src/store/port.ts. Everything the app needs from its host besides
// storage: time, ids, outbound fetch, post-response work, the validated
// response cache, blob storage (dumps), and configuration. Implementations:
// platform/workers.ts (Cloudflare, P1), platform/lambda.ts and
// platform/node.ts (P2/P3).
import type { Clock } from "../core/time";
import type { Store } from "../store/port";

/** A stored blob (an R2 object today, S3 later). `httpEtag` is the quoted ETag the object is served with. */
export interface BlobObject {
  body: ReadableStream<Uint8Array>;
  httpEtag: string;
  contentType: string | null;
  size: number;
}

export interface BlobStore {
  /** strong, read. null if absent. */
  get(key: string): Promise<BlobObject | null>;
  /** single. Overwrite. */
  put(key: string, body: Uint8Array | string, contentType: string): Promise<void>;
}

/**
 * The validated response cache behind `core/etag.ts` `conditional()`/`cachePut()`:
 * a hit counts only when its `ETag` equals the one the caller just computed,
 * so it can never serve stale data. Best-effort; failures act as a miss.
 */
export interface ResponseCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

/** Host configuration: the Worker's `[vars]` and secrets, by name (src/env.ts minus the bindings). */
export interface PlatformConfig {
  DISCORD_API_URL: string;
  MODQUEUE_DISCORD_WEBHOOK?: string;
  MODQUEUE_DISCORD_COMPONENTS?: string;
  MODQUEUE_DISCORD_BOT_TOKEN?: string;
  MODQUEUE_DISCORD_APPLICATION_ID?: string;
  MODQUEUE_DISCORD_PUBLIC_KEY?: string;
  MODQUEUE_DISCORD_GUILD_ID?: string;
  MODQUEUE_DISCORD_CHANNEL_ID?: string;
  MODQUEUE_DISCORD_CARDS?: string;
  MODQUEUE_DISCORD_ACTIONS?: string;
  MODQUEUE_DISCORD_DMS?: string;
}

export interface Platform {
  readonly store: Store;
  readonly blobs: BlobStore;
  readonly cache: ResponseCache;
  readonly config: PlatformConfig;
  /** ISO-8601 now; tests inject a fake (TEST_CLOCK). */
  readonly now: Clock;
  /** A new ULID; tests may seed it. */
  ulid(): string;
  /** Outbound HTTP (Discord). */
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  /** Run `task` after the response is sent; never rejects the request. Workers: waitUntil. Lambda: awaited after the stream ends. */
  background(task: Promise<unknown>): void;
}
