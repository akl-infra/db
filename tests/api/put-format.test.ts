// [LDB-P13] Older-major write (20-spark.md S5; 19-upcast.md round 2 §3/§7's
// P11, renumbered here): a write naming an older major of the record's own
// lineage is refused `409 format_behind` iff the record's latest-only
// content is non-empty (the down-view would itself be held); otherwise it
// is chained UP to the lineage's latest major at write time, with
// `detail.written_as` on the event naming what was actually sent -- and
// the stored major never decreases. Exercised through the stub `t/1 ->
// t/2 -> t/3` lineage (`stub-lineage.ts`), since `spark/1`/`mana2/1` are
// each still a one-major lineage. Every write here is a FORMAT-scope write
// on lineage `t` (21-formats.md §2.2) -- If-Match tokens are `"t:<rev>"`.
import { env } from "cloudflare:test";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { fixedClock } from "../../src/core/time";
import { registerForTest } from "../../src/formats/registry";
import { T1, T2, T3 } from "../formats/stub-lineage";
import { actorFixture, pinTestClock, register, uniqueName, writeFetch } from "./write-support";

const db = (env as unknown as Bindings).DB;
const clock = fixedClock("2026-09-10T00:00:00.000Z");
pinTestClock(env as unknown as { TEST_CLOCK?: typeof clock }, clock);

function headers() {
  return register(actorFixture(), `tok-${uniqueName("pf")}`, "owner-put-format-1");
}

// A FRESH actor per call (own unique `owner_user_id`) -- LDB-R6 caps writes
// at 60 per 10-minute window PER ACTOR, and the property test below issues
// up to 9 writes per run; a shared actor across `numRuns` iterations would
// blow that budget almost immediately and 429 instead of exercising the
// invariant under test.
function freshHeaders() {
  const owner = uniqueName("owner-pf-prop");
  return register(actorFixture(), `tok-${uniqueName("pf-prop-tok")}`, owner);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// Registers t/1..t/3 for the lifetime of one test -- same convention
// `tests/api/held.test.ts`'s stub-lineage tests use.
function withStubLineage<T>(fn: () => Promise<T>): Promise<T> {
  const un1 = registerForTest(T1);
  const un2 = registerForTest(T2);
  const un3 = registerForTest(T3);
  return fn().finally(() => {
    un3();
    un2();
    un1();
  });
}

async function storedFormatOf(id: string): Promise<string> {
  const row = await db.prepare("SELECT format FROM layout_formats WHERE layout_id = ? AND lineage = 't'").bind(id).first<{ format: string }>();
  return row!.format;
}

async function writtenAsOf(id: string): Promise<unknown> {
  const row = await db
    .prepare("SELECT detail_json FROM events WHERE layout_id = ? AND format IS NOT NULL ORDER BY seq DESC LIMIT 1")
    .bind(id)
    .first<{ detail_json: string | null }>();
  return row?.detail_json === null || row?.detail_json === undefined ? undefined : (JSON.parse(row.detail_json) as { written_as?: string }).written_as;
}

describe("[LDB-P13] POST in an older major: R2's chain, no R1", () => {
  it("[LDB-P13] POST format 't/1' stores at t/3 (the lineage's latest), written_as: 't/1'", () =>
    withStubLineage(async () => {
      const res = await writeFetch("/v1/layouts", "POST", headers(), { name: uniqueName("pf-post"), format: "t/1", payload: { v: 1, a: 5 } });
      expect(res.status).toBe(201);
      const body = await res.json<{ id: string; format: string; payload: unknown }>();
      expect(body.format).toBe("t/3"); // native, chained -- t/1 isn't an alias, so no relabel
      expect(body.payload).toEqual({ v: 3, a: 5, b: 0, c: false });
      expect(await storedFormatOf(body.id)).toBe("t/3");
      expect(await writtenAsOf(body.id)).toBe("t/1");
    }));

  it("[LDB-P13] POST format 't/3' (already latest) stores at t/3, no written_as", () =>
    withStubLineage(async () => {
      const res = await writeFetch("/v1/layouts", "POST", headers(), {
        name: uniqueName("pf-post-latest"),
        format: "t/3",
        payload: { v: 3, a: 5, b: 1, c: true },
      });
      expect(res.status).toBe(201);
      const body = await res.json<{ id: string; format: string }>();
      expect(body.format).toBe("t/3");
      expect(await writtenAsOf(body.id)).toBeUndefined();
    }));
});

describe("[LDB-P13] PUT in an older major on an EXISTING record", () => {
  async function seedT3(payload: { v: 3; a: number; b: number; c: boolean }): Promise<{ id: string; rev: number }> {
    const res = await writeFetch("/v1/layouts", "POST", headers(), { name: uniqueName("pf-seed"), format: "t/3", payload });
    const body = await res.json<{ id: string; formats: Record<string, { rev: number }> }>();
    return { id: body.id, rev: body.formats["t/3"]!.rev };
  }

  it("[LDB-P13] the record's latest-only content is EMPTY -> the older-major write is accepted, chained to t/3", () =>
    withStubLineage(async () => {
      const seeded = await seedT3({ v: 3, a: 1, b: 0, c: false }); // b===0, c===false: translate(record, t/1) is NOT held
      const res = await writeFetch(`/v1/layouts/${seeded.id}`, "PUT", { ...headers(), "If-Match": `"t:${seeded.rev}"` }, { format: "t/1", payload: { v: 1, a: 99 } });
      expect(res.status).toBe(200);
      const body = await res.json<{ format: string; payload: unknown }>();
      expect(body.format).toBe("t/3");
      expect(body.payload).toEqual({ v: 3, a: 99, b: 0, c: false });
      expect(await storedFormatOf(seeded.id)).toBe("t/3");
      expect(await writtenAsOf(seeded.id)).toBe("t/1");
    }));

  it("[LDB-P13] the record's latest-only content is NON-empty (c: true) -> 409 format_behind, nothing written", () =>
    withStubLineage(async () => {
      const seeded = await seedT3({ v: 3, a: 1, b: 0, c: true }); // c===true: down_3 (t/3 -> t/2) holds, so the whole t/3 -> t/1 chain does too
      const beforeFormat = await storedFormatOf(seeded.id);
      const res = await writeFetch(`/v1/layouts/${seeded.id}`, "PUT", { ...headers(), "If-Match": `"t:${seeded.rev}"` }, { format: "t/1", payload: { v: 1, a: 99 } });
      expect(res.status).toBe(409);
      const body = await res.json<{ error: string; format: string; see: string; rev: number; held: boolean }>();
      expect(body.error).toBe("format_behind");
      expect(body.held).toBe(true);
      expect(body.format).toBe("t/1");
      expect(body.see).toBe("t/3");
      expect(body.rev).toBe(seeded.rev);
      expect(await storedFormatOf(seeded.id)).toBe(beforeFormat); // unchanged -- the major never decreases, and this write never landed
    }));

  it("[LDB-P13] the record's latest-only content is non-empty via 'b' alone (t/2's own field) -> also 409 format_behind writing t/1", () =>
    withStubLineage(async () => {
      const seeded = await seedT3({ v: 3, a: 1, b: 3, c: false });
      const res = await writeFetch(`/v1/layouts/${seeded.id}`, "PUT", { ...headers(), "If-Match": `"t:${seeded.rev}"` }, { format: "t/1", payload: { v: 1, a: 99 } });
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({ error: "format_behind", format: "t/1", see: "t/3" });
    }));

  it("[LDB-P13] format_behind is PER-FORMAT, not all-or-nothing: a record with b!=0 but c=false is writable as t/2 (which keeps b) but not t/1 (which would lose it)", () =>
    withStubLineage(async () => {
      const seeded = await seedT3({ v: 3, a: 1, b: 4, c: false }); // down_3 (t/3->t/2) only checks c -- not held; down_2 (t/2->t/1) checks b -- held
      const asT2 = await writeFetch(`/v1/layouts/${seeded.id}`, "PUT", { ...headers(), "If-Match": `"t:${seeded.rev}"` }, { format: "t/2", payload: { v: 2, a: 5, b: 4 } });
      expect(asT2.status).toBe(200); // t/3 -> t/2 is not held: b survives, c was already false
      const body = await asT2.json<{ format: string; formats: Record<string, { rev: number }> }>();
      expect(body.format).toBe("t/3"); // still chained to latest

      const asT1 = await writeFetch(`/v1/layouts/${seeded.id}`, "PUT", { ...headers(), "If-Match": `"t:${body.formats["t/3"]!.rev}"` }, { format: "t/1", payload: { v: 1, a: 6 } });
      expect(asT1.status).toBe(409); // t/3 -> t/2 -> t/1: the second step loses b
      await expect(asT1.json()).resolves.toMatchObject({ error: "format_behind", format: "t/1", see: "t/3" });
    }));

  it("[LDB-P13] writing the SAME format the record is already at never triggers R1's held check", () =>
    withStubLineage(async () => {
      const seeded = await seedT3({ v: 3, a: 1, b: 9, c: true }); // maximally risky, but format === record.format
      const res = await writeFetch(`/v1/layouts/${seeded.id}`, "PUT", { ...headers(), "If-Match": `"t:${seeded.rev}"` }, { format: "t/3", payload: { v: 3, a: 2, b: 9, c: true } });
      expect(res.status).toBe(200);
    }));
});

describe("[LDB-P13] property: the stored major never decreases under a random sequence of writes", () => {
  it("[LDB-P13] random {format, risk} write sequences: every accepted write lands at t/3; every refusal leaves the stored format untouched", async () => {
    await withStubLineage(async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.record({ format: fc.constantFrom("t/1", "t/2", "t/3"), risky: fc.boolean() }), { minLength: 1, maxLength: 8 }),
          async (steps) => {
            const h = freshHeaders();
            const seedRes = await writeFetch("/v1/layouts", "POST", h, { name: uniqueName("pf-prop"), format: "t/3", payload: { v: 3, a: 0, b: 0, c: false } });
            const seeded = await seedRes.json<{ id: string; formats: Record<string, { rev: number }> }>();
            let rev = seeded.formats["t/3"]!.rev;
            let lastGoodFormat = "t/3";

            for (const step of steps) {
              const beforeFormat = await storedFormatOf(seeded.id);
              const payload =
                step.format === "t/1"
                  ? { v: 1, a: 1 }
                  : step.format === "t/2"
                    ? { v: 2, a: 1, b: step.risky ? 5 : 0 }
                    : { v: 3, a: 1, b: step.risky ? 5 : 0, c: step.risky };
              const res = await writeFetch(`/v1/layouts/${seeded.id}`, "PUT", { ...h, "If-Match": `"t:${rev}"` }, { format: step.format, payload });
              if (res.status === 200) {
                const body = await res.json<{ format: string; formats: Record<string, { rev: number }> }>();
                expect(body.format).toBe("t/3"); // R2: always chained to the lineage's latest
                rev = body.formats["t/3"]!.rev;
                lastGoodFormat = body.format;
              } else {
                expect(res.status).toBe(409); // format_behind (or, if the record's own new risky state itself blocks a LATER step, still format_behind)
                await res.text(); // drain
              }
              // The stored major NEVER decreases, whatever happened: either
              // unchanged (a refusal) or still the lineage's latest (an
              // acceptance is always chained there).
              const afterFormat = await storedFormatOf(seeded.id);
              expect(afterFormat === beforeFormat || afterFormat === lastGoodFormat).toBe(true);
            }
          },
        ),
        { numRuns: 25 },
      );
    });
  });
});

// Coordinator review (M5): PATCH's own `format` field used to be
// completely ignored beyond computing its lineage for scoping -- every
// edit silently applied to whatever major happened to be stored, no
// matter what the caller actually named. Now it's resolved through the
// registry (unknown_format / format_not_writable) and, when it names a
// DIFFERENT major than what's stored, checked against the SAME LDB-P13 R1
// rule `putFormat` runs (format_behind) -- all BEFORE any edit is applied.
describe("[LDB-P13] PATCH validates the format it names (M5)", () => {
  async function seedSpark() {
    const res = await writeFetch("/v1/layouts", "POST", headers(), { name: uniqueName("patch-format-seed"), format: "spark/1", payload: { keys: [{ char: "a", row: 0, col: 0, finger: "LP" }] } });
    const body = await res.json<{ id: string; formats: Record<string, { rev: number }> }>();
    return { id: body.id, rev: body.formats["spark/1"]!.rev };
  }

  it("[LDB-P13] {format: 'spark/9', fingermap} -- an unregistered major -> 400 unknown_format, spark/1 untouched", async () => {
    const seeded = await seedSpark();
    const res = await writeFetch(`/v1/layouts/${seeded.id}`, "PATCH", { ...headers(), "If-Match": `"spark:${seeded.rev}"` }, { format: "spark/9", fingermap: { a: "LM" } });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "unknown_format" });
    const row = await db.prepare("SELECT rev, payload_json FROM layout_formats WHERE layout_id = ? AND lineage = 'spark'").bind(seeded.id).first<{ rev: number; payload_json: string }>();
    expect(row!.rev).toBe(seeded.rev); // never edited
    expect(JSON.parse(row!.payload_json)).toEqual({ keys: [{ char: "a", row: 0, col: 0, finger: "LP" }] });
  });

  it("[LDB-P13] {format: 'mana2/1', fingermap} on a spark/1-stored layout -> 400 format_not_writable (output format), untouched", async () => {
    const seeded = await seedSpark();
    // If-Match must name mana2/1's OWN lineage ("mana2") to get past
    // MF-11's scope check (checked before any read, and before this
    // route even resolves the named format) -- the rev value itself is
    // irrelevant since format_not_writable fires before any rev compare.
    const res = await writeFetch(`/v1/layouts/${seeded.id}`, "PATCH", { ...headers(), "If-Match": `"mana2:1"` }, { format: "mana2/1", fingermap: { a: "LM" } });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "format_not_writable", format: "mana2/1" });
    const row = await db.prepare("SELECT rev FROM layout_formats WHERE layout_id = ? AND lineage = 'spark'").bind(seeded.id).first<{ rev: number }>();
    expect(row!.rev).toBe(seeded.rev);
  });

  it("[LDB-P13] naming an OLDER major that can't show the record's current content -> 409 format_behind, nothing applied", () =>
    withStubLineage(async () => {
      const res0 = await writeFetch("/v1/layouts", "POST", headers(), { name: uniqueName("patch-behind-seed"), format: "t/3", payload: { v: 3, a: 1, b: 0, c: true } });
      const created = await res0.json<{ id: string; formats: Record<string, { rev: number }> }>();
      const rev = created.formats["t/3"]!.rev;

      // c===true: down_3 (t/3 -> t/2) holds, so naming the OLDER t/1 --
      // which the caller may believe is still what's stored -- must never
      // silently edit the record through a translated-down (impossible)
      // view.
      const res = await writeFetch(`/v1/layouts/${created.id}`, "PATCH", { ...headers(), "If-Match": `"t:${rev}"` }, { format: "t/1", fingermap: { a: "x" } });
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({ error: "format_behind", format: "t/1", see: "t/3" });

      const row = await db.prepare("SELECT rev, format, payload_json FROM layout_formats WHERE layout_id = ? AND lineage = 't'").bind(created.id).first<{ rev: number; format: string; payload_json: string }>();
      expect(row!.rev).toBe(rev); // never edited
      expect(row!.format).toBe("t/3");
      expect(JSON.parse(row!.payload_json)).toEqual({ v: 3, a: 1, b: 0, c: true });
    }));

  it("[LDB-P13] naming the SAME major the record is already stored at -- edit applies normally (no format_behind)", async () => {
    const seeded = await seedSpark();
    const res = await writeFetch(`/v1/layouts/${seeded.id}`, "PATCH", { ...headers(), "If-Match": `"spark:${seeded.rev}"` }, { format: "spark/1", fingermap: { a: "LM" } });
    expect(res.status).toBe(200);
    const body = await res.json<{ format: string; payload: { keys: { char?: string; finger: string }[] } }>();
    expect(body.format).toBe("spark/1");
    expect(body.payload.keys.find((k) => k.char === "a")?.finger).toBe("LM");
  });
});
