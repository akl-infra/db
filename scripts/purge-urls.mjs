// The URLs deploy-aws.sh purges from Cloudflare's edge cache after a deploy: the static routes a Cache Rule holds for a day,
// /v1/formats and each registered format's schema (src/routes/formats.ts), built from the registry the bundle ships.
//   node scripts/purge-urls.mjs <host> [out.json]      prints {"files":[...]} (or writes it to out.json)
import fs from "node:fs";
import { list } from "../formats/registry.ts";

const MAX_PER_CALL = 30; // Cloudflare's Free plan: 30 URLs per purge call

export function purgeUrls(host) {
  const base = `https://${host}`;
  return [`${base}/v1/formats`, ...list().map((f) => `${base}/v1/formats/${f.id}/schema.json`)];
}

const [host, out] = process.argv.slice(2);
if (host === undefined) {
  console.error("usage: node scripts/purge-urls.mjs <host> [out.json]");
  process.exit(2);
}
const files = purgeUrls(host);
if (files.length > MAX_PER_CALL) {
  console.error(`${files.length} URLs is over one purge call (${MAX_PER_CALL}); split the call in deploy-aws.sh`);
  process.exit(1);
}
const json = JSON.stringify({ files });
if (out === undefined) console.log(json);
else fs.writeFileSync(out, json + "\n");
