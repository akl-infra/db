// [SITE-33] every label on both W1c sequence diagrams fits its own lane
// (a unit test over the diagram's own data model -- src/ui/diagrams/
// sequence.ts's checkFit/checkLaneFit -- estimating each label's width at
// var(--font-body)'s real monospace advance width, generously rounded up).
// This is the model-level half of SITE-33; the other half is the real
// Chrome measurement (getBBox() per <text> vs its lane) run during the W1c
// Chrome check -- see AuthOwnership.tsx/TrustedClient.tsx's own header
// comments for that result. No DOM/Solid runtime needed here: `sequence.ts`
// is plain data + arithmetic, so this suite runs under vitest's default
// "node" environment same as every other tools/ test in this package.
import { describe, expect, it } from "vitest";
import { checkFit, checkLaneFit, fitTextLength } from "../../src/ui/diagrams/sequence.ts";
import { authOwnershipModel } from "../../src/ui/diagrams/AuthOwnership.tsx";
import { trustedClientModel } from "../../src/ui/diagrams/TrustedClient.tsx";

const DIAGRAMS = [
  { name: "AuthOwnership", model: authOwnershipModel },
  { name: "TrustedClient", model: trustedClientModel },
];

describe("[SITE-33] sequence diagram text fit", () => {
  for (const { name, model } of DIAGRAMS) {
    it(`[SITE-33] ${name}: every lane header fits its own box without exceeding the allowed squeeze`, () => {
      // checkLaneFit() itself throws (via fitTextLength) if any label would
      // need more than MAX_SQUEEZE compression -- calling it is the
      // assertion; a passing call means every lane header fits.
      const results = checkLaneFit(model);
      expect(results.length).toBe(model.lanes.length);
      for (const r of results) {
        expect(r.avail).toBeGreaterThan(0);
      }
    });

    it(`[SITE-33] ${name}: every step label fits its own arrow/self-loop span without exceeding the allowed squeeze`, () => {
      const results = checkFit(model);
      expect(results.length).toBe(model.steps.length);
      for (const r of results) {
        expect(r.avail).toBeGreaterThan(0);
        // If a textLength was assigned, it must never widen a label beyond
        // its own natural size (fitTextLength only ever narrows).
        if (r.textLength !== undefined) {
          expect(r.textLength).toBeLessThanOrEqual(r.avail);
        }
      }
    });

    it(`[SITE-33] ${name}: has at least one arrow step and one self step (both code paths exercised)`, () => {
      expect(model.steps.some((s) => s.kind === "arrow")).toBe(true);
      expect(model.steps.some((s) => s.kind === "self")).toBe(true);
    });
  }

  it("[SITE-33] a label engineered to overflow even at max squeeze is rejected, not silently over-compressed", () => {
    // fitTextLength itself is the enforcement point checkFit/checkLaneFit
    // both call -- proving IT refuses an impossible fit is what makes a
    // passing checkFit() above meaningful (not vacuously true because
    // squeezing is unbounded).
    expect(() => fitTextLength("this label is far too long to ever fit in a narrow lane gap", 100)).toThrow();
  });
});
