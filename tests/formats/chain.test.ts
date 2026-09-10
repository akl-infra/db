// [LDB-F18] Chain contract (20-spark.md S5; 19-upcast.md round 2 §8's F16,
// renumbered here): every registered `<L>/<N>`, `N > 1`, must have
// `<L>/<N-1>` registered and export `up`/`down`/`edits`; `to`/`from` never
// name a module's own lineage; `down` is held or `up(down(p)) === p`
// (down is honest, §3 R3); `up(down(q)) === q`-shaped round trips going the
// other way (`up` is injective) and `up(q)` always validates at `N`. With
// only `spark/1`/`mana2/1` registered (each a one-major lineage) this is
// exercised entirely through the stub `t/1 -> t/2 -> t/3` lineage
// (`stub-lineage.ts`) -- including its deliberately-broken variants, which
// prove `chainViolations` actually catches each missing piece, not just
// that it passes on a conforming module.
import { describe, expect, it } from "vitest";
import { chainViolations, list, registerForTest } from "../../formats/registry.ts";
import { T1, T1_SELF_EDGE, T2, T2_MISSING_DOWN, T2_MISSING_EDITS, T2_MISSING_UP, T3 } from "./stub-lineage.ts";

describe("[LDB-F18] every REAL registered module is chain-clean today", () => {
  it("[LDB-F18] spark/1 and mana2/1 (each major 1) have zero chainViolations", () => {
    for (const mod of list()) {
      expect(chainViolations(mod), mod.id).toEqual([]);
    }
  });
});

describe("[LDB-F18] a conforming stub lineage has zero violations", () => {
  it("[LDB-F18] t/1, t/2, t/3 registered together are all clean", () => {
    const un1 = registerForTest(T1);
    const un2 = registerForTest(T2);
    const un3 = registerForTest(T3);
    try {
      expect(chainViolations(T1)).toEqual([]);
      expect(chainViolations(T2)).toEqual([]);
      expect(chainViolations(T3)).toEqual([]);
    } finally {
      un3();
      un2();
      un1();
    }
  });
});

describe("[LDB-F18] chainViolations catches each missing piece", () => {
  it("[LDB-F18] missing 'up' on a major > 1 is flagged", () => {
    const un1 = registerForTest(T1);
    const un2 = registerForTest(T2_MISSING_UP);
    try {
      const errs = chainViolations(T2_MISSING_UP);
      expect(errs.some((e) => e.includes("missing 'up'"))).toBe(true);
    } finally {
      un2();
      un1();
    }
  });

  it("[LDB-F18] missing 'down' on a major > 1 is flagged", () => {
    const un1 = registerForTest(T1);
    const un2 = registerForTest(T2_MISSING_DOWN);
    try {
      const errs = chainViolations(T2_MISSING_DOWN);
      expect(errs.some((e) => e.includes("missing 'down'"))).toBe(true);
    } finally {
      un2();
      un1();
    }
  });

  it("[LDB-F18] missing 'edits' on a major > 1 is flagged", () => {
    const un1 = registerForTest(T1);
    const un2 = registerForTest(T2_MISSING_EDITS);
    try {
      const errs = chainViolations(T2_MISSING_EDITS);
      expect(errs.some((e) => e.includes("missing 'edits'"))).toBe(true);
    } finally {
      un2();
      un1();
    }
  });

  it("[LDB-F18] a lineage gap (N-1 not registered) is flagged", () => {
    // T2 registered WITHOUT T1 -- `t/1` never lands.
    const un2 = registerForTest(T2);
    try {
      const errs = chainViolations(T2);
      expect(errs.some((e) => e.includes("no registered t/1"))).toBe(true);
    } finally {
      un2();
    }
  });

  it("[LDB-F18] 'to'/'from' naming the module's OWN lineage is flagged, even at major 1", () => {
    const errs = chainViolations(T1_SELF_EDGE);
    expect(errs.some((e) => e.includes("own lineage"))).toBe(true);
    // Unregistered here on purpose -- `chainViolations` is pure and doesn't
    // need this module actually IN the registry to check its own `to`/`from`.
  });
});

// -- Round-trip properties over the stub lineage's own fixtures (LDB-F18's
// own text): "down(p) is held OR up(down(p)) === p" and "up(down(q)) ...
// up(q) validates at N" (down honest / up injective+validating).
describe("[LDB-F18] round-trip properties (down honest, up injective+validating)", () => {
  const T2_FIXTURES = [
    { v: 2 as const, a: 1, b: 0 }, // b === 0: down never holds
    { v: 2 as const, a: 5, b: 7 }, // b !== 0: down MUST hold
  ];
  const T1_FIXTURES = [
    { v: 1 as const, a: 1 },
    { v: 1 as const, a: 42 },
  ];

  it("[LDB-F18] down(t/2 fixture) is held OR up(down(p)) === p", () => {
    for (const p of T2_FIXTURES) {
      const down = T2.down!(p);
      if (typeof down === "object" && down !== null && "held" in down) {
        expect(p.b).not.toBe(0); // held exactly when something would be lost
      } else {
        expect(T2.up!(down)).toEqual(p);
      }
    }
  });

  it("[LDB-F18] up(t/1 fixture) never holds, validates at t/2, and up is injective (down(up(q)) === q)", () => {
    for (const q of T1_FIXTURES) {
      const up = T2.up!(q);
      expect(T2.validate(up).ok).toBe(true);
      const down = T2.down!(up);
      expect(down).toEqual(q); // fresh `up` output always has b === 0 -- down never holds on it
    }
  });

  it("[LDB-F18] the SAME properties hold one major further up the chain (t/2 <-> t/3)", () => {
    const t3Fixtures = [
      { v: 3 as const, a: 1, b: 0, c: false },
      { v: 3 as const, a: 5, b: 7, c: true },
    ];
    for (const p of t3Fixtures) {
      const down = T3.down!(p);
      if (typeof down === "object" && down !== null && "held" in down) {
        expect(p.c).toBe(true);
      } else {
        expect(T3.up!(down)).toEqual(p);
      }
    }
    for (const q of T2_FIXTURES) {
      const up = T3.up!(q);
      expect(T3.validate(up).ok).toBe(true);
      expect(T3.down!(up)).toEqual(q);
    }
  });
});
