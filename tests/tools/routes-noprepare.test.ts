// [LDB-W1] Every write route is resolve -> authorize -> check -> `appendWrite`
// (09 §2.6): the pipeline lives in `src/core/write.ts`, `src/routes/
// write.ts` is glue only and must not prepare a D1 statement itself -- the
// same boundary discipline `onlywriter.test.ts` enforces for `layouts`,
// scoped to the write route file T2 adds. Phase 1's READ routes
// (`layouts.ts`, `authors.ts`, ...) are a different, already-shipped
// design (07 §6 S6) that reads D1 directly and is not what LDB-W1 covers.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DB_ROOT = path.resolve(import.meta.dirname, "..", "..");
const WRITE_ROUTES_FILE = path.join(DB_ROOT, "src", "routes", "write.ts");
const D1_PATTERN = /\.prepare\(|\.batch\(/;

describe("src/routes/write.ts write boundary", () => {
  it("[LDB-W1] the write routes file does not prepare a D1 statement itself", () => {
    expect(fs.existsSync(WRITE_ROUTES_FILE)).toBe(true);
    const source = fs.readFileSync(WRITE_ROUTES_FILE, "utf8");
    expect(D1_PATTERN.test(source)).toBe(false);
  });
});
