// Send a plan to production and shadow and judge each pair (LDB-PV3). Only GETs, only to the two hosts it is given, with no
// credentials: the request carries a User-Agent and Accept, and an If-None-Match built from the answer the same side just
// gave (never copied from a log). Output: one NDJSON record per request (and per 304 follow-up).
import { judge } from "./diff.mjs";
import { STATE_KINDS, headOfEtag } from "./routes.mjs";

export const UA = "akldb-shadow-replay/1";

async function fetchOne(fetchImpl, base, item, extra = {}) {
  const started = Date.now();
  const res = await fetchImpl(`${base}${item.path}${item.query}`, {
    method: "GET",
    headers: { "user-agent": UA, accept: item.group === "blob" ? "*/*" : "application/json", ...extra },
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  const body = Buffer.from(await res.arrayBuffer());
  const headers = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  return { status: res.status, headers, body, ms: Date.now() - started };
}

/** For each state class: did production append an event of a kind that changes it after the seq of shadow's last dump? */
export async function stateGuard({ fetchImpl, prod, shadow }) {
  const moved = {};
  let dumpSeq;
  try {
    const latest = await fetchImpl(`${shadow}/v1/dump/latest.json`, { headers: { "user-agent": UA }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
    dumpSeq = (await latest.json()).seq;
  } catch {
    return { moved, dumpSeq: undefined };
  }
  if (!Number.isInteger(dumpSeq)) return { moved, dumpSeq: undefined };
  for (const [cls, kinds] of Object.entries(STATE_KINDS)) {
    try {
      const res = await fetchImpl(`${prod}/v1/changes?since=${dumpSeq}&limit=1&kinds=${kinds.join(",")}`, { headers: { "user-agent": UA }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
      moved[cls] = ((await res.json()).items ?? []).length > 0;
    } catch {
      moved[cls] = undefined;
    }
  }
  return { moved, dumpSeq };
}

/**
 * @param {{plan:{items:object[]}, prod:string, shadow:string, fetchImpl?:typeof fetch, sleep?:(ms:number)=>Promise<void>, onRecord?:(r:object)=>void, guard?:boolean}} o
 * @returns {Promise<object[]>} the records
 */
export async function runReplay({ plan, prod, shadow, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onRecord = () => {}, guard = true }) {
  for (const base of [prod, shadow]) if (!/^https?:\/\/[^/]+$/.test(base)) throw new Error(`replay base must be an origin: ${base}`);
  const records = [];
  const emit = (r) => {
    records.push(r);
    onRecord(r);
  };
  const g = guard ? await stateGuard({ fetchImpl, prod, shadow }) : { moved: {}, dumpSeq: undefined };
  const startedAt = Date.now();
  for (const item of plan.items) {
    const wait = item.at - (Date.now() - startedAt);
    if (wait > 0) await sleep(wait);
    const at = new Date().toISOString();
    const base = { at, n: item.n, class: item.class, group: item.group, path: item.path, query: item.query, weight: item.weight, inm: item.inm };
    let a;
    let b;
    try {
      [a, b] = await Promise.all([fetchOne(fetchImpl, prod, item), fetchOne(fetchImpl, shadow, item)]);
    } catch (e) {
      emit({ ...base, phase: "200", verdict: "error", reason: String(e?.message ?? e).slice(0, 200), problems: [] });
      continue;
    }
    const j = judge(item, a, b, { stateMoved: g.moved });
    emit({ ...base, phase: "200", ...j, status: { prod: a.status, shadow: b.status }, ms: { prod: a.ms, shadow: b.ms }, bytes: { prod: a.body.length, shadow: b.body.length }, dumpSeq: g.dumpSeq ?? null });
    // the revalidation path: each side gets its own ETag back and must answer 304
    if (item.inm && j.verdict === "equal" && a.headers.etag !== undefined && b.headers.etag !== undefined && headOfEtag(a.headers.etag) !== null) {
      try {
        const [c, d] = await Promise.all([fetchOne(fetchImpl, prod, item, { "if-none-match": a.headers.etag }), fetchOne(fetchImpl, shadow, item, { "if-none-match": b.headers.etag })]);
        const k = judge(item, c, d, { stateMoved: g.moved });
        const problems = [...k.problems];
        if (c.status !== 304 || d.status !== 304) problems.push({ kind: "status", detail: `revalidation answered ${c.status} / ${d.status}, wanted 304 / 304` });
        emit({ ...base, phase: "304", verdict: problems.length === 0 ? "equal" : k.verdict === "skipped" ? "skipped" : "diff", ...(k.reason !== undefined ? { reason: k.reason } : {}), problems, heads: k.heads, status: { prod: c.status, shadow: d.status }, ms: { prod: c.ms, shadow: d.ms } });
      } catch (e) {
        emit({ ...base, phase: "304", verdict: "error", reason: String(e?.message ?? e).slice(0, 200), problems: [] });
      }
    }
  }
  return records;
}
