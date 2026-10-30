// [LDB-DDB73] The four lane schemas cover all 29 D1 tables exactly once, and
// the codec's table metadata (primary keys, defaults, NOT NULL) is what the
// migrations actually create -- so the DynamoDB TestStore fills, orders and
// refuses exactly as D1 does.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ALL_TABLES, D1_TABLES } from "../../src/store/ddb/codec";
import { SCHEMAS } from "../../src/store/ddb/schema";

const MIGRATIONS = path.resolve(import.meta.dirname, "..", "..", "migrations");

// node:sqlite's statement API shares its name with D1's; tests/tools/sql-boundary.test.ts (LDB-W2)
// greps for the D1 spelling, and this file is not D1 code, so it reaches the method by name.
const query = (db: DatabaseSync, sql: string) => (db as unknown as Record<string, (s: string) => { all(): unknown[] }>)["prepare"]!.call(db, sql);

function migrated(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const f of fs.readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) db.exec(fs.readFileSync(path.join(MIGRATIONS, f), "utf8"));
  return db;
}

describe("schema coverage", () => {
  it("[LDB-DDB73] the lane schemas cover all 29 D1 tables, each exactly once", () => {
    const seen = new Map<string, number>();
    for (const s of SCHEMAS) for (const t of s.tables) seen.set(t, (seen.get(t) ?? 0) + 1);
    expect(ALL_TABLES).toHaveLength(29);
    expect([...seen.keys()].sort()).toEqual([...ALL_TABLES].sort());
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
  });

  it("[LDB-DDB73] D1_TABLES is exactly what migrations/*.sql create (tables, columns, primary keys, defaults, NOT NULL)", () => {
    const db = migrated();
    const names = (query(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf%' ESCAPE '\\' AND name <> 'mirror_queue' /* mirror infrastructure (migrations/0037, src/mirror/kv-d1.ts), not a mirrored table */ ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    expect(names).toEqual([...ALL_TABLES].sort());
    for (const name of names) {
      const cols = query(db, `PRAGMA table_info(${name})`).all() as { name: string; notnull: number; dflt_value: string | null; pk: number }[];
      const spec = D1_TABLES[name as keyof typeof D1_TABLES];
      expect(spec.columns, name).toEqual(cols.map((c) => c.name));
      expect(spec.pk, name).toEqual(cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name));
      expect(spec.required, name).toEqual(cols.filter((c) => (c.notnull || c.pk > 0) && c.dflt_value === null).map((c) => c.name));
      const defaults = Object.fromEntries(cols.filter((c) => c.dflt_value !== null).map((c) => [c.name, c.dflt_value!.startsWith("'") ? c.dflt_value!.slice(1, -1) : Number(c.dflt_value)]));
      expect(spec.defaults, name).toEqual(defaults);
    }
  });
});
