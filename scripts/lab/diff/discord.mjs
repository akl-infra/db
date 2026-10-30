// Lane S: the fake-Discord record diff. Both sides of a run point at their own fake Discord (scripts/lab/fake-discord);
// each records NDJSON (`seq`, `at`, `method`, `path`, `authKind`, `headers`, `body`, `status`, `injected`). The two
// records must match: same calls, same bodies, same order (or the same multiset with `ordered: false`, for jobs that
// run concurrently). Ignored: `seq` and `at` (wall time), and transport headers that differ by runtime, never the
// credential (the record has none, only `authKind`).
import fs from "node:fs";
import { canonRow } from "./state.mjs";

export const IGNORED_FIELDS = ["seq", "at"];
export const IGNORED_HEADERS = ["host", "connection", "content-length", "date", "accept", "accept-encoding", "accept-language", "user-agent", "keep-alive", "transfer-encoding", "traceparent", "x-amzn-trace-id", "x-forwarded-for", "x-forwarded-proto", "x-request-id"];

export function parseRecord(text) {
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        throw new Error(`record line ${i + 1} is not JSON`);
      }
    });
}

export function loadRecord(file) {
  return parseRecord(fs.readFileSync(file, "utf8"));
}

/** A call reduced to what must match. */
export function normalizeCall(c) {
  const o = {};
  for (const [k, v] of Object.entries(c)) {
    if (IGNORED_FIELDS.includes(k)) continue;
    if (k === "headers" && v !== null && typeof v === "object") {
      o.headers = Object.fromEntries(Object.entries(v).filter(([h]) => !IGNORED_HEADERS.includes(h.toLowerCase())).map(([h, x]) => [h.toLowerCase(), x]));
    } else o[k] = v;
  }
  return o;
}

function brief(c) {
  return `${c.method} ${c.path} -> ${c.status}`;
}

/**
 * @param {object[]} a oracle record  @param {object[]} b AWS record
 * @param {{ordered?: boolean}} [opts]
 * @returns {{ok:boolean, calls:[number,number], problems:{index:number, kind:string, detail:string}[]}}
 */
export function diffRecords(a, b, opts = {}) {
  const ordered = opts.ordered ?? true;
  const na = a.map(normalizeCall);
  const nb = b.map(normalizeCall);
  const problems = [];
  if (ordered) {
    const n = Math.min(na.length, nb.length);
    for (let i = 0; i < n; i++) {
      const x = canonRow(na[i]);
      const y = canonRow(nb[i]);
      if (x === y) continue;
      const fields = [...new Set([...Object.keys(na[i]), ...Object.keys(nb[i])])].filter((f) => JSON.stringify(na[i][f]) !== JSON.stringify(nb[i][f]));
      problems.push({ index: i, kind: "call", detail: `call ${i}: ${brief(a[i])} vs ${brief(b[i])}; differing: ${fields.join(",")}` });
    }
    if (na.length !== nb.length) problems.push({ index: n, kind: "count", detail: `${na.length} vs ${nb.length} calls; first extra: ${brief((na.length > nb.length ? a : b)[n])}` });
  } else {
    const ca = na.map(canonRow).sort();
    const cb = nb.map(canonRow).sort();
    const sb = new Set(cb);
    const sa = new Set(ca);
    const onlyA = na.findIndex((c) => !sb.has(canonRow(c)));
    const onlyB = nb.findIndex((c) => !sa.has(canonRow(c)));
    if (onlyA !== -1) problems.push({ index: onlyA, kind: "oracle-only", detail: `oracle-only call ${onlyA}: ${brief(a[onlyA])}` });
    if (onlyB !== -1) problems.push({ index: onlyB, kind: "aws-only", detail: `aws-only call ${onlyB}: ${brief(b[onlyB])}` });
    if (problems.length === 0 && ca.length !== cb.length) problems.push({ index: 0, kind: "count", detail: `${ca.length} vs ${cb.length} calls (duplicate multiplicity differs)` });
  }
  return { ok: problems.length === 0, calls: [a.length, b.length], problems };
}
