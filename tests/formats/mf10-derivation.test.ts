// [MF-10 = LDB-F26] design/layout-db/21-formats.md §2.5/§4: each `role:
// "output"` format is reachable from exactly one `role: "stored"` lineage.
// `formats/registry.ts`'s `reachingLineages()`/`outputSourceLineage()` are
// the registry-level check this invariant runs on (read-time derivation,
// `core/formatread.ts`, is exercised live in `tests/api/held.test.ts`'s
// own MF-10-tagged case). Proven two ways: the REAL registry (today: only
// `mana2/1` is an output format, reached only by `spark/1`) satisfies it,
// and a deliberately-broken test-only pair of stored lineages BOTH
// claiming an edge to the same output format is caught (ambiguous ->
// `outputSourceLineage` answers `undefined`, not an arbitrary pick).
import { afterEach, describe, expect, it } from "vitest";
import { list as listFormats, outputSourceLineage, reachingLineages, registerForTest } from "../../formats/registry.ts";
import type { FormatModule, ValidationResult } from "../../formats/registry.ts";

function validateAlwaysOk(): ValidationResult {
  return { ok: true };
}

const OUT1: FormatModule = {
  id: "mf10out/1",
  owner: "test",
  description: "test-only output format (MF-10)",
  schema: {},
  role: "output",
  validate: validateAlwaysOk,
  to: {},
  from: {},
  hasMagic: () => false,
};

const SRC_A: FormatModule = {
  id: "mf10a/1",
  owner: "test",
  description: "test-only stored lineage A, reaches mf10out/1 (MF-10)",
  schema: {},
  role: "stored",
  validate: validateAlwaysOk,
  to: { "mf10out/1": (p: unknown) => p },
  from: {},
  hasMagic: () => false,
};

const SRC_B: FormatModule = {
  id: "mf10b/1",
  owner: "test",
  description: "test-only stored lineage B -- ALSO reaches mf10out/1 (the deliberately-broken half of MF-10)",
  schema: {},
  role: "stored",
  validate: validateAlwaysOk,
  to: { "mf10out/1": (p: unknown) => p },
  from: {},
  hasMagic: () => false,
};

let unregisterFns: (() => void)[] = [];
afterEach(() => {
  for (const un of unregisterFns.reverse()) un();
  unregisterFns = [];
});

function register(...mods: FormatModule[]): void {
  for (const m of mods) unregisterFns.push(registerForTest(m));
}

describe("[MF-10 = LDB-F26] the real registry: every output format has exactly one reaching stored lineage", () => {
  it("[MF-10] reachingLineages(id).length === 1 for every registered role:'output' format", () => {
    const outputs = listFormats().filter((f) => f.role === "output");
    expect(outputs.length).toBeGreaterThan(0); // mana2/1, today
    for (const out of outputs) {
      const reaching = reachingLineages(out.id);
      expect(reaching, `output format '${out.id}'`).toHaveLength(1);
      expect(outputSourceLineage(out.id)).toBe(reaching[0]);
    }
  });

  it("[MF-10] reachingLineages/outputSourceLineage answer empty/undefined for a non-output or unregistered id", () => {
    const stored = listFormats().find((f) => f.role === "stored")!;
    expect(reachingLineages(stored.id)).toEqual([]);
    expect(outputSourceLineage(stored.id)).toBeUndefined();
    expect(reachingLineages("not/registered")).toEqual([]);
    expect(outputSourceLineage("not/registered")).toBeUndefined();
  });
});

describe("[MF-10 = LDB-F26] a single reaching lineage resolves cleanly", () => {
  it("[MF-10] one stored lineage reaching the output format -> reachingLineages == [that lineage], outputSourceLineage resolves it", () => {
    register(OUT1, SRC_A);
    expect(reachingLineages("mf10out/1")).toEqual(["mf10a/1"]);
    expect(outputSourceLineage("mf10out/1")).toBe("mf10a/1");
  });
});

describe("[MF-10 = LDB-F26] TWO stored lineages reaching one output format is caught, not silently resolved", () => {
  it("[MF-10] reachingLineages reports both; outputSourceLineage refuses to pick one (undefined, not arbitrary)", () => {
    register(OUT1, SRC_A, SRC_B);
    const reaching = reachingLineages("mf10out/1");
    expect(reaching.sort()).toEqual(["mf10a/1", "mf10b/1"]);
    expect(outputSourceLineage("mf10out/1")).toBeUndefined();
  });
});
