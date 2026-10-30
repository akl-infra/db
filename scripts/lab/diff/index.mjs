// Lane S: the diff CLI.
//   node scripts/lab/diff/index.mjs discord <oracle.ndjson> <aws.ndjson> [--unordered]
//   node scripts/lab/diff/index.mjs state <oracle.json> <aws.json> [--ignore t1,t2]    ({table: rows[]} files)
// Exit 0 identical, 1 differences, 2 usage.
import fs from "node:fs";
import process from "node:process";
import url from "node:url";
import { diffRecords, loadRecord } from "./discord.mjs";
import { diffExports, renderStateDiff } from "./state.mjs";

export function main(argv) {
  const [cmd, fa, fb, ...rest] = argv;
  if ((cmd !== "discord" && cmd !== "state") || !fa || !fb) {
    console.error("usage: index.mjs discord <a.ndjson> <b.ndjson> [--unordered] | state <a.json> <b.json> [--ignore t1,t2]");
    return 2;
  }
  if (cmd === "discord") {
    const r = diffRecords(loadRecord(fa), loadRecord(fb), { ordered: !rest.includes("--unordered") });
    console.log(`discord record: ${r.calls[0]} vs ${r.calls[1]} calls, ${r.problems.length} problems`);
    for (const p of r.problems.slice(0, 20)) console.log(`  ${p.detail}`);
    return r.ok ? 0 : 1;
  }
  const i = rest.indexOf("--ignore");
  const ignore = i === -1 ? [] : (rest[i + 1] ?? "").split(",").filter(Boolean);
  const d = diffExports(JSON.parse(fs.readFileSync(fa, "utf8")), JSON.parse(fs.readFileSync(fb, "utf8")), ignore);
  console.log(renderStateDiff(d));
  return d.length === 0 ? 0 : 1;
}

if (process.argv[1] && url.fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
