// The one allowed difference between the D1 Worker and the DynamoDB server:
// the gzip bytes of a dump. src/dump/write.ts compresses with CompressionStream,
// and workerd's zlib and Node's emit different (both valid) bytes for the same
// input, so the compressed `sha256` and `bytes` of a dump record differ while
// the gunzipped dumps are byte-identical (lane K proved it).
//
// The rule is narrow on purpose:
//  - a "dump record" is an object with a 64-hex `sha256`, a numeric `bytes` and a
//    `key` naming a dump object (`dump-*.json.gz` or `monthly/dump-*.json.gz`)
//    (the LatestJson shape: latest.json, the admin dump and nightly-tick
//    responses, and `detail_json` of events or state rows that carry one);
//    only its `sha256` and `bytes` are masked;
//  - the gzip bytes of a dump object are compared gunzipped, and the dump's
//    ETag is ignored (it is the md5 of the compressed bytes);
//  - nothing else is masked: a content difference in the gunzipped dump, or in
//    any other field of those records, still fails.
import zlib from "node:zlib";

const DUMP_KEY = /^(monthly\/)?dump-\d{4}-\d{2}(-\d{2})?\.json\.gz$/;
export const MASK = "<masked gzip>";

export function isDumpRecord(o) {
  return o !== null && typeof o === "object" && !Array.isArray(o) && typeof o.sha256 === "string" && /^[0-9a-f]{64}$/.test(o.sha256) && typeof o.bytes === "number" && typeof o.key === "string" && DUMP_KEY.test(o.key);
}

/** A copy of `v` with every dump record's `sha256` and `bytes` masked (also inside JSON-encoded string values). */
export function maskDumpRecords(v) {
  if (typeof v === "string") {
    const t = v.trimStart();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        const inner = JSON.parse(v);
        const masked = maskDumpRecords(inner);
        return JSON.stringify(masked) === JSON.stringify(inner) ? v : JSON.stringify(masked);
      } catch {
        return v;
      }
    }
    return v;
  }
  if (Array.isArray(v)) return v.map(maskDumpRecords);
  if (v !== null && typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = maskDumpRecords(x);
    if (isDumpRecord(v)) {
      out.sha256 = MASK;
      out.bytes = MASK;
    }
    return out;
  }
  return v;
}

/** True for the routes that serve a dump object's compressed bytes. */
export function isDumpObjectPath(p) {
  const path = p.split("?")[0];
  return /^\/v1\/dump\/(monthly\/)?dump-[\d-]+\.json\.gz$/.test(path);
}

/** The response body as the differ should compare it: gunzipped for dump objects, dump records masked in JSON. */
export function comparableBody(path, buf) {
  if (isDumpObjectPath(path)) {
    try {
      return zlib.gunzipSync(buf);
    } catch {
      return buf;
    }
  }
  try {
    const parsed = JSON.parse(buf.toString("utf8"));
    const masked = maskDumpRecords(parsed);
    return JSON.stringify(masked) === JSON.stringify(parsed) ? buf : Buffer.from(JSON.stringify(masked));
  } catch {
    return buf;
  }
}

/** State rows ({table: row[]}) with dump records masked inside any JSON-encoded cell. */
export function maskStateRows(state) {
  const out = {};
  for (const [t, rows] of Object.entries(state)) out[t] = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, maskDumpRecords(v)])));
  return out;
}
