// [LDB-A7] Strict per-route body schemas (09 §2.6): a key outside the
// verb's own schema -- `owner` above all, but also `id`/`rev`/`created_at`/
// `like_count` -- is refused with `400 bad_request` and a `param` naming
// it, not silently dropped; a missing required key is the same; `payload`
// must be an object; the body must be valid JSON at all (a non-JSON body,
// or `Content-Type` absent on an otherwise-valid JSON body, must not be
// conflated with "not JSON").
import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { appendWrite } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import { CMINI_PAYLOAD, actorFixture, register, uniqueName, writeFetch } from "./write-support";

const db = (env as unknown as Bindings).DB;
const clock = fixedClock("2026-07-05T00:00:00.000Z");
const OWNER = "owner-bodies-1";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function seed() {
  const { record } = await appendWrite(db, clock, {
    kind: "created",
    name: uniqueName("bodies-seed"),
    owner: OWNER,
    modified_at: clock(),
    format: "cmini/1",
    payload: CMINI_PAYLOAD,
    actor: OWNER,
    via: "discord",
    hasMagic: false,
  });
  return record;
}

function ownerHeaders() {
  const fake = actorFixture();
  return register(fake, "tok-bodies-owner", OWNER);
}

describe("[LDB-A7] POST /v1/layouts body", () => {
  const base = { name: uniqueName("post-body"), format: "cmini/1", payload: CMINI_PAYLOAD };

  it("[LDB-A7] a foreign key (owner) -> 400 bad_request, param /owner", async () => {
    const res = await writeFetch("/v1/layouts", "POST", ownerHeaders(), { ...base, owner: "someone-else" });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "bad_request", param: "/owner" });
  });

  for (const key of ["id", "rev", "created_at", "like_count"]) {
    it(`a foreign key (${key}) -> 400 bad_request, param /${key}`, async () => {
      const res = await writeFetch("/v1/layouts", "POST", ownerHeaders(), { ...base, [key]: "x" });
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: "bad_request", param: `/${key}` });
    });
  }

  it("missing a required key (name) -> 400", async () => {
    const { name: _name, ...rest } = base;
    const res = await writeFetch("/v1/layouts", "POST", ownerHeaders(), rest);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "bad_request" });
  });

  it("payload not an object -> 400", async () => {
    const res = await writeFetch("/v1/layouts", "POST", ownerHeaders(), { ...base, payload: "not an object" });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "bad_request", param: "/payload" });
  });

  it("non-JSON body -> 400", async () => {
    const res = await fetchRaw("/v1/layouts", "POST", ownerHeaders(), "{not json");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "bad_request" });
  });

  it("Content-Type absent but body valid JSON -> accepted", async () => {
    const headers = ownerHeaders(); // no Content-Type set
    const res = await fetchRaw("/v1/layouts", "POST", headers, JSON.stringify({ ...base, name: uniqueName("no-ct") }));
    expect(res.status).toBe(201);
  });
});

describe("[LDB-A7] PUT /v1/layouts/{ref} body", () => {
  it("owner in the body -> 400 bad_request, param /owner", async () => {
    const record = await seed();
    const res = await writeFetch(`/v1/layouts/${record.id}`, "PUT", ownerHeaders(), {
      format: "cmini/1",
      payload: CMINI_PAYLOAD,
      owner: "someone-else",
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "bad_request", param: "/owner" });
  });

  it("missing payload -> 400", async () => {
    const record = await seed();
    const res = await writeFetch(`/v1/layouts/${record.id}`, "PUT", ownerHeaders(), { format: "cmini/1" });
    expect(res.status).toBe(400);
  });
});

describe("[LDB-A7] POST /v1/layouts/{ref}/transfer body", () => {
  it("owner in the body -> 400 bad_request, param /owner", async () => {
    const record = await seed();
    const res = await writeFetch(`/v1/layouts/${record.id}/transfer`, "POST", ownerHeaders(), {
      to: "20000000000000002",
      owner: "someone-else",
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "bad_request", param: "/owner" });
  });
});

async function fetchRaw(path: string, method: string, headers: Record<string, string>, rawBody: string) {
  return SELF.fetch(`https://example.com${path}`, { method, headers, body: rawBody });
}
