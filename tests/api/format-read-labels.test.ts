// [LDB-F20] 20-spark.md S2 §1.12 (refined §8 R-H3/R-L3): the wire `format`
// field is the record's NATIVE format everywhere; the ONE exception is a
// response to a request that named `akl/1` (`?as=akl/1` on detail,
// `/rev/{n}`, and `full=1`) -- it carries `format: "akl/1"` even though
// the record is stored (and every OTHER read shows) `spark/1`.
// `?as=cmini/1` is never relabelled (it's an adapter projection, not the
// same format); the default (`?as` absent) and `?as=spark/1` show the
// native format too.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { appendWrite } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import { actorFixture, register, uniqueName, writeFetch } from "./write-support";

const db = (env as unknown as Bindings).DB;
const clock = fixedClock("2026-07-16T00:00:00.000Z");
const OWNER = "owner-readlabels-1";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function seed() {
  const { record } = await appendWrite(db, clock, {
      upstream: null,
    kind: "created",
    name: uniqueName("readlabel"),
    owner: OWNER,
    modified_at: clock(),
    format: "spark/1",
    payload: { keys: {} },
    actor: OWNER,
    via: "discord",
    hasMagic: false,
  });
  return record;
}

describe("[LDB-F20] GET detail: the label rule", () => {
  it("no ?as= (default spark/1) -> native format, no relabel", async () => {
    const record = await seed();
    const res = await writeFetch(`/v1/layouts/${record.id}`, "GET");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ format: "spark/1" });
  });

  it("?as=spark/1 -> native format, no relabel", async () => {
    const record = await seed();
    const res = await writeFetch(`/v1/layouts/${record.id}?as=spark/1`, "GET");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ format: "spark/1" });
  });

  it("[LDB-F20] ?as=akl/1 -> relabelled format: akl/1", async () => {
    const record = await seed();
    const res = await writeFetch(`/v1/layouts/${record.id}?as=akl/1`, "GET");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ format: "akl/1" });
  });

  it("?as=cmini/1 -> NOT relabelled: still native spark/1, even though the payload is the adapter projection", async () => {
    const record = await seed();
    const res = await writeFetch(`/v1/layouts/${record.id}?as=cmini/1`, "GET");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ format: "spark/1" });
  });
});

describe("[LDB-F20] GET /v1/layouts?full=1: the label rule per item", () => {
  it("full=1&as=akl/1 -> every non-held item relabelled akl/1", async () => {
    const record = await seed();
    const res = await writeFetch("/v1/layouts?full=1&as=akl/1", "GET");
    expect(res.status).toBe(200);
    const body = await res.json<{ items: { id: string; format: string }[] }>();
    const item = body.items.find((i) => i.id === record.id);
    expect(item?.format).toBe("akl/1");
  });

  it("full=1 (default) -> native format", async () => {
    const record = await seed();
    const res = await writeFetch("/v1/layouts?full=1", "GET");
    expect(res.status).toBe(200);
    const body = await res.json<{ items: { id: string; format: string }[] }>();
    const item = body.items.find((i) => i.id === record.id);
    expect(item?.format).toBe("spark/1");
  });
});

describe("[LDB-F20] GET /v1/layouts/{ref}/rev/{n}: the label rule", () => {
  it("?as=akl/1 -> relabelled format: akl/1", async () => {
    const record = await seed();
    const res = await writeFetch(`/v1/layouts/${record.id}/rev/1?as=akl/1`, "GET");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ format: "akl/1" });
  });

  it("no ?as= -> native format", async () => {
    const record = await seed();
    const res = await writeFetch(`/v1/layouts/${record.id}/rev/1`, "GET");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ format: "spark/1" });
  });
});

// The label rule also follows the WRITE body (POST/PUT) and the 409
// stale body -- covered in tests/api/write.test.ts's own [LDB-P4] cases
// and tests/api/format-write-matrix.test.ts's [LDB-F16] ones; not
// repeated here.
describe("[LDB-F20] ?format= list filter resolves aliases", () => {
  it("?format=akl/1 matches records stored spark/1 (akl/1's alias target)", async () => {
    const record = await seed(); // stored spark/1
    const res = await writeFetch(`/v1/layouts?owner=${OWNER}&format=akl/1`, "GET");
    expect(res.status).toBe(200);
    const body = await res.json<{ items: { id: string }[] }>();
    expect(body.items.map((i) => i.id)).toContain(record.id);
  });

  it("?format=spark/1 matches the same records directly (unaffected)", async () => {
    const record = await seed();
    const res = await writeFetch(`/v1/layouts?owner=${OWNER}&format=spark/1`, "GET");
    expect(res.status).toBe(200);
    const body = await res.json<{ items: { id: string }[] }>();
    expect(body.items.map((i) => i.id)).toContain(record.id);
  });

  it("?format=cmini/1 stays a literal match against legacy-stored rows (never resolved to the adapter target)", async () => {
    const { record: legacy } = await appendWrite(db, clock, {
      upstream: null,
      kind: "created",
      name: uniqueName("readlabel-cmini"),
      owner: OWNER,
      modified_at: clock(),
      format: "cmini/1",
      payload: { board: "ortho", keys: {} },
      actor: OWNER,
      via: "discord",
      hasMagic: false,
    });
    const res = await writeFetch(`/v1/layouts?owner=${OWNER}&format=cmini/1`, "GET");
    expect(res.status).toBe(200);
    const body = await res.json<{ items: { id: string; format: string }[] }>();
    const item = body.items.find((i) => i.id === legacy.id);
    expect(item?.format).toBe("cmini/1");
  });
});

describe("[LDB-F20] list rows never relabel (no ?as= on the plain list route)", () => {
  it("a plain list row shows the native format regardless", async () => {
    const record = await seed();
    const fake = actorFixture();
    register(fake, `tok-${uniqueName("readlabel-owner")}`, OWNER);
    const res = await writeFetch(`/v1/layouts?owner=${OWNER}`, "GET");
    expect(res.status).toBe(200);
    const body = await res.json<{ items: { id: string; format: string }[] }>();
    const item = body.items.find((i) => i.id === record.id);
    expect(item?.format).toBe("spark/1");
  });
});
