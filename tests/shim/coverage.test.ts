// [LDB-SH1] the shim covers every D1Database call store/d1 and src make.
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Replica } from "../../src/replica/replica";
import { looksLikeSql, scanLiterals, walkFiles } from "./literals";
import { freshReplica, ROOT, shimOf } from "./support";

const SRC = path.join(ROOT, "src");
// D1Result.meta's fields (other `.meta.` hits in store/d1 are akldb's own head objects, e.g. `.meta.seq`).
const D1_META = ["duration", "size_after", "rows_read", "rows_written", "last_row_id", "changed_db", "changes", "served_by"];

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function d1Files(): string[] {
  return walkFiles(path.join(SRC, "store", "d1"), /\.ts$/);
}

describe("D1 surface coverage", () => {
  let replica: Replica;
  let db: D1Database;
  beforeAll(async () => {
    replica = (await freshReplica()).replica;
    db = shimOf(replica);
  });

  it("[LDB-SH1] every method store/d1 calls on the database, a statement or a result exists on the shim", async () => {
    const used = { db: new Set<string>(), stmt: new Set<string>(), meta: new Set<string>() };
    for (const f of d1Files()) {
      const code = stripComments(fs.readFileSync(f, "utf8"));
      for (const m of code.matchAll(/\bdb\.(\w+)\s*[<(]/g)) used.db.add(m[1]!);
      for (const m of code.matchAll(/(?<!Promise)\.(first|all|run|raw|bind|iterate)\s*[<(]/g)) used.stmt.add(m[1]!);
      for (const m of code.matchAll(/\.meta\.(\w+)/g)) if (D1_META.includes(m[1]!)) used.meta.add(m[1]!);
    }
    // Sanity: the scan sees what we know is there (a scan that finds nothing proves nothing).
    expect(used.db).toContain("prepare");
    expect(used.db).toContain("batch");
    expect(used.stmt).toContain("first");
    expect(used.stmt).toContain("all");
    expect(used.stmt).toContain("run");
    expect(used.meta).toContain("changes");
    expect(used.meta).toContain("last_row_id");

    const stmt = db.prepare("SELECT 1 AS x") as unknown as Record<string, unknown>;
    const dbo = db as unknown as Record<string, unknown>;
    for (const name of used.db) expect(typeof dbo[name], `db.${name}`).toBe("function");
    for (const name of used.stmt) expect(typeof stmt[name], `statement.${name}`).toBe("function");
    // The rest of the D1 surface (src and the tests use exec(); raw/withSession/dump are part of the interface).
    for (const name of ["prepare", "batch", "exec", "dump", "withSession"]) expect(typeof dbo[name], `db.${name}`).toBe("function");
    for (const name of ["bind", "first", "all", "run", "raw"]) expect(typeof stmt[name], `statement.${name}`).toBe("function");
    const meta = (await db.prepare("SELECT 1 AS x").run()).meta as unknown as Record<string, unknown>;
    for (const name of used.meta) expect(Object.keys(meta), `meta.${name}`).toContain(name);
  });

  it("[LDB-SH1] nothing outside store/d1 touches the database: no .prepare/.batch/.exec on a D1 binding in src", () => {
    const hits: string[] = [];
    for (const f of walkFiles(SRC, /\.ts$/)) {
      const rel = path.relative(ROOT, f);
      if (rel.startsWith(path.join("src", "store", "d1") + path.sep) || rel.startsWith(path.join("src", "store", "shim") + path.sep) || rel.startsWith(path.join("src", "replica") + path.sep)) continue;
      const code = stripComments(fs.readFileSync(f, "utf8"));
      if (/\b(?:env|bindings|db|DB)\.(?:DB\.)?(?:prepare|batch|exec|dump|withSession)\s*\(/.test(code)) hits.push(rel);
    }
    expect(hits).toEqual([]);
  });

  it("[LDB-SH1] every static SQL string in store/d1 compiles on the shim's schema (the migrated replica)", () => {
    let compiled = 0;
    const failures: string[] = [];
    for (const f of d1Files()) {
      for (const lit of scanLiterals(fs.readFileSync(f, "utf8"))) {
        if (lit.dynamic || !looksLikeSql(lit.text) || !/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH|REPLACE)\b/i.test(lit.text)) continue;
        try {
          replica.db.prepare(lit.text);
          compiled++;
        } catch (e) {
          // A string that is only the start of a statement (dump.ts's "INSERT INTO layouts" + columns) is not a statement.
          if ((e as Error).message === "incomplete input") continue;
          failures.push(`${path.relative(ROOT, f)}:${lit.line}: ${(e as Error).message}`);
        }
      }
    }
    expect(failures).toEqual([]);
    // 218 statements in the study (28 batches); the dynamic ones are covered by the suite.
    expect(compiled).toBeGreaterThan(120);
  });
});
