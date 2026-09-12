#!/usr/bin/env node
// `npm run diff-upstream` (LEDGER.md L4): the shrunk upstream mirror diff.
// Compares our layout count to upstream's and content-compares a random
// sample of following layouts over HTTP, printing a summary; exits 1 on
// any difference. All the real logic (the spark projection compare, the
// path-diff) lives in `../src/import/diff.ts`, imported directly here --
// see that file's header for why it's safe to import from plain Node (no
// `wrangler`/bundler in this script) while the rest of `src/` isn't.
//
// `DB_BASE_URL` defaults to a local `wrangler dev` (http://localhost:8787);
// `UPSTREAM_URL`/`IMPORT_UA` default to the same values `wrangler.toml`
// gives the deployed Worker's import (`IMPORT_SOURCE_URL`/`IMPORT_UA`), so
// running this against a fresh local D1 + a real upstream tick compares
// like for like.
//
// M1 (LDB-P5, design/layout-db/17-magic-ownership.md §3): the spark
// projection this compares is magic-less on both sides (`diff.ts`'s
// `compareRecords` -> `projectSparkNoMagic`) -- cmini's magic is never
// akl.gg's, so it never enters the DB and is never counted as a
// difference from what the DB actually mirrors.
import { DEFAULT_SAMPLE_SIZE, diffUpstream, httpOurs } from "../src/import/diff.ts";

const DB_BASE_URL = process.env.DB_BASE_URL ?? "http://localhost:8787";
const UPSTREAM_URL = process.env.UPSTREAM_URL ?? "https://clemenpine.com/layoutapi/v3";
const UA = process.env.IMPORT_UA ?? "akl-db-import/1.0";
const SAMPLE_SIZE = process.env.DIFF_SAMPLE_SIZE ? Number(process.env.DIFF_SAMPLE_SIZE) : DEFAULT_SAMPLE_SIZE;

function printLines(label, lines, max = 20) {
  if (lines.length === 0) return;
  console.log(`\n${label} (${lines.length}):`);
  for (const line of lines.slice(0, max)) {
    console.log(`  ${line.name}${line.path ? ` ${line.path}` : ""}${line.message ? ` -- ${line.message}` : ""}`);
  }
  if (lines.length > max) console.log(`  ... and ${lines.length - max} more`);
}

async function main() {
  console.log(
    `diff-upstream: ours=${DB_BASE_URL} upstream=${UPSTREAM_URL} (UA: ${UA}) -- spark projection, magic excluded (LDB-P5/M1), sample=${SAMPLE_SIZE}`,
  );
  const summary = await diffUpstream({ ours: httpOurs(DB_BASE_URL), upstreamUrl: UPSTREAM_URL, ua: UA, sampleSize: SAMPLE_SIZE });

  console.log(
    `\nlayout_count:     upstream ${summary.layoutCount.upstream} / ours ${summary.layoutCount.ours} -- ${summary.layoutCount.equal ? "equal" : "MISMATCH"}`,
  );
  console.log(`sampled:          ${summary.sampleSize} following layout(s)`);
  console.log(`matched:          ${summary.matched}`);

  printLines("missing (sampled following layout upstream no longer answers for)", summary.missing);
  printLines("invalid upstream detail", summary.invalidUpstream);
  printLines("content differs", summary.contentDiffs);

  console.log(`\n${summary.ok ? "OK -- zero differences" : "DIFFERENCES FOUND"}`);
  process.exitCode = summary.ok ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
