// A plain markdown pipe-table parser, shared by every test that reads a
// hand-maintained table out of a design doc (LDB-G10's endpoint/error
// tables in docs-site.test.ts; the [LDB-V4] route-table contract in
// tests/contract/ -- both read `db/docs/adoption.md`'s pipe tables and
// must never re-implement this parsing twice, or the two could silently
// disagree on what a row means). Extracted from docs-site.test.ts
// verbatim (2026-09-13, design/layout-db/25-api-versioning.md) -- no
// behavior change, just a second caller.

// Locates a pipe table by its header row's cells (exact, case-sensitive
// match against `headerCells`) so a doc's several pipe tables (the
// endpoint table, the error table, and others) are never confused for one
// another -- no comment markers needed (the renderer these docs target,
// design/federation/build_page.mjs's `render`, has no raw-HTML-comment
// passthrough, so a marker would render as visible text).
export function findPipeTable(md: string, headerCells: string[], sourceLabel = "markdown"): string[][] {
  const lines = md.split("\n");
  const cells = (line: string) =>
    line
      .replace(/^\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((c) => c.trim());
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]!;
    if (!line.startsWith("|") || !/^\|[\s:|-]+\|$/.test(lines[i + 1]!)) continue; // header, then a `---` separator row (internal `|`s included in the class)
    if (JSON.stringify(cells(line)) !== JSON.stringify(headerCells)) continue;
    const rows: string[][] = [];
    for (let j = i + 2; j < lines.length && lines[j]!.startsWith("|"); j++) rows.push(cells(lines[j]!));
    return rows;
  }
  throw new Error(`findPipeTable: no table with header ${JSON.stringify(headerCells)} in ${sourceLabel}`);
}

// "`/v1/layouts/:ref`" -> "/v1/layouts/:ref"; a cell with no backticks is
// returned trimmed, unchanged.
export function unbacktick(cell: string): string {
  const m = /^`([^`]*)`$/.exec(cell.trim());
  return m ? m[1]! : cell.trim();
}
