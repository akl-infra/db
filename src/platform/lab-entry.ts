// The lab entry (design/aws-port.md §5.1; lane P): what every proving-ground server wraps the app in, whichever
// runtime it runs on. Runtime-agnostic on purpose (no node: import): workerd imports it through
// scripts/lab/entry/workers-lab.ts, Node and Lambda (P4) call it directly.
//
// It does four things and nothing else, and it bypasses no auth: identities are lab-signed client lanes and fake-Discord
// bearer tokens, checked by the real code.
//  1. Refuses to run unless LAB_MODE is set, and refuses any request addressed to api.akldb.org.
//  2. Freezes `Date` and reseeds `crypto.getRandomValues`/`randomUUID` from the `x-lab-now` / `x-lab-seed` request
//     headers, with the very generator scripts/lab/fuzz/d1-lab-entry.ts and src/platform/node-lab-server.ts use, so a
//     request sent to two servers mints the same ULIDs, nonces and timestamps.
//  3. Patches `fetch` so only 127.0.0.1 is reachable.
//  4. Falls back to the pinned Discord base (`https://discord.com/api`) when DISCORD_API_URL is unset, exactly as
//     wrangler.toml and the Lambda config do (tests/lab/discord-base.test.ts).
//
// The oracle entry (fuzz/d1-lab-entry.ts) and p1-crawl-diff.mjs's inline one are NOT rewritten to import this: p1-crawl-diff
// writes its entry into a checkout of the BASE revision, which has no such file, and neither sets LAB_MODE. The generator
// below is pinned to theirs by a literal sequence in tests/lab/entry.test.ts, so the three cannot drift unseen.

/** The default Discord base: wrangler.toml's [vars] value, today's production string. */
export const PINNED_DISCORD_API_URL = "https://discord.com/api";
export const LAB_DEFAULT_NOW = "2026-10-25T12:00:00.000Z";
export const PRODUCTION_HOST = "api.akldb.org";

/** Thrown (and answered as 503) when the lab entry refuses to serve. */
export class LabRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** The pieces of the runtime the entry patches; defaults to `globalThis`, a test passes a stand-in. */
export interface LabGlobals {
  Date: DateConstructor;
  crypto: Crypto;
  fetch: typeof fetch;
  caches?: { default: unknown };
}

export function assertLabMode(env: unknown): void {
  const mode = (env as { LAB_MODE?: unknown } | null | undefined)?.LAB_MODE;
  if (typeof mode !== "string" || mode === "" || mode === "off" || mode === "0" || mode === "false") {
    throw new LabRefusal("lab_mode_unset", "LAB_MODE is not set: the lab entry only runs in a lab stage");
  }
}

/** True for a request addressed to production: the URL host or the Host header. */
export function addressedToProduction(req: Request): boolean {
  const hosts = [new URL(req.url).hostname, (req.headers.get("host") ?? "").split(":")[0] ?? ""];
  return hosts.some((h) => h.toLowerCase() === PRODUCTION_HOST);
}

/** `env` with DISCORD_API_URL defaulted to the pinned string. The prototype chain keeps every binding as it was. */
export function withDiscordDefault<E>(env: E): E {
  const e = env as { DISCORD_API_URL?: unknown };
  if (typeof e.DISCORD_API_URL === "string" && e.DISCORD_API_URL !== "") return env;
  return Object.create(env as object, { DISCORD_API_URL: { value: PINNED_DISCORD_API_URL, enumerable: true } }) as E;
}

// --- determinism -----------------------------------------------------------------------------------------------

export interface Determinism {
  /** Apply the request's `x-lab-now` / `x-lab-seed` headers. */
  arm(headers: Headers): void;
  /** Set the clock and the seed directly. */
  set(nowMs?: number, seed?: number): void;
}

export interface DeterminismOptions {
  /** True while code that must see real randomness runs (the AWS SDK's request ids, in Node: an AsyncLocalStorage scope). */
  exempt?: () => boolean;
}

/** The oracle's generator (mulberry32 step). Exported so a test can pin it. */
export function labRandom(initial = 1): { next(): number; fill<T extends ArrayBufferView>(a: T): T; seed(s: number): void } {
  let state = initial >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
  return {
    next,
    seed: (s) => {
      state = s >>> 0;
    },
    fill<T extends ArrayBufferView>(arr: T): T {
      const u8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
      for (let i = 0; i < u8.length; i++) u8[i] = next() & 0xff;
      return arr;
    },
  };
}

export function installDeterminism(g: LabGlobals = globalThis as unknown as LabGlobals, opts: DeterminismOptions = {}): Determinism {
  const RealDate = g.Date;
  let frozenMs = RealDate.parse(LAB_DEFAULT_NOW);
  const rng = labRandom(1);
  const exempt = opts.exempt ?? (() => false);
  class LabDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(frozenMs);
      else super(...(args as [number]));
    }
    static override now(): number {
      return frozenMs;
    }
  }
  g.Date = LabDate as unknown as DateConstructor;
  const c = g.crypto;
  const realGet = c.getRandomValues.bind(c);
  const realUuid = c.randomUUID.bind(c);
  Object.defineProperty(c, "getRandomValues", {
    configurable: true,
    writable: true,
    value: <T extends ArrayBufferView>(a: T): T => (exempt() ? (realGet(a as never) as T) : rng.fill(a)),
  });
  Object.defineProperty(c, "randomUUID", {
    configurable: true,
    writable: true,
    value: () => {
      if (exempt()) return realUuid();
      const b = new Uint8Array(16);
      rng.fill(b);
      b[6] = (b[6]! & 0x0f) | 0x40;
      b[8] = (b[8]! & 0x3f) | 0x80;
      const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    },
  });
  return {
    arm(headers) {
      const n = headers.get("x-lab-now");
      if (n !== null) frozenMs = RealDate.parse(n);
      const s = headers.get("x-lab-seed");
      if (s !== null) rng.seed(Number(s) >>> 0);
    },
    set(nowMs, seed) {
      if (nowMs !== undefined) frozenMs = nowMs;
      if (seed !== undefined) rng.seed(seed);
    },
  };
}

// --- outbound fetch ----------------------------------------------------------------------------------------------

/** `fetch` that reaches 127.0.0.1 only. */
export function loopbackGuard(real: typeof fetch): typeof fetch {
  const guarded = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let host: string;
    try {
      host = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).hostname;
    } catch {
      return Promise.reject(new LabRefusal("lab_fetch_refused", "lab fetch refused: not a URL"));
    }
    if (host !== "127.0.0.1") return Promise.reject(new LabRefusal("lab_fetch_refused", `lab fetch refused: ${host} is not 127.0.0.1`));
    return real(input as never, init);
  };
  return guarded as typeof fetch;
}

const GUARD = Symbol.for("akldb.lab.fetchGuard");

export function installFetchGuard(g: LabGlobals = globalThis as unknown as LabGlobals): void {
  if ((g.fetch as unknown as Record<symbol, unknown>)[GUARD] === true) return;
  const guarded = loopbackGuard(g.fetch.bind(g) as typeof fetch);
  (guarded as unknown as Record<symbol, unknown>)[GUARD] = true;
  try {
    Object.defineProperty(g, "fetch", { configurable: true, writable: true, value: guarded });
  } catch {
    g.fetch = guarded;
  }
  if (g.fetch !== guarded) throw new LabRefusal("lab_fetch_unguarded", "cannot guard fetch: refusing to start");
}

/**
 * No edge cache. conditional() serves a cached 200 whose ETag matches; an ETag is (head seq, query), sound in production
 * where events 1..seq never change, but a lab server rebuilds its database between sequences, so an earlier run's cached
 * page carries the same ETag as the new one's (fuzz seed 1, sequence 40). The oracle and the DynamoDB lab server therefore
 * both run uncached, and so does every entry built here.
 */
export function disableEdgeCache(g: LabGlobals = globalThis as unknown as LabGlobals): void {
  if (g.caches === undefined) return;
  Object.defineProperty(g.caches, "default", {
    configurable: true,
    value: { match: async () => undefined, put: async () => {}, delete: async () => false },
  });
}

// --- the entry -----------------------------------------------------------------------------------------------------

interface Worker<E> {
  fetch(req: Request, env: E, ctx: ExecutionContext): Response | Promise<Response>;
  scheduled?(ev: unknown, env: E, ctx: ExecutionContext): void | Promise<void>;
}

export interface LabEntryOptions<E> {
  globals?: LabGlobals;
  exempt?: () => boolean;
  /** Lab-only control routes (`/__lab/*`), tried before the app; return null to fall through. */
  control?: (req: Request, env: E) => Promise<Response | null>;
}

function refusal(e: LabRefusal, status = 503): Response {
  return Response.json({ error: e.code, message: e.message }, { status });
}

/** Wrap `worker` as the lab entry. Nothing is patched until the first request has passed the LAB_MODE check. */
export function createLabEntry<E>(worker: Worker<E>, opts: LabEntryOptions<E> = {}): Required<Pick<Worker<E>, "fetch">> & Pick<Worker<E>, "scheduled"> {
  let det: Determinism | undefined;
  const boot = (env: E): Determinism => {
    assertLabMode(env);
    if (det === undefined) {
      const g = opts.globals ?? (globalThis as unknown as LabGlobals);
      installFetchGuard(g);
      disableEdgeCache(g);
      det = installDeterminism(g, { exempt: opts.exempt });
    }
    return det;
  };
  return {
    async fetch(req, env, ctx) {
      let d: Determinism;
      try {
        d = boot(env);
      } catch (e) {
        if (e instanceof LabRefusal) return refusal(e);
        throw e;
      }
      if (addressedToProduction(req)) return refusal(new LabRefusal("lab_refuses_production", `the lab never serves ${PRODUCTION_HOST}`), 403);
      const control = opts.control === undefined ? null : await opts.control(req, env);
      if (control !== null) return control;
      d.arm(req.headers);
      return worker.fetch(req, withDiscordDefault(env), ctx);
    },
    async scheduled(ev, env, ctx) {
      boot(env);
      await worker.scheduled?.(ev, withDiscordDefault(env), ctx);
    },
  };
}
