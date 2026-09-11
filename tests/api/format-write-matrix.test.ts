// [LDB-F16] Every accepted write resolves `body.format` through the
// registry and stores natively (`spark/1`) -- verb x format, over
// {spark/1, mana2/1 (output-only), unknown}. 21-formats.md D5/D12 deleted
// every alias (`akl/1`) and the unregistered `cmini/1` write path along
// with the legacy carry-forward (`storedAsSpark`) this file used to have
// a dedicated "every legacy format converts" matrix for -- after the D8
// wipe no row is ever stored as a legacy format, so delete/restore/
// transfer/PATCH carrying a record's own (already-native) format forward
// is covered by the ordinary tests in write.test.ts/restore.test.ts/
// transfer.test.ts/patch.test.ts, not a second matrix here.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { fixedClock } from "../../src/core/time";
import { AKL_PAYLOAD, actorFixture, pinTestClock, register, uniqueName, writeFetch } from "./write-support";

const db = (env as unknown as Bindings).DB;
const clock = fixedClock("2026-07-15T00:00:00.000Z");
pinTestClock(env as unknown as { TEST_CLOCK?: typeof clock }, clock);

const OWNER = "owner-fwmatrix-1";

function headers() {
  return register(actorFixture(), `tok-${uniqueName("fwm")}`, OWNER);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// -- POST/PUT: `body.format` resolution -------------------------------

describe("[LDB-F16] POST /v1/layouts: format resolution", () => {
  it("[LDB-F16] spark/1 -> 201, stores spark/1 natively", async () => {
    const res = await writeFetch("/v1/layouts", "POST", headers(), { name: uniqueName("fwm-spark"), format: "spark/1", payload: AKL_PAYLOAD });
    expect(res.status).toBe(201);
    const body = await res.json<{ id: string; format: string }>();
    expect(body.format).toBe("spark/1");
    const row = await db.prepare("SELECT format FROM layout_formats WHERE layout_id = ? AND lineage = 'spark'").bind(body.id).first<{ format: string }>();
    expect(row?.format).toBe("spark/1");
  });

  it("cmini/1 -> 400 unknown_format, known lists registered ids only", async () => {
    const res = await writeFetch("/v1/layouts", "POST", headers(), { name: uniqueName("fwm-cmini"), format: "cmini/1", payload: { board: "ortho", keys: {} } });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string; format: string; known: string[] }>();
    expect(body.error).toBe("unknown_format");
    expect(body.format).toBe("cmini/1");
    expect(body.known).toEqual(["spark/1", "mana2/1"]);
  });

  it("mana2/1 -> 400 format_not_writable, never unknown_format", async () => {
    const res = await writeFetch("/v1/layouts", "POST", headers(), { name: uniqueName("fwm-mana2"), format: "mana2/1", payload: {} });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string; format: string }>();
    expect(body.error).toBe("format_not_writable");
    expect(body.format).toBe("mana2/1");
  });

  it("an unregistered format -> 400 unknown_format", async () => {
    const res = await writeFetch("/v1/layouts", "POST", headers(), { name: uniqueName("fwm-bogus"), format: "bogus/1", payload: {} });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "unknown_format", format: "bogus/1" });
  });

  it("no event is appended for any refused format", async () => {
    const before = await db.prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>();
    for (const format of ["cmini/1", "mana2/1", "bogus/1"]) {
      const res = await writeFetch("/v1/layouts", "POST", headers(), { name: uniqueName(`fwm-noevent-${format}`), format, payload: {} });
      expect(res.status, format).toBe(400);
    }
    const after = await db.prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });
});

async function seedSpark(owner: string) {
  const res = await writeFetch("/v1/layouts", "POST", register(actorFixture(), `tok-${uniqueName("fwm-seed")}`, owner), {
    name: uniqueName("fwm-seed"),
    format: "spark/1",
    payload: AKL_PAYLOAD,
  });
  vi.unstubAllGlobals();
  const body = await res.json<{ id: string; owner: string; formats: Record<string, { rev: number }> }>();
  return { id: body.id, owner: body.owner, rev: body.formats["spark/1"]!.rev };
}

async function sparkRev(id: string): Promise<number> {
  const row = await db.prepare("SELECT rev FROM layout_formats WHERE layout_id = ? AND lineage = 'spark'").bind(id).first<{ rev: number }>();
  return row!.rev;
}

describe("[LDB-F16] PUT /v1/layouts/{ref}: same resolution rules apply", () => {
  it("mana2/1 -> 400 format_not_writable, record unchanged", async () => {
    const record = await seedSpark(OWNER);
    const h = headers();
    const res = await writeFetch(`/v1/layouts/${record.id}`, "PUT", { ...h, "If-Match": `"spark:${record.rev}"` }, { format: "mana2/1", payload: {} });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "format_not_writable", format: "mana2/1" });
    expect(await sparkRev(record.id)).toBe(record.rev);
  });

  it("cmini/1 -> 400 unknown_format, record unchanged", async () => {
    const record = await seedSpark(OWNER);
    const h = headers();
    const res = await writeFetch(`/v1/layouts/${record.id}`, "PUT", { ...h, "If-Match": `"spark:${record.rev}"` }, { format: "cmini/1", payload: { board: "ortho", keys: {} } });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "unknown_format", format: "cmini/1" });
    expect(await sparkRev(record.id)).toBe(record.rev);
  });
});
