// [LDB-F71] API 1.38 (saltorbit 2026-11-23): an `alts[].ngram` literal need not
// be one of the layout's keys, and a space is a valid `adaptive_swaps[].trigger`
// on every layout. These are the three publishes akldb refused in 2026-11
// (akl.gg error telemetry: `"∞"`, `"\""`, trigger `" "`); each now stores and
// reads back exactly as written, and the mana2/1 projection stays well-formed.
import { env } from "../harness";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixedClock } from "../../src/core/time";
import { actorFixture, pinTestClock, register, uniqueName, writeFetch } from "./write-support";

const clock = fixedClock("2026-11-23T00:00:00.000Z");
pinTestClock(env as unknown as { TEST_CLOCK?: typeof clock }, clock);

const OWNER = "owner-off-layout-alt-keys-1";

function headers() {
  return register(actorFixture(), `tok-${uniqueName("olk")}`, OWNER);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const KEYS = [
  { char: "y", row: 0, col: 5, finger: "RI" },
  { char: "h", row: 1, col: 5, finger: "RI" },
  { char: "'", row: 1, col: 9, finger: "RP" },
  { char: "a", row: 1, col: 0, finger: "LP" },
  { char: "e", row: 1, col: 2, finger: "LM" },
  { char: "◇", row: 3, col: 4, finger: "LT" },
];

const PAYLOAD = {
  keys: KEYS,
  magic: {
    magic_keys: [{ key: "◇", default: { kind: "repeat" } }],
    adaptive_swaps: [{ trigger: " ", swap: ["y", "h"] }, { trigger: "a", swap: ["y", "e"] }],
  },
  alts: [
    { ngram: ["∞"], fingers: ["LT"] },
    { ngram: ['"'], fingers: ["LI"] },
    { ngram: ["e", '"'], fingers: ["LM", "RR"] },
    { ngram: ["h"], fingers: ["RM"] },
  ],
};

describe("[LDB-F71] off-layout alt literals and a space trigger round-trip through the write/read routes", () => {
  it("[LDB-F71] POST accepts them; spark/1 reads back byte-identical; mana2/1 carries the space-led swap rows", async () => {
    const name = uniqueName("off-layout-alts");
    const res = await writeFetch("/v1/layouts", "POST", headers(), { name, format: "spark/1", payload: PAYLOAD });
    expect(res.status).toBe(201);
    const { id } = await res.json<{ id: string }>();

    const read = await writeFetch(`/v1/layouts/${id}?format=spark/1`, "GET");
    expect(read.status).toBe(200);
    expect((await read.json<{ payload: unknown }>()).payload).toEqual(PAYLOAD);

    const m = await writeFetch(`/v1/layouts/${id}?format=mana2/1`, "GET");
    expect(m.status).toBe(200);
    const mana = await m.json<{ payload: { magic: { rules: { inputs: string; output: string }[] } }; derived_from: string }>();
    expect(mana.derived_from).toBe("spark/1");
    expect(mana.payload.magic.rules).toEqual(expect.arrayContaining([{ inputs: " y", output: " h" }, { inputs: " h", output: " y" }]));
  });

  it("[LDB-F71] PUT replaces a payload with one carrying them", async () => {
    const name = uniqueName("off-layout-alts-put");
    const res = await writeFetch("/v1/layouts", "POST", headers(), { name, format: "spark/1", payload: { keys: KEYS } });
    expect(res.status).toBe(201);
    const { id } = await res.json<{ id: string }>();
    const put = await writeFetch(`/v1/layouts/${id}`, "PUT", { ...headers(), "If-Match": '"spark:1"' }, { format: "spark/1", payload: PAYLOAD });
    expect(put.status).toBe(200);
    const read = await writeFetch(`/v1/layouts/${id}?format=spark/1`, "GET");
    expect((await read.json<{ payload: unknown }>()).payload).toEqual(PAYLOAD);
  });

  it("[LDB-F71] [LDB-F22] an off-layout trigger other than space is still refused", async () => {
    const name = uniqueName("off-layout-trigger");
    const payload = { keys: KEYS, magic: { adaptive_swaps: [{ trigger: "C", swap: ["y", "h"] }] } };
    const res = await writeFetch("/v1/layouts", "POST", headers(), { name, format: "spark/1", payload });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string; path: string }>();
    expect(body.error).toBe("invalid_payload");
    expect(body.path).toBe("/magic/adaptive_swaps/0/trigger");
  });
});
