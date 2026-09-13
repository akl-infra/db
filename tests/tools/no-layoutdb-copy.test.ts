// [LDB-G14] The product these docs describe is "akldb" (akldb.org,
// api.akldb.org) -- saltorbit, 2026-09-13 ("akldb everywhere"). "layoutdb" /
// "layout-db" / "the layout database" is the internal/historical name
// (design docs under design/layout-db/**, the `akl-db` Worker/app id) and
// must never reach the prose a client-integration reader sees: db/docs/
// adoption.md (served verbatim at akldb.org/adoption.md, LDB-G9/SITE-7)
// and db/INTEGRATION.md (this repo's own integration guide, LDB-G8's
// generated error table lives inside it). The ONE allowed exception is a
// literal `design/layout-db/<doc>.md` path -- an internal doc reference,
// not copy -- so this strips every such path before scanning the rest of
// the file for the banned pattern.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DB_ROOT = path.resolve(import.meta.dirname, "..", "..");
const BANNED = /layout[- ]?db|layout database/i;
const DOC_PATH_RE = /design\/layout-db\/[\w./-]*/g;

function withoutDocPaths(text: string): string {
  return text.replace(DOC_PATH_RE, "");
}

describe("[LDB-G14] client-facing docs never say \"layoutdb\"/\"layout database\"", () => {
  for (const rel of ["docs/adoption.md", "INTEGRATION.md"]) {
    it(`[LDB-G14] db/${rel} names the product akldb, never layoutdb/layout-db/layout database`, () => {
      const full = path.join(DB_ROOT, rel);
      const raw = fs.readFileSync(full, "utf8");
      const stripped = withoutDocPaths(raw);

      const offendingLines = stripped
        .split("\n")
        .map((line, i) => ({ line, i: i + 1 }))
        .filter(({ line }) => BANNED.test(line));

      expect(offendingLines, `db/${rel} lines still naming the old product: ${JSON.stringify(offendingLines)}`).toEqual([]);
    });
  }

  it("[LDB-G14] the DB base URL banner and the one-environment note both say akldb", () => {
    const adoption = fs.readFileSync(path.join(DB_ROOT, "docs/adoption.md"), "utf8");
    const integration = fs.readFileSync(path.join(DB_ROOT, "INTEGRATION.md"), "utf8");
    for (const text of [adoption, integration]) {
      expect(text).toMatch(/<- the one akldb/);
      expect(text).toMatch(/There is one akldb, production\./);
    }
  });

  it("[LDB-G14] withoutDocPaths sanity: the one remaining design/layout-db/ reference is stripped, not silently unmatched", () => {
    expect(withoutDocPaths("see `design/layout-db/25-api-versioning.md` for details")).not.toMatch(BANNED);
    // and the helper doesn't over-strip a real "layoutdb" appearing OUTSIDE
    // a design/layout-db/ path -- this must still be flagged.
    expect(withoutDocPaths("the one layoutdb")).toMatch(BANNED);
  });
});
