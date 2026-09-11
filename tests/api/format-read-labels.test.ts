// 21-formats.md D5/D12 deleted the alias mechanism (`akl/1`'s relabel
// rule, `cmini/1`'s `adapter:cmini` read path) that this file's own
// [LDB-F20] used to be entirely about: the wire `format` field is simply
// always the record's native format now, on every route, with no
// exceptions to pin. What's left worth a dedicated file: `?as=cmini/1`
// now answers exactly like any other unregistered format (400
// unknown_format, never a projection), and `?format=` list filtering
// stays a plain equality match now that there is no alias table to
// resolve through.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { appendWrite } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import { writeFetch } from "./write-support";

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
    source: { client: "discord-app:test", version: null },
    hasMagic: false,
  });
  return record;
}

let uniqueCounter = 0;
function uniqueName(prefix: string): string {
  return `${prefix}-${uniqueCounter++}`;
}

describe("GET detail: the wire format is always the record's native one", () => {
  it("no ?as= (default spark/1) -> native format", async () => {
    const record = await seed();
    const res = await writeFetch(`/v1/layouts/${record.id}`, "GET");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ format: "spark/1" });
  });

  it("?as=spark/1 -> native format", async () => {
    const record = await seed();
    const res = await writeFetch(`/v1/layouts/${record.id}?as=spark/1`, "GET");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ format: "spark/1" });
  });

  it("?as=cmini/1 -> 400 unknown_format, same as any other unregistered format (21-formats.md D5)", async () => {
    const record = await seed();
    const res = await writeFetch(`/v1/layouts/${record.id}?as=cmini/1`, "GET");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "unknown_format", format: "cmini/1", known: ["spark/1", "mana2/1"] });
  });
});

describe("GET /v1/layouts?full=1: the wire format is always the record's native one", () => {
  it("full=1 -> native format per item", async () => {
    const record = await seed();
    const res = await writeFetch("/v1/layouts?full=1", "GET");
    expect(res.status).toBe(200);
    const body = await res.json<{ items: { id: string; format: string }[] }>();
    const item = body.items.find((i) => i.id === record.id);
    expect(item?.format).toBe("spark/1");
  });

  it("full=1&as=cmini/1 -> 400 unknown_format", async () => {
    await seed();
    const res = await writeFetch("/v1/layouts?full=1&as=cmini/1", "GET");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "unknown_format", format: "cmini/1" });
  });
});

describe("GET /v1/layouts/{ref}/rev/{n}: the wire format is always the record's native one", () => {
  it("no ?as= -> native format", async () => {
    const record = await seed();
    const res = await writeFetch(`/v1/layouts/${record.id}/rev/1`, "GET");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ format: "spark/1" });
  });
});

describe("?format= list filter: a plain equality match, no alias table to resolve through", () => {
  it("?format=spark/1 matches records stored spark/1", async () => {
    const record = await seed();
    const res = await writeFetch(`/v1/layouts?owner=${OWNER}&format=spark/1`, "GET");
    expect(res.status).toBe(200);
    const body = await res.json<{ items: { id: string }[] }>();
    expect(body.items.map((i) => i.id)).toContain(record.id);
  });

  it("?format=cmini/1 matches nothing live (no row is ever stored under that literal any more)", async () => {
    await seed();
    const res = await writeFetch(`/v1/layouts?owner=${OWNER}&format=cmini/1`, "GET");
    expect(res.status).toBe(200);
    const body = await res.json<{ items: { id: string }[] }>();
    expect(body.items).toEqual([]);
  });
});

describe("list rows show the native format", () => {
  it("a plain list row shows the native format", async () => {
    const record = await seed();
    const res = await writeFetch(`/v1/layouts?owner=${OWNER}`, "GET");
    expect(res.status).toBe(200);
    const body = await res.json<{ items: { id: string; format: string }[] }>();
    const item = body.items.find((i) => i.id === record.id);
    expect(item?.format).toBe("spark/1");
  });
});
