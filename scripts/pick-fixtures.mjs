#!/usr/bin/env node
// Writes db/tests/fixtures/upstream-100/{list.json,full.json,authors.json}
// from the live cmini API (07 §5.3): the named witnesses for every row of
// the §0.1 measured table, filled to exactly 100 by `modified_at` desc.
// Run ONCE; the result is committed and frozen (LDB-F6's frozen.test.ts
// covers db/formats/*/*/fixtures, not this snapshot, but the same rule
// applies by convention -- a bug found in the wild becomes a new fixture,
// this one is never edited in place).
//
// The three files keep the exact shape of their live endpoint (list.json ~
// GET /layouts, full.json ~ GET /layouts?full=1, authors.json ~ GET
// /authors) so a FakeUpstream (S5) can serve them byte-for-byte as if they
// were live responses.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const BASE = process.env.IMPORT_SOURCE_URL ?? "https://clemenpine.com/layoutapi/v3";
const UA = process.env.IMPORT_UA ?? "akl-db-import/1.0";

// 07 §5.3 -- every named id witnesses one row of the §0.1 table.
const NAMED = [
  "graphite", // ortho; the repo's canonical fixture
  "opal", // 35 magic rows, all type: magic; "?◇" names a non-key
  "auditor", // repeat + magic rows
  "opal-dario", // adaptive
  "whirl", // one untyped magic row
  "opal-e200", // 3-code-point magic.inputs
  "crescent", // combos
  "sanrie-cmini-test2", // row 4
  "adept", // TB finger
  "test12222", // both thumbs; thumb fingers on rows 0-2
  "40kwh", // stagger with a row 3, non-thumb fingers on it
  "apt26", // free
  "haul", // mini
  "abyss", // angle
  "adnw", // name "AdNW", a payload `link`
  "00------higgs", // empty keys
  "io", // 2-char name
  "02_we've_been_in_this_room_too_long", // apostrophe
];

async function getJson(p) {
  const res = await fetch(`${BASE}${p}`, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`GET ${p} -> ${res.status}`);
  return res.json();
}

async function main() {
  const list = (await getJson("/layouts")).layouts;
  const full = (await getJson("/layouts?full=1")).layouts;
  const authors = await getJson("/authors");

  const byId = new Map(list.map((l) => [l.id, l]));
  const byName = new Map(full.map((l) => [l.name, l]));

  const missing = NAMED.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(
      `named fixture(s) no longer exist upstream, pick a substitute and update NAMED + the S2 report: ${missing.join(", ")}`,
    );
  }

  const selectedIds = new Set(NAMED);
  const rest = list
    .filter((l) => !selectedIds.has(l.id))
    .sort((a, b) => (a.modified_at < b.modified_at ? 1 : a.modified_at > b.modified_at ? -1 : a.id < b.id ? -1 : 1));
  for (const l of rest) {
    if (selectedIds.size >= 100) break;
    selectedIds.add(l.id);
  }
  if (selectedIds.size !== 100) {
    throw new Error(`expected exactly 100 selected ids, got ${selectedIds.size} (upstream has fewer live layouts?)`);
  }

  // Preserve NAMED's order first (readable diffs, stable witnesses), then
  // the fill entries in the same modified_at-desc order used to pick them.
  const orderedIds = [...NAMED, ...rest.filter((l) => selectedIds.has(l.id)).map((l) => l.id)];

  const listOut = orderedIds.map((id) => {
    const entry = byId.get(id);
    if (!entry) throw new Error(`missing list entry for ${id}`);
    return entry;
  });

  const fullOut = listOut.map((entry) => {
    const detail = byName.get(entry.name);
    if (!detail) throw new Error(`missing ?full=1 detail for name '${entry.name}' (id ${entry.id})`);
    return detail;
  });

  const ownerIds = new Set(listOut.map((l) => l.user));
  const authorsOut = Object.fromEntries(
    Object.entries(authors)
      .filter(([, userId]) => ownerIds.has(userId))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

  const outDir = path.join(
    path.dirname(url.fileURLToPath(import.meta.url)),
    "..",
    "tests",
    "fixtures",
    "upstream-100",
  );
  fs.mkdirSync(outDir, { recursive: true });

  const write = (name, data) => {
    const file = path.join(outDir, name);
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
    console.log(`wrote ${file} (${Buffer.byteLength(JSON.stringify(data))} bytes)`);
  };

  write("list.json", { layouts: listOut, total: listOut.length });
  write("full.json", { layouts: fullOut, total: fullOut.length });
  write("authors.json", authorsOut);

  console.log(`\n${listOut.length} layouts, ${Object.keys(authorsOut).length} authors.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
