// Lane S: the latency report, p50/p95/p99 per route, cold starts counted separately.
// Input: NDJSON, one request per line (written by the replay/crawl drivers and the Lambda log parser):
//   {"method":"GET","path":"/v1/meta","ms":42,"cold":false,"vantage":"iad","status":200}
// `cold` marks a request that paid a Lambda init (REPORT line with Init Duration). Cold requests are excluded from
// the percentiles and reported as `cold: {count, p50, max}` per route. `vantage` splits the report (iad, lax, eu,
// in-region); omitted = "all". Percentiles are nearest-rank. A baseline ({"GET /v1/meta": {"p95": 80}, ...}, today's
// production p95 per route) gates: every route's p95 must be <= its baseline.
import fs from "node:fs";
import process from "node:process";
import url from "node:url";
import { matchRoute } from "./coverage.mjs";

export function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sortedAsc.length));
  return sortedAsc[rank - 1];
}

/** @param {object[]} samples @param {string[]} [routeIds] inventory route ids, to fold concrete paths into templates */
export function latencyReport(samples, routeIds = [], baseline = null) {
  const groups = new Map();
  for (const s of samples) {
    const route = routeIds.length > 0 ? (matchRoute(s.method, s.path, routeIds) ?? `${s.method} ${s.path.split("?")[0]}`) : `${s.method} ${s.path.split("?")[0]}`;
    const key = `${s.vantage ?? "all"}\u0000${route}`;
    const g = groups.get(key) ?? { vantage: s.vantage ?? "all", route, warm: [], cold: [] };
    (s.cold ? g.cold : g.warm).push(s.ms);
    groups.set(key, g);
  }
  const rows = [...groups.values()]
    .map((g) => {
      const w = [...g.warm].sort((a, b) => a - b);
      const c = [...g.cold].sort((a, b) => a - b);
      return { vantage: g.vantage, route: g.route, n: w.length, p50: percentile(w, 50), p95: percentile(w, 95), p99: percentile(w, 99), cold: { count: c.length, p50: percentile(c, 50), max: c.length ? c[c.length - 1] : null } };
    })
    .sort((a, b) => (a.vantage + a.route < b.vantage + b.route ? -1 : 1));
  const regressions = [];
  if (baseline !== null) {
    for (const r of rows) {
      const b = baseline[r.route]?.p95;
      if (b !== undefined && r.p95 !== null && r.p95 > b) regressions.push({ vantage: r.vantage, route: r.route, p95: r.p95, baseline: b });
    }
  }
  return { ok: regressions.length === 0, requests: samples.length, cold_total: rows.reduce((n, r) => n + r.cold.count, 0), rows, regressions };
}

export function renderLatency(r) {
  const lines = [`latency ${r.ok ? "OK" : "FAIL"}: ${r.requests} requests, ${r.cold_total} cold starts, ${r.regressions.length} p95 regressions`];
  for (const x of r.rows) lines.push(`  ${x.vantage} ${x.route}: n=${x.n} p50=${x.p50} p95=${x.p95} p99=${x.p99} cold=${x.cold.count}${x.cold.count ? ` (max ${x.cold.max})` : ""}`);
  for (const x of r.regressions) lines.push(`  REGRESSION ${x.vantage} ${x.route}: p95 ${x.p95} > baseline ${x.baseline}`);
  return lines.join("\n");
}

// node scripts/lab/report/latency.mjs <samples.ndjson> [--inventory inv.json] [--baseline base.json]
if (process.argv[1] && url.fileURLToPath(import.meta.url) === process.argv[1]) {
  const a = process.argv.slice(2);
  const opt = (n) => (a.indexOf(n) === -1 ? null : a[a.indexOf(n) + 1]);
  const samples = fs.readFileSync(a[0], "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const inv = opt("--inventory") ? JSON.parse(fs.readFileSync(opt("--inventory"), "utf8")).items.filter((i) => i.component === "akldb" && i.kind === "http_route").map((i) => i.id) : [];
  const r = latencyReport(samples, inv, opt("--baseline") ? JSON.parse(fs.readFileSync(opt("--baseline"), "utf8")) : null);
  console.log(renderLatency(r));
  process.exit(r.ok ? 0 : 1);
}
