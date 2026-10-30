// Lane S: the response differ, `diffPair(a, b, ctx) => Problem[]` (the signature lane R's replay pins).
// Compares status, contract headers and body bytes of two responses ({status, headers, body: Buffer}); `a` is the
// oracle (D1), `b` the AWS side. The only tolerated differences:
//   - the allow-list (allow.json): `health.*.age_s` in a JSON body, masked before the byte comparison;
//   - the gzip bytes of a dump (scripts/lab/fuzz/dumpmask.mjs, narrow and proven by lane K).
// Reuses p1-crawl-diff's CONTRACT_HEADERS and firstDiff.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { CONTRACT_HEADERS, firstDiff } from "../p1-crawl-diff.mjs";
import { comparableBody } from "../fuzz/dumpmask.mjs";

export { CONTRACT_HEADERS, firstDiff };

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
export const ALLOW_FILE = path.join(HERE, "allow.json");
export const MASKED = "<allowed>";

export function loadAllowList(file = ALLOW_FILE) {
  return JSON.parse(fs.readFileSync(file, "utf8")).allow.map((e) => e.path.split("."));
}

function matches(pattern, keys) {
  return pattern.length === keys.length && pattern.every((p, i) => p === "*" || p === keys[i]);
}

/** A copy of `v` with every allow-listed numeric/null leaf replaced by MASKED. */
export function maskAllowed(v, patterns, keys = []) {
  if (Array.isArray(v)) return v.map((x, i) => maskAllowed(x, patterns, [...keys, String(i)]));
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskAllowed(x, patterns, [...keys, k])]));
  if ((typeof v === "number" || v === null) && patterns.some((p) => matches(p, keys))) return MASKED;
  return v;
}

function maskedBody(buf, patterns) {
  let parsed;
  try {
    parsed = JSON.parse(buf.toString("utf8"));
  } catch {
    return { buf, changed: false };
  }
  const m = maskAllowed(parsed, patterns);
  if (JSON.stringify(m) === JSON.stringify(parsed)) return { buf, changed: false };
  return { buf: Buffer.from(JSON.stringify(m)), changed: true };
}

const DEFAULT_PATTERNS = loadAllowList();

/**
 * @param {{status:number, headers:Record<string,string>, body:Buffer}} a
 * @param {{status:number, headers:Record<string,string>, body:Buffer}} b
 * @param {{path?:string, query?:string}} [ctx]
 * @returns {{kind:"status"|"header"|"body", detail:string}[]}
 */
export function diffPair(a, b, ctx = {}) {
  const problems = [];
  const reqPath = `${ctx.path ?? ""}${ctx.query ?? ""}`;
  if (a.status !== b.status) problems.push({ kind: "status", detail: `status ${a.status} vs ${b.status}` });
  const ba0 = comparableBody(reqPath, a.body);
  const bb0 = comparableBody(reqPath, b.body);
  const ma = maskedBody(ba0, DEFAULT_PATTERNS);
  const mb = maskedBody(bb0, DEFAULT_PATTERNS);
  const masked = ma.changed || mb.changed;
  const onDump = reqPath.startsWith("/v1/dump");
  for (const h of CONTRACT_HEADERS) {
    if (a.headers[h] === b.headers[h]) continue;
    if (h === "content-length" && masked) continue; // a masked integer may change the digit count
    if (h === "etag" && onDump && Buffer.compare(ba0, bb0) === 0) continue; // md5/sha of encoder-dependent gzip bytes
    problems.push({ kind: "header", detail: `header ${h}: ${JSON.stringify(a.headers[h])} vs ${JSON.stringify(b.headers[h])}` });
  }
  const at = firstDiff(ma.buf, mb.buf);
  if (at !== -1) {
    const around = (buf) => JSON.stringify(buf.subarray(Math.max(0, at - 40), at + 80).toString("utf8"));
    problems.push({ kind: "body", detail: `body differs at byte ${at} (${ma.buf.length} vs ${mb.buf.length} bytes): ${around(ma.buf)} vs ${around(mb.buf)}` });
  }
  return problems;
}
