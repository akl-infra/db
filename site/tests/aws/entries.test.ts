import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SERVER = path.resolve(import.meta.dirname, "..", "..", "server");
const read = (f: string) => fs.readFileSync(path.join(SERVER, f), "utf8");

describe("[LDB-SITE9] one app, two entries", () => {
  it("both entries import the shared app and define no routes of their own", () => {
    for (const f of ["workers.ts", "lambda.ts"]) {
      expect(read(f)).toContain('from "./index.ts"');
      expect(read(f)).not.toMatch(/new Hono|\bapp\.(get|post|all|route|use)\(/);
    }
  });
  it("wrangler runs the Workers entry", () => {
    const toml = fs.readFileSync(path.join(SERVER, "..", "wrangler.toml"), "utf8");
    expect(toml).toContain('main = "server/workers.ts"');
  });
  it("the local diff harness exists (run by hand: node tests/aws/diff.mjs)", () => {
    expect(fs.existsSync(path.join(SERVER, "..", "tests", "aws", "diff.mjs"))).toBe(true);
  });
});
