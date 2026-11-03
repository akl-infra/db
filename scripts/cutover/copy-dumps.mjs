#!/usr/bin/env node
// Standalone dump-history copy, R2 -> S3 (see dumps.mjs; the cutover runs the same code as its `copy-dumps` step). Without --execute it lists what it
// would copy and changes nothing. Run it days before the cutover to do the bulk of the copy; the cutover's own step then only re-syncs.
//
//   aws-vault exec akldb -- node scripts/cutover/copy-dumps.mjs --dest-bucket akldb-prod-data-335937358231 [--execute]
//   options: --dest-bucket <bucket>   the stack's data bucket (prod, or akldb-staging-data-... / akldb-shadow-data-... for those stages)
//            --dest-prefix dumps/     where under the bucket the Worker-compatible keys go (the stack reads dumps/<key>)
//            --r2-env <file>          default ~/git/akl/akldb-r2-dumps-read.env: R2_KEY_ID, R2_SECRET, R2_ENDPOINT (+ optional R2_BUCKET, default akl-db-dumps)
//            --region us-east-2
// AWS credentials come from the environment (s3:GetObject/PutObject/ListBucket on <bucket>/dumps/*). Nothing secret is printed.
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { copyDumps } from "./dumps.mjs";
import { r2Source, s3Destination } from "./dumps-real.mjs";
import { readEnvFile } from "./ports-real.mjs";

export async function main(argv, { env = process.env, out = (s) => console.log(s), fetchImpl } = {}) {
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const execute = argv.includes("--execute");
  const bucket = flag("dest-bucket") ?? flag("bucket");
  if (!bucket) {
    out("copy-dumps: --dest-bucket <the stack's data bucket, e.g. akldb-prod-data-335937358231> is required");
    return 2;
  }
  const r2Env = path.resolve(flag("r2-env") ?? path.join(os.homedir(), "git", "akl", "akldb-r2-dumps-read.env"));
  let r2;
  try {
    r2 = readEnvFile(r2Env);
  } catch (e) {
    out(`copy-dumps: cannot read ${r2Env}: ${e.code === "ENOENT" ? "not found" : e.message}`);
    return 2;
  }
  const missing = ["R2_KEY_ID", "R2_SECRET", "R2_ENDPOINT"].filter((k) => !r2[k]).map((k) => `${k} in ${r2Env}`).concat(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"].filter((k) => !env[k]));
  if (missing.length > 0) {
    out(`copy-dumps: missing ${missing.join(", ")}`);
    return 2;
  }
  const src = r2Source({ endpoint: r2.R2_ENDPOINT, accessKeyId: r2.R2_KEY_ID, secretAccessKey: r2.R2_SECRET, bucket: r2.R2_BUCKET ?? "akl-db-dumps", fetchImpl });
  const dst = s3Destination({ bucket, region: flag("region") ?? "us-east-2", prefix: flag("dest-prefix") ?? "dumps/", credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}) }, fetchImpl });
  const r = await copyDumps({ src, dst, log: out, dryRun: !execute });
  out(`copy-dumps: ${r.objects} objects: ${execute ? "copied" : "would copy"} ${r.copied.length}, already there ${r.skipped.length}, ${r.bytes} bytes${execute ? "" : " (dry run: add --execute)"}`);
  for (const m of r.mismatches) out(`copy-dumps: MISMATCH ${m.key}: ${m.why}`);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => (console.error(`copy-dumps: ${e?.stack ?? e}`), process.exit(1)));
}
