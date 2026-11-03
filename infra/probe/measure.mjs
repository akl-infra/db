// The latency probe's measurement (LDB-PV9): the same measurement as handoff/aws-tools/akldb/latency-compare.py, in JS, so it can
// run inside the probe Lambda in us-east-2 (the vantage of gate (a): Spark's). Per route and host: the 200 path (full responses,
// the first request of each route is a connection warm-up and is dropped) and the 304 path (If-None-Match with the ETag the
// same host just gave), p50 and p95, over one keep-alive connection per host. Prod and shadow are measured alternately,
// request by request, so a slow minute hurts both the same.
import https from "node:https";
import http from "node:http";

export const UA = "akldb-latency-compare/1";

/** The routes of latency-compare.py, same order. */
export const ROUTES = [
  ["/v1/meta", "validated (head seq + authors + import state)"],
  ["/v1/formats", "static (code only, no DB)"],
  ["/v1/layouts?format=spark/1&limit=50", "validated list"],
  ["/v1/authors", "validated (authors_head)"],
  ["/v1/comment-counts", "validated"],
  ["/v1/changes?since=0&limit=50", "validated feed page"],
  ["/v1/wpm", "validated"],
  ["/v1/dump/latest.json", "blob (R2 / S3)"],
  ["/v1/does-not-exist", "404 path (pure routing)"],
];

export const ALLOWED_HOSTS = new Set(["api.akldb.org", "shadow-api.akldb.org", "staging-api.akldb.org"]);

/** Python's round(): half to even. */
function roundHalfEven(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

/** latency-compare.py's pct(): nearest index round(p * (n - 1)), half to even; NaN for no samples. */
export function pct(xs, p) {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, roundHalfEven(p * (s.length - 1)))];
}

/** One keep-alive client for one origin: `get(path, headers)` resolves {status, headers, ms, bytes}. */
export function client(origin, { allowLocal = false } = {}) {
  const u = new URL(origin);
  const local = allowLocal && u.hostname === "127.0.0.1" && u.protocol === "http:";
  if (!local && (u.protocol !== "https:" || !ALLOWED_HOSTS.has(u.hostname))) throw new Error(`the probe measures only ${[...ALLOWED_HOSTS].join(", ")} (got ${origin})`);
  const lib = local ? http : https;
  const agent = new lib.Agent({ keepAlive: true, maxSockets: 1 });
  return {
    origin,
    get(path, headers = {}) {
      return new Promise((resolve, reject) => {
        const t = process.hrtime.bigint();
        const req = lib.request({ agent, host: u.hostname, port: u.port || (local ? 80 : 443), path, method: "GET", headers: { "user-agent": UA, ...headers }, timeout: 30_000 }, (res) => {
          let bytes = 0;
          res.on("data", (c) => void (bytes += c.length));
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, ms: Number(process.hrtime.bigint() - t) / 1e6, bytes }));
          res.on("error", reject);
        });
        req.on("timeout", () => req.destroy(new Error("timeout")));
        req.on("error", reject);
        req.end();
      });
    },
    close: () => agent.destroy(),
  };
}

/**
 * @param {{targets: Record<string,string>, n?: number, routes?: [string,string][], allowLocal?: boolean}} o
 * `targets` maps a label (prod, shadow) to an origin. Returns raw samples and a summary per route and label.
 */
export async function probe({ targets, n = 20, routes = ROUTES, allowLocal = false }) {
  const labels = Object.keys(targets);
  const clients = Object.fromEntries(labels.map((l) => [l, client(targets[l], { allowLocal })]));
  const startedAt = new Date().toISOString();
  const out = [];
  try {
    for (const [path, kind] of routes) {
      const cell = Object.fromEntries(labels.map((l) => [l, { full: [], revalid: [], statuses: new Set(), cache: new Set(), etag: null, bytes: 0, errors: 0 }]));
      for (let i = 0; i < n + 1; i++) {
        for (const l of labels) {
          try {
            const r = await clients[l].get(path);
            const c = cell[l];
            c.statuses.add(r.status);
            c.cache.add(r.headers["cf-cache-status"] ?? "-");
            c.etag = r.headers.etag ?? c.etag;
            c.bytes = r.bytes;
            if (i > 0) c.full.push(r.ms);
          } catch {
            cell[l].errors++;
          }
        }
      }
      for (let i = 0; i < n; i++) {
        for (const l of labels) {
          const c = cell[l];
          if (!c.etag) continue;
          try {
            const r = await clients[l].get(path, { "if-none-match": c.etag });
            c.revalid.push(r.ms);
            c.statuses.add(r.status);
          } catch {
            c.errors++;
          }
        }
      }
      out.push({
        path,
        kind,
        hosts: Object.fromEntries(
          labels.map((l) => {
            const c = cell[l];
            return [l, { full: c.full, revalid: c.revalid, statuses: [...c.statuses].sort(), cache: [...c.cache].sort(), bytes: c.bytes, errors: c.errors, p50: pct(c.full, 0.5), p95: pct(c.full, 0.95), p50_304: pct(c.revalid, 0.5), p95_304: pct(c.revalid, 0.95) }];
          }),
        ),
      });
    }
  } finally {
    for (const l of labels) clients[l].close();
  }
  return { startedAt, n, vantage: process.env.AWS_REGION ?? "local", routes: out };
}
