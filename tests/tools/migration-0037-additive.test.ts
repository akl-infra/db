// [LDB-R17] migrations/0037_read_indexes.sql is purely additive: two partial
// indexes, nothing else. Complements LDB-G15's forbidden-statement scan with a
// positive allow-list.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("[LDB-R17] [LDB-R20] migration 0037 is purely additive", () => {
  it("[LDB-R17] [LDB-R20] creates only the three partial read indexes; no table, column or row is touched", () => {
    const sql = fs.readFileSync(path.resolve(import.meta.dirname, "../../migrations/0037_read_indexes.sql"), "utf8")
      .split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
    const statements = sql.split(";").map((s) => s.trim()).filter((s) => s.length > 0);
    expect(statements).toEqual([
      "CREATE INDEX events_upstream_deleted_at ON events(at) WHERE kind = 'upstream_deleted'",
      "CREATE INDEX clients_suspended ON clients(id) WHERE status = 'suspended'",
      "CREATE INDEX layouts_tombstones_by_name ON layouts(name, modified_at, layout_rev) WHERE deleted = 1",
    ]);
  });
});
