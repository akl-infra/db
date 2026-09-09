// [LDB-W1] Every write route is resolve -> authorize -> check -> `appendWrite`
// (09 §2.6): the pipeline lives in `src/core/write.ts`, `src/routes/
// write.ts` is glue only and must not prepare a D1 statement itself -- the
// same boundary discipline `onlywriter.test.ts` enforces for `layouts`,
// scoped to the write route file T2 adds. Phase 1's READ routes
// (`layouts.ts`, `authors.ts`, ...) are a different, already-shipped
// design (07 §6 S6) that reads D1 directly and is not what LDB-W1 covers.
// X1 (12 §3) extends the rule to `routes/webhooks.ts` (glue over
// `core/webhooks.ts`) and `routes/stream.ts` (glue over `core/events.ts`'s
// `feed()`) -- neither prepares a D1 statement of its own either.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DB_ROOT = path.resolve(import.meta.dirname, "..", "..");
const D1_PATTERN = /\.prepare\(|\.batch\(/;
const NOPREPARE_FILES = ["write.ts", "webhooks.ts", "stream.ts"];

describe("routes/*.ts write boundary", () => {
  for (const name of NOPREPARE_FILES) {
    it(`[LDB-W1] src/routes/${name} does not prepare a D1 statement itself`, () => {
      const file = path.join(DB_ROOT, "src", "routes", name);
      expect(fs.existsSync(file)).toBe(true);
      const source = fs.readFileSync(file, "utf8");
      expect(D1_PATTERN.test(source)).toBe(false);
    });
  }
});
