// LDB-F52 (docs/decisions/22-spark-spec.md §9): the `/v1` read of a spark/1
// payload is frozen at the 1.28 shape. Skip magic (API 1.29, LDB-F48..F51)
// is served only to a client that opts in with `features=skip`; everyone
// else gets the payload below. Pure, self-contained (07 §5: no import of
// src/), never mutates its input, and returns the SAME object when there is
// nothing to withhold.
//
// Withheld, and nothing else:
//   - `magic.magic_keys[].default` of kind `skip_repeat` (the key and its
//     rules stay);
//   - every `magic.magic_keys[].rules[]` entry whose `after` is an array;
//   - every `magic.chiral_keys[]` entry with `skip: true`, whole.
// Empty arrays stay empty, never deleted. Input that is not shaped like a
// payload is returned as is (callers validate; this never throws).
export interface Withheld<T> {
  payload: T;
  withheld: boolean;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function withholdMagicKey(k: unknown): { key: unknown; withheld: boolean } {
  if (!isObject(k)) return { key: k, withheld: false };
  let withheld = false;
  let out: Record<string, unknown> = k;
  if (isObject(k.default) && k.default.kind === "skip_repeat") {
    const { default: _default, ...rest } = out;
    out = rest;
    withheld = true;
  }
  if (Array.isArray(k.rules) && k.rules.some((r) => isObject(r) && Array.isArray(r.after))) {
    out = { ...out, rules: k.rules.filter((r) => !(isObject(r) && Array.isArray(r.after))) };
    withheld = true;
  }
  return { key: out, withheld };
}

export function withholdSkip<T>(payload: T): Withheld<T> {
  if (!isObject(payload) || !isObject(payload.magic)) return { payload, withheld: false };
  const magic = payload.magic;
  let changed = false;
  const next: Record<string, unknown> = { ...magic };

  if (Array.isArray(magic.magic_keys)) {
    const keys = magic.magic_keys.map(withholdMagicKey);
    if (keys.some((k) => k.withheld)) {
      next.magic_keys = keys.map((k) => k.key);
      changed = true;
    }
  }
  if (Array.isArray(magic.chiral_keys) && magic.chiral_keys.some((k) => isObject(k) && k.skip === true)) {
    next.chiral_keys = magic.chiral_keys.filter((k) => !(isObject(k) && k.skip === true));
    changed = true;
  }

  if (!changed) return { payload, withheld: false };
  return { payload: { ...payload, magic: next } as T, withheld: true };
}

// True iff the payload uses any skip construct (what `withholdSkip` would
// remove). The write guard's test (core/write.ts, `features_required`).
export function usesSkip(payload: unknown): boolean {
  return withholdSkip(payload).withheld;
}
