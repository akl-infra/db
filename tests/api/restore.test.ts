// [LDB-P8] Restore (09 §3 T2, §6.7): within 30 days the owner gets the
// tombstone back (same name/payload/format, `rev + 1`, live by name); past
// 30 days the owner gets `404` but an admin still gets `200`; a live
// record holding the name meanwhile is `409 name_taken`; by name is always
// `404` (a tombstone has no live name); by id on a live record is `400`;
// restoring an `upstream_deleted` tombstone as the owner stops it following
// upstream (LDB-I2a).
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { appendWrite } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import type { Clock } from "../../src/core/time";
import { CMINI_PAYLOAD, actorFixture, pinTestClock, register, uniqueName, writeFetch } from "./write-support";

const bindings = env as unknown as Bindings;
const db = bindings.DB;
const OWNER = "owner-restore-1";
const OTHER = "owner-restore-2";
const DELETED_AT = "2026-08-01T00:00:00.000Z"; // fixed "now" this whole suite pins clocks relative to

afterEach(() => {
  vi.unstubAllGlobals();
});

function setNow(iso: string) {
  pinTestClock(env as unknown as { TEST_CLOCK?: Clock }, fixedClock(iso));
}

function ownerHeaders(id: string, token: string) {
  const fake = actorFixture();
  return register(fake, token, id);
}

async function seedTombstone(name = uniqueName("restore-seed"), owner = OWNER, via: "discord" | "import:cmini" = "discord") {
  const created = await appendWrite(db, fixedClock(DELETED_AT), {
    kind: via === "import:cmini" ? "imported" : "created",
    name,
    owner,
    modified_at: DELETED_AT,
    format: "cmini/1",
    payload: CMINI_PAYLOAD,
    actor: via === "import:cmini" ? "system:cmini-import" : owner,
    via,
    hasMagic: false,
  });
  const deleted = await appendWrite(db, fixedClock(DELETED_AT), {
    kind: via === "import:cmini" ? "upstream_deleted" : "deleted",
    layoutId: created.record.id,
    name,
    owner,
    modified_at: DELETED_AT,
    format: "cmini/1",
    payload: CMINI_PAYLOAD,
    actor: via === "import:cmini" ? "system:cmini-import" : owner,
    via,
    deleted: true,
  });
  return deleted.record;
}

function addDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

describe("[LDB-P8] restore within the 30-day window", () => {
  it("29d 23h after deletion -> 200, same name/payload/format, rev + 1, live by name", async () => {
    const tombstone = await seedTombstone();
    setNow(new Date(new Date(addDays(DELETED_AT, 29)).getTime() + 23 * 60 * 60 * 1000).toISOString());

    const headers = ownerHeaders(OWNER, `tok-${uniqueName("t")}`);
    const res = await writeFetch(`/v1/layouts/${tombstone.id}/restore`, "POST", headers);
    expect(res.status).toBe(200);
    const body = await res.json<{ deleted: boolean; name: string; payload: unknown; format: string; rev: number }>();
    expect(body.deleted).toBe(false);
    expect(body.name).toBe(tombstone.name);
    expect(body.payload).toEqual(tombstone.payload);
    expect(body.format).toBe(tombstone.format);
    expect(body.rev).toBe(tombstone.rev + 1);

    const byName = await writeFetch(`/v1/layouts/${encodeURIComponent(tombstone.name)}`, "GET");
    expect(byName.status).toBe(200);
  });
});

describe("[LDB-P8] restore past the 30-day window", () => {
  it("30d + 1s after deletion -> 404 for the owner", async () => {
    const tombstone = await seedTombstone();
    setNow(new Date(new Date(addDays(DELETED_AT, 30)).getTime() + 1000).toISOString());

    const headers = ownerHeaders(OWNER, `tok-${uniqueName("t")}`);
    const res = await writeFetch(`/v1/layouts/${tombstone.id}/restore`, "POST", headers);
    expect(res.status).toBe(404);
  });

  it("30d + 1s after deletion -> 200 for an admin", async () => {
    const tombstone = await seedTombstone();
    setNow(new Date(new Date(addDays(DELETED_AT, 30)).getTime() + 1000).toISOString());

    const headers = ownerHeaders("184412255822020608", `tok-${uniqueName("t")}`);
    const res = await writeFetch(`/v1/layouts/${tombstone.id}/restore`, "POST", headers);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ deleted: false });
  });
});

describe("[LDB-P8] restore edge cases", () => {
  it("restore of a live record -> 400", async () => {
    const { record } = await appendWrite(db, fixedClock(DELETED_AT), {
      kind: "created",
      name: uniqueName("live-not-deleted"),
      owner: OWNER,
      modified_at: DELETED_AT,
      format: "cmini/1",
      payload: CMINI_PAYLOAD,
      actor: OWNER,
      via: "discord",
      hasMagic: false,
    });
    setNow(DELETED_AT);
    const headers = ownerHeaders(OWNER, `tok-${uniqueName("t")}`);
    const res = await writeFetch(`/v1/layouts/${record.id}/restore`, "POST", headers);
    expect(res.status).toBe(400);
  });

  it("a live holder of the name meanwhile -> 409 name_taken with holder", async () => {
    const tombstone = await seedTombstone();
    const { record: holder } = await appendWrite(db, fixedClock(DELETED_AT), {
      kind: "created",
      name: tombstone.name, // freed by the delete; a new live record claims it
      owner: OTHER,
      modified_at: DELETED_AT,
      format: "cmini/1",
      payload: CMINI_PAYLOAD,
      actor: OTHER,
      via: "discord",
      hasMagic: false,
    });
    setNow(DELETED_AT);
    const headers = ownerHeaders(OWNER, `tok-${uniqueName("t")}`);
    const res = await writeFetch(`/v1/layouts/${tombstone.id}/restore`, "POST", headers);
    expect(res.status).toBe(409);
    const body = await res.json<{ error: string; holder: { id: string; owner: string } }>();
    expect(body.error).toBe("name_taken");
    expect(body.holder).toEqual({ id: holder.id, owner: holder.owner });
  });

  it("by name -> 404 (a tombstone has no live name)", async () => {
    const tombstone = await seedTombstone();
    setNow(DELETED_AT);
    const headers = ownerHeaders(OWNER, `tok-${uniqueName("t")}`);
    const res = await writeFetch(`/v1/layouts/${encodeURIComponent(tombstone.name)}/restore`, "POST", headers);
    expect(res.status).toBe(404);
  });

  it("[LDB-I2a] owner restores an upstream_deleted tombstone -> 200, no longer follows upstream", async () => {
    const tombstone = await seedTombstone(uniqueName("was-following"), OWNER, "import:cmini");
    setNow(DELETED_AT);
    const headers = ownerHeaders(OWNER, `tok-${uniqueName("t")}`);
    const res = await writeFetch(`/v1/layouts/${tombstone.id}/restore`, "POST", headers);
    expect(res.status).toBe(200);

    const { results } = await db
      .prepare("SELECT kind, via, rev FROM events WHERE layout_id = ? AND rev IS NOT NULL ORDER BY seq DESC LIMIT 1")
      .bind(tombstone.id)
      .all<{ kind: string; via: string; rev: number }>();
    expect(results[0]).toMatchObject({ kind: "restored", via: "discord" }); // LDB-I2a: latest rev-bumping event's via decides "follows upstream"
  });
});
