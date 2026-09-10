#!/usr/bin/env node
// db/scripts/drill-verify.mjs -- step 3 of the Fly restore drill
// (design/layout-db/12-implementation-phase5.md §3 X4, LDB-D5): proves
// the restored database actually SERVES the real API, not just that its
// rows look right in isolation -- checks `/v1/meta`'s `layout_count`/
// `seq` and walks every layout id in the dump, comparing `GET /v1/layouts/
// :id` against the dump's own record byte-for-byte (via `canonical()`,
// the same order-independent comparison every other byte-identity check
// in this codebase uses). This is `tests/rehost.test.ts`'s own
// conformance-replay idea, run over real HTTP against a `wrangler dev
// --local` Worker instead of vitest-pool-workers' in-process one -- the
// operational proof that a REHOSTED DEPLOYMENT (not just the test
// harness) actually works end to end.
//
// A tombstoned record is walked too (not skipped): `GET /v1/layouts/:id`
// looks records up by id via `readById()` (src/core/records.ts), which
// does not filter `deleted` -- only name lookups do (LDB-P8).
import fs from "node:fs";
import url from "node:url";
import { canonical } from "../src/core/canonical.ts";

const CONCURRENCY = 16;

function parseArgs(argv) {
  const out = { dump: null, base: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dump") out.dump = argv[++i];
    else if (argv[i] === "--base") out.base = argv[++i];
  }
  return out;
}

// A small fixed-concurrency pool -- ~4200 layouts one at a time against a
// local Worker would be needlessly slow; ~4200 all at once would be a
// thundering herd against wrangler's single local dev process.
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const idx = next++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

// `likes` in the order `dump.likes` already carries it in: `dump/write.ts`
// pages the `likes` table ordered `(layout_id ASC, user_id ASC)` globally
// (the same SQLite BINARY collation `GET /v1/layouts/:ref/likes`'s own
// `ORDER BY user_id ASC` query uses), so grouping by `layout_id` in a
// single forward pass over that array preserves the exact per-layout order
// the live route serves -- no re-sort needed (or safe to assume matches a
// DB collation this script never touches directly).
export function likesByLayoutFromDump(dumpLikes) {
  const map = new Map();
  for (const like of dumpLikes) {
    if (!map.has(like.layout_id)) map.set(like.layout_id, []);
    map.get(like.layout_id).push(like.user_id);
  }
  return map;
}

// The exact shape `GET /v1/layouts/:ref` returns (src/routes/layouts.ts:
// `{ ...sansPayload(rec), likes, payload }`), built from a dump's raw
// `LayoutDbRow` (0/1 booleans, `payload_json` a string) the way `src/core/
// records.ts`'s `rowToRecord` converts a live D1 row.
export function expectedFromRecord(rec, likes) {
  return {
    id: rec.id,
    name: rec.name,
    owner: rec.owner,
    rev: rec.rev,
    created_at: rec.created_at,
    modified_at: rec.modified_at,
    deleted: rec.deleted !== 0,
    like_count: rec.like_count,
    has_magic: rec.has_magic !== 0,
    format: rec.format,
    // 20-spark.md S3a (LDB-D1/D5 amended): a dump row without these keys
    // (pre-0005) means "no known link", same as `rowToRecord`.
    upstream: rec.upstream_source == null ? null : { source: rec.upstream_source, id: rec.upstream_id, state: rec.upstream_state },
    likes,
    payload: JSON.parse(rec.payload_json),
  };
}

async function checkOne(base, rec, likesByLayout) {
  const reqUrl = `${base}/v1/layouts/${rec.id}?as=${encodeURIComponent(rec.format)}`;
  let res;
  try {
    res = await fetch(reqUrl);
  } catch (e) {
    return { id: rec.id, name: rec.name, reason: `fetch failed: ${String(e)}` };
  }
  if (!res.ok) return { id: rec.id, name: rec.name, reason: `GET ${reqUrl} -> ${res.status}` };
  const body = await res.json();
  const expected = expectedFromRecord(rec, likesByLayout.get(rec.id) ?? []);
  const gotCanon = canonical(body);
  const expectCanon = canonical(expected);
  if (gotCanon !== expectCanon) {
    return { id: rec.id, name: rec.name, reason: "body mismatch", got: body, expected };
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dump || !args.base) {
    console.error("usage: node scripts/drill-verify.mjs --dump <path> --base <url>");
    process.exit(1);
    return;
  }

  let dump;
  try {
    dump = JSON.parse(fs.readFileSync(args.dump, "utf8"));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, step: "read-dump", path: args.dump, error: String(e) }));
    process.exit(1);
    return;
  }

  let meta;
  try {
    const metaRes = await fetch(`${args.base}/v1/meta`);
    if (!metaRes.ok) throw new Error(`GET /v1/meta -> ${metaRes.status}`);
    meta = await metaRes.json();
  } catch (e) {
    console.log(JSON.stringify({ ok: false, step: "meta", error: String(e) }));
    process.exit(1);
    return;
  }
  const metaExpected = { layout_count: dump.meta.layout_count, seq: dump.meta.seq };
  const metaGot = { layout_count: meta.layout_count, seq: meta.seq };
  const metaOk = metaGot.layout_count === metaExpected.layout_count && metaGot.seq === metaExpected.seq;

  const likesByLayout = likesByLayoutFromDump(dump.likes);
  const results = await pool(dump.records, CONCURRENCY, (rec) => checkOne(args.base, rec, likesByLayout));
  const mismatches = results.filter((r) => r !== null);

  const ok = metaOk && mismatches.length === 0;
  console.log(
    JSON.stringify({
      ok,
      checked: dump.records.length,
      meta_ok: metaOk,
      meta_got: metaGot,
      meta_expected: metaExpected,
      mismatch_count: mismatches.length,
      mismatches: mismatches.slice(0, 20), // capped -- a report-sized sample, not the whole (possibly huge) failure list
    }),
  );
  if (!ok) process.exit(1);
}

const isMain = process.argv[1] !== undefined && url.pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    console.log(JSON.stringify({ ok: false, step: "unexpected", error: String(err) }));
    process.exit(1);
  });
}
