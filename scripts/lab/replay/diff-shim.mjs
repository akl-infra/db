// Lane R: a local stand-in for lane S's `scripts/lab/diff/pair.mjs` (`diffPair(a, b, ctx) => Problem[]`), with the
// comparison logic of scripts/lab/p1-crawl-diff.mjs: status, contract headers, body bytes. Lane S replaces it:
// `loadDiffPair()` prefers `../diff/pair.mjs` when that file exists. S's allow-list (health.*.age_s) is NOT here.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

export const CONTRACT_HEADERS = ["etag", "cache-control", "content-type", "x-akldb-api", "x-wait-ignored", "retry-after", "deprecation", "sunset", "location", "content-length", "www-authenticate"];

export function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

/**
 * @param {{status:number, headers:Record<string,string>, body:Buffer}} a  the oracle (D1) side
 * @param {{status:number, headers:Record<string,string>, body:Buffer}} b  the AWS side
 * @param {object} [ctx] request context (method, path, query, family); unused here
 * @returns {{kind:"status"|"header"|"body", detail:string}[]}
 */
export function diffPair(a, b, ctx = {}) {
  void ctx;
  const problems = [];
  if (a.status !== b.status) problems.push({ kind: "status", detail: `status ${a.status} vs ${b.status}` });
  for (const h of CONTRACT_HEADERS) {
    if (a.headers[h] !== b.headers[h]) problems.push({ kind: "header", detail: `header ${h}: ${JSON.stringify(a.headers[h])} vs ${JSON.stringify(b.headers[h])}` });
  }
  const at = firstDiff(a.body, b.body);
  if (at !== -1) {
    const around = (buf) => JSON.stringify(buf.subarray(Math.max(0, at - 40), at + 80).toString("utf8"));
    problems.push({ kind: "body", detail: `body differs at byte ${at} (${a.body.length} vs ${b.body.length} bytes): ${around(a.body)} vs ${around(b.body)}` });
  }
  return problems;
}

/** Lane S's differ when it exists, else the shim. */
export async function loadDiffPair() {
  const s = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..", "diff", "pair.mjs");
  if (fs.existsSync(s)) {
    const mod = await import(url.pathToFileURL(s).href);
    return { diffPair: mod.diffPair, source: "lane S" };
  }
  return { diffPair, source: "shim" };
}
