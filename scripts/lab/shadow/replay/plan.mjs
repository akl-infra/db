// From raw requests to a replay plan (LDB-PV8): public GETs only, de-duplicated, sampled per route class and paced.
import { classify, normalizeQuery } from "./routes.mjs";

/** A small seeded PRNG (xorshift32), so the same input and seed give the same sample. */
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

/**
 * @param {{ts:number, method:string, path:string, query:string, inm:boolean}[]} requests
 * @param {{n?:number, perClass?:number, seed?:number, rps?:number}} [opts]
 * @returns {{items: object[], dropped: Record<string, number>, considered: number, uniques: number, rps: number}}
 *   items: `{n, method:"GET", path, query, inm, class, group, weight, at}` with `at` the planned offset in ms from the start
 */
export function buildPlan(requests, opts = {}) {
  const n = opts.n ?? 400;
  const perClass = opts.perClass ?? Math.max(10, Math.ceil(n / 4));
  const rps = opts.rps ?? 2;
  const dropped = {};
  const drop = (why) => void (dropped[why] = (dropped[why] ?? 0) + 1);
  const byKey = new Map();
  for (const r of requests) {
    if (r.method !== "GET") {
      drop(`method ${r.method}`);
      continue;
    }
    const c = classify(r.path);
    if (c === null) {
      drop("not a public replayable route");
      continue;
    }
    const query = normalizeQuery(r.query);
    const key = `${r.path}${query}\u0000${r.inm ? 1 : 0}`;
    const e = byKey.get(key);
    if (e !== undefined) e.weight++;
    else byKey.set(key, { method: "GET", path: r.path, query, inm: r.inm, class: c.class, group: c.group, weight: 1 });
  }
  const uniques = [...byKey.values()];
  // stratified sample: at most perClass per class (chosen at random, weighted by how often production saw them), then trimmed to n
  const rand = rng(opts.seed ?? 1);
  const classes = new Map();
  for (const u of uniques) (classes.get(u.class) ?? classes.set(u.class, []).get(u.class)).push(u);
  let picked = [];
  for (const [cls, list] of [...classes.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const keyed = list.map((u) => ({ u, k: Math.pow(rand(), 1 / u.weight) })).sort((a, b) => b.k - a.k);
    picked.push(...keyed.slice(0, perClass).map((x) => x.u));
    if (list.length > perClass) dropped[`sampled out (${cls})`] = list.length - perClass;
  }
  if (picked.length > n) {
    picked = picked.map((u) => ({ u, k: rand() })).sort((a, b) => a.k - b.k).slice(0, n).map((x) => x.u);
  }
  // a stable, interleaved order (not clustered by class), paced at rps
  picked = picked.map((u) => ({ u, k: rand() })).sort((a, b) => a.k - b.k).map((x) => x.u);
  const items = picked.map((u, i) => ({ n: i, ...u, at: Math.round((i * 1000) / rps) }));
  return { items, dropped, considered: requests.length, uniques: uniques.length, rps };
}
