// Lane R: the Logpush parser (design/aws-port.md §5.1). Input: Workers trace events as gzip NDJSON under
// `<YYYYMMDD>/<YYYYMMDD>/<start>_<end>_<id>.log.gz`. Fields used: EventTimestampMs, Event.Request.URL/Method,
// Event.Response.Status, Outcome, ScriptName, wall/CPU time. There are NO request headers or bodies.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/** `get(obj, "Event.Request.URL")` over nested objects, falling back to a flat dotted key. */
export function get(obj, dotted) {
  if (obj !== null && typeof obj === "object" && dotted in obj) return obj[dotted];
  let cur = obj;
  for (const part of dotted.split(".")) {
    if (cur === null || typeof cur !== "object" || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

const firstOf = (obj, names) => {
  for (const n of names) {
    const v = get(obj, n);
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
};

/**
 * One NDJSON line -> a normalized request, or `{ error }` for a line that is not a request event.
 * `{ts, method, path, query, status, outcome, script, wallMs, cpuMs, bytes, src}`; `path` has no query, `query`
 * keeps its leading `?` (or is empty).
 */
export function parseLine(line) {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return { error: "json" };
  }
  if (o === null || typeof o !== "object") return { error: "json" };
  const ts = Number(firstOf(o, ["EventTimestampMs", "Event.TimestampMs"]));
  const rawUrl = firstOf(o, ["Event.Request.URL", "Event.Request.Url"]);
  const method = firstOf(o, ["Event.Request.Method"]);
  if (!Number.isFinite(ts) || typeof rawUrl !== "string" || typeof method !== "string") return { error: "not-a-request" };
  let u;
  try {
    u = new URL(rawUrl, "http://logpush.invalid");
  } catch {
    return { error: "url" };
  }
  const status = Number(firstOf(o, ["Event.Response.Status"]) ?? 0);
  return {
    ts,
    method: method.toUpperCase(),
    path: u.pathname,
    query: u.search,
    host: rawUrl.startsWith("http") ? u.host : "",
    status: Number.isFinite(status) ? status : 0,
    outcome: String(firstOf(o, ["Outcome"]) ?? ""),
    script: String(firstOf(o, ["ScriptName"]) ?? ""),
    wallMs: Number(firstOf(o, ["WallTimeMs", "WallTime"]) ?? 0) || 0,
    cpuMs: Number(firstOf(o, ["CPUTimeMs", "CPUTime"]) ?? 0) || 0,
    // Not guaranteed to exist (the verified production format has none); used for erased-comment lengths when present.
    bytes: firstOf(o, ["Event.Request.BodyBytes", "Event.Request.ContentLength", "Event.Request.Size"]),
  };
}

/** A whole buffer (gzip or plain) -> `{requests, errors}`; `errors` counts unparsable lines by reason. */
export function parseBuffer(buf, src = "") {
  const text = (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf).toString("utf8");
  const requests = [];
  const errors = {};
  let n = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const r = parseLine(line);
    if (r.error !== undefined) {
      errors[r.error] = (errors[r.error] ?? 0) + 1;
      continue;
    }
    r.src = src;
    r.n = n++;
    requests.push(r);
  }
  return { requests, errors };
}

/** Every `*.log.gz` / `*.log` / `*.ndjson` file under a day directory (or a file), sorted by name. */
export function listLogFiles(root) {
  const st = fs.statSync(root);
  if (st.isFile()) return [root];
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(log\.gz|log|ndjson|ndjson\.gz)$/.test(e.name)) out.push(f);
    }
  };
  walk(root);
  return out;
}

/** Read a Logpush tree, return all requests sorted by (EventTimestampMs, file, line) -- the replay order. */
export function readLogs(root, opts = {}) {
  const requests = [];
  const errors = {};
  const files = listLogFiles(root);
  for (const f of files) {
    const r = parseBuffer(fs.readFileSync(f), path.relative(root, f) || path.basename(f));
    for (const x of r.requests) requests.push(x);
    for (const [k, v] of Object.entries(r.errors)) errors[k] = (errors[k] ?? 0) + v;
  }
  let kept = requests;
  if (opts.script !== undefined) kept = kept.filter((r) => r.script === opts.script);
  kept.sort((a, b) => a.ts - b.ts || (a.src < b.src ? -1 : a.src > b.src ? 1 : a.n - b.n));
  return { requests: kept, errors, files: files.length, filtered: requests.length - kept.length };
}
