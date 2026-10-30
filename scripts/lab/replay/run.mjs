// Lane R: the replay engine (design/aws-port.md §5.1). Replays a plan (plan.mjs) against two sides, ordered by
// EventTimestampMs at 1x or 10x, and hands each response pair to `diffPair`.
//
// Ordering. Requests start in log order at `(ts - ts0) / speed` after the start (a request is late, never early, when
// a side is slow). The lab clock header always carries the ORIGINAL timestamp, so what the servers compute does not
// depend on the speed. A write is a barrier: everything started before it finishes first, nothing starts while it
// runs. That keeps "same request sequence on both sides" exact where order matters, and lets reads overlap.
//
// Long-polls (`/v1/changes?wait=`, ~16% of production requests) are NOT barriers and never delay the schedule: each
// runs concurrently on its own, in-flight while later requests (including the writes that wake it) are dispatched.
// At 1x the logged `wait` is kept (real holds, so the hold budget and wake-ups are exercised as in production). At
// Nx the wait is scaled to ceil(wait / N), at least 1 s, so a held request spans the same stretch of replayed log
// time instead of N times too much of it: holding real time at 10x would keep ~10x the production number of
// connections open. Barriers do not wait for long-polls (a write must be able to wake them).
//
// 304s. A logged 304 is replayed with the then-current ETag: a fresh unconditional GET of the same URL on each side
// (cached until the next write) supplies each side's own tag.
import { LAB_USER } from "./sign.mjs";

export const realClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** The dispatch offset in ms of every item at `speed`. */
export function schedule(items, speed) {
  if (items.length === 0) return [];
  const t0 = items[0].logged.ts;
  return items.map((item) => ({ item, dueMs: (item.logged.ts - t0) / speed }));
}

export function scaleWait(query, speed) {
  if (!(speed > 1)) return query;
  return query.replace(/([?&]wait=)([^&]*)/, (m, pre, v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? `${pre}${Math.max(1, Math.ceil(n / speed))}` : m;
  });
}

const replaceAll = (s, from, to) => (from === to ? s : s.split(from).join(to));

class Gate {
  constructor(n) {
    this.free = n;
    this.q = [];
  }
  async run(fn) {
    if (this.free === 0) await new Promise((r) => this.q.push(r));
    else this.free--;
    try {
      return await fn();
    } finally {
      const next = this.q.shift();
      if (next) next();
      else this.free++;
    }
  }
}

/**
 * @param {{items:any[]}} plan
 * @param {{sides:[{name:string,send:Function},{name:string,send:Function}], diffPair:Function, signer:any,
 *          speed?:number, clock?:typeof realClock, concurrency?:number, seedBase?:number}} opts
 *   `send(wire)` -> `{status, headers (lower-case), body: Buffer}`; wire = `{method, pathWithQuery, headers, body}`.
 */
export async function runPlan(plan, opts) {
  const speed = opts.speed ?? 1;
  const clock = opts.clock ?? realClock;
  const gate = new Gate(opts.concurrency ?? 16);
  const [A, B] = opts.sides;
  const idmap = [new Map(), new Map()];
  const etags = [new Map(), new Map()];
  let epoch = 0;
  let seed = opts.seedBase ?? 1000;
  const out = { results: [], diffs: [], sent: 0, primes: 0, lagMaxMs: 0, speed, longpolls: 0, errors: [] };

  const remap = (side, s) => {
    let t = s;
    for (const [orig, now] of idmap[side]) t = replaceAll(t, orig, now);
    return t;
  };

  const wireFor = (side, item, query, nowMs, seedN, extraHeaders = {}) => {
    const pathWithQuery = remap(side, item.path) + query;
    const bodyText = item.body === null ? null : remap(side, item.body.toString("utf8"));
    const body = bodyText === null ? undefined : Buffer.from(bodyText);
    const headers = { "x-lab-now": new Date(nowMs).toISOString(), "x-lab-seed": String(seedN), ...item.headers, ...extraHeaders };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (item.actor !== null && item.actor !== undefined) Object.assign(headers, opts.signer.sign({ method: item.method, pathWithQuery, body, actor: item.actor ?? LAB_USER, nowMs, nonceSeed: seedN }));
    return { method: item.method, pathWithQuery, headers, body };
  };

  const exchange = async (item, query, seedN, extraByside, flags = {}) => {
    const nowMs = item.logged.ts;
    const wires = [wireFor(0, item, query, nowMs, seedN, extraByside?.[0]), wireFor(1, item, query, nowMs, seedN, extraByside?.[1])];
    const [ra, rb] = await Promise.all([A.send(wires[0]), B.send(wires[1])]);
    out.sent++;
    const ctx = { method: item.method, path: item.path, query, logged_status: item.logged.status, ...flags };
    const problems = opts.diffPair(ra, rb, ctx);
    const rec = { i: item.i, method: item.method, path: item.path, query, status: [ra.status, rb.status], problems, ...flags };
    out.results.push(rec);
    if (problems.length > 0) out.diffs.push(rec);
    return [ra, rb];
  };

  const learnIds = (item, resp) => {
    if (item.mint === null || item.mint === undefined) return;
    resp.forEach((r, side) => {
      try {
        const j = JSON.parse(r.body.toString("utf8"));
        const id = j?.id ?? j?.layout?.id ?? j?.submission?.id;
        if (typeof id === "string") idmap[side].set(item.mint.orig, id);
      } catch {
        /* a failed write mints nothing */
      }
    });
  };

  const conditionalHeaders = async (item, query, seedN) => {
    const key = item.path + query;
    const tags = [];
    for (let side = 0; side < 2; side++) {
      const c = etags[side].get(key);
      if (c !== undefined && c.epoch === epoch) tags.push({ "If-None-Match": c.etag });
      else tags.push(null);
    }
    if (tags.some((t) => t === null)) {
      // Prime: an unconditional GET on both sides gives each its then-current tag.
      const probe = { ...item, headers: {}, actor: item.actor, logged: item.logged };
      const resp = await exchange(probe, query, seedN, undefined, { prime: true });
      out.primes++;
      resp.forEach((r, side) => {
        if (r.headers.etag !== undefined) etags[side].set(key, { etag: r.headers.etag, epoch });
      });
      return resp.map((r) => (r.headers.etag === undefined ? {} : { "If-None-Match": r.headers.etag }));
    }
    return tags;
  };

  const doRequest = async (item, seedN) => {
    try {
      const query = item.kind === "longpoll" ? scaleWait(item.query, speed) : item.query;
      let extra;
      if (item.conditional304) extra = await conditionalHeaders(item, query, seedN + 500000);
      const resp = await exchange(item, query, seedN, extra);
      if (item.kind === "read" || item.kind === "longpoll") {
        resp.forEach((r, side) => {
          if (r.status === 200 && r.headers.etag !== undefined && item.method === "GET" && !item.conditional304) etags[side].set(item.path + query, { etag: r.headers.etag, epoch });
        });
      }
      if (item.kind === "write") learnIds(item, resp);
    } catch (e) {
      out.errors.push({ i: item.i, path: item.path, error: e instanceof Error ? e.message : String(e) });
    }
  };

  const sched = schedule(plan.items, speed);
  const start = clock.now();
  const inflight = new Set();
  const holds = new Set();
  const track = (set, p) => {
    set.add(p);
    void p.finally(() => set.delete(p));
  };
  for (const { item, dueMs } of sched) {
    const elapsed = clock.now() - start;
    if (dueMs > elapsed) await clock.sleep(dueMs - elapsed);
    else out.lagMaxMs = Math.max(out.lagMaxMs, elapsed - dueMs);
    const seedN = ++seed;
    if (item.kind === "write") {
      await Promise.all([...inflight]);
      await doRequest(item, seedN);
      epoch++;
    } else if (item.kind === "longpoll") {
      out.longpolls++;
      track(holds, doRequest(item, seedN));
    } else {
      track(inflight, gate.run(() => doRequest(item, seedN)));
    }
  }
  await Promise.all([...inflight, ...holds]);
  return out;
}
