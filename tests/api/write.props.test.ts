// [LDB-FZ11] Seeded property test for the write routes (Stage 4 F-db; stage4-spec.md §3): random bodies to POST /v1/layouts, PUT and
// PATCH /v1/layouts/{id} never answer 5xx, and a 4xx never changes state (no event, no layout, no revision moved). Bodies are
// generated spark/1 payloads (odd code points, API 1.38 off-layout alt literals and space swap triggers included, so a 2xx is
// reachable), mutated fixtures, and arbitrary JSON in every body slot. A 2xx must read back exactly what was written.
// Fixed seed + 50 runs here (a few seconds); the nightly `fuzz` job sets FUZZ_SEED/FUZZ_RUNS.
import { env, store, testStore } from "../harness";
import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { ulid } from "ulidx";
import { commitWrite, type CommitInput } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import { AKL_PAYLOAD, actorFixture, pinTestClock, register, uniqueName, writeFetch } from "./write-support";
import { runProperty } from "../formats/fuzz-support";
import { anyInput, wildJson } from "../formats/fuzz-arbitraries";

const clock = fixedClock("2026-11-24T00:00:00.000Z");
pinTestClock(env as unknown as { TEST_CLOCK?: typeof clock }, clock);

const OWNER = "owner-write-props-1";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function seed(): Promise<{ id: string; formatRev: number; layoutRev: number }> {
  const input: CommitInput = {
    layoutId: ulid(),
    creating: true,
    currentN: 0,
    currentLayout: null,
    currentFormats: new Map(),
    layout: { kind: "created", name: uniqueName("props-seed"), owner: OWNER, created_at: clock(), deleted: false },
    format: { kind: "format_added", lineage: "spark", format: "spark/1", payload: AKL_PAYLOAD, hasMagic: false },
    modified_at: clock(),
    actor: OWNER,
    via: "discord",
    source: { client: "discord-app:test", version: null },
    upstream: null,
  };
  const { layout, formats } = await commitWrite(store, clock, input);
  return { id: layout.id, formatRev: formats.get("spark")!.rev, layoutRev: layout.layout_rev };
}

async function stateCounts(): Promise<string> {
  return JSON.stringify([await testStore.count("events"), await testStore.count("layouts"), await testStore.count("layout_formats"), await testStore.count("layout_revs")]);
}

const nameArb = fc.oneof(fc.string({ maxLength: 12 }), fc.constantFrom("", " ", "∞", "😀 x", "a".repeat(300)), wildJson);
const formatArb = fc.oneof({ weight: 6, arbitrary: fc.constant("spark/1") }, fc.constantFrom("mana2/1", "cmini/1", "nope/9", ""), wildJson);
const bodyArb = fc.oneof(
  { weight: 6, arbitrary: fc.record({ name: nameArb, format: formatArb, payload: anyInput }) },
  { weight: 2, arbitrary: fc.record({ format: formatArb, payload: anyInput }) },
  { weight: 1, arbitrary: wildJson },
);
const patchArb = fc.oneof(
  fc.record({ name: nameArb }),
  fc.record({ format: formatArb, fingermap: wildJson }),
  fc.record({ format: formatArb, magic: wildJson }),
  fc.record({ format: formatArb, alts: wildJson, combos: wildJson }, { requiredKeys: [] }),
  wildJson,
);

describe("[LDB-FZ11] write routes: seeded properties", () => {
  it("[LDB-FZ11] POST/PUT/PATCH with random bodies: never 5xx; a 4xx never changes state; a 2xx reads back what was written", async () => {
    const headers = register(actorFixture(), `tok-${uniqueName("props")}`, OWNER);
    let accepted = 0;
    await runProperty(
      "write-routes-total",
      fc.asyncProperty(fc.constantFrom("POST", "PUT", "PATCH"), bodyArb, patchArb, async (verb, body, patch) => {
        const rec = await seed();
        const before = await stateCounts();
        const ifMatch = { ...headers, "If-Match": `"spark:${rec.formatRev}"` };
        const res =
          verb === "POST"
            ? await writeFetch("/v1/layouts", "POST", headers, body)
            : verb === "PUT"
              ? await writeFetch(`/v1/layouts/${rec.id}`, "PUT", ifMatch, body)
              : await writeFetch(`/v1/layouts/${rec.id}`, "PATCH", ifMatch, patch);
        const text = await res.text();
        expect(res.status, `${verb} answered ${res.status}: ${text.slice(0, 300)}`).toBeLessThan(500);
        if (res.status >= 400) {
          // The seed itself added rows before `before` was read; a refused write adds none.
          expect(await stateCounts(), `${verb} answered ${res.status} but changed state`).toBe(before);
          expect(() => JSON.parse(text), "a refusal is a JSON body").not.toThrow();
        } else {
          accepted++;
          if (verb === "PUT") {
            const read = await writeFetch(`/v1/layouts/${rec.id}?format=spark%2F1`, "GET", headers);
            expect(read.status).toBe(200);
            const got = (await read.json()) as { payload?: unknown };
            expect(got.payload, "a 2xx PUT reads back the payload written").toEqual((body as { payload: unknown }).payload);
          }
        }
      }),
      50,
    );
    // The generators must reach the accepted side at least once, or the readback half proves nothing.
    expect(accepted).toBeGreaterThan(0);
  });
});
