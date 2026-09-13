// [LDB-A10] rogue-trusted-client hardening (saltorbit 2026-09-13): the pure
// half of the auto-suspend budget -- `destructiveThreshold` itself, and
// the "at most budget+1 destructive writes ever land" property that
// `core/clients.ts`'s `checkDestructiveBudget` (called from `core/
// write.ts`'s `commitWithRetry` / `core/links.ts`'s `clearLink`, right
// after each destructive write's own commit) is built to guarantee. The
// real end-to-end wiring (a client actually getting 403'd mid-stream, and
// un-stuck by an admin reactivate) is proven over real HTTP in
// tests/api/rogue-client.test.ts; this file pins the ALGEBRAIC shape of
// the bound itself, independent of HTTP/D1.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DESTRUCTIVE_BUDGET_BASE, destructiveThreshold } from "../../src/core/destructive-budget";

describe("[LDB-A10] destructiveThreshold(liveLayoutCount)", () => {
  it("[LDB-A10] never below the base, for any non-negative layout count", () => {
    fc.assert(
      fc.property(fc.nat({ max: 10_000_000 }), (n) => {
        expect(destructiveThreshold(n)).toBeGreaterThanOrEqual(DESTRUCTIVE_BUDGET_BASE);
      }),
    );
  });

  it("[LDB-A10] non-decreasing in liveLayoutCount", () => {
    fc.assert(
      fc.property(fc.nat({ max: 10_000_000 }), fc.nat({ max: 10_000_000 }), (a, b) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        expect(destructiveThreshold(lo)).toBeLessThanOrEqual(destructiveThreshold(hi));
      }),
    );
  });

  it("[LDB-A10] a catalog large enough that 5% exceeds the base is reflected exactly (ceil(pct * n))", () => {
    // 200 / 0.05 = 4000 -- comfortably past that, the percentage term wins.
    expect(destructiveThreshold(4_177)).toBe(209); // ceil(4177 * 0.05)
    expect(destructiveThreshold(1_000_000)).toBe(50_000);
  });
});

// [LDB-A10] the "can never complete more than budget+1" claim, as an
// algebraic property over an arbitrary sequence of destructive-write
// ATTEMPTS from one client: every attempt increments a monotonic per-
// window counter (the same fixed-window upsert `destructiveBudgetStatement`
// drives, `core/destructive-budget.ts`) and, once that counter exceeds
// `destructiveThreshold(liveLayouts)`, every LATER attempt in the same
// window is refused before it can increment anything at all (auth/
// client.ts's live `status` check, checked BEFORE the write's own batch
// ever runs) -- so the count of attempts that actually LAND is bounded by
// the threshold plus exactly the one attempt that tripped it.
function simulateWindow(attempts: number, liveLayouts: number): { landed: number; trippedAt: number | null } {
  const threshold = destructiveThreshold(liveLayouts);
  let count = 0;
  let landed = 0;
  let suspended = false;
  let trippedAt: number | null = null;
  for (let i = 0; i < attempts; i++) {
    if (suspended) continue; // auth/client.ts refuses it before any commit
    count += 1;
    landed += 1;
    if (count > threshold && !suspended) {
      suspended = true;
      trippedAt = i;
    }
  }
  return { landed, trippedAt };
}

describe("[LDB-A10] property: a client can never complete more destructive writes in one window than budget + 1", () => {
  it("[LDB-A10] [property] over random attempt counts and catalog sizes", () => {
    fc.assert(
      fc.property(fc.nat({ max: 2000 }), fc.nat({ max: 1_000_000 }), (attempts, liveLayouts) => {
        const threshold = destructiveThreshold(liveLayouts);
        const { landed, trippedAt } = simulateWindow(attempts, liveLayouts);
        expect(landed).toBeLessThanOrEqual(threshold + 1);
        // And it's TIGHT when there were enough attempts to reach it --
        // never refuses early, never leaves the tripping write unrefused
        // for the NEXT one.
        if (attempts > threshold) {
          expect(landed).toBe(threshold + 1);
          expect(trippedAt).toBe(threshold); // zero-indexed: the (threshold+1)th attempt
        } else {
          expect(landed).toBe(attempts);
          expect(trippedAt).toBeNull();
        }
      }),
    );
  });
});
