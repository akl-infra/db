// [SITE-21] The likes wire the site consumes is the one the DB records:
// `db/tests/fixtures/db-responses/likes.json` (`{ user_ids: [...] }` per
// layout). A production regression on 2026-09-13 read `.likes` instead --
// the resulting TypeError inside a memo (signed-in users only) disposed
// the whole Solid root ("none of the buttons work"). This test pins the
// shape against the recorded fixture and proves the helper never throws.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { isLikedBy } from "../../src/lib/likes.ts";

const FIXTURE = path.resolve(import.meta.dirname, "..", "..", "..", "tests", "fixtures", "db-responses", "likes.json");

describe("[SITE-21] likes wire shape", () => {
  it("[SITE-21] every recorded likes response is { user_ids: string[] } and isLikedBy reads exactly that", () => {
    const all = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;
    const entries = Object.entries(all);
    expect(entries.length).toBeGreaterThan(0);
    for (const [, res] of entries) {
      expect(res).toHaveProperty("user_ids");
      const ids = (res as { user_ids: unknown }).user_ids;
      expect(Array.isArray(ids)).toBe(true);
      for (const id of ids as string[]) expect(isLikedBy(res, id)).toBe(true);
      expect(isLikedBy(res, "not-a-user")).toBe(false);
    }
  });

  it("[SITE-21] isLikedBy never throws, whatever shape it is handed", () => {
    fc.assert(
      fc.property(fc.anything(), fc.string(), (res, id) => {
        expect(() => isLikedBy(res, id)).not.toThrow();
      }),
    );
  });
});
