// [LDB-V8] [LDB-V9] [LDB-V10] API 1.32: `/v1` spark/1 is frozen at the 1.28
// shape; skip magic is served only with `?features=skip`.
//   V8  every default read validates against the frozen reader schema
//   V9  the opt-in param, the `withheld` signal, the served schema, ETags
//   V10 the write guard (`409 features_required`)
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterEach, describe, expect, it, vi } from "vitest";
import frozenSchema from "../contract/spark-1.v1-reader.schema.json" with { type: "json" };
import { withholdSkip } from "../../formats/spark/1/withhold.ts";
import { schema as currentSchema } from "../../formats/spark/1/index.ts";
import { SKIP_PAYLOADS } from "../fixtures/skip-payloads";
import { actorFixture, register, scopedToken, uniqueName, writeFetch } from "./write-support";

const ajv = new Ajv2020({ strict: true });
addFormats(ajv);
const validFrozen = ajv.compile(frozenSchema);

interface Wire {
  id: string;
  payload: unknown;
  formats: Record<string, { rev: number; has_magic: boolean; withheld?: string[] }>;
}

afterEach(() => vi.unstubAllGlobals());

const FULL = "?features=skip";

async function setup() {
  const headers = register(actorFixture(), uniqueName("v1f-token"), uniqueName("v1f-owner"));
  const created: { name: string; payload: unknown; id: string; rev: number }[] = [];
  for (const { name, payload } of SKIP_PAYLOADS) {
    const res = await writeFetch(`/v1/layouts${FULL}`, "POST", headers, { name: uniqueName("v1f-layout"), format: "spark/1", payload });
    expect(res.status, `${name}: ${await res.clone().text()}`).toBe(201);
    const body = await res.json<Wire>();
    expect(body.payload).toEqual(payload);
    created.push({ name, payload, id: body.id, rev: body.formats["spark/1"]!.rev });
  }
  return { headers, created };
}

function expectFrozen(payload: unknown, where: string) {
  expect(validFrozen(payload), `${where}: ${JSON.stringify(validFrozen.errors)}`).toBe(true);
}

describe("[LDB-V8] every default /v1 read of a skip record validates against the frozen reader schema", () => {
  it("[LDB-V8] single, rev, list full=1, the write echo and a stale record", async () => {
    const { headers, created } = await setup();

    for (const c of created) {
      const single = await (await writeFetch(`/v1/layouts/${c.id}?format=spark/1`, "GET")).json<Wire>();
      expectFrozen(single.payload, `${c.name}: single`);
      expect(single.payload).toEqual(withholdSkip(c.payload).payload);
      expect(single.formats["spark/1"]!.withheld).toEqual(["skip"]);
      expect(single.formats["spark/1"]!.has_magic).toBe(true);

      const rev = await (await writeFetch(`/v1/layouts/${c.id}/rev/${c.rev}?format=spark/1`, "GET")).json<{ payload: unknown; withheld?: string[] }>();
      expectFrozen(rev.payload, `${c.name}: rev`);
      expect(rev.withheld).toEqual(["skip"]);
    }

    const full = await (await writeFetch("/v1/layouts?format=spark/1&full=1", "GET")).json<{ items: Wire[] }>();
    const mineIds = new Set(created.map((c) => c.id));
    const mine = full.items.filter((i) => mineIds.has(i.id));
    expect(mine.length).toBe(created.length);
    for (const item of mine) {
      expectFrozen(item.payload, `full list ${item.id}`);
      expect(item.formats["spark/1"]!.withheld).toEqual(["skip"]);
    }

    const plain = await (await writeFetch("/v1/layouts?format=spark/1", "GET")).json<{ items: Wire[] }>();
    expect(plain.items.filter((i) => mineIds.has(i.id)).every((i) => i.formats["spark/1"]!.withheld?.[0] === "skip")).toBe(true);

    // the echo of a PUT that carries skip (accepted: the writer knows skip) and the echo of a stale PUT's record
    const c = created[0]!;
    const put = await writeFetch(`/v1/layouts/${c.id}`, "PUT", { ...headers, "If-Match": scopedToken("spark", c.rev) }, { format: "spark/1", payload: c.payload });
    expect(put.status).toBe(200);
    const echo = await put.json<Wire>();
    expectFrozen(echo.payload, "PUT echo");
    expect(echo.formats["spark/1"]!.withheld).toEqual(["skip"]);

    const stale = await writeFetch(`/v1/layouts/${c.id}`, "PUT", { ...headers, "If-Match": scopedToken("spark", c.rev) }, { format: "spark/1", payload: c.payload });
    expect(stale.status).toBe(409);
    const staleBody = await stale.json<{ error: string; record: Wire }>();
    expect(staleBody.error).toBe("stale");
    expectFrozen(staleBody.record.payload, "stale record");

    // a create with no features param echoes the withheld payload too
    const created2 = await writeFetch("/v1/layouts", "POST", headers, { name: uniqueName("v1f-layout"), format: "spark/1", payload: c.payload });
    expect(created2.status).toBe(201);
    expectFrozen((await created2.json<Wire>()).payload, "POST echo");
  });

  it("[LDB-V8] a record that never used skip is served unchanged, with no `withheld`", async () => {
    const { headers } = await setup();
    const plain = { ...(SKIP_PAYLOADS[3]!.payload as object), magic: { magic_keys: [{ key: "∯", rules: [{ after: "h", emit: "e" }] }] } };
    const res = await writeFetch("/v1/layouts", "POST", headers, { name: uniqueName("v1f-plain"), format: "spark/1", payload: plain });
    expect(res.status).toBe(201);
    const body = await res.json<Wire>();
    expect(body.payload).toEqual(plain);
    expect(body.formats["spark/1"]!.withheld).toBeUndefined();
    const read = await (await writeFetch(`/v1/layouts/${body.id}?format=spark/1`, "GET")).json<Wire>();
    expect(read.payload).toEqual(plain);
    expect("withheld" in read.formats["spark/1"]!).toBe(false);
  });
});

describe("[LDB-V9] features=skip opts in; the served schema follows", () => {
  it("[LDB-V9] with features=skip every read returns the stored payload and no `withheld`", async () => {
    const { created } = await setup();
    for (const c of created) {
      const single = await (await writeFetch(`/v1/layouts/${c.id}?format=spark/1&features=skip`, "GET")).json<Wire>();
      expect(single.payload).toEqual(c.payload);
      expect("withheld" in single.formats["spark/1"]!).toBe(false);
      const rev = await (await writeFetch(`/v1/layouts/${c.id}/rev/${c.rev}?format=spark/1&features=skip`, "GET")).json<{ payload: unknown; withheld?: string[] }>();
      expect(rev.payload).toEqual(c.payload);
      expect(rev.withheld).toBeUndefined();
    }
    const full = await (await writeFetch("/v1/layouts?format=spark/1&full=1&features=skip", "GET")).json<{ items: Wire[] }>();
    const byId = new Map(created.map((c) => [c.id, c.payload]));
    const mine = full.items.filter((i) => byId.has(i.id));
    expect(mine.length).toBe(created.length);
    for (const item of mine) {
      expect(item.payload).toEqual(byId.get(item.id));
      expect("withheld" in item.formats["spark/1"]!).toBe(false);
    }
  });

  it("[LDB-V9] names are comma-separated, unknown names are ignored, repeats work", async () => {
    const { created } = await setup();
    const c = created[0]!;
    for (const q of ["features=skip,future", "features=future,skip", "features=future&features=skip", "features=%20skip"]) {
      const body = await (await writeFetch(`/v1/layouts/${c.id}?format=spark/1&${q}`, "GET")).json<Wire>();
      expect(body.payload, q).toEqual(c.payload);
    }
    for (const q of ["features=future", "features=", "features=skipp", "features=SKIP"]) {
      const res = await writeFetch(`/v1/layouts/${c.id}?format=spark/1&${q}`, "GET");
      expect(res.status, q).toBe(200);
      expect((await res.json<Wire>()).payload, q).toEqual(withholdSkip(c.payload).payload);
    }
  });

  it("[LDB-V9] mana2/1 is unaffected, and `withheld` is still said for the record's spark/1 summary", async () => {
    const { created } = await setup();
    const c = created[0]!;
    const a = await (await writeFetch(`/v1/layouts/${c.id}?format=mana2/1`, "GET")).json<Wire>();
    const b = await (await writeFetch(`/v1/layouts/${c.id}?format=mana2/1&features=skip`, "GET")).json<Wire>();
    expect(a.payload).toEqual(b.payload);
  });

  it("[LDB-V9] the schema is the frozen 1.28 file by default and today's with features=skip", async () => {
    const def = await writeFetch("/v1/formats/spark/1/schema.json", "GET");
    expect(await def.json()).toEqual(frozenSchema);
    const full = await writeFetch("/v1/formats/spark/1/schema.json?features=skip", "GET");
    expect(await full.json()).toEqual(currentSchema);
    expect(JSON.stringify(currentSchema)).toContain("skip_repeat");
    // another format ignores the param
    const m1 = await (await writeFetch("/v1/formats/mana2/1/schema.json", "GET")).text();
    const m2 = await (await writeFetch("/v1/formats/mana2/1/schema.json?features=skip", "GET")).text();
    expect(m1).toBe(m2);
  });

  it("[LDB-V9] the ETag of a list differs with and without features=skip, and a 304 never crosses", async () => {
    await setup();
    for (const path of ["/v1/layouts?format=spark/1", "/v1/layouts?format=spark/1&full=1"]) {
      const withheld = await writeFetch(path, "GET");
      const full = await writeFetch(`${path}&features=skip`, "GET");
      await withheld.text();
      await full.text();
      const a = withheld.headers.get("ETag")!;
      const b = full.headers.get("ETag")!;
      expect(a).not.toBe(b);
      expect((await writeFetch(`${path}&features=skip`, "GET", { "If-None-Match": a })).status).toBe(200);
      expect((await writeFetch(path, "GET", { "If-None-Match": b })).status).toBe(200);
      expect((await writeFetch(path, "GET", { "If-None-Match": a })).status).toBe(304);
      expect((await writeFetch(`${path}&features=skip`, "GET", { "If-None-Match": b })).status).toBe(304);
      // an ignored unknown name changes nothing
      const unknown = await writeFetch(`${path}&features=future`, "GET");
      await unknown.text();
      expect(unknown.headers.get("ETag")).toBe(a);
    }
  });
});

describe("[LDB-V10] a write that would drop skip the writer never read is 409 features_required", () => {
  it("[LDB-V10] PUT and PATCH magic without features=skip, body without skip: 409, nothing written", async () => {
    const { headers, created } = await setup();
    const c = created.find((x) => x.name === "skip beside a plain rule")!;
    const ifMatch = { ...headers, "If-Match": scopedToken("spark", c.rev) };
    const readerCopy = withholdSkip(c.payload).payload;

    const put = await writeFetch(`/v1/layouts/${c.id}`, "PUT", ifMatch, { format: "spark/1", payload: readerCopy });
    expect(put.status).toBe(409);
    expect(await put.json()).toMatchObject({ error: "features_required", feature: "skip" });

    const patch = await writeFetch(`/v1/layouts/${c.id}`, "PATCH", ifMatch, { format: "spark/1", magic: (readerCopy as { magic: unknown }).magic });
    expect(patch.status).toBe(409);
    expect(await patch.json()).toMatchObject({ error: "features_required", feature: "skip" });

    const after = await (await writeFetch(`/v1/layouts/${c.id}?format=spark/1&features=skip`, "GET")).json<Wire>();
    expect(after.payload).toEqual(c.payload);
    expect(after.formats["spark/1"]!.rev).toBe(c.rev);
  });

  it("[LDB-V10] accepted: a body with skip, features=skip, PATCH of something other than magic, a record without skip", async () => {
    const { headers, created } = await setup();
    const c = created.find((x) => x.name === "skip beside a plain rule")!;
    const readerCopy = withholdSkip(c.payload).payload;
    let rev = c.rev;
    const ifMatch = () => ({ ...headers, "If-Match": scopedToken("spark", rev) });
    const bump = async (res: Response) => {
      expect(res.status, await res.clone().text()).toBe(200);
      rev = (await res.json<Wire>()).formats["spark/1"]!.rev;
    };

    // features=skip: the writer says it knows skip, even with a body that drops it
    await bump(await writeFetch(`/v1/layouts/${c.id}?features=skip`, "PUT", ifMatch(), { format: "spark/1", payload: readerCopy }));
    // the record no longer uses skip, so a reader's PUT is fine now
    await bump(await writeFetch(`/v1/layouts/${c.id}`, "PUT", ifMatch(), { format: "spark/1", payload: readerCopy }));

    // a body that itself uses skip is accepted without the param
    await bump(await writeFetch(`/v1/layouts/${c.id}`, "PUT", ifMatch(), { format: "spark/1", payload: c.payload }));
    // PATCH of alts / fingermap keeps magic: accepted without the param, skip survives
    await bump(await writeFetch(`/v1/layouts/${c.id}`, "PATCH", ifMatch(), { format: "spark/1", alts: [] }));
    const kept = await (await writeFetch(`/v1/layouts/${c.id}?format=spark/1&features=skip`, "GET")).json<Wire>();
    expect((kept.payload as { magic: unknown }).magic).toEqual((c.payload as { magic: unknown }).magic);
    // PATCH magic with skip in the body: accepted
    await bump(await writeFetch(`/v1/layouts/${c.id}`, "PATCH", ifMatch(), { format: "spark/1", magic: (c.payload as { magic: unknown }).magic }));
    // PATCH magic with features=skip and a body without it: accepted
    await bump(await writeFetch(`/v1/layouts/${c.id}?features=skip`, "PATCH", ifMatch(), { format: "spark/1", magic: (readerCopy as { magic: unknown }).magic }));
  });

  it("[LDB-V10] a stale If-Match still answers stale, ahead of features_required", async () => {
    const { headers, created } = await setup();
    const c = created[0]!;
    const res = await writeFetch(`/v1/layouts/${c.id}`, "PUT", { ...headers, "If-Match": scopedToken("spark", c.rev + 5) }, { format: "spark/1", payload: withholdSkip(c.payload).payload });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("stale");
  });
});
