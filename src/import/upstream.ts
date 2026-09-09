// The cmini upstream HTTP client (07 §6 S5). Ported from
// ../../../scripts/sync_cmini_data.py @ 6ed4cb13b3639a3056d35ad06b628941fade3c0c
// (fetch_with_retry, fetch_list, batch_join_details, parse_snowflake) -- a
// copy, not an import (nothing under db/ imports outside db/, LDB-G5).
//
// `fetchImpl` is injected (rather than reaching for global `fetch`) so tests
// can supply a fake without needing `cloudflare:test`'s `fetchMock`, which
// this repo's pinned @cloudflare/vitest-pool-workers (0.22.0) does not
// export from "cloudflare:test" (verified: no `fetchMock` symbol anywhere in
// its dist/types -- only the unrelated undici `MockAgent` class, which is
// not wired to the Worker's global fetch in this version). `sleepImpl` is
// injected for the same reason `now` is elsewhere: tests must not wait out
// real backoff delays.
// `signal` is optional and unused by this module's own calls -- added for
// auth/discord.ts's 5s Discord timeout (09 §2.2), which reuses this exact
// type rather than inventing a second injection shape.
export type FetchImpl = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;
export type SleepImpl = (ms: number) => Promise<void>;

const RETRIES = 3;
const BACKOFF_MS = [1000, 2000, 4000];

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class NotFoundError extends Error {}

// A Discord snowflake as the API sends it: a JSON number or a numeric
// string (the API's v2 fix for consumers whose numbers are IEEE doubles,
// which lose precision above 2**53). Returns the value as a decimal string
// (never a JS number -- `owner`/likes are TEXT columns) or null if `value`
// is neither. Booleans are excluded: `typeof true === "boolean"`, not
// reachable via the `number`/`string` branches, but called out explicitly
// to match the ported behaviour (`isinstance(True, int)` is True in Python).
export function parseSnowflake(value: unknown): string | null {
  if (typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : null;
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return value;
  return null;
}

export interface UpstreamListEntry {
  id: string;
  name: string;
  modified_at?: string;
  like_count?: number;
  [k: string]: unknown;
}

export type RawUpstreamDetail = Record<string, unknown>;

export type DetailResult = { ok: true; detail: RawUpstreamDetail } | { ok: false; notFound: true };

export interface FullResult {
  byName: Map<string, RawUpstreamDetail>;
  dupNames: Set<string>;
}

async function fetchJson(fetchImpl: FetchImpl, ua: string, url: string): Promise<unknown> {
  const res = await fetchImpl(url, { headers: { "User-Agent": ua } });
  if (res.status === 404) throw new NotFoundError(`404 not found: ${url}`);
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new Error(`invalid JSON from ${url}: ${(e as Error).message}`);
  }
}

// fetchJson, retried RETRIES times with 1s/2s/4s backoff. A 404 is
// permanent (no point retrying a missing resource) and rethrown immediately,
// never counted against the retry budget.
async function fetchWithRetry(
  fetchImpl: FetchImpl,
  sleepImpl: SleepImpl,
  ua: string,
  url: string,
): Promise<unknown> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      return await fetchJson(fetchImpl, ua, url);
    } catch (e) {
      if (e instanceof NotFoundError) throw e;
      lastErr = e;
    }
    if (attempt < RETRIES - 1) await sleepImpl(BACKOFF_MS[attempt]!);
  }
  throw new Error(`failed to fetch ${url} after ${RETRIES} attempts: ${String(lastErr)}`);
}

export class UpstreamClient {
  constructor(
    private readonly baseUrl: string,
    private readonly ua: string,
    private readonly fetchImpl: FetchImpl,
    private readonly sleepImpl: SleepImpl = realSleep,
  ) {}

  // The whole /meta body, unread field-by-field (07 §0.1: its shape has
  // been in flux) -- the caller canonicalizes it into the gate token.
  async meta(): Promise<unknown> {
    return fetchWithRetry(this.fetchImpl, this.sleepImpl, this.ua, `${this.baseUrl}/meta`);
  }

  // /layouts -- deduped by id, every entry required to carry a string id
  // (a malformed entry is a hard failure: a half-broken scrape must never
  // be consumed, per the ported script's posture).
  async list(): Promise<UpstreamListEntry[]> {
    const raw = await fetchWithRetry(this.fetchImpl, this.sleepImpl, this.ua, `${this.baseUrl}/layouts`);
    if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { layouts?: unknown }).layouts)) {
      throw new Error("/layouts response is not {layouts: [...]}");
    }
    const entries: UpstreamListEntry[] = [];
    const seen = new Set<string>();
    for (const entry of (raw as { layouts: unknown[] }).layouts) {
      if (typeof entry !== "object" || entry === null || typeof (entry as { id?: unknown }).id !== "string") {
        throw new Error(`malformed /layouts entry (no string id): ${JSON.stringify(entry)}`);
      }
      const id = (entry as { id: string }).id;
      if (seen.has(id)) continue;
      seen.add(id);
      entries.push(entry as UpstreamListEntry);
    }
    return entries;
  }

  // /layouts?full=1 -- one large response, entries carry no `id` (07 §0.1),
  // joined back to ids by the caller via `name`. Duplicate names are
  // dropped from the map into `dupNames` (the caller falls back to a per-id
  // GET for those, same posture as the ported `batch_join_details`).
  async full(): Promise<FullResult> {
    const raw = await fetchWithRetry(this.fetchImpl, this.sleepImpl, this.ua, `${this.baseUrl}/layouts?full=1`);
    if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { layouts?: unknown }).layouts)) {
      throw new Error("/layouts?full=1 response is not {layouts: [...]}");
    }
    const byName = new Map<string, RawUpstreamDetail>();
    const dupNames = new Set<string>();
    for (const entry of (raw as { layouts: unknown[] }).layouts) {
      if (typeof entry !== "object" || entry === null || typeof (entry as { name?: unknown }).name !== "string") {
        continue; // unusable without a name -- the per-id fallback covers it
      }
      const name = (entry as { name: string }).name;
      if (byName.has(name) || dupNames.has(name)) {
        byName.delete(name);
        dupNames.add(name);
        continue;
      }
      byName.set(name, entry as RawUpstreamDetail);
    }
    return { byName, dupNames };
  }

  // /layouts/<id> -- 404 is a real (non-retried) result, not a thrown
  // error: a listed id whose detail has vanished between the list GET and
  // this one is a deletion this tick (07 §0.1), not a fetch failure.
  async detail(id: string): Promise<DetailResult> {
    try {
      const raw = await fetchWithRetry(
        this.fetchImpl,
        this.sleepImpl,
        this.ua,
        `${this.baseUrl}/layouts/${encodeURIComponent(id)}`,
      );
      return { ok: true, detail: raw as RawUpstreamDetail };
    } catch (e) {
      if (e instanceof NotFoundError) return { ok: false, notFound: true };
      throw e;
    }
  }

  // /authors -> {author_name: discord_user_id}. Values are snowflakes
  // (number or numeric string); malformed entries are dropped rather than
  // failing the whole tick (07 §6 S5: authors are best-effort bookkeeping,
  // no events, never block the import).
  async authors(): Promise<Record<string, string>> {
    const raw = await fetchWithRetry(this.fetchImpl, this.sleepImpl, this.ua, `${this.baseUrl}/authors`);
    if (typeof raw !== "object" || raw === null) {
      throw new Error("/authors response is not an object");
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const id = parseSnowflake(v);
      if (id !== null) out[k] = id;
    }
    return out;
  }
}
