// [LDB-F42] design/layout-db's row-minus-one decision (2026-09-21): a row
// ABOVE the 3x10 alpha block is stored as `row: -1` (the number row).
// Purely additive to `/v1` -- no migration, no existing stored row needs
// rewriting (unlike 1.6/1.12/1.13's in-place format edits, this widens a
// value's DOMAIN, it doesn't change a shape) -- so there is no
// `migration-00NN.test.ts` counterpart for this slice. This file is the
// one API-level round trip: write a layout with a number row through the
// real write route, read it back both natively (`?format=spark/1`) and
// derived (`?format=mana2/1`), over HTTP, through the real router.
//
// The nightly dump/restore path is NOT re-tested here: `src/dump/write.ts`
// /`src/dump/restore.ts` (LDB-D1/D9) treat every format's `payload_json` as
// an opaque string round-tripped byte-for-byte -- no per-format branching
// exists there to widen, so `tests/rehost.test.ts`'s existing (format-
// agnostic) coverage already proves a row-minus-one payload survives a
// dump/restore exactly as any other spark/1 payload would.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixedClock } from "../../src/core/time";
import { actorFixture, pinTestClock, register, uniqueName, writeFetch } from "./write-support";

const clock = fixedClock("2026-09-21T00:00:00.000Z");
pinTestClock(env as unknown as { TEST_CLOCK?: typeof clock }, clock);

const OWNER = "owner-row-minus-one-1";

function headers() {
  return register(actorFixture(), `tok-${uniqueName("rm1")}`, OWNER);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// A full 3x10 alpha block plus a full number row on row -1, no thumb --
// the same shape as formats/spark/1/fixtures/906-number-row.json (kept
// inline so this file stays self-contained, matching this test dir's own
// convention of not reaching into formats/ fixtures from tests/api/).
const NUMBER_ROW_PAYLOAD = {
  keys: [
    { char: "1", row: -1, col: 0, finger: "LP" },
    { char: "2", row: -1, col: 1, finger: "LR" },
    { char: "3", row: -1, col: 2, finger: "LM" },
    { char: "4", row: -1, col: 3, finger: "LI" },
    { char: "5", row: -1, col: 4, finger: "LI" },
    { char: "6", row: -1, col: 5, finger: "RI" },
    { char: "7", row: -1, col: 6, finger: "RI" },
    { char: "8", row: -1, col: 7, finger: "RM" },
    { char: "9", row: -1, col: 8, finger: "RR" },
    { char: "0", row: -1, col: 9, finger: "RP" },
    { char: "q", row: 0, col: 0, finger: "LP" },
    { char: "w", row: 0, col: 1, finger: "LR" },
    { char: "e", row: 0, col: 2, finger: "LM" },
    { char: "a", row: 1, col: 0, finger: "LP" },
    { char: "z", row: 2, col: 0, finger: "LR" },
  ],
};

describe("[LDB-F42] row -1 (the number row) round-trips through the real write/read routes", () => {
  it("[LDB-F42] POST /v1/layouts accepts a number-row payload, and GET ?format=spark/1 returns row -1 keys unchanged", async () => {
    const name = uniqueName("rm1-write");
    const res = await writeFetch("/v1/layouts", "POST", headers(), { name, format: "spark/1", payload: NUMBER_ROW_PAYLOAD });
    expect(res.status).toBe(201);
    const body = await res.json<{ id: string; format: string }>();
    expect(body.format).toBe("spark/1");

    const read = await writeFetch(`/v1/layouts/${body.id}?format=spark/1`, "GET");
    expect(read.status).toBe(200);
    const detail = await read.json<{ payload: { keys: { char?: string; row: number; col: number; finger: string }[] } }>();
    const numberRowKeys = detail.payload.keys.filter((k) => k.row === -1);
    expect(numberRowKeys).toHaveLength(10);
    expect(numberRowKeys).toContainEqual({ char: "1", row: -1, col: 0, finger: "LP" });
    expect(numberRowKeys).toContainEqual({ char: "0", row: -1, col: 9, finger: "RP" });
  });

  it("[LDB-F42] GET ?format=mana2/1 derives the number row as fingers[0], with a -0.5 stagger entry ahead of the alpha block's", async () => {
    const name = uniqueName("rm1-mana2");
    const res = await writeFetch("/v1/layouts", "POST", headers(), { name, format: "spark/1", payload: NUMBER_ROW_PAYLOAD });
    expect(res.status).toBe(201);
    const body = await res.json<{ id: string }>();

    const read = await writeFetch(`/v1/layouts/${body.id}?format=mana2/1`, "GET");
    expect(read.status).toBe(200);
    const detail = await read.json<{
      payload: { layout: { fingers: string[] }; board: { rowOrColumnStagger: number[] } };
      derived_from: string;
    }>();
    expect(detail.derived_from).toBe("spark/1");
    // Row order is ascending stored row (row -1 first): fingers[0] is the
    // number row, fingers[1] is qwerty's own top row.
    expect(detail.payload.layout.fingers[0]).toBe("1 2 3 4 5 6 7 8 9 0");
    expect(detail.payload.layout.fingers[1]!.startsWith("q w e")).toBe(true);
    expect(detail.payload.board.rowOrColumnStagger[0]).toBe(-0.5);
    expect(detail.payload.board.rowOrColumnStagger[1]).toBe(0);
  });

  it("[LDB-F42] a thumb finger on row -1 is refused at write time, same as any other finger row", async () => {
    const name = uniqueName("rm1-thumb-refused");
    const payload = { keys: [{ char: "1", row: -1, col: 0, finger: "LT" }] };
    const res = await writeFetch("/v1/layouts", "POST", headers(), { name, format: "spark/1", payload });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string; message: string }>();
    expect(body.error).toBe("invalid_payload");
    expect(body.message).toMatch(/rows -1\.\.2 are finger rows/);
  });
});
