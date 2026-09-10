// [LDB-F16] 20-spark.md S2: one stored format. Every accepted write
// resolves `body.format` through the registry's alias table and stores
// natively (`spark/1`) -- never the caller's own literal -- and every
// write that carries an EXISTING record's payload forward (delete,
// restore, transfer, PATCH) converts it through `storedAsSpark` rather
// than re-storing whatever the record happened to be. This is the
// dedicated matrix S2's own plan calls for: verb x format, over
// {spark/1, akl/1 (alias), cmini/1 (unregistered), mana2/1 (output-only),
// unknown}.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { appendWrite } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import { AKL_PAYLOAD, BOOTSTRAP_ADMIN, CMINI_PAYLOAD, actorFixture, pinTestClock, register, uniqueName, writeFetch } from "./write-support";

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
    const row = await db.prepare("SELECT format FROM layouts WHERE id = ?").bind(body.id).first<{ format: string }>();
    expect(row?.format).toBe("spark/1");
  });

  it("[LDB-F20] akl/1 (alias) -> 201, stores spark/1 natively, response relabelled akl/1", async () => {
    const res = await writeFetch("/v1/layouts", "POST", headers(), { name: uniqueName("fwm-akl"), format: "akl/1", payload: AKL_PAYLOAD });
    expect(res.status).toBe(201);
    const body = await res.json<{ id: string; format: string }>();
    expect(body.format).toBe("akl/1"); // relabelled: the request named akl/1
    const row = await db.prepare("SELECT format FROM layouts WHERE id = ?").bind(body.id).first<{ format: string }>();
    expect(row?.format).toBe("spark/1"); // stored natively
  });

  it("cmini/1 -> 400 unknown_format, known lists registered ids only", async () => {
    const res = await writeFetch("/v1/layouts", "POST", headers(), { name: uniqueName("fwm-cmini"), format: "cmini/1", payload: CMINI_PAYLOAD });
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

async function seedLegacy(owner: string, format: "cmini/1" | "akl/1" | "spark/1" = "cmini/1") {
  const { record } = await appendWrite(db, clock, {
    kind: "created",
    name: uniqueName("fwm-legacy"),
    owner,
    modified_at: clock(),
    format,
    payload: format === "cmini/1" ? CMINI_PAYLOAD : AKL_PAYLOAD,
    actor: owner,
    via: "discord",
    hasMagic: false,
  });
  return record;
}

// [LDB-F20] The deployed bot's own three read points
// (bot/src/cache/apply.ts's write response, magic/source.ts,
// commands/magic.ts) all branch on `format === 'akl/1'` -- this is the
// exact write-response and 409-stale shape it depends on staying stable
// through the transition (design/layout-db/20-spark.md §1.12).
describe("[LDB-F20] the deployed-bot path: write response and 409 stale relabel to akl/1", () => {
  it("[LDB-F20] PUT with body.format 'akl/1' -> 200 response format 'akl/1'", async () => {
    const record = await seedLegacy(OWNER, "akl/1");
    const h = headers();
    const res = await writeFetch(`/v1/layouts/${record.id}`, "PUT", { ...h, "If-Match": `"${record.rev}"` }, { format: "akl/1", payload: AKL_PAYLOAD });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ format: "akl/1" });
  });

  it("a 409 stale body for a PUT whose body said format 'akl/1' carries record.format 'akl/1'", async () => {
    const record = await seedLegacy(OWNER, "akl/1");
    const h = headers();
    const res = await writeFetch(
      `/v1/layouts/${record.id}`,
      "PUT",
      { ...h, "If-Match": `"${record.rev + 5}"` }, // deliberately stale
      { format: "akl/1", payload: AKL_PAYLOAD },
    );
    expect(res.status).toBe(409);
    const body = await res.json<{ error: string; record: { format: string } }>();
    expect(body.error).toBe("stale");
    expect(body.record.format).toBe("akl/1");
  });

  it("a 409 stale body for a PUT whose body said format 'spark/1' carries record.format 'spark/1' (no relabel)", async () => {
    const record = await seedLegacy(OWNER, "spark/1");
    const h = headers();
    const res = await writeFetch(
      `/v1/layouts/${record.id}`,
      "PUT",
      { ...h, "If-Match": `"${record.rev + 5}"` },
      { format: "spark/1", payload: AKL_PAYLOAD },
    );
    expect(res.status).toBe(409);
    const body = await res.json<{ error: string; record: { format: string } }>();
    expect(body.error).toBe("stale");
    expect(body.record.format).toBe("spark/1");
  });
});

describe("[LDB-F16] PUT /v1/layouts/{ref}: same resolution rules apply", () => {
  it("mana2/1 -> 400 format_not_writable, record unchanged", async () => {
    const record = await seedLegacy(OWNER, "akl/1");
    const h = headers();
    const res = await writeFetch(`/v1/layouts/${record.id}`, "PUT", { ...h, "If-Match": `"${record.rev}"` }, { format: "mana2/1", payload: {} });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "format_not_writable", format: "mana2/1" });
    const row = await db.prepare("SELECT rev FROM layouts WHERE id = ?").bind(record.id).first<{ rev: number }>();
    expect(row?.rev).toBe(record.rev);
  });

  it("cmini/1 -> 400 unknown_format, record unchanged", async () => {
    const record = await seedLegacy(OWNER, "akl/1");
    const h = headers();
    const res = await writeFetch(`/v1/layouts/${record.id}`, "PUT", { ...h, "If-Match": `"${record.rev}"` }, { format: "cmini/1", payload: CMINI_PAYLOAD });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "unknown_format", format: "cmini/1" });
    const row = await db.prepare("SELECT rev FROM layouts WHERE id = ?").bind(record.id).first<{ rev: number }>();
    expect(row?.rev).toBe(record.rev);
  });
});

// -- carry-forward writes: every legacy-stored record converts ---------

describe("[LDB-F16] [LDB-F21] carry-forward writes always store spark/<latest>", () => {
  for (const format of ["cmini/1", "akl/1"] as const) {
    it(`[LDB-F21] delete of a ${format}-stored record -> tombstone stores spark/1`, async () => {
      const record = await seedLegacy(OWNER, format);
      const h = headers();
      const res = await writeFetch(`/v1/layouts/${record.id}`, "DELETE", { ...h, "If-Match": `"${record.rev}"` });
      expect(res.status).toBe(200);
      const body = await res.json<{ format: string }>();
      expect(body.format).toBe("spark/1");
      const row = await db.prepare("SELECT format FROM layouts WHERE id = ?").bind(record.id).first<{ format: string }>();
      expect(row?.format).toBe("spark/1");
    });

    it(`restore of a ${format}-stored tombstone -> stores spark/1`, async () => {
      const record = await seedLegacy(OWNER, format);
      await appendWrite(db, clock, {
        kind: "deleted",
        layoutId: record.id,
        name: record.name,
        owner: record.owner,
        modified_at: clock(),
        format: record.format,
        payload: record.payload,
        actor: OWNER,
        via: "discord",
        deleted: true,
      });
      const h = headers();
      const res = await writeFetch(`/v1/layouts/${record.id}/restore`, "POST", h);
      expect(res.status).toBe(200);
      const body = await res.json<{ format: string }>();
      expect(body.format).toBe("spark/1");
    });

    it(`transfer of a ${format}-stored record -> stores spark/1`, async () => {
      const record = await seedLegacy(OWNER, format);
      const fake = actorFixture();
      const h = register(fake, `tok-${uniqueName("fwm-transfer-target")}`, "20000000000000009");
      const meRes = await writeFetch("/v1/me", "GET", h);
      expect(meRes.status).toBe(200);
      vi.unstubAllGlobals();

      const owner = register(actorFixture(), `tok-${uniqueName("fwm-transfer-owner")}`, OWNER);
      const res = await writeFetch(
        `/v1/layouts/${record.id}/transfer`,
        "POST",
        { ...owner, "If-Match": `"${record.rev}"` },
        { to: "20000000000000009" },
      );
      expect(res.status).toBe(200);
      const body = await res.json<{ format: string }>();
      expect(body.format).toBe("spark/1");
    });

    it(`PATCH {name} on a ${format}-stored record -> stores spark/1`, async () => {
      const record = await seedLegacy(OWNER, format);
      const h = headers();
      const res = await writeFetch(
        `/v1/layouts/${record.id}`,
        "PATCH",
        { ...h, "If-Match": `"${record.rev}"` },
        { name: uniqueName("fwm-patched") },
      );
      expect(res.status).toBe(200);
      const row = await db.prepare("SELECT format FROM layouts WHERE id = ?").bind(record.id).first<{ format: string }>();
      expect(row?.format).toBe("spark/1");
    });
  }
});
