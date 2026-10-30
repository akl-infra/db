// Lane S: the daily coverage report. Every akldb HTTP route (73), scheduled job (13) and background step (4) of
// the inventory (tests/lab/fixtures/coverage/akldb-inventory.json, copied from handoff/aws-coverage-inventory.md)
// must be seen at least once. "Seen" comes from observation records (NDJSON, one object per line; replay, crawl,
// simulator and job runners append them):
//   {"day":"2026-11-02","kind":"route","method":"GET","path":"/v1/layouts/abc"}
//   {"day":"2026-11-02","kind":"job","id":"modqueue-notify"}      (id = inventory `key` or full id)
//   {"day":"2026-11-02","kind":"step","id":"step-link-notify"}
// A route is matched against the inventory's templates (`:param` = one segment, literal beats param). Observations
// that match nothing are reported as `unknown` (the inventory has drifted from the app).
import fs from "node:fs";
import process from "node:process";
import url from "node:url";

export function loadInventory(file) {
  return JSON.parse(fs.readFileSync(file, "utf8")).items;
}

function splitRoute(id) {
  const [method, ...rest] = id.split(" ");
  return { method, path: rest.join(" ") };
}

/** Score of template `t` against concrete `p` (segments), or -1: literal segments count more than params. */
function score(tpl, p) {
  const ts = tpl.split("/");
  const ps = p.split("/");
  const wildcard = ts[ts.length - 1] === "*";
  if (wildcard ? ps.length < ts.length : ps.length !== ts.length) return -1;
  let s = 0;
  for (let i = 0; i < ts.length; i++) {
    if (wildcard && i === ts.length - 1) break;
    if (ts[i].startsWith(":")) continue;
    if (ts[i] !== ps[i]) return -1;
    s += 1;
  }
  return wildcard ? s : s + 0.5;
}

/** The inventory route id ("GET /v1/layouts/:ref") that a request lands on, or null. */
export function matchRoute(method, rawPath, routeIds) {
  const p = rawPath.split("?")[0].replace(/\/+$/, "") || "/";
  let best = null;
  let bestScore = -1;
  for (const id of routeIds) {
    const t = splitRoute(id);
    if (t.method !== "*" && t.method !== method.toUpperCase()) continue;
    const sc = score(t.path, p);
    if (sc > bestScore) {
      best = id;
      bestScore = sc;
    }
  }
  return best;
}

export function parseObservations(text) {
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

/**
 * @param {object[]} items inventory items
 * @param {object[]} observations
 * @param {{components?: string[]}} [opts] default ["akldb"]; add "akldb-site" for the site Worker
 */
export function coverageReport(items, observations, opts = {}) {
  const components = opts.components ?? ["akldb"];
  const mine = items.filter((i) => components.includes(i.component));
  const routeIds = mine.filter((i) => i.kind === "http_route").map((i) => i.id);
  const byKind = { route: mine.filter((i) => i.kind === "http_route"), job: mine.filter((i) => i.kind === "scheduled_job"), step: mine.filter((i) => i.kind === "background_step") };
  const idOf = (kind, it) => (kind === "route" ? it.id : (it.key ?? it.id));
  const seen = { route: new Map(), job: new Map(), step: new Map() };
  const unknown = [];
  for (const o of observations) {
    let key = null;
    if (o.kind === "route") key = matchRoute(o.method ?? "GET", o.path ?? "", routeIds);
    else if (o.kind === "job" || o.kind === "step") key = byKind[o.kind].find((it) => it.key === o.id || it.id === o.id) ? (byKind[o.kind].find((it) => it.key === o.id || it.id === o.id).key ?? o.id) : null;
    if (key === null || key === undefined) {
      unknown.push({ kind: o.kind, what: o.kind === "route" ? `${o.method} ${o.path}` : o.id });
      continue;
    }
    const m = seen[o.kind];
    const e = m.get(key) ?? { count: 0, days: new Set() };
    e.count++;
    if (o.day) e.days.add(o.day);
    m.set(key, e);
  }
  const days = [...new Set(observations.map((o) => o.day).filter(Boolean))].sort();
  const kinds = {};
  const unseen = {};
  for (const kind of ["route", "job", "step"]) {
    const all = byKind[kind];
    const missing = all.filter((it) => !seen[kind].has(idOf(kind, it)));
    kinds[kind] = { total: all.length, seen: all.length - missing.length };
    unseen[kind] = missing.map((it) => ({ id: idOf(kind, it), planned: it.coverage, gap: it.gap }));
  }
  const perDay = days.map((day) => {
    const d = {};
    for (const kind of ["route", "job", "step"]) d[kind] = [...seen[kind].values()].filter((e) => e.days.has(day)).length;
    return { day, ...d };
  });
  const ok = Object.values(unseen).every((u) => u.length === 0) && unknown.length === 0;
  return { ok, kinds, unseen, unknown, perDay };
}

export function renderCoverage(r) {
  const lines = [`coverage ${r.ok ? "OK" : "FAIL"}: routes ${r.kinds.route.seen}/${r.kinds.route.total}, jobs ${r.kinds.job.seen}/${r.kinds.job.total}, steps ${r.kinds.step.seen}/${r.kinds.step.total}`];
  for (const kind of ["route", "job", "step"]) for (const u of r.unseen[kind]) lines.push(`  unseen ${kind}: ${u.id}${u.gap ? ` [gap ${u.gap}]` : ""} (planned: ${u.planned})`);
  for (const u of r.unknown.slice(0, 20)) lines.push(`  unknown ${u.kind}: ${u.what}`);
  for (const d of r.perDay) lines.push(`  ${d.day}: routes ${d.route}, jobs ${d.job}, steps ${d.step}`);
  return lines.join("\n");
}

// node scripts/lab/report/coverage.mjs <inventory.json> <observations.ndjson>... [--site]   exit 1 unless complete
if (process.argv[1] && url.fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const files = args.filter((a) => !a.startsWith("--"));
  const obs = files.slice(1).flatMap((f) => parseObservations(fs.readFileSync(f, "utf8")));
  const r = coverageReport(loadInventory(files[0]), obs, { components: args.includes("--site") ? ["akldb", "akldb-site"] : ["akldb"] });
  console.log(renderCoverage(r));
  process.exit(r.ok ? 0 : 1);
}
