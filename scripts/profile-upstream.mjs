#!/usr/bin/env node
// Prints the 07-implementation-phase1.md §0.1 table from the live cmini API.
// Re-run this before changing a schema rule that cites the table -- it is
// the measurement, not a cached belief about upstream.
const BASE = process.env.IMPORT_SOURCE_URL ?? "https://clemenpine.com/layoutapi/v3";
const UA = process.env.IMPORT_UA ?? "akl-db-import/1.0";

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

function count(iterable, pred) {
  let n = 0;
  for (const x of iterable) if (pred(x)) n++;
  return n;
}

function row(label, value) {
  console.log(`${label.padEnd(28)} ${value}`);
}

async function main() {
  console.log(`profiling ${BASE} (UA: ${UA})\n`);

  const meta = await getJson("/meta");
  const { layouts: list } = await getJson("/layouts");
  const { layouts: full } = await getJson("/layouts?full=1");
  const authors = await getJson("/authors");

  row("layouts / authors", `${meta.layout_count} / ${meta.author_count}`);

  const boardCounts = new Map();
  for (const l of list) boardCounts.set(l.board, (boardCounts.get(l.board) ?? 0) + 1);
  row(
    "board",
    [...boardCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([word, n]) => `${word} ${n}`)
      .join(" · "),
  );

  const listFieldCounts = new Map();
  for (const l of list) for (const k of Object.keys(l)) listFieldCounts.set(k, (listFieldCounts.get(k) ?? 0) + 1);
  row(
    "list fields (count/4174)",
    [...listFieldCounts.entries()].map(([k, n]) => `${k}:${n}`).join(" "),
  );

  const idNameCaseDiffer = count(list, (l) => l.id !== l.name);
  row("id !== name", `${idNameCaseDiffer} (case differences)`);

  const nameLens = list.map((l) => l.name.length);
  row("name length range", `${Math.min(...nameLens)}..${Math.max(...nameLens)}`);
  const dupNamesCI = list.length - new Set(list.map((l) => l.name.toLowerCase())).size;
  row("case-insensitive name dupes", String(dupNamesCI));

  row("?full=1 entries / has id?", `${full.length} / ${full.some((l) => "id" in l)}`);
  const dupNamesFull = full.length - new Set(full.map((l) => l.name)).size;
  row("?full=1 duplicate names", String(dupNamesFull));

  const rows = new Set();
  const cols = [];
  const fingers = new Set();
  let emptyKeys = 0;
  const row4Layouts = [];
  const dupPositionLayouts = [];
  for (const l of full) {
    const keys = l.keys ?? {};
    const entries = Object.entries(keys);
    if (entries.length === 0) emptyKeys++;
    const seen = new Set();
    let hasRow4 = false;
    for (const [, pos] of entries) {
      rows.add(pos.row);
      cols.push(pos.col);
      fingers.add(pos.finger);
      if (pos.row === 4) hasRow4 = true;
      const posKey = `${pos.row},${pos.col}`;
      if (seen.has(posKey)) dupPositionLayouts.push(l.name);
      seen.add(posKey);
    }
    if (hasRow4) row4Layouts.push(l.name);
  }
  row("keys: rows seen", [...rows].sort((a, b) => a - b).join(","));
  row(
    "keys: col range",
    cols.length
      ? `${cols.reduce((a, b) => Math.min(a, b))}..${cols.reduce((a, b) => Math.max(a, b))}`
      : "n/a",
  );
  row("keys: fingers seen", [...fingers].sort().join(" "));
  row("keys: empty-keys layouts", String(emptyKeys));
  row("keys: row-4 layouts", row4Layouts.join(", "));
  row("keys: duplicate-position layouts", dupPositionLayouts.join(", ") || "none");

  const freeLayouts = count(full, (l) => Array.isArray(l.free) && l.free.length > 0);
  row("free: layouts with free[]", String(freeLayouts));

  const magicLayouts = full.filter((l) => Array.isArray(l.magic) && l.magic.length > 0);
  const magicRows = magicLayouts.flatMap((l) => l.magic);
  const magicTypeCounts = new Map();
  let untypedRows = 0;
  let threeCodePointInputs = 0;
  const dupInputsLayouts = [];
  for (const l of magicLayouts) {
    const seen = new Set();
    for (const m of l.magic) {
      const t = m.type ?? "(absent)";
      magicTypeCounts.set(t, (magicTypeCounts.get(t) ?? 0) + 1);
      if (m.type === undefined) untypedRows++;
      if ([...m.inputs].length >= 3) threeCodePointInputs++;
      if (seen.has(m.inputs)) dupInputsLayouts.push(l.name);
      seen.add(m.inputs);
    }
  }
  row("magic: layouts / rows", `${magicLayouts.length} / ${magicRows.length}`);
  row(
    "magic: types",
    [...magicTypeCounts.entries()].map(([t, n]) => `${t} ${n}`).join(" · "),
  );
  row("magic: untyped rows", String(untypedRows));
  row("magic: inputs >= 3 code points", String(threeCodePointInputs));
  row("magic: duplicate-inputs layouts", dupInputsLayouts.join(", ") || "none");

  const comboLayouts = full.filter((l) => Array.isArray(l.combos) && l.combos.length > 0);
  row(
    "combos: layouts",
    comboLayouts.map((l) => `${l.name} (${l.combos.length})`).join(", ") || "none",
  );

  const tagCounts = new Map();
  const blameCounts = new Map();
  for (const l of full) {
    tagCounts.set(l.tag, (tagCounts.get(l.tag) ?? 0) + 1);
    blameCounts.set(l.blame, (blameCounts.get(l.blame) ?? 0) + 1);
  }
  row("tag values", [...tagCounts.entries()].map(([k, n]) => `${k} ${n}`).join(" · "));
  row("blame values", [...blameCounts.entries()].map(([k, n]) => `${k} ${n}`).join(" · "));

  const totalLikes = full.reduce((n, l) => n + (l.likes?.length ?? 0), 0);
  const likeCountMismatches = list.filter((l) => {
    const detail = full.find((f) => f.name === l.name);
    return detail && (l.like_count ?? 0) !== (detail.likes?.length ?? 0);
  });
  row("likes: total", String(totalLikes));
  row("likes: list.like_count mismatches", String(likeCountMismatches.length));

  const userTypes = new Set(full.map((l) => typeof l.user));
  row("user field type(s)", [...userTypes].join(","));

  const created = full.map((l) => l.created_at).sort();
  row("created_at range", `${created[0]} .. ${created[created.length - 1]}`);
  const sameCreatedModified = count(full, (l) => l.created_at === l.modified_at);
  row("created_at === modified_at", String(sameCreatedModified));

  row("authors (map size)", String(Object.keys(authors).length));

  console.log(
    "\n(404-on-a-listed-id and the UA-403 check are transient/negative facts -- not re-measured here; see 07 §0.1.)",
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
