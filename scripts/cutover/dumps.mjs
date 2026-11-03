// Copy the dump history from R2 (`akl-db-dumps`) to the AWS data bucket (`dumps/<key>`), object by object (LDB-CV20).
//
// The Worker serves /v1/dump* from R2; the AWS stack serves it from S3, which starts EMPTY, so every dated and monthly dump older than the
// last one the stack wrote would 404 after the flip. This copies EVERY object of the R2 bucket (dated `dump-YYYY-MM-DD.json.gz`, `monthly/`,
// `latest.json`, the per-major `latest.<name>-<N>.json[.sha256]` files) keeping each object's content type, and proves each one:
//   - what R2 sent matches its own ETag (the MD5 of a single-part object) and its Content-Length;
//   - what S3 stored matches: size, MD5 ETag, content type.
// It is idempotent (an object S3 already has, equal on all three, is skipped) and cheap to repeat: the cutover runs it long before the freeze,
// then again just before `proxy` for whatever the nightly job wrote in between (usually nothing; `latest.json` if a dump ran).
//
//   node scripts/cutover/copy-dumps.mjs [--execute] [--bucket <data bucket>] [--r2-bucket akl-db-dumps] [--region us-east-2]
//   env (never printed): CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (an R2 API token with OBJECT READ ONLY on akl-db-dumps),
//        AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN (aws-vault exec akldb -- ...: s3:PutObject/GetObject/ListBucket on dumps/*)
import { createHash } from "node:crypto";

const md5 = (bytes) => createHash("md5").update(bytes).digest("hex");
const unquote = (etag) => (etag ?? "").replace(/^W\//, "").replace(/^"|"$/g, "");

/**
 * src: { list() -> [{key, size, etag}], get(key) -> { bytes, contentType, etag, size } }
 * dst: { head(key) -> { size, etag, contentType } | null, put(key, bytes, contentType) -> void }
 * Returns { objects, copied, skipped, bytes, mismatches: [{key, why}] }; a mismatch is never silent and `ok` is false.
 */
export async function copyDumps({ src, dst, log = () => {}, dryRun = false }) {
  const listed = await src.list();
  const out = { objects: listed.length, copied: [], skipped: [], bytes: 0, mismatches: [] };
  for (const o of listed.sort((a, b) => (a.key < b.key ? -1 : 1))) {
    const have = await dst.head(o.key);
    const want = unquote(o.etag);
    const multipart = want.includes("-");
    if (have !== null && have.size === o.size && (multipart || unquote(have.etag) === want)) {
      // equal size and MD5 already; the content type is checked on the source side below only when we copy, so compare it here too
      const s = await src.get(o.key, { headOnly: true });
      if (s.contentType === undefined || have.contentType === s.contentType) {
        out.skipped.push(o.key);
        continue;
      }
    }
    if (dryRun) {
      out.copied.push(o.key);
      continue;
    }
    const got = await src.get(o.key);
    const sum = md5(got.bytes);
    if (got.bytes.byteLength !== o.size) {
      out.mismatches.push({ key: o.key, why: `R2 sent ${got.bytes.byteLength} bytes, listed ${o.size}` });
      continue;
    }
    if (!multipart && sum !== want) {
      out.mismatches.push({ key: o.key, why: `R2 bytes have md5 ${sum}, R2's ETag says ${want}` });
      continue;
    }
    await dst.put(o.key, got.bytes, got.contentType);
    const stored = await dst.head(o.key);
    if (stored === null) out.mismatches.push({ key: o.key, why: "S3 has no such object after the put" });
    else if (stored.size !== o.size) out.mismatches.push({ key: o.key, why: `S3 stored ${stored.size} bytes, expected ${o.size}` });
    else if (unquote(stored.etag) !== sum) out.mismatches.push({ key: o.key, why: `S3 ETag ${unquote(stored.etag)} != md5 ${sum}` });
    else if (got.contentType !== undefined && stored.contentType !== got.contentType) out.mismatches.push({ key: o.key, why: `S3 content type ${stored.contentType}, R2's ${got.contentType}` });
    else {
      out.copied.push(o.key);
      out.bytes += o.size;
      log(`copied ${o.key} (${o.size} bytes, ${got.contentType})`);
    }
  }
  out.ok = out.mismatches.length === 0;
  return out;
}
