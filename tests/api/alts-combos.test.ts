// [LDB-F45] design/alts/07-format.md: `has_alts`/`has_combos` beside
// `has_magic` in spark/1's per-format wire summary, written on every
// create/replace, filterable the same way (`?has_alts=`/`?has_combos=`),
// and folded correctly from the event log (LDB-P1's own `has_magic` claim,
// restated for the two new columns).
import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { fixedClock } from "../../src/core/time";
import { actorFixture, AKL_PAYLOAD, pinTestClock, register, uniqueName, writeFetch } from "./write-support";

const db = (env as unknown as Bindings).DB;
const clock = fixedClock("2026-09-30T00:00:00.000Z");
pinTestClock(env as unknown as { TEST_CLOCK?: typeof clock }, clock);

const OWNER = "owner-alts-combos-1";

const ALTS_PAYLOAD = {
  keys: [
    { char: "g", row: 1, col: 4, finger: "LM" },
    { char: "s", row: 1, col: 2, finger: "LR" },
  ],
  alts: [{ ngram: ["s", "g"], fingers: ["LP", "LI"] }],
};

const COMBOS_PAYLOAD = {
  keys: [
    { char: "g", row: 1, col: 4, finger: "LM" },
    { char: "s", row: 1, col: 2, finger: "LR" },
  ],
  combos: [{ keys: ["g", "s"], output: "th" }],
};

interface FormatSummary {
  rev: number;
  has_magic: boolean;
  has_alts: boolean;
  has_combos: boolean;
}
interface WriteBody {
  id: string;
  format: string;
  payload: unknown;
  formats: Record<string, FormatSummary>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("[LDB-F45] has_alts/has_combos on the write paths", () => {
  it("[LDB-F45] POST with alts sets has_alts true, has_combos false", async () => {
    const fake = actorFixture();
    const headers = register(fake, "tok-alts-post", OWNER);
    const name = uniqueName("alts-post");

    const res = await writeFetch("/v1/layouts", "POST", headers, { name, format: "spark/1", payload: ALTS_PAYLOAD });
    expect(res.status).toBe(201);
    const body = await res.json<WriteBody>();
    expect(body.formats["spark/1"]).toMatchObject({ has_magic: false, has_alts: true, has_combos: false });

    const row = await db.prepare("SELECT has_alts, has_combos FROM layout_formats WHERE layout_id = ? AND lineage = 'spark'").bind(body.id).first<{ has_alts: number; has_combos: number }>();
    expect(row).toEqual({ has_alts: 1, has_combos: 0 });
  });

  it("[LDB-F45] POST with combos sets has_combos true, has_alts false", async () => {
    const fake = actorFixture();
    const headers = register(fake, "tok-combos-post", OWNER);
    const name = uniqueName("combos-post");

    const res = await writeFetch("/v1/layouts", "POST", headers, { name, format: "spark/1", payload: COMBOS_PAYLOAD });
    expect(res.status).toBe(201);
    const body = await res.json<WriteBody>();
    expect(body.formats["spark/1"]).toMatchObject({ has_magic: false, has_alts: false, has_combos: true });
  });

  it("[LDB-F45] POST with neither is false/false (same as has_magic)", async () => {
    const fake = actorFixture();
    const headers = register(fake, "tok-plain-post", OWNER);
    const name = uniqueName("plain-post");

    const res = await writeFetch("/v1/layouts", "POST", headers, { name, format: "spark/1", payload: AKL_PAYLOAD });
    expect(res.status).toBe(201);
    const body = await res.json<WriteBody>();
    expect(body.formats["spark/1"]).toMatchObject({ has_magic: false, has_alts: false, has_combos: false });
  });

  it("[LDB-F45] PUT replacing a plain payload with an alts-bearing one flips has_alts true", async () => {
    const fake = actorFixture();
    const headers = register(fake, "tok-put-alts", OWNER);
    const name = uniqueName("put-alts");

    const created = await writeFetch("/v1/layouts", "POST", headers, { name, format: "spark/1", payload: AKL_PAYLOAD });
    const createdBody = await created.json<WriteBody>();
    expect(createdBody.formats["spark/1"]!.has_alts).toBe(false);

    const put = await writeFetch(`/v1/layouts/${createdBody.id}`, "PUT", { ...headers, "If-Match": '"spark:1"' }, { format: "spark/1", payload: ALTS_PAYLOAD });
    expect(put.status).toBe(200);
    const putBody = await put.json<WriteBody>();
    expect(putBody.formats["spark/1"]).toMatchObject({ has_alts: true, has_combos: false });
  });

  it("[LDB-F45] ?has_alts=true/?has_combos=true partition the list, mirroring ?has_magic=", async () => {
    const fake = actorFixture();
    const headers = register(fake, "tok-list-alts", OWNER);
    const altsName = uniqueName("list-alts");
    const combosName = uniqueName("list-combos");
    const plainName = uniqueName("list-plain");

    const altsRes = await writeFetch("/v1/layouts", "POST", headers, { name: altsName, format: "spark/1", payload: ALTS_PAYLOAD });
    const altsId = (await altsRes.json<WriteBody>()).id;
    const combosRes = await writeFetch("/v1/layouts", "POST", headers, { name: combosName, format: "spark/1", payload: COMBOS_PAYLOAD });
    const combosId = (await combosRes.json<WriteBody>()).id;
    const plainRes = await writeFetch("/v1/layouts", "POST", headers, { name: plainName, format: "spark/1", payload: AKL_PAYLOAD });
    const plainId = (await plainRes.json<WriteBody>()).id;

    const altsListRes = await SELF.fetch("https://example.com/v1/layouts?format=spark/1&has_alts=true&limit=1000");
    const altsListBody = await altsListRes.json<{ items: { id: string }[] }>();
    const altsIds = new Set(altsListBody.items.map((i) => i.id));
    expect(altsIds.has(altsId)).toBe(true);
    expect(altsIds.has(combosId)).toBe(false);
    expect(altsIds.has(plainId)).toBe(false);

    const combosListRes = await SELF.fetch("https://example.com/v1/layouts?format=spark/1&has_combos=true&limit=1000");
    const combosListBody = await combosListRes.json<{ items: { id: string }[] }>();
    const combosIds = new Set(combosListBody.items.map((i) => i.id));
    expect(combosIds.has(combosId)).toBe(true);
    expect(combosIds.has(altsId)).toBe(false);

    const neitherListRes = await SELF.fetch("https://example.com/v1/layouts?format=spark/1&has_alts=false&has_combos=false&limit=1000");
    const neitherListBody = await neitherListRes.json<{ items: { id: string }[] }>();
    const neitherIds = new Set(neitherListBody.items.map((i) => i.id));
    expect(neitherIds.has(plainId)).toBe(true);
    expect(neitherIds.has(altsId)).toBe(false);
    expect(neitherIds.has(combosId)).toBe(false);
  });

  it("[LDB-F45] GET detail round-trips alts/combos in the payload and the envelope flags", async () => {
    const fake = actorFixture();
    const headers = register(fake, "tok-detail-alts", OWNER);
    const name = uniqueName("detail-alts");

    const created = await writeFetch("/v1/layouts", "POST", headers, { name, format: "spark/1", payload: ALTS_PAYLOAD });
    const { id } = await created.json<WriteBody>();

    const res = await SELF.fetch(`https://example.com/v1/layouts/${id}?format=spark/1`);
    expect(res.status).toBe(200);
    const body = await res.json<WriteBody>();
    expect(body.payload).toEqual(ALTS_PAYLOAD);
    expect(body.formats["spark/1"]).toMatchObject({ has_alts: true, has_combos: false });
  });
});
