// 21-formats.md D5/D12 deleted the alias mechanism this file used to be
// about; D4 (21-formats.md §2.4) then deleted `?as=`'s DEFAULT entirely --
// every read that returns a payload now REQUIRES `?format=`, and the wire
// `format` field always names exactly what was requested (the record's own
// native format when it matches, or the requested format when it was
// derived -- `derived_from` names the source). What's left worth a
// dedicated file: `?format=cmini/1` (never registered) answers exactly
// like any other unregistered format everywhere it appears (400
// unknown_format), and the plain `?format=` list selector shows the
// native format per item.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { commitWrite, type CommitInput } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import { ulid } from "ulidx";
import { writeFetch } from "./write-support";

const db = (env as unknown as Bindings).DB;
const clock = fixedClock("2026-07-16T00:00:00.000Z");
const OWNER = "owner-readlabels-1";

afterEach(() => {
  vi.unstubAllGlobals();
});

let uniqueCounter = 0;
function uniqueName(prefix: string): string {
  return `${prefix}-${uniqueCounter++}`;
}

async function seed() {
  const input: CommitInput = {
    layoutId: ulid(),
    creating: true,
    currentN: 0,
    currentLayout: null,
    currentFormats: new Map(),
    layout: { kind: "created", name: uniqueName("readlabel"), owner: OWNER, created_at: clock(), deleted: false },
    format: { kind: "format_added", lineage: "spark", format: "spark/1", payload: { keys: [], board: "ansi" }, hasMagic: false },
    modified_at: clock(),
    actor: OWNER,
    via: "discord",
    source: { client: "discord-app:test", version: null },
    upstream: null,
  };
  const { layout } = await commitWrite(db, clock, input);
  return layout;
}

describe("GET detail: ?format= is required (D4); the wire format is always the record's native one", () => {
  it("[MF-4] [LDB-G11] no ?format= -> 400 format_required", async () => {
    const record = await seed();
    const res = await writeFetch(`/v1/layouts/${record.id}`, "GET");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "format_required" });
  });

  it("?format=spark/1 -> native format", async () => {
    const record = await seed();
    const res = await writeFetch(`/v1/layouts/${record.id}?format=spark/1`, "GET");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ format: "spark/1" });
  });

  it("?format=cmini/1 -> 400 unknown_format, same as any other unregistered format (21-formats.md D5)", async () => {
    const record = await seed();
    const res = await writeFetch(`/v1/layouts/${record.id}?format=cmini/1`, "GET");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "unknown_format", format: "cmini/1", known: ["spark/1", "mana2/1"] });
  });
});

describe("GET /v1/layouts?full=1: ?format= required; the wire format is always the record's native one", () => {
  it("full=1&format=spark/1 -> native format per item", async () => {
    const record = await seed();
    const res = await writeFetch("/v1/layouts?full=1&format=spark/1", "GET");
    expect(res.status).toBe(200);
    const body = await res.json<{ items: { id: string; format: string }[] }>();
    const item = body.items.find((i) => i.id === record.id);
    expect(item?.format).toBe("spark/1");
  });

  it("[MF-4] [LDB-G11] full=1 with no ?format= -> 400 format_required", async () => {
    await seed();
    const res = await writeFetch("/v1/layouts?full=1", "GET");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "format_required" });
  });

  it("full=1&format=cmini/1 -> 400 unknown_format", async () => {
    await seed();
    const res = await writeFetch("/v1/layouts?full=1&format=cmini/1", "GET");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "unknown_format", format: "cmini/1" });
  });
});

describe("GET /v1/layouts/{ref}/rev/{n}: ?format= required; the wire format is always the record's native one", () => {
  it("?format=spark/1 -> native format", async () => {
    const record = await seed();
    const res = await writeFetch(`/v1/layouts/${record.id}/rev/1?format=spark/1`, "GET");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ format: "spark/1" });
  });

  it("[MF-4] [LDB-G11] no ?format= -> 400 format_required", async () => {
    const record = await seed();
    const res = await writeFetch(`/v1/layouts/${record.id}/rev/1`, "GET");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "format_required" });
  });
});

describe("?format= list selector: required, plain equality against the stored lineage", () => {
  it("?format=spark/1 lists records stored spark/1", async () => {
    const record = await seed();
    const res = await writeFetch(`/v1/layouts?owner=${OWNER}&format=spark/1`, "GET");
    expect(res.status).toBe(200);
    const body = await res.json<{ items: { id: string }[] }>();
    expect(body.items.map((i) => i.id)).toContain(record.id);
  });

  it("?format=cmini/1 -> 400 unknown_format (never registered, so never a valid selector)", async () => {
    await seed();
    const res = await writeFetch(`/v1/layouts?owner=${OWNER}&format=cmini/1`, "GET");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "unknown_format" });
  });

  it("[MF-4] [LDB-G11] no ?format= -> 400 format_required", async () => {
    await seed();
    const res = await writeFetch(`/v1/layouts?owner=${OWNER}`, "GET");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "format_required" });
  });
});

describe("list rows show the native format", () => {
  it("a plain list row shows the native format", async () => {
    const record = await seed();
    const res = await writeFetch(`/v1/layouts?owner=${OWNER}&format=spark/1`, "GET");
    expect(res.status).toBe(200);
    const body = await res.json<{ items: { id: string; format: string }[] }>();
    const item = body.items.find((i) => i.id === record.id);
    expect(item?.format).toBe("spark/1");
  });
});
