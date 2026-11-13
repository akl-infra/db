// Runs INSIDE emulayout's own runtime (bun), spawned by scripts/emulayout-compat.mjs. It imports emulayout's
// real reader entry points -- `validateSparkLayout` (src/lib/sparkSchema.ts) and `parseAkldbLayouts` /
// `ensureAkldbCatalog` (bin/akldb-cache.js) -- and nothing else of theirs: no sync script, no network (the
// catalog fetch is served from the input file by an injected `fetchImpl`), and its cache file is a path in a
// scratch directory. Usage: <runtime> emulayout-harness.mjs <emulayout-dir> <input.json>; prints one JSON
// document on stdout. Plain JavaScript on purpose: it must load under bun and under node.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [dir, inputPath] = process.argv.slice(2);
if (!dir || !inputPath) throw new Error("usage: emulayout-harness.mjs <emulayout-dir> <input.json>");
const input = JSON.parse(readFileSync(inputPath, "utf8"));

let warnings = [];
console.warn = (...args) => warnings.push(args.join(" "));
console.log = () => {};

const cache = await import(pathToFileURL(join(dir, "bin", "akldb-cache.js")).href);
const schema = await import(pathToFileURL(join(dir, "src", "lib", "sparkSchema.ts")).href);

const message = (e) => (e instanceof Error ? e.message : String(e));
const isRecord = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

const manaById = new Map((input.mana?.items ?? []).map((m) => [m.id, m]));
const records = [];
for (const item of input.spark.items) {
  const name = isRecord(item) && typeof item.name === "string" ? item.name : "?";
  const out = { name, status: "accepted", dropped: [], error: null };
  warnings = [];
  // 1. the sanitizer alone: what it dropped (parseAkldbLayouts only logs the drops).
  if (isRecord(item) && isRecord(item.payload)) {
    try {
      out.dropped = schema.validateSparkLayout(item.payload, "layout").dropped.map((d) => ({ path: d.path, reason: d.reason }));
    } catch (e) {
      out.error = message(e);
    }
  }
  // 2. the whole envelope through the catalog parser, one record at a time, so one failure names itself.
  if (out.error === null) {
    try {
      const mana = isRecord(item) ? manaById.get(item.id) : undefined;
      const { skipped } = cache.parseAkldbLayouts({ items: [item] }, { items: mana ? [mana] : [] });
      if (skipped > 0) {
        const line = warnings.find((w) => w.includes("skipping AKLDB layout"));
        out.error = line ? line.replace(/^\s*⚠ skipping AKLDB layout [^:]*: /, "") : "skipped by parseAkldbLayouts";
      }
    } catch (e) {
      out.error = message(e);
    }
  }
  if (out.error !== null) out.status = "rejected";
  else if (out.dropped.length > 0) out.status = "dropped";
  records.push(out);
}

// 3. the catalog as one unit, through ensureAkldbCatalog's own checks (meta, counts, authors), offline.
const urls = new Map([
  [cache.AKLDB_META_URL, input.meta],
  [cache.AKLDB_LAYOUTS_URL, input.spark],
  [cache.AKLDB_MANA_LAYOUTS_URL, input.mana],
  [cache.AKLDB_AUTHORS_URL, input.authors],
]);
const fetchImpl = async (url) => {
  if (!urls.has(url)) return new Response("not found", { status: 404, statusText: "Not Found" });
  return new Response(JSON.stringify(urls.get(url)), { status: 200 });
};
let catalog;
warnings = [];
try {
  const r = await cache.ensureAkldbCatalog({ force: true, fetchImpl, snapshotPath: join(input.scratch, "catalog-v1.json") });
  catalog = { ok: true, layouts: r.json.layouts.layouts.length, skipped: r.json.layouts.skipped };
} catch (e) {
  catalog = { ok: false, error: message(e) };
}
process.stdout.write(JSON.stringify({ records, catalog }) + "\n");
