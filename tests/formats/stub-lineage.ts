// 20-spark.md S5's test-only stub lineage: with only `spark/1` and
// `mana2/1` registered in production (each a one-major lineage), every
// chain behaviour (LDB-F18/F19/P13) is exercised here instead, through a
// throwaway `t/1 -> t/2 -> t/3` lineage plus a second lineage `u/1` that
// carries a registered cross edge FROM `t`'s own non-latest major (`t/2`,
// while `t`'s latest is `t/3`) -- exactly the "cross edge at a non-latest
// major" shape LDB-F19's own test needs. Never registered by default:
// every caller uses `registerForTest`/its own `afterEach`/`afterAll`
// unregister, same convention `tests/api/held.test.ts`'s `HELD_FORMAT`
// already sets.
//
// Payload shapes are deliberately trivial (each major a strict superset of
// the one below, one added field): `validate` only checks `a` is a number,
// so a hand-built object never needs to satisfy anything beyond what each
// test itself cares about.
import type { FormatModule, Held, ValidationResult } from "../../formats/registry.ts";

export interface T1Payload {
  v: 1;
  a: number;
}
export interface T2Payload {
  v: 2;
  a: number;
  b: number;
}
export interface T3Payload {
  v: 3;
  a: number;
  b: number;
  c: boolean;
}
export interface UPayload {
  tag: "u";
  a: number;
  b: number;
}

function validateHasNumberA(p: unknown): ValidationResult {
  if (typeof p !== "object" || p === null || typeof (p as { a?: unknown }).a !== "number") {
    return { ok: false, error: { error: "invalid_payload", message: "stub lineage: 'a' must be a number", path: "/a" } };
  }
  return { ok: true };
}

export const T1: FormatModule = {
  id: "t/1",
  owner: "test",
  description: "stub lineage major 1 (LDB-F18/F19/P13)",
  schema: {},
  role: "stored",
  validate: validateHasNumberA,
  to: {},
  from: {},
  hasMagic: () => false,
};

// up_2/down_2: `b` is added going up, defaulted to 0; `down` is held
// whenever `b !== 0` (R3: "down is honest -- held whenever ANYTHING would
// be lost"), which is exactly the fixture-driven round-trip LDB-F18's test
// checks (`b === 0` -> `up(down(p)) === p`-shaped; `b !== 0` -> held).
export const T2: FormatModule = {
  id: "t/2",
  owner: "test",
  description: "stub lineage major 2 (LDB-F18/F19/P13)",
  schema: {},
  role: "stored",
  validate: (p: unknown): ValidationResult => {
    const base = validateHasNumberA(p);
    if (!base.ok) return base;
    if (typeof (p as { b?: unknown }).b !== "number") {
      return { ok: false, error: { error: "invalid_payload", message: "stub lineage: 'b' must be a number", path: "/b" } };
    }
    return { ok: true };
  },
  to: {
    // The cross edge lives at a NON-LATEST major of `t` (latest is `t/3`):
    // LDB-F19's own "cross edge at a non-latest major" case.
    "u/1": (p: T2Payload): UPayload => ({ tag: "u", a: p.a, b: p.b }),
  },
  from: {},
  hasMagic: () => false,
  edits: {},
  up: (p: T1Payload): T2Payload => ({ v: 2, a: p.a, b: 0 }),
  down: (p: T2Payload): T1Payload | Held => (p.b !== 0 ? { held: true, reason: "b would be lost" } : { v: 1, a: p.a }),
};

// up_3/down_3: `c` added going up, defaulted to `false`; `down` held iff
// `c === true`.
export const T3: FormatModule = {
  id: "t/3",
  owner: "test",
  description: "stub lineage major 3 (LDB-F18/F19/P13)",
  schema: {},
  role: "stored",
  validate: (p: unknown): ValidationResult => {
    const base = validateHasNumberA(p);
    if (!base.ok) return base;
    if (typeof (p as { c?: unknown }).c !== "boolean") {
      return { ok: false, error: { error: "invalid_payload", message: "stub lineage: 'c' must be a boolean", path: "/c" } };
    }
    return { ok: true };
  },
  to: {},
  from: {},
  hasMagic: () => false,
  edits: {},
  up: (p: T2Payload): T3Payload => ({ v: 3, a: p.a, b: p.b, c: false }),
  down: (p: T3Payload): T2Payload | Held => (p.c ? { held: true, reason: "c would be lost" } : { v: 2, a: p.a, b: p.b }),
};

// The cross-lineage target `t/2.to["u/1"]` reaches -- a one-major lineage
// of its own, no `up`/`down` needed.
export const U1: FormatModule = {
  id: "u/1",
  owner: "test",
  description: "stub cross-lineage target, reachable only from t/2 (LDB-F19)",
  schema: {},
  role: "stored",
  validate: (p: unknown): ValidationResult => {
    if (typeof p !== "object" || p === null || (p as { tag?: unknown }).tag !== "u") {
      return { ok: false, error: { error: "invalid_payload", message: "stub lineage: 'tag' must be 'u'", path: "/tag" } };
    }
    return { ok: true };
  },
  to: {},
  from: {},
  hasMagic: () => false,
};

// -- Deliberately-broken variants, used ONLY to prove `chainViolations`
// (LDB-F18) actually catches each missing piece, not just that it passes
// on a conforming module (20-spark.md S5's own bar: "must prove each
// invariant AND prove the contract checks catch each missing piece").

export const T2_MISSING_UP: FormatModule = { ...T2, up: undefined };
export const T2_MISSING_DOWN: FormatModule = { ...T2, down: undefined };
export const T2_MISSING_EDITS: FormatModule = { ...T2, edits: undefined };
// `to`/`from` may never name the module's OWN lineage (19 §4.1) -- t/1
// pointing at t/2 violates this regardless of major.
export const T1_SELF_EDGE: FormatModule = { ...T1, to: { "t/2": (p: T1Payload) => p } };
