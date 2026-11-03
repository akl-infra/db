// Shadow's reads of production's public API (the only non-AWS host the egress guard lets through, GET only).
import { FollowerRefusal, type FeedEvent, type FormatAfter } from "./apply";

export type UpstreamFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const UPSTREAM_BASE = "https://api.akldb.org";
const UA = "akldb-shadow/1";

/** A failure that is the upstream's or the network's (retry on the next tick), not a statement about an event. */
export class UpstreamError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "UpstreamError";
  }
}

export interface Upstream {
  base: string;
  /** GET and parse JSON; non-2xx is an UpstreamError carrying the status. */
  json(path: string): Promise<unknown>;
  /** GET bytes. */
  bytes(path: string): Promise<{ bytes: Uint8Array; text: () => string }>;
}

export function createUpstream(fetchImpl: UpstreamFetch, base: string = UPSTREAM_BASE, timeoutMs = 15_000): Upstream {
  async function get(path: string, accept: string): Promise<Response> {
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, { method: "GET", headers: { "user-agent": UA, accept }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new UpstreamError(`GET ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new UpstreamError(`GET ${path}: ${res.status}`, res.status);
    }
    return res;
  }
  return {
    base,
    async json(path) {
      const res = await get(path, "application/json");
      try {
        return (await res.json()) as unknown;
      } catch (e) {
        throw new UpstreamError(`GET ${path}: the body is not JSON (${e instanceof Error ? e.message : String(e)})`);
      }
    },
    async bytes(path) {
      const res = await get(path, "*/*");
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { bytes, text: () => new TextDecoder().decode(bytes) };
    },
  };
}

/**
 * The payload a format-scope event stored, from `GET /v1/layouts/<id>/rev/<rev>?format=<format>`, checked to be the event's own:
 * the answer repeats the event's rev, format, created_at, modified_at and has_magic. A 4xx or a mismatch refuses the event
 * (FollowerRefusal); anything else is an UpstreamError (retried).
 */
export function payloadFetcher(up: Upstream): (ev: FeedEvent) => Promise<unknown> {
  return async (ev) => {
    if (ev.layout_id === null || ev.format === null || ev.rev === null) throw new FollowerRefusal(ev.seq, ev.kind, "a format event without layout, format and rev");
    const path = `/v1/layouts/${encodeURIComponent(ev.layout_id)}/rev/${ev.rev}?format=${encodeURIComponent(ev.format)}`;
    let body: unknown;
    try {
      body = await up.json(path);
    } catch (e) {
      if (e instanceof UpstreamError && e.status !== undefined && e.status >= 400 && e.status < 500) throw new FollowerRefusal(ev.seq, ev.kind, `the payload is not served: ${e.message}`);
      throw e;
    }
    const b = body as { rev?: unknown; format?: unknown; created_at?: unknown; modified_at?: unknown; has_magic?: unknown; payload?: unknown } | null;
    const a = ev.after as FormatAfter;
    if (b === null || typeof b !== "object" || b.rev !== ev.rev || b.format !== ev.format || b.created_at !== a.created_at || b.modified_at !== a.modified_at || b.has_magic !== a.has_magic || !("payload" in b)) {
      throw new FollowerRefusal(ev.seq, ev.kind, "the served revision is not this event's (rev, format, created_at, modified_at or has_magic differ)");
    }
    return b.payload;
  };
}
