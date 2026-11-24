// [LDB-F72] a stored spark/1 layout that mana2/1 cannot write answers `409
// held` on `?format=mana2/1` (the same typed error a record too new for a
// format gets), never a hang, a 500 or an invalid mana2/1 payload; its
// native read and every other layout are unaffected.
import { env } from "../harness";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixedClock } from "../../src/core/time";
import { actorFixture, pinTestClock, register, uniqueName, writeFetch } from "./write-support";

const clock = fixedClock("2026-11-24T00:00:00.000Z");
pinTestClock(env as unknown as { TEST_CLOCK?: typeof clock }, clock);

const headers = () => register(actorFixture(), `tok-${uniqueName("m2h")}`, "owner-mana2-held-1");

afterEach(() => {
  vi.unstubAllGlobals();
});

const cases: [string, unknown][] = [
  ["col 1e9", { keys: [{ char: "a", row: 0, col: 0, finger: "LP" }, { char: "b", row: 0, col: 1_000_000_000, finger: "RP" }] }],
  ["six rows", { keys: [{ char: "1", row: -1, col: 0, finger: "LP" }, { char: "z", row: 4, col: 0, finger: "LP" }] }],
  ["multi-code-point char", { keys: [{ char: "{}", row: 0, col: 0, finger: "LP" }] }],
  [
    "whitespace combo key",
    { keys: [{ char: "a", row: 0, col: 0, finger: "LP" }, { char: "\f", row: 0, col: 1, finger: "LR" }], combos: [{ keys: ["a", "\f"], output: "x" }] },
  ],
];

describe("[LDB-F72] GET ?format=mana2/1 on a layout mana2/1 cannot write", () => {
  for (const [label, payload] of cases) {
    it(`[LDB-F72] ${label}: 409 held on mana2/1, 200 on spark/1`, async () => {
    const res = await writeFetch("/v1/layouts", "POST", headers(), { name: uniqueName("m2h"), format: "spark/1", payload });
    expect(res.status, label).toBe(201);
    const { id } = await res.json<{ id: string }>();

    const m = await writeFetch(`/v1/layouts/${id}?format=mana2/1`, "GET");
    expect(m.status).toBe(409);
    expect(await m.json()).toMatchObject({ error: "held", held: true, format: "mana2/1", see: "spark/1" });

    const native = await writeFetch(`/v1/layouts/${id}?format=spark/1`, "GET");
    expect(native.status).toBe(200);
    expect((await native.json<{ payload: unknown }>()).payload).toEqual(payload);
    });
  }
});
