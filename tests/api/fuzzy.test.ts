import { buildDump } from "../../src/dump/write";
import type { Bindings } from "../../src/env";
import { SELF, env, testStore } from "../harness";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixedClock } from "../../src/core/time";
import { actorFixture, pinTestClock, register, uniqueName, writeFetch } from "./write-support";
const clock = fixedClock("2026-11-07T00:00:00.000Z");
pinTestClock(env as unknown as { TEST_CLOCK?: typeof clock }, clock);
const payload = {
  keys: [{ char: "w", row: 0, col: 3, finger: "LI" }, { char: "s", row: 1, col: 2, finger: "LM" }],
  alts: [{ ngram: ["w"], fingers: ["LM"] }, { ngram: ["w"], fingers: ["LR"] }, { ngram: ["w"], fingers: ["RT"] }],
};
type Body = { id: string; payload: typeof payload; formats: Record<string, { rev: number; has_alts: boolean }> };
afterEach(() => vi.unstubAllGlobals());
describe("[LDB-F52] ordinary v1 unary alternatives end to end", () => {
  it("[LDB-F52] round-trips POST, list/full/ref/revision, PATCH, PUT and stale responses without a flag", async () => {
    const headers = register(actorFixture(), "fuzzy-default-token", "fuzzy-owner");
    const created = await writeFetch("/v1/layouts", "POST", headers, { name: uniqueName("fuzzy"), format: "spark/1", payload });
    expect(created.status).toBe(201);
    const body = await created.json<Body>();
    expect(body.payload).toEqual(payload);
    expect(body.formats["spark/1"]!.has_alts).toBe(true);
    for (const path of [`/v1/layouts/${body.id}?format=spark/1`, `/v1/layouts/${body.id}/rev/1?format=spark/1`]) {
      expect((await (await SELF.fetch(`https://akl.test${path}`)).json<Body>()).payload).toEqual(payload);
    }
    const full = await (await SELF.fetch("https://akl.test/v1/layouts?format=spark/1&full=1")).json<{ items: Body[] }>();
    expect(full.items.find(x => x.id === body.id)?.payload).toEqual(payload);
    const list = await (await SELF.fetch("https://akl.test/v1/layouts?format=spark/1&has_alts=true")).json<{ items: Body[] }>();
    expect(list.items.some(x => x.id === body.id)).toBe(true);
    const patch = await writeFetch(`/v1/layouts/${body.id}`, "PATCH", { ...headers, "If-Match": '"spark:1"' }, { format: "spark/1", magic: {} });
    expect(patch.status).toBe(200);
    expect((await patch.json<Body>()).payload.alts).toEqual(payload.alts);
    const stale = await writeFetch(`/v1/layouts/${body.id}`, "PUT", { ...headers, "If-Match": '"spark:1"' }, { format: "spark/1", payload });
    expect(stale.status).toBe(409);
    expect((await stale.json<{ error: string; record: Body }>()).record.payload.alts).toEqual(payload.alts);
    const put = await writeFetch(`/v1/layouts/${body.id}`, "PUT", { ...headers, "If-Match": '"spark:2"' }, { format: "spark/1", payload });
    expect(put.status).toBe(200);
    expect((await put.json<Body>()).payload).toEqual(payload);
    const stored = await testStore.row<{ payload_json: string }>("layout_formats", { layout_id: body.id, lineage: "spark" });
    expect(JSON.parse(stored!.payload_json)).toEqual(payload);
    const dump = await buildDump(env as unknown as Bindings, clock);
    const backup = dump.layout_formats.find(x => x.layout_id === body.id && x.lineage === "spark");
    expect(JSON.parse(backup!.payload_json)).toEqual(payload);
    const historic = dump.layout_revs.filter(x => x.layout_id === body.id && x.lineage === "spark");
    expect(historic.length).toBe(3);
    for (const rev of historic) expect(JSON.parse(rev.payload_json!).alts).toEqual(payload.alts);
    const feed = await (await SELF.fetch(`https://akl.test/v1/changes?since=0&layout=${body.id}`)).text();
    expect(feed).toContain('"has_alts":true');
  });
  it("[LDB-F52] serves an extended default schema and rejects duplicate unary writes", async () => {
    const schema = await (await SELF.fetch("https://akl.test/v1/formats/spark/1/schema.json")).json<{ $defs: { alt: { properties: { ngram: { minItems: number } } } } }>();
    expect(schema.$defs.alt.properties.ngram.minItems).toBe(1);
    const headers = register(actorFixture(), "fuzzy-duplicate-token", "fuzzy-owner");
    const response = await writeFetch("/v1/layouts", "POST", headers, {
      name: uniqueName("duplicate-fuzzy"), format: "spark/1", payload: { ...payload, alts: [payload.alts[0], payload.alts[0]] },
    });
    expect(response.status).toBe(400);
  });
});
