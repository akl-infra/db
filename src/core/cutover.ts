// The cutover modes (design/aws-port.md §5.2; LDB-CUT6..CUT12). The flag is `store.cutover.mode()`: D1 `import_state['cutover.mode']`
// or DynamoDB `STATE/cutover.mode`, cached 1 s. `null` (the normal case, and every deployment that never sets the flag) changes nothing.
//   - `read_only`: every non-safe request gets `503 read_only` (`Retry-After`), reads continue. Mounted right after the actor is
//     resolved, before idempotency and the rate limit, so a frozen write is neither replayed from nor charged to either. The Discord
//     interaction POST is gated too (it writes), and so are the scheduled jobs (`frozen`): nothing may write after the final seq.
//   - `proxy`: the Worker forwards the request (method, headers, body) to `CUTOVER_PROXY_URL`, the AWS stage, and returns its response
//     as is. It is the first thing after the platform, so even a request the local stack would have refused is the AWS stack's to
//     answer. A forwarded request carries `X-Akldb-Proxied`; one that arrives carrying it is served locally, so a misconfigured URL that
//     points back here cannot loop.
import type { Context, MiddlewareHandler } from "hono";
import { SAFE_METHODS } from "../auth/actor";
import { type AppEnv, platformOf } from "../app";
import type { Store } from "../store/port";
import { describeError } from "./describe-error";
import { internal, readOnly } from "./errors";

export const PROXIED_HEADER = "X-Akldb-Proxied";

// Hop-by-hop and connection-specific headers are the forwarder's, not the client's.
const DROPPED_REQUEST_HEADERS = new Set(["host", "connection", "keep-alive", "transfer-encoding", "te", "upgrade", "proxy-authorization", "content-length", "accept-encoding"]);
// The forwarded request asks for an identity body (accept-encoding dropped), and the runtime re-frames the rest.
const DROPPED_RESPONSE_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding"]);

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

function fetchOf(c: Context<AppEnv>): FetchLike {
  return (c.env as unknown as { TEST_CUTOVER_FETCH?: FetchLike }).TEST_CUTOVER_FETCH ?? ((input, init) => platformOf(c).fetch(input, init));
}

/** The flags are read only where `CUTOVER_ARMED=on` (every AWS stage; D1 from the staging of a cutover). Unarmed, no request or tick
 *  queries the store for them, so production keeps today's statement counts (LDB-R9). */
export function cutoverArmed(env: { CUTOVER_ARMED?: string }): boolean {
  return env.CUTOVER_ARMED === "on";
}

/** The mode, or null without a store read when unarmed. */
async function modeOf(c: Context<AppEnv>): Promise<"read_only" | "proxy" | null> {
  return cutoverArmed(c.env) ? platformOf(c).store.cutover.mode() : null;
}

/** True while a cutover owns the data: scheduled work must not write (read_only) or belongs to the other side (proxy). */
export async function frozen(store: Pick<Store, "cutover">, env: { CUTOVER_ARMED?: string }): Promise<boolean> {
  return cutoverArmed(env) && (await store.cutover.mode()) !== null;
}

/** Mounted right after `platformMiddleware`. */
export function cutoverProxy(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if ((await modeOf(c)) !== "proxy" || c.req.header(PROXIED_HEADER) !== undefined) {
      await next();
      return;
    }
    const base = c.env.CUTOVER_PROXY_URL;
    if (base === undefined || base === "") {
      console.error("cutover: mode is 'proxy' but CUTOVER_PROXY_URL is unset");
      throw internal();
    }
    const incoming = new URL(c.req.url);
    const target = new URL(incoming.pathname + incoming.search, base.endsWith("/") ? base : `${base}/`);
    const headers = new Headers();
    for (const [name, value] of c.req.raw.headers) if (!DROPPED_REQUEST_HEADERS.has(name.toLowerCase())) headers.append(name, value);
    headers.set(PROXIED_HEADER, "1");
    const hasBody = c.req.method !== "GET" && c.req.method !== "HEAD";
    let upstream: Response;
    try {
      upstream = await fetchOf(c)(target.toString(), {
        method: c.req.method,
        headers,
        body: hasBody ? await c.req.raw.arrayBuffer() : undefined,
        redirect: "manual",
      });
    } catch (e) {
      console.error(`cutover: proxy to ${target.origin} failed: ${describeError(e)}`);
      throw internal();
    }
    const out = new Headers();
    for (const [name, value] of upstream.headers) if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) out.append(name, value);
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
  };
}

/** Mounted after actor resolution on `/v1/*`, and on the Discord interaction path. */
export function cutoverReadOnly(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method) && (await modeOf(c)) === "read_only") throw readOnly();
    await next();
  };
}
