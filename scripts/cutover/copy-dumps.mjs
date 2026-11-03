#!/usr/bin/env node
// Standalone dump-history copy, R2 -> S3 (see dumps.mjs). Without --execute it lists what it would copy and changes nothing.
import url from "node:url";
import { copyDumps } from "./dumps.mjs";
import { r2Source, s3Destination } from "./dumps-real.mjs";

export async function main(argv, { env = process.env, out = (s) => console.log(s), fetchImpl } = {}) {
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const execute = argv.includes("--execute");
  const bucket = flag("bucket");
  if (!bucket) {
    out("copy-dumps: --bucket <the AWS data bucket, e.g. akldb-prod-data-335937358231> is required");
    return 2;
  }
  const missing = ["CLOUDFLARE_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"].filter((k) => !env[k]);
  if (missing.length > 0) {
    out(`copy-dumps: missing ${missing.join(", ")}`);
    return 2;
  }
  const src = r2Source({ accountId: env.CLOUDFLARE_ACCOUNT_ID, accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, bucket: flag("r2-bucket") ?? "akl-db-dumps", fetchImpl });
  const dst = s3Destination({ bucket, region: flag("region") ?? "us-east-2", credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}) }, fetchImpl });
  const r = await copyDumps({ src, dst, log: out, dryRun: !execute });
  out(`copy-dumps: ${r.objects} objects: ${execute ? "copied" : "would copy"} ${r.copied.length}, already there ${r.skipped.length}, ${r.bytes} bytes${execute ? "" : " (dry run: add --execute)"}`);
  for (const m of r.mismatches) out(`copy-dumps: MISMATCH ${m.key}: ${m.why}`);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => (console.error(`copy-dumps: ${e?.stack ?? e}`), process.exit(1)));
}
