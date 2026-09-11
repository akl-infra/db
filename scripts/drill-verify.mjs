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
//
// 21-formats.md (several formats per layout): a layout's payload no
// longer lives on its own `layouts` row -- it's one `layout_formats` row
// per lineage the layout has stored, and every read of one requires an
// explicit `?format=` (D4, no default; `?as=` is gone). So this script
// now walks every STORED format row a layout has (real dumps carry
// exactly one, `spark/1`, today; a test dump may carry more) and does one
// `GET /v1/layouts/:id?format=<that format>` per row, each compared
// against the exact `fullWire()` shape the live route builds (imported
// straight from `src/core/records.ts` so this can never drift from the
// real wire function).
import fs from "node:fs";
import url from "node:url";
import { canonical } from "../src/core/canonical.ts";
import { fullWire, rowToFormat, rowToLayout } from "../src/core/records.ts";

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

// 21-formats.md: groups a dump's `layout_formats` rows by `layout_id`, the
// same shape `formatsForLayout()` (src/core/records.ts) returns off a live
// D1 read -- so `expectedFromRecord` below can build the exact same
// `Map<lineage, FormatRow>` `fullWire()` expects, straight from a dump's
// raw rows.
export function formatsByLayoutFromDump(dumpFormats) {
  const map = new Map();
  for (const f of dumpFormats) {
    if (!map.has(f.layout_id)) map.set(f.layout_id, []);
    map.get(f.layout_id).push(f);
  }
  return map;
}

// The exact shape `GET /v1/layouts/:ref?format=F` returns
// (src/routes/layouts.ts: `{ ...fullWire(lwf.layout, lwf.formats, {format,
// payload, derived_from?}), likes }`) for ONE of this layout's own stored
// formats (`format` -- never a derived/output format: every dump row is
// already `role: "stored"` by construction). Built from `fullWire()`
// itself (imported, not reimplemented) over `rowToLayout`/`rowToFormat`
// applied to the dump's own raw rows, so this can never drift from the
// live wire function the way a hand-copied shape could.
export function expectedFromRecord(rec, formatRows, format, likes) {
  const layout = rowToLayout(rec);
  const formatsMap = new Map(formatRows.map((f) => [f.lineage, rowToFormat(f)]));
  const requested = formatsMap.get(format.slice(0, format.indexOf("/")));
  if (requested === undefined || requested.format !== format) {
    throw new Error(`drill-verify: layout ${rec.id} has no stored format '${format}'`);
  }
  return { ...fullWire(layout, formatsMap, { format: requested.format, payload: requested.payload }), likes };
}

async function checkOne(base, rec, formatRows, likesByLayout) {
  const likes = likesByLayout.get(rec.id) ?? [];
  for (const fr of formatRows) {
    const reqUrl = `${base}/v1/layouts/${rec.id}?format=${encodeURIComponent(fr.format)}`;
    let res;
    try {
      res = await fetch(reqUrl);
    } catch (e) {
      return { id: rec.id, name: rec.name, format: fr.format, reason: `fetch failed: ${String(e)}` };
    }
    if (!res.ok) return { id: rec.id, name: rec.name, format: fr.format, reason: `GET ${reqUrl} -> ${res.status}` };
    const body = await res.json();
    const expected = expectedFromRecord(rec, formatRows, fr.format, likes);
    const gotCanon = canonical(body);
    const expectCanon = canonical(expected);
    if (gotCanon !== expectCanon) {
      return { id: rec.id, name: rec.name, format: fr.format, reason: "body mismatch", got: body, expected };
    }
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
  const formatsByLayout = formatsByLayoutFromDump(dump.layout_formats ?? []);
  const results = await pool(dump.records, CONCURRENCY, (rec) => checkOne(args.base, rec, formatsByLayout.get(rec.id) ?? [], likesByLayout));
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
