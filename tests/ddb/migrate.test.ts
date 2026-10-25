// [LDB-DDB74] Data migrations: numbered, run in order once, recorded in
// STATE/migrations, safe to run twice and to race, additive only, and the
// migrations-ddb/ directory and its index agree.
import fs from "node:fs";
import path from "node:path";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it } from "vitest";
import { exportRows } from "../../src/store/ddb/codec";
import { appliedMigrations, runMigrations, validateMigrations, MIGRATIONS_KEY, type DdbMigration } from "../../src/store/ddb/migrate";
import { MIGRATIONS } from "../../migrations-ddb";
import { ddbHarness } from "../harness/ddb";
import { wipeTables } from "../harness/ddb-store";

const ctx = { doc: ddbHarness.raw, tables: ddbHarness.tables, blobs: ddbHarness.blobs };
const DIR = path.resolve(import.meta.dirname, "..", "..", "migrations-ddb");
const mk = (id: string, up: DdbMigration["up"] = async () => {}): DdbMigration => ({ id, description: id, up });

beforeEach(() => wipeTables(ctx));

describe("runMigrations", () => {
  it("[LDB-DDB74] runs the real list once, records it, and a second run does nothing", async () => {
    const first = await runMigrations(ctx);
    expect(first.ran).toEqual(MIGRATIONS.map((m) => m.id));
    expect(first.skipped).toEqual([]);
    const second = await runMigrations(ctx);
    expect(second.ran).toEqual([]);
    expect(second.skipped).toEqual(MIGRATIONS.map((m) => m.id));
    expect(Object.keys(await appliedMigrations(ctx))).toEqual(MIGRATIONS.map((m) => m.id));
  });

  it("[LDB-DDB74] the no-op migration bumps the schema version and touches no row", async () => {
    const before = await exportRows(ctx);
    await runMigrations(ctx);
    const item = (await ctx.doc.send(new GetCommand({ TableName: ctx.tables.main, Key: MIGRATIONS_KEY, ConsistentRead: true }))).Item!;
    expect(item.schema_version).toBe(1);
    expect(await exportRows(ctx)).toEqual(before); // STATE/migrations is bookkeeping, not an import_state row
  });

  it("[LDB-DDB74] runs in id order, stops at a failure, records only what succeeded, and resumes there", async () => {
    const order: string[] = [];
    let fail = true;
    const list = [
      mk("0001_a", async () => void order.push("a")),
      mk("0002_b", async () => {
        order.push("b");
        if (fail) throw new Error("boom");
      }),
      mk("0003_c", async () => void order.push("c")),
    ];
    await expect(runMigrations(ctx, list)).rejects.toThrow("boom");
    expect(Object.keys(await appliedMigrations(ctx))).toEqual(["0001_a"]);
    fail = false;
    const r = await runMigrations(ctx, list);
    expect(r).toEqual({ ran: ["0002_b", "0003_c"], skipped: ["0001_a"] });
    expect(order).toEqual(["a", "b", "b", "c"]);
  });

  it("[LDB-DDB74] two runners racing both finish and the first record stands", async () => {
    let runs = 0;
    const list = [mk("0001_x", async () => void runs++), mk("0002_y", async () => void runs++)];
    const [a, b] = await Promise.all([runMigrations(ctx, list, () => "T1"), runMigrations(ctx, list, () => "T2")]);
    expect(a.ran.length + b.ran.length).toBeGreaterThanOrEqual(2);
    const applied = await appliedMigrations(ctx);
    expect(Object.keys(applied).sort()).toEqual(["0001_x", "0002_y"]);
    expect(runs).toBeGreaterThanOrEqual(2); // idempotent migrations may run twice; the record is single
    expect(["T1", "T2"]).toContain(applied["0001_x"]);
  });

  it("[LDB-DDB74] ids must be NNNN_snake_case, unique and ascending", () => {
    expect(() => validateMigrations([mk("1_a")])).toThrow(/NNNN/);
    expect(() => validateMigrations([mk("0001_Upper")])).toThrow(/NNNN/);
    expect(() => validateMigrations([mk("0002_a"), mk("0001_b")])).toThrow(/not after/);
    expect(() => validateMigrations([mk("0001_a"), mk("0001_a")])).toThrow(/not after/);
    expect(() => validateMigrations(MIGRATIONS)).not.toThrow();
  });
});

describe("migrations-ddb/", () => {
  const files = fs.readdirSync(DIR).filter((f) => /^\d{4}_.*\.ts$/.test(f)).sort();

  it("[LDB-DDB74] every NNNN_*.ts file is in the index, with its own file name as id, and vice versa", () => {
    expect(files.map((f) => f.replace(/\.ts$/, ""))).toEqual(MIGRATIONS.map((m) => m.id));
  });

  // The DynamoDB twin of tests/tools/migrations-additive.test.ts (LDB-G15): a data
  // migration may add and rewrite items, never remove them or drop a table.
  const FORBIDDEN: { name: string; pattern: RegExp }[] = [
    { name: "DeleteCommand", pattern: /\bDeleteCommand\b/ },
    { name: "DeleteItem", pattern: /\bDeleteItem(Command)?\b/ },
    { name: "DeleteRequest", pattern: /\bDeleteRequest\b/ },
    { name: "Delete: (transact item)", pattern: /\bDelete\s*:/ },
    { name: "DeleteTable", pattern: /\bDeleteTable(Command)?\b/ },
    { name: "deleteTables", pattern: /\bdeleteTables\b/ },
    { name: "REMOVE (update expression)", pattern: /\bREMOVE\s+[#:\w]/ },
    { name: "UpdateTimeToLive disable", pattern: /Enabled\s*:\s*false/ },
  ];
  const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const violations = (src: string): string[] => FORBIDDEN.filter((f) => f.pattern.test(strip(src))).map((f) => f.name);

  it("[LDB-DDB74] no migration deletes an item or a table (additive only)", () => {
    for (const f of files) expect(violations(fs.readFileSync(path.join(DIR, f), "utf8")), f).toEqual([]);
  });

  it("[LDB-DDB74] the additive scan trips on every forbidden construct (it is not vacuous)", () => {
    expect(violations("await doc.send(new DeleteCommand({}))")).toEqual(["DeleteCommand"]);
    expect(violations("{ Delete: { TableName } }")).toEqual(["Delete: (transact item)"]);
    expect(violations("UpdateExpression: 'REMOVE a'")).toEqual(["REMOVE (update expression)"]);
    expect(violations("RequestItems: { t: [{ DeleteRequest: {} }] }")).toEqual(["DeleteRequest"]);
    expect(violations("await deleteTables(doc, t)")).toEqual(["deleteTables"]);
    expect(violations("// a DeleteCommand in a comment is prose")).toEqual([]);
  });
});
