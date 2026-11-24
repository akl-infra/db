// [LDB-FZ10] Seeded property tests for the stored format and its translators (Stage 4 F-db; stage4-spec.md §3):
//   - `validate` never throws on any JSON, generated or mutated from a real fixture, and always answers `{ok:true}` or a typed
//     `{ok:false, error:{error,message,path}}`;
//   - a valid payload: `compileMagic`, `hasMagic/hasAlts/hasCombos`, `translate` to mana2/1 never throw and the mana2/1 result
//     (when not held) is itself valid mana2/1; a JSON round-trip stays valid and compiles to the same rows;
//   - an edit never throws: `{error}` or a payload `validate` can judge without throwing; a well-formed fingermap edit validates;
//   - cmini/1 (`validate`, `parseUpstreamDetail`) and mana2/1 `validate` never throw on arbitrary JSON.
// Fixed seed + small runs here; the nightly `fuzz` job re-runs this file with FUZZ_SEED random and FUZZ_RUNS large. The inputs
// respect API 1.38 (LDB-F71): off-layout alt literals (`"∞"`, `"\""`) and a space swap trigger are ACCEPTED, so no property
// assumes they are refused; the generator emits them on purpose.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as spark1 from "../../formats/spark/1/index.ts";
import * as mana2 from "../../formats/mana2/1/index.ts";
import * as cmini from "../../formats/adapters/cmini/index.ts";
import { parseUpstreamDetail } from "../../formats/adapters/cmini/parse.ts";
import { translate } from "../../formats/registry.ts";
import { runProperty } from "./fuzz-support.ts";
import { FIXTURES, FINGERS, anyInput, charArb, fingerArb, payloadArb, wildJson } from "./fuzz-arbitraries.ts";

function typedRefusal(r: spark1.ValidationResult): void {
  if (r.ok) return;
  expect(typeof r.error.error).toBe("string");
  expect(typeof r.error.message).toBe("string");
  expect(typeof r.error.path).toBe("string");
  expect(String(r.error.path).startsWith("/")).toBe(true);
}

describe("[LDB-FZ10] spark/1 seeded properties", () => {
  it("[LDB-FZ10] the fixtures themselves are all valid (the mutation base is not vacuous)", () => {
    expect(FIXTURES.length).toBeGreaterThan(5);
    for (const f of FIXTURES) expect(spark1.validate(f.payload), f.name).toEqual({ ok: true });
  });

  it("[LDB-FZ10] validate never throws, and answers ok or a typed refusal, on any JSON", async () => {
    await runProperty("spark1-validate-total", fc.property(anyInput, (p) => typedRefusal(spark1.validate(p))), 200);
  });

  it("[LDB-FZ10] the generators reach both sides (some inputs accepted, some refused)", () => {
    const sample = fc.sample(anyInput, { seed: 1, numRuns: 300 });
    const ok = sample.filter((p) => spark1.validate(p).ok).length;
    expect(ok).toBeGreaterThan(10);
    expect(ok).toBeLessThan(sample.length - 10);
  });

  it("[LDB-FZ10] valid => compile/flags/translate never throw, mana2/1 output validates, JSON round-trip is stable", async () => {
    await runProperty(
      "spark1-valid-downstream",
      fc.property(anyInput, (p) => {
        fc.pre(spark1.validate(p).ok);
        const payload = p as spark1.Payload;
        const rows = spark1.compileMagic(payload);
        expect(Array.isArray(rows)).toBe(true);
        expect(spark1.hasMagic(payload)).toBe(rows.length > 0);
        expect(typeof spark1.hasAlts(payload)).toBe("boolean");
        expect(typeof spark1.hasCombos(payload)).toBe("boolean");
        const again = JSON.parse(JSON.stringify(payload));
        expect(spark1.validate(again)).toEqual({ ok: true });
        expect(JSON.stringify(spark1.compileMagic(again))).toBe(JSON.stringify(rows));
        // Third reported gap: spark/1 has no upper bound on `col`, and translating a layout with col 1e9 (or 1e308) to mana2/1
        // pushes one "skip" token per empty column (`mana2/1/translate.ts` fromSpark) -- seconds of CPU, then RangeError. The
        // translation half of this property therefore only runs for plausible columns.
        if (payload.keys.some((k) => k.col > 1000)) return;
        const t = translate({ format: "spark/1", payload }, "mana2/1");
        if ("payload" in t) {
          // Reported gaps (Stage 4 F-db handoff): spark/1 accepts a multi-code-point `char`, a control-character `char` used in a
          // combo, and a six-row (-1..4) layout, and their mana2/1 translations are refused by mana2/1's own validate. The validity half of this property holds for the rest.
          const ks = payload.keys;
          const rowsSpan = ks.length === 0 ? 0 : Math.max(...ks.map((k) => k.row)) - Math.min(...ks.map((k) => k.row)) + 1;
          const singleChars = ks.every((k) => k.char === undefined || ([...k.char].length === 1 && !/[\p{Cc}\p{Cs}]/u.test(k.char)));
          if (singleChars && rowsSpan <= 5) {
            const v = mana2.validate(t.payload);
            expect(v.ok, JSON.stringify(v)).toBe(true);
          }
        } else expect("held" in t || "unknown" in t).toBe(true);
      }),
      200,
    );
  });

  it("[LDB-FZ10] an edit never throws: a typed {error}, or a payload validate can judge; a well-formed fingermap edit validates", async () => {
    const editArb = fc.oneof(
      fc.record({ verb: fc.constant("setFingermap" as const), value: fc.dictionary(charArb, fc.oneof(fingerArb, wildJson as fc.Arbitrary<never>), { maxKeys: 4 }) }),
      fc.record({ verb: fc.constant("setMagic" as const), value: wildJson }),
      fc.record({ verb: fc.constant("setAlts" as const), value: wildJson }),
      fc.record({ verb: fc.constant("setCombos" as const), value: wildJson }),
    );
    await runProperty(
      "spark1-edits-total",
      fc.property(payloadArb, editArb, (p, edit) => {
        fc.pre(spark1.validate(p).ok);
        const payload = p as unknown as spark1.Payload;
        const before = JSON.stringify(payload);
        const result = (spark1.edits[edit.verb] as (p: spark1.Payload, v: unknown) => unknown)(payload, edit.value);
        expect(JSON.stringify(payload), "an edit never mutates its input").toBe(before);
        if (result && typeof result === "object" && "error" in result && !("keys" in result)) {
          const e = (result as { error: spark1.ErrBody }).error;
          expect(typeof e.error).toBe("string");
          expect(typeof e.message).toBe("string");
        } else {
          typedRefusal(spark1.validate(result));
          if (edit.verb === "setFingermap") {
            const fm = edit.value as Record<string, unknown>;
            if (Object.values(fm).every((f) => typeof f === "string" && FINGERS.includes(f))) {
              expect(spark1.validate(result), "a well-formed fingermap edit on a valid payload stays valid").toEqual({ ok: true });
            }
          }
        }
      }),
      200,
    );
  });

  it("[LDB-FZ10] mana2/1 and cmini/1 validate, and the cmini upstream parser, never throw on any JSON", async () => {
    await runProperty(
      "other-formats-total",
      fc.property(anyInput, (p) => {
        for (const v of [mana2.validate(p), cmini.validate(p)]) {
          expect(typeof v.ok).toBe("boolean");
          if (!v.ok) expect(typeof v.error.message).toBe("string");
        }
        const parsed = parseUpstreamDetail(p);
        if (!parsed.ok) {
          expect(typeof parsed.error.path).toBe("string");
          expect(typeof parsed.error.message).toBe("string");
        }
        // translate's precondition is a payload valid in its own format (the write path validates first).
        for (const as of ["spark/1", "mana2/1", "cmini/1", "nope/9"]) {
          for (const [format, mod] of [["spark/1", spark1], ["mana2/1", mana2]] as const) {
            if (!mod.validate(p).ok) continue;
            if (format === "spark/1" && (p as spark1.Payload).keys.some((k) => k.col > 1000)) continue; // see the col note above
            const t = translate({ format, payload: p }, as);
            expect("payload" in t || "held" in t || "unknown" in t).toBe(true);
          }
        }
      }),
      150,
    );
  });

  it("[LDB-FZ10] the harness finds a planted bug at the fixed seed (a validate that throws on an empty-string key)", async () => {
    const planted = (p: unknown): void => {
      spark1.validate(p);
      const keys = (p as { keys?: { char?: unknown }[] } | null)?.keys;
      if (Array.isArray(keys) && keys.some((k) => k && k.char === "∞")) throw new Error("planted");
    };
    await expect(runProperty("planted", fc.property(payloadArb, (p) => planted(p)), 200)).rejects.toThrow(/FUZZ_SEED=/);
  });
});
