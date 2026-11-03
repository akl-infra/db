// The response differ of the GET replay (LDB-PV3). `judge(item, prod, shadow, ctx)` compares two answers of the same request
// and returns a verdict: equal, diff, diff-state, or skipped (with the reason). Pure.
//
// Compared: the status; the head seq in the ETag (a comparison happens only when both answers were computed at the SAME head,
// else it is "skipped: different heads", because one side saw a write the other had not applied yet); the contract headers
// below; and the body, as canonical JSON for JSON answers (key order is not part of the contract) and as bytes otherwise.
//
// Masked, and why (this list is the whole of it):
//   - /v1/meta `health`: live bookkeeping that production's own jobs write (dump.last_at, ages in seconds, the import and diff
//     probes); shadow runs none of those jobs and mirrors the dump it was synchronized at, so the block cannot agree.
//   - content-length: a transport detail (Cloudflare re-encodes the body differently per response).
//   - the ETag of a dump file (md5 of the compressed bytes, computed by R2 on one side and S3 on the other): the body is compared.
// Not masked: everything else, including the whole ETag of the validated routes (it carries the head seq and a hash of the query).
import crypto from "node:crypto";
import { headOfEtag } from "./routes.mjs";

/** Headers compared (lower-case). */
export const CONTRACT_HEADERS = ["etag", "cache-control", "content-type", "x-akldb-api", "x-wait-ignored", "retry-after", "deprecation", "sunset", "location", "www-authenticate", "access-control-allow-origin", "access-control-expose-headers", "vary"];

/** /v1/meta fields that follow the authors table (a state table): a difference confined to them is `diff-state`. */
export const META_STATE_FIELDS = ["author_count", "authors_modified_at", "authors_version"];
/** /v1/meta fields masked entirely. */
export const META_MASKED_FIELDS = ["health"];

function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v !== null && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const isJson = (res) => /json/i.test(res.headers["content-type"] ?? "");

function firstDifference(a, b, path = "") {
  if (canon(a) === canon(b)) return null;
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) {
      const d = firstDifference(a[k], b[k], `${path}/${k}`);
      if (d !== null) return d;
    }
  }
  const clip = (v) => (canon(v) ?? "undefined").slice(0, 160);
  return `${path || "/"}: ${clip(a)} vs ${clip(b)}`;
}

/**
 * @param {{class:string, group:string, path:string}} item
 * @param {{status:number, headers:Record<string,string>, body:Buffer}} prod
 * @param {{status:number, headers:Record<string,string>, body:Buffer}} shadow
 * @param {{stateMoved?: Record<string, boolean|undefined>}} [ctx]  stateMoved[class] === true: production changed that state since shadow's last dump
 * @returns {{verdict:"equal"|"diff"|"diff-state"|"skipped", reason?:string, problems:{kind:string, detail:string}[], heads:{prod:number|null, shadow:number|null}}}
 */
export function judge(item, prod, shadow, ctx = {}) {
  const heads = { prod: headOfEtag(prod.headers.etag), shadow: headOfEtag(shadow.headers.etag) };
  const result = (verdict, problems = [], reason) => ({ verdict, problems, heads, ...(reason !== undefined ? { reason } : {}) });

  if (heads.prod !== null && heads.shadow !== null && heads.prod !== heads.shadow) return result("skipped", [], `different heads (prod ${heads.prod}, shadow ${heads.shadow})`);

  const problems = [];
  if (prod.status !== shadow.status) problems.push({ kind: "status", detail: `status ${prod.status} vs ${shadow.status}` });
  for (const h of CONTRACT_HEADERS) {
    if (h === "etag" && item.group === "blob") continue;
    if (prod.headers[h] !== shadow.headers[h]) problems.push({ kind: "header", detail: `header ${h}: ${JSON.stringify(prod.headers[h])} vs ${JSON.stringify(shadow.headers[h])}` });
  }

  let stateOnly = false;
  if (item.group === "blob") {
    if (item.class === "dump-latest") {
      let a;
      let b;
      try {
        a = JSON.parse(prod.body.toString("utf8"));
        b = JSON.parse(shadow.body.toString("utf8"));
      } catch {
        problems.push({ kind: "body", detail: "latest.json is not JSON on one side" });
      }
      if (a !== undefined && b !== undefined && canon(a) !== canon(b)) {
        if (a.seq !== b.seq || a.key !== b.key) return result("skipped", [], `different dump generations (prod seq ${a.seq}, shadow seq ${b.seq})`);
        problems.push({ kind: "body", detail: `latest.json: ${firstDifference(a, b)}` });
      }
    } else if (sha(prod.body) !== sha(shadow.body)) {
      problems.push({ kind: "body", detail: `dump bytes differ (${prod.body.length} vs ${shadow.body.length} bytes)` });
    }
  } else if (isJson(prod) && isJson(shadow)) {
    let a;
    let b;
    try {
      a = JSON.parse(prod.body.toString("utf8"));
      b = JSON.parse(shadow.body.toString("utf8"));
    } catch {
      problems.push({ kind: "body", detail: "a JSON answer does not parse" });
    }
    if (a !== undefined && b !== undefined) {
      if (item.class === "meta" && a !== null && b !== null && typeof a === "object") {
        for (const f of META_MASKED_FIELDS) {
          delete a[f];
          delete b[f];
        }
        const sa = Object.fromEntries(META_STATE_FIELDS.map((f) => [f, a[f]]));
        const sb = Object.fromEntries(META_STATE_FIELDS.map((f) => [f, b[f]]));
        for (const f of META_STATE_FIELDS) {
          delete a[f];
          delete b[f];
        }
        const d = firstDifference(a, b);
        if (d !== null) problems.push({ kind: "body", detail: d });
        else if (canon(sa) !== canon(sb)) {
          stateOnly = true;
          problems.push({ kind: "body", detail: `author fields: ${firstDifference(sa, sb)}` });
        }
      } else {
        const d = firstDifference(a, b);
        if (d !== null) problems.push({ kind: "body", detail: d });
      }
    }
  } else if (sha(prod.body) !== sha(shadow.body)) {
    problems.push({ kind: "body", detail: `bodies differ (${prod.body.length} vs ${shadow.body.length} bytes)` });
  }

  if (problems.length === 0) return result("equal");
  if (item.group === "state" || stateOnly) {
    if (ctx.stateMoved?.[item.class] === true) return result("skipped", problems, "production changed this state after shadow's last dump");
    // authors change without an event, so a difference there can never be told from staleness; the meta author fields are the same
    if (stateOnly || item.class === "authors") return result("diff-state", problems);
  }
  return result("diff", problems);
}
