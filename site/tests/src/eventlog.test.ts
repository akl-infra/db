// [SITE-19] The Event log pages BACKWARDS from the head sequence: the
// windows it requests partition (0, head] exactly -- descending, adjacent,
// no overlap, no gap -- and the first window always contains the head
// (the newest event). A regression for the 2026-09-13 bug where the page
// started at since=0 and showed the oldest 50 events forever.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { windowBelow } from "../../src/lib/eventlog.ts";

describe("[SITE-19] Event log backwards paging", () => {
  it("[SITE-19] windows partition (0, head] descending with no gaps or overlaps, first window holds the head", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5000 }), fc.integer({ min: 1, max: 200 }), (head, page) => {
        let hi = head;
        let prevSince = head;
        let covered = 0;
        let first = true;
        for (let guard = 0; guard < 10000 && hi > 0; guard++) {
          const w = windowBelow(hi, page);
          expect(w.since + w.limit).toBe(hi); // window is (since, hi]
          expect(w.limit).toBeGreaterThan(0);
          expect(w.limit).toBeLessThanOrEqual(page);
          expect(w.since).toBe(hi - w.limit);
          expect(hi).toBe(prevSince); // adjacent to the previous window
          if (first) {
            expect(w.since < head && head <= w.since + w.limit).toBe(true);
            first = false;
          }
          covered += w.limit;
          prevSince = w.since;
          hi = w.nextHi;
        }
        expect(hi).toBe(0);
        expect(covered).toBe(head);
      }),
    );
  });

  it("[SITE-19] an empty log yields an empty window", () => {
    expect(windowBelow(0, 50)).toEqual({ since: 0, limit: 0, nextHi: 0 });
  });
});
