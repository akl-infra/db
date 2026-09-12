// [LDB-G8] db/INTEGRATION.md's error-code appendix is generated from
// src/core/errors.ts's own ApiError factories (db/scripts/gen-error-table.mjs)
// -- the integration guide's error table cannot drift from the real error
// vocabulary. Same shape as [LDB-G3]'s codeowners.test.ts: a subprocess
// `--check` run (the doc-authoring workflow other agents/PRs will actually
// run) plus a direct comparison against the generator's own exports (so a
// failure here says exactly which row differs, not just "mismatch").
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// gen-error-table.mjs is a plain script (no .d.ts) -- typed locally rather
// than widening db/tsconfig.json's own allowJs setting for one test file
// (codeowners.test.ts's own comment, same reason).
// @ts-expect-error -- see above
import * as genErrorTable from "../../scripts/gen-error-table.mjs";

const generate = genErrorTable.generate as () => string;
const parseErrors = genErrorTable.parseErrors as () => { name: string; params: string; status: string; code: string; message: string }[];

const DB_ROOT = path.resolve(import.meta.dirname, "..", "..");
const DOC_PATH = path.join(DB_ROOT, "INTEGRATION.md");
const BEGIN_MARKER = "<!-- BEGIN GENERATED ERROR TABLE (db/scripts/gen-error-table.mjs) -->";
const END_MARKER = "<!-- END GENERATED ERROR TABLE -->";

function docTable(): string {
  const text = fs.readFileSync(DOC_PATH, "utf8");
  const start = text.indexOf(BEGIN_MARKER);
  const stop = text.indexOf(END_MARKER);
  expect(start, `${BEGIN_MARKER} not found in db/INTEGRATION.md`).toBeGreaterThanOrEqual(0);
  expect(stop, `${END_MARKER} not found in db/INTEGRATION.md`).toBeGreaterThan(start);
  return text.slice(start + BEGIN_MARKER.length, stop).trim();
}

describe("db/INTEGRATION.md's error table is generated from errors.ts", () => {
  it("[LDB-G8] gen-error-table.mjs --check passes against the committed doc", () => {
    expect(() =>
      execFileSync("node", [path.join(DB_ROOT, "scripts", "gen-error-table.mjs"), "--check"], { stdio: "pipe" }),
    ).not.toThrow();
  });

  it("[LDB-G8] the doc's table equals generate()'s output, byte for byte", () => {
    expect(docTable()).toBe(generate());
  });

  it("[LDB-G8] every error() factory in errors.ts has exactly one row, and no row names a factory that isn't there", () => {
    const rows = parseErrors();
    const names = rows.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length); // no duplicates

    const errorsSrc = fs.readFileSync(path.join(DB_ROOT, "src", "core", "errors.ts"), "utf8");
    const exported = [...errorsSrc.matchAll(/^export function (\w+)\(/gm)].map((m) => m[1]);
    expect(new Set(names)).toEqual(new Set(exported));
  });

  it("[LDB-G8] every generated row's `error` code is a distinct snake_case identifier and every status is a valid HTTP status this service uses", () => {
    const rows = parseErrors();
    const codes = rows.map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const r of rows) {
      expect(r.code).toMatch(/^[a-z][a-z_]*$/);
      expect(["400", "401", "403", "404", "409", "422", "429", "500", "503"]).toContain(r.status);
    }
  });
});
