#!/usr/bin/env node
// `npm run diff-upstream` (07-implementation-phase1.md §6 S8): the D12
// mirror diff. Compares every upstream cmini layout against ours over
// HTTP and prints a summary; exits 1 on any difference. All the real logic
// (matching, `cmini/1` projection compare, the path-diff, the likes/authors/
// meta checks) lives in `../src/import/diff.ts`, imported directly here --
// see that file's header for why it's safe to import from plain Node (no
// `wrangler`/bundler in this script) while the rest of `src/` isn't.
//
// `DB_BASE_URL` defaults to a local `wrangler dev` (http://localhost:8787);
// `UPSTREAM_URL`/`IMPORT_UA` default to the same values `wrangler.toml`
// gives the deployed Worker's import (`IMPORT_SOURCE_URL`/`IMPORT_UA`), so
// running this against a fresh local D1 + a real upstream tick (07 §8)
// compares like for like.
//
// M1 (LDB-P5, design/layout-db/17-magic-ownership.md §3): the `cmini/1`
// projection this compares is magic-less on both sides (`diff.ts`'s
// `compareRecords` -> `cmini1.projectNoMagic`) -- cmini's magic is never
// akl.gg's, so it never enters the DB and is never counted as a
// difference from what the DB actually mirrors.
import { diffUpstream, httpOurs } from "../src/import/diff.ts";

const DB_BASE_URL = process.env.DB_BASE_URL ?? "http://localhost:8787";
const UPSTREAM_URL = process.env.UPSTREAM_URL ?? "https://clemenpine.com/layoutapi/v3";
const UA = process.env.IMPORT_UA ?? "akl-db-import/1.0";

function printLines(label, lines, max = 20) {
  if (lines.length === 0) return;
  console.log(`\n${label} (${lines.length}):`);
  for (const line of lines.slice(0, max)) {
    const path = "path" in line ? line.path : undefined;
    const name = "name" in line ? line.name : line;
    const message = "message" in line ? line.message : undefined;
    console.log(`  ${name}${path ? ` ${path}` : ""}${message ? ` -- ${message}` : ""}`);
  }
  if (lines.length > max) console.log(`  ... and ${lines.length - max} more`);
}

async function main() {
  console.log(`diff-upstream: ours=${DB_BASE_URL} upstream=${UPSTREAM_URL} (UA: ${UA}) -- cmini/1 projection, magic excluded (LDB-P5/M1)`);
  const summary = await diffUpstream({ ours: httpOurs(DB_BASE_URL), upstreamUrl: UPSTREAM_URL, ua: UA });

  console.log(`\nupstream layouts: ${summary.upstreamCount} (dup names dropped: ${summary.upstreamDupNames})`);
  console.log(`our layouts:      ${summary.ourCount}`);
  console.log(`matched:          ${summary.corpus.matched}`);
  console.log(
    `layout_count:     upstream ${summary.layoutCount.upstream} / ours ${summary.layoutCount.ours} -- ${summary.layoutCount.equal ? "equal" : "MISMATCH"}`,
  );

  printLines("held (unexpected -- as=cmini/1 should always be identity in phase 1)", summary.held.map((name) => ({ name })));
  printLines("missing (upstream has, we don't)", summary.corpus.missing);
  printLines("invalid upstream detail", summary.corpus.invalidUpstream);
  printLines("content differs", summary.corpus.contentDiffs);
  printLines("extra (we have, upstream no longer lists, but we follow it)", summary.corpus.extra);
  printLines(
    "unresolved (bug: follow status never checked)",
    summary.corpus.extraUnresolved.map((name) => ({ name })),
  );
  printLines(
    "authors missing (upstream ids we don't have at all)",
    summary.authors.missing.map((a) => ({ name: a.name, message: `id ${a.id}` })),
  );
  printLines(
    "authors extra (our ids upstream doesn't have at all)",
    summary.authors.extra.map((a) => ({ name: a.name, message: `id ${a.id}` })),
  );
  if (summary.authors.aliasCount > 0) {
    console.log(
      `\nauthors: ${summary.authors.aliasCount} upstream name(s) are an older alias of an id we already have under a newer name -- informational only, not a difference`,
    );
  }

  console.log(`\n${summary.ok ? "OK -- zero differences" : "DIFFERENCES FOUND"}`);
  process.exitCode = summary.ok ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
