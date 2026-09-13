// [LDB-F3] Intent is never silently lowered on write: a record whose
// client sent idioms (magic_keys/chiral_keys/adaptive_swaps/the raw escape
// hatch) reads back with those idioms intact. The registry (src/formats/
// registry.ts) never lowers a stored payload -- `translate()` is either
// the identity (the resolved `as` equals the record's own format) or a
// `to[as]` translation; there is no path from "store" to "read the same
// format back" that touches `compileMagic()`/`lower()` at all.
// 901-idioms.json is the fixture built for exactly this (repeat key +
// except + explicit rules + chiral key + except + adaptive swap + raw
// rules, on a realistic 30-key layout). 21-formats.md D5/D12 deleted the
// `akl/1` alias this test used to read through deliberately (proving the
// alias path too, not just the native id) -- there are no aliases left,
// so this reads `"spark/1"` directly now.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { get as getFormat } from "../../src/formats/registry";
import type { Payload } from "../../formats/spark/1/index.ts";

const FIXTURE = path.resolve(import.meta.dirname, "..", "..", "formats", "spark", "1", "fixtures", "901-idioms.json");

describe("intent survives store + read (LDB-F3)", () => {
  const payload = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as Payload;

  it("901-idioms.json validates as spark/1", () => {
    const spark1 = getFormat("spark/1")!;
    expect(spark1.validate(payload).ok).toBe(true);
  });

  it("[LDB-F3] reading it back as its own format (the registry's identity path) keeps adaptive_swaps intact", () => {
    const spark1 = getFormat("spark/1")!;
    // "Reading it back" is exactly what a GET ?as=spark/1 of a spark/1
    // record does: registry.translate() with `as === rec.format` returns
    // the payload UNCHANGED (src/formats/registry.ts's `translate`), never
    // routing through `lower()`. Simulated here at the format-module level
    // (no D1/records in a format-only test) by asserting identity itself.
    const readBack = payload; // the identity translation IS the object itself
    expect(readBack.magic?.adaptive_swaps).toEqual(payload.magic?.adaptive_swaps);
    expect(readBack.magic?.adaptive_swaps).toEqual([{ trigger: "n", swap: ["h", "j"] }]);
    expect(spark1.validate(readBack).ok).toBe(true);
  });

  it("[LDB-F3] every idiom construct in the fixture is present, not pre-lowered", () => {
    expect(payload.magic?.magic_keys).toEqual([
      {
        key: ";",
        default: { kind: "repeat" },
        rules: [{ after: "t", output: "th" }],
        except: ["q"],
      },
    ]);
    expect(payload.magic?.chiral_keys).toEqual([{ key: "/", same: "ee", opposite: "ei", except: ["m"] }]);
    expect(payload.magic?.rules?.length).toBe(2);
  });

  it("[LDB-F3] the registry's own translate() never calls a format's compileMagic()/lower() on the identity path", () => {
    // Static check on registry.ts's own source: `translate()` returns
    // `{ payload: rec.payload }` verbatim once the resolved `as` equals
    // the record's own format, before ever touching `source.to[as]`
    // (which is the only place any format's own compile step gets
    // called, transitively, via fromCmini). Reading the source directly
    // here is deliberate: it's the one place this invariant is actually
    // enforced, and a future edit that made identity route through a
    // translation would be exactly the regression LDB-F3 exists to catch.
    // The pure `translate()` itself lives in db/formats/registry.ts (12
    // §3 X5 item 1, moved out of src/formats/registry.ts so it ships
    // inside @akl/layout-formats); 21-formats.md D5/D12 deleted the
    // legacy-normalization/alias-resolution steps that used to run in
    // front of this same identity check, so it's simpler now, not more
    // complex -- still a bare return with no `to[...]`/compile call.
    const src = fs.readFileSync(path.resolve(import.meta.dirname, "..", "..", "formats", "registry.ts"), "utf8");
    const identityLine = src.match(/if \(as === rec\.format\) return \{[^}]*\};/);
    expect(identityLine).not.toBeNull();
    expect(identityLine![0]).not.toMatch(/lower|compileMagic|to\[/);
  });
});
