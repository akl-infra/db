// Where the replay's requests come from (LDB-PV8): Workers Observability for akl-db (the telemetry query API, token CF_OBS_TOKEN,
// read only), or a Logpush NDJSON tree that was already fetched. Both give method + URL (and, where present, whether the
// request had If-None-Match). Nothing else is kept: no header values, no body, no client address, no user agent.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export const ACCOUNT_ID = "58a5eb82948e2134d8b7b242e9567ac4";
export const SERVICE = "akl-db";
const API = "https://api.cloudflare.com/client/v4";

/** `get(obj, "a.b.c")` over nested objects, falling back to the flat dotted key (telemetry events come either way). */
export function get(obj, dotted) {
  if (obj !== null && typeof obj === "object" && dotted in obj) return obj[dotted];
  let cur = obj;
  for (const part of dotted.split(".")) {
    if (cur === null || typeof cur !== "object" || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}
const first = (obj, names) => {
  for (const n of names) {
    const v = get(obj, n);
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
};

/** Header names (lower-case) whose VALUES could be credentials or identify a person. Only the presence of if-none-match is kept. */
export const CREDENTIAL_HEADERS = ["authorization", "cookie", "x-akl-client", "x-akl-signature", "x-akl-nonce", "x-akl-actor", "x-akl-timestamp", "cf-access-jwt-assertion", "x-akldb-origin", "proxy-authorization"];

/**
 * One telemetry event or Logpush line -> `{ts, method, path, query, inm}`, or null when it is not a request. Only method, URL
 * and the presence of If-None-Match survive; every other header is dropped here, before anything else sees the record.
 */
export function extractRequest(ev) {
  const rawUrl = first(ev, ["$workers.event.request.url", "$workers.request.url", "source.request.url", "request.url", "Event.Request.URL", "Event.Request.Url"]);
  const method = first(ev, ["$workers.event.request.method", "$workers.request.method", "source.request.method", "request.method", "Event.Request.Method"]);
  if (typeof rawUrl !== "string" || typeof method !== "string") return null;
  let u;
  try {
    u = new URL(rawUrl, "http://logpush.invalid");
  } catch {
    return null;
  }
  const ts = Number(first(ev, ["timestamp", "$metadata.timestamp", "EventTimestampMs", "Event.TimestampMs"]));
  const headers = first(ev, ["$workers.event.request.headers", "source.request.headers", "request.headers", "Event.Request.Headers"]);
  let inm = false;
  if (headers !== null && typeof headers === "object") inm = Object.keys(headers).some((k) => k.toLowerCase() === "if-none-match");
  return { ts: Number.isFinite(ts) ? ts : 0, method: method.toUpperCase(), path: u.pathname, query: u.search, inm };
}

/** A telemetry query response -> its events, whichever level the API nests them at. */
export function eventsOf(body) {
  const r = body?.result ?? body;
  const evs = r?.events?.events ?? r?.events ?? [];
  return Array.isArray(evs) ? evs : [];
}

/**
 * All akl-db events in [fromMs, toMs): pages of `limit` by event-id cursor, windows of `windowMs`, `maxPages` pages at most.
 * `fetchImpl` is injected (tests); the real call sends the token only in the Authorization header of this one endpoint.
 */
export async function fetchTelemetry({ token, fromMs, toMs, windowMs = 15 * 60_000, limit = 1000, maxPages = 60, fetchImpl = fetch, accountId = ACCOUNT_ID, service = SERVICE }) {
  if (!(Number.isInteger(fromMs) && Number.isInteger(toMs) && fromMs < toMs)) throw new Error("fromMs and toMs must be integers with fromMs < toMs");
  const events = [];
  const seen = new Set();
  let pages = 0;
  for (let from = fromMs; from < toMs; from += windowMs) {
    const to = Math.min(from + windowMs, toMs);
    let cursor;
    for (;;) {
      if (pages >= maxPages) return { events, pages, truncated: true };
      pages++;
      const body = {
        queryId: "akldb-shadow-replay",
        dry: true,
        view: "events",
        limit,
        timeframe: { from, to },
        parameters: { filterCombination: "and", filters: [{ key: "$metadata.service", operation: "eq", type: "string", value: service }] },
        ...(cursor !== undefined ? { offset: cursor, offsetDirection: "next" } : {}),
      };
      const res = await fetchImpl(`${API}/accounts/${accountId}/workers/observability/telemetry/query`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "manual",
      });
      if (!res.ok) throw new Error(`telemetry query: ${res.status}`);
      const page = eventsOf(await res.json());
      let fresh = 0;
      for (const e of page) {
        const id = get(e, "$metadata.id");
        if (id !== undefined && seen.has(id)) continue;
        if (id !== undefined) seen.add(id);
        events.push(e);
        fresh++;
      }
      if (page.length < limit || fresh === 0) break;
      const last = get(page[page.length - 1], "$metadata.id");
      if (last === undefined || last === cursor) break;
      cursor = last;
    }
  }
  return { events, pages, truncated: false };
}

/** Logpush NDJSON (plain or gzip) files under a path -> requests. */
export function readLogpush(root) {
  const files = [];
  const walk = (p) => {
    const st = fs.statSync(p);
    if (st.isFile()) return files.push(p);
    for (const e of fs.readdirSync(p, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) walk(path.join(p, e.name));
  };
  walk(root);
  const out = [];
  for (const f of files.filter((x) => /\.(log\.gz|log|ndjson|ndjson\.gz)$/.test(x))) {
    const buf = fs.readFileSync(f);
    const text = (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf).toString("utf8");
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const r = extractRequest(JSON.parse(line));
        if (r !== null) out.push(r);
      } catch {
        /* not a request line */
      }
    }
  }
  return out;
}
