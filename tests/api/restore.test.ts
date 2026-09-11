// [LDB-P8] Restore (09 §3 T2, §6.7; 20-spark.md §1 decisions 8 and 9):
// owner or admin restores a tombstone AT ANY TIME (the 30-day owner
// window is gone -- tombstones were never pruned, so there is no storage
// pressure it was protecting against); a live record holding the name
// meanwhile is `409 name_taken`; by name is always `404` (a tombstone has
// no live name); by id on a live record is `400`; restoring an
// `upstream_deleted` tombstone as the owner stops it following upstream
// (LDB-I2a). The body is optional -- absent, `{}`, or `{name}` (a
// different name goes through `check_name`, LDB-N1 amended, and is
// recorded as `detail: {renamed_from}`) -- any other key is `400
// bad_request` (LDB-A7). The tombstone's payload/format carry forward
// verbatim (21-formats.md D12 deleted the legacy `storedAsSpark`
// conversion this used to run through -- every stored row is already
// spark/1).
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { appendWrite } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import type { Clock } from "../../src/core/time";
import { AKL_PAYLOAD, actorFixture, pinTestClock, register, uniqueName, writeFetch } from "./write-support";

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
      upstream: null,
    kind: via === "import:cmini" ? "imported" : "created",
    name,
    owner,
    modified_at: DELETED_AT,
    format: "spark/1",
    payload: AKL_PAYLOAD,
    actor: via === "import:cmini" ? "system:cmini-import" : owner,
    via,
    source: via === "import:cmini" ? { client: "system:cmini-import", version: null } : { client: "discord-app:test", version: null },
    hasMagic: false,
  });
  const deleted = await appendWrite(db, fixedClock(DELETED_AT), {
      upstream: null,
    kind: via === "import:cmini" ? "upstream_deleted" : "deleted",
    layoutId: created.record.id,
    name,
    owner,
    modified_at: DELETED_AT,
    format: "spark/1",
    payload: AKL_PAYLOAD,
    actor: via === "import:cmini" ? "system:cmini-import" : owner,
    via,
    source: via === "import:cmini" ? { client: "system:cmini-import", version: null } : { client: "discord-app:test", version: null },
    deleted: true,
  });
  return deleted.record;
}

function addDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

async function restore(id: string, headers: Record<string, string>, body?: unknown): Promise<Response> {
  return writeFetch(`/v1/layouts/${id}/restore`, "POST", body === undefined ? headers : { ...headers, "Content-Type": "application/json" }, body);
}

describe("[LDB-P8] restore has no time limit", () => {
  it("[LDB-P8] [LDB-F16] shortly after deletion -> 200, payload/format carried forward verbatim, rev + 1, live by name", async () => {
    const tombstone = await seedTombstone();
    setNow(new Date(new Date(addDays(DELETED_AT, 1)).getTime()).toISOString());

    const headers = ownerHeaders(OWNER, `tok-${uniqueName("t")}`);
    const res = await restore(tombstone.id, headers);
    expect(res.status).toBe(200);
    const body = await res.json<{ deleted: boolean; name: string; payload: { keys: unknown; board: unknown }; format: string; rev: number }>();
    expect(body.deleted).toBe(false);
    expect(body.name).toBe(tombstone.name);
    expect(body.format).toBe("spark/1"); // 21-formats.md D12: every stored row already is spark/1, no conversion
    expect(body.payload.keys).toEqual((tombstone.payload as { keys: unknown }).keys);
    expect(body.rev).toBe(tombstone.rev + 1);

    const byName = await writeFetch(`/v1/layouts/${encodeURIComponent(tombstone.name)}`, "GET");
    expect(byName.status).toBe(200);
  });

  // 20-spark.md §1 decision 8: restore has NO time limit for owner or
  // admin -- what was the 30-day owner boundary is now just "restore
  // works, arbitrarily long after deletion."
  it("[LDB-P8] 90 days after deletion -> still 200 for the owner (no window)", async () => {
    const tombstone = await seedTombstone();
    setNow(addDays(DELETED_AT, 90));

    const headers = ownerHeaders(OWNER, `tok-${uniqueName("t")}`);
    const res = await restore(tombstone.id, headers);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ deleted: false });
  });

  it("[LDB-P8] 90 days after deletion -> 200 for an admin too", async () => {
    const tombstone = await seedTombstone();
    setNow(addDays(DELETED_AT, 90));

    const headers = ownerHeaders("184412255822020608", `tok-${uniqueName("t")}`);
    const res = await restore(tombstone.id, headers);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ deleted: false });
  });
});

describe("[LDB-P8] restore edge cases", () => {
  it("restore of a live record -> 400", async () => {
    const { record } = await appendWrite(db, fixedClock(DELETED_AT), {
      upstream: null,
      kind: "created",
      name: uniqueName("live-not-deleted"),
      owner: OWNER,
      modified_at: DELETED_AT,
      format: "spark/1",
      payload: AKL_PAYLOAD,
      actor: OWNER,
      via: "discord",
      source: { client: "discord-app:test", version: null },
      hasMagic: false,
    });
    setNow(DELETED_AT);
    const headers = ownerHeaders(OWNER, `tok-${uniqueName("t")}`);
    const res = await restore(record.id, headers);
    expect(res.status).toBe(400);
  });

  it("a live holder of the name meanwhile, no {name} in the body -> 409 name_taken with holder", async () => {
    const tombstone = await seedTombstone();
    const { record: holder } = await appendWrite(db, fixedClock(DELETED_AT), {
      upstream: null,
      kind: "created",
      name: tombstone.name, // freed by the delete; a new live record claims it
      owner: OTHER,
      modified_at: DELETED_AT,
      format: "spark/1",
      payload: AKL_PAYLOAD,
      actor: OTHER,
      via: "discord",
      source: { client: "discord-app:test", version: null },
      hasMagic: false,
    });
    setNow(DELETED_AT);
    const headers = ownerHeaders(OWNER, `tok-${uniqueName("t")}`);
    const res = await restore(tombstone.id, headers);
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

  it("[LDB-I14] owner restores an upstream_deleted tombstone -> 200, no longer follows upstream", async () => {
    const tombstone = await seedTombstone(uniqueName("was-following"), OWNER, "import:cmini");
    setNow(DELETED_AT);
    const headers = ownerHeaders(OWNER, `tok-${uniqueName("t")}`);
    const res = await restore(tombstone.id, headers);
    expect(res.status).toBe(200);

    const { results } = await db
      .prepare("SELECT kind, via, rev FROM events WHERE layout_id = ? AND rev IS NOT NULL ORDER BY seq DESC LIMIT 1")
      .bind(tombstone.id)
      .all<{ kind: string; via: string; rev: number }>();
    expect(results[0]).toMatchObject({ kind: "restored", via: "discord" }); // LDB-I14: a user write (via !== import:cmini) always forks
  });
});

// 20-spark.md §1 decision 9 (refined §8 R-L1): the restore body itself.
describe("[LDB-P8] [LDB-N1] restore body: optional, {name} renames under check_name", () => {
  it("no body at all -> 200, restores under the tombstone's own name (the deployed site/bot send no body)", async () => {
    const tombstone = await seedTombstone();
    setNow(DELETED_AT);
    const headers = ownerHeaders(OWNER, `tok-${uniqueName("t")}`);
    const res = await writeFetch(`/v1/layouts/${tombstone.id}/restore`, "POST", headers); // no body, no Content-Type
    expect(res.status).toBe(200);
    const body = await res.json<{ name: string }>();
    expect(body.name).toBe(tombstone.name);
  });

  it("{} -> 200, same as no body", async () => {
    const tombstone = await seedTombstone();
    setNow(DELETED_AT);
    const headers = ownerHeaders(OWNER, `tok-${uniqueName("t")}`);
    const res = await restore(tombstone.id, headers, {});
    expect(res.status).toBe(200);
    const body = await res.json<{ name: string }>();
    expect(body.name).toBe(tombstone.name);
  });

  it("[LDB-N1] {name} naming a DIFFERENT free name -> 200, restores under it, detail.renamed_from", async () => {
    const tombstone = await seedTombstone();
    setNow(DELETED_AT);
    const headers = ownerHeaders(OWNER, `tok-${uniqueName("t")}`);
    const newName = uniqueName("restore-renamed");
    const res = await restore(tombstone.id, headers, { name: newName });
    expect(res.status).toBe(200);
    const body = await res.json<{ name: string }>();
    expect(body.name).toBe(newName);

    const { results } = await db
      .prepare("SELECT kind, name, detail_json FROM events WHERE layout_id = ? ORDER BY seq DESC LIMIT 1")
      .bind(tombstone.id)
      .all<{ kind: string; name: string; detail_json: string | null }>();
    expect(results[0]).toMatchObject({ kind: "restored", name: newName });
    expect(JSON.parse(results[0]!.detail_json!)).toEqual({ renamed_from: tombstone.name });
  });

  it("[LDB-N1] {name} naming the SAME name as the tombstone -> 200, no renamed_from (not a rename)", async () => {
    const tombstone = await seedTombstone();
    setNow(DELETED_AT);
    const headers = ownerHeaders(OWNER, `tok-${uniqueName("t")}`);
    const res = await restore(tombstone.id, headers, { name: tombstone.name });
    expect(res.status).toBe(200);

    const { results } = await db
      .prepare("SELECT detail_json FROM events WHERE layout_id = ? ORDER BY seq DESC LIMIT 1")
      .bind(tombstone.id)
      .all<{ detail_json: string | null }>();
    expect(results[0]?.detail_json).toBeNull();
  });

  it("[LDB-N1] {name} that fails check_name -> 400 invalid_name", async () => {
    const tombstone = await seedTombstone();
    setNow(DELETED_AT);
    const headers = ownerHeaders(OWNER, `tok-${uniqueName("t")}`);
    const res = await restore(tombstone.id, headers, { name: "_bad" });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_name" });
  });

  it("[LDB-N1] {name} naming a name a LIVE record already holds -> 409 name_taken with holder", async () => {
    const tombstone = await seedTombstone();
    const { record: holder } = await appendWrite(db, fixedClock(DELETED_AT), {
      upstream: null,
      kind: "created",
      name: uniqueName("restore-name-taken"),
      owner: OTHER,
      modified_at: DELETED_AT,
      format: "spark/1",
      payload: AKL_PAYLOAD,
      actor: OTHER,
      via: "discord",
      source: { client: "discord-app:test", version: null },
      hasMagic: false,
    });
    setNow(DELETED_AT);
    const headers = ownerHeaders(OWNER, `tok-${uniqueName("t")}`);
    const res = await restore(tombstone.id, headers, { name: holder.name });
    expect(res.status).toBe(409);
    const body = await res.json<{ error: string; holder: { id: string; owner: string } }>();
    expect(body.error).toBe("name_taken");
    expect(body.holder).toEqual({ id: holder.id, owner: holder.owner });
  });

  it("[LDB-A7] a body with an unknown key -> 400 bad_request", async () => {
    const tombstone = await seedTombstone();
    setNow(DELETED_AT);
    const headers = ownerHeaders(OWNER, `tok-${uniqueName("t")}`);
    const res = await restore(tombstone.id, headers, { color: "blue" });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "bad_request", param: "/color" });
  });
});
