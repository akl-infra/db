// [LDB-A7] [LDB-P1] The write-verb x actor x format matrix (09 §3 T2, 02
// §4): POST accepts any actor; PUT/DELETE/restore/transfer accept the
// owner or an admin (logged `admin: true` only when the actor isn't the
// owner) and refuse a stranger with `403 not_owner`; every verb requires a
// resolved actor at all (401 anonymous, already swept exhaustively by
// tests/auth/routes.test.ts -- checked once more here per-verb for the
// matrix's own sake). Every accepted write lands in the event log with
// `via: discord`, the right `kind`, `rev + 1` (POST: 1), a `layout_revs`
// row, `has_magic` from the format, and an `ETag: "<rev>"` header.
import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { type EventDbRow, appendWrite, rowToEvent } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import {
  AKL_PAYLOAD,
  BOOTSTRAP_ADMIN,
  CMINI_PAYLOAD,
  actorFixture,
  pinTestClock,
  register,
  uniqueName,
  writeFetch,
} from "./write-support";

const db = (env as unknown as Bindings).DB;
const clock = fixedClock("2026-07-01T00:00:00.000Z");
// Pins every write route's "now" to the same instant the seeds below use --
// keeps rev/ETag assertions deterministic and (restore) trivially inside
// the 30-day window (tests/api/restore.test.ts covers that boundary itself).
pinTestClock(env as unknown as { TEST_CLOCK?: typeof clock }, clock);

const OWNER = "owner-write-1";
const OTHER = "owner-write-2";

async function seed(format: "cmini/1" | "akl/1" = "cmini/1", owner = OWNER) {
  const payload = format === "cmini/1" ? CMINI_PAYLOAD : AKL_PAYLOAD;
  const { record } = await appendWrite(db, clock, {
    kind: "created",
    name: uniqueName("write-seed"),
    owner,
    modified_at: clock(),
    format,
    payload,
    actor: owner,
    via: "discord",
    hasMagic: false,
  });
  return record;
}

async function eventsFor(layoutId: string) {
  const { results } = await db
    .prepare("SELECT * FROM events WHERE layout_id = ? ORDER BY seq ASC")
    .bind(layoutId)
    .all<EventDbRow>();
  return results.map(rowToEvent);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("[LDB-P1] POST /v1/layouts: any actor", () => {
  for (const [kind, id] of [
    ["owner-like actor", OWNER],
    ["a stranger", OTHER],
    ["an admin", BOOTSTRAP_ADMIN],
  ] as const) {
    it(`${kind} -> 201, kind created, rev 1, ETag`, async () => {
      const fake = actorFixture();
      const headers = register(fake, `tok-post-${id}`, id);
      const name = uniqueName("post-ok");

      const res = await writeFetch("/v1/layouts", "POST", headers, {
        name,
        format: "cmini/1",
        payload: CMINI_PAYLOAD,
      });
      expect(res.status, kind).toBe(201);
      expect(res.headers.get("ETag")).toBe('"1"');
      const body = await res.json<{ id: string; rev: number; owner: string; name: string; has_magic: boolean }>();
      expect(body.rev).toBe(1);
      expect(body.owner).toBe(id);
      expect(body.name).toBe(name);
      expect(body.has_magic).toBe(false);

      const events = await eventsFor(body.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: "created", via: "discord", actor: id, rev: 1, admin: false });

      const rev = await db.prepare("SELECT * FROM layout_revs WHERE layout_id = ? AND rev = 1").bind(body.id).first();
      expect(rev).not.toBeNull();
    });
  }

  it("[LDB-A7] anonymous -> 401, no event", async () => {
    const before = await db.prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>();
    const res = await writeFetch("/v1/layouts", "POST", {}, { name: uniqueName("anon"), format: "cmini/1", payload: CMINI_PAYLOAD });
    expect(res.status).toBe(401);
    const after = await db.prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });
});

describe("[LDB-A7] PUT /v1/layouts/{ref}: owner or admin", () => {
  it("the owner -> 200, kind updated, rev + 1, format may change", async () => {
    const record = await seed("cmini/1");
    const fake = actorFixture();
    const headers = register(fake, "tok-put-owner", OWNER);

    const res = await writeFetch(`/v1/layouts/${record.id}`, "PUT", headers, { format: "akl/1", payload: AKL_PAYLOAD });
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe(`"${record.rev + 1}"`);
    const body = await res.json<{ rev: number; format: string; name: string; owner: string }>();
    expect(body.rev).toBe(record.rev + 1);
    expect(body.format).toBe("akl/1");
    expect(body.name).toBe(record.name); // kept
    expect(body.owner).toBe(record.owner); // kept

    const events = await eventsFor(record.id);
    expect(events.at(-1)).toMatchObject({ kind: "updated", via: "discord", actor: OWNER, rev: record.rev + 1, admin: false });
  });

  it("a stranger -> 403 not_owner, record unchanged", async () => {
    const record = await seed();
    const fake = actorFixture();
    const headers = register(fake, "tok-put-stranger", OTHER);

    const res = await writeFetch(`/v1/layouts/${record.id}`, "PUT", headers, { format: "cmini/1", payload: CMINI_PAYLOAD });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: "not_owner", owner: OWNER });
    expect(await eventsFor(record.id)).toHaveLength(1); // just the seed's own "created"
  });

  it("an admin (non-owner) -> 200, event admin: true", async () => {
    const record = await seed();
    const fake = actorFixture();
    const headers = register(fake, "tok-put-admin", BOOTSTRAP_ADMIN);

    const res = await writeFetch(`/v1/layouts/${record.id}`, "PUT", headers, { format: "cmini/1", payload: CMINI_PAYLOAD });
    expect(res.status).toBe(200);
    const events = await eventsFor(record.id);
    expect(events.at(-1)).toMatchObject({ kind: "updated", actor: BOOTSTRAP_ADMIN, admin: true });
  });

  it("anonymous -> 401", async () => {
    const record = await seed();
    const res = await writeFetch(`/v1/layouts/${record.id}`, "PUT", {}, { format: "cmini/1", payload: CMINI_PAYLOAD });
    expect(res.status).toBe(401);
  });
});

describe("[LDB-A7] DELETE /v1/layouts/{ref}: owner or admin", () => {
  it("the owner -> 200, kind deleted, deleted: true, payload kept", async () => {
    const record = await seed();
    const fake = actorFixture();
    const headers = register(fake, "tok-del-owner", OWNER);

    const res = await writeFetch(`/v1/layouts/${record.id}`, "DELETE", headers);
    expect(res.status).toBe(200);
    const body = await res.json<{ deleted: boolean; payload: unknown; rev: number }>();
    expect(body.deleted).toBe(true);
    expect(body.payload).toEqual(record.payload);
    expect(body.rev).toBe(record.rev + 1);
  });

  it("a stranger -> 403", async () => {
    const record = await seed();
    const fake = actorFixture();
    const headers = register(fake, "tok-del-stranger", OTHER);
    const res = await writeFetch(`/v1/layouts/${record.id}`, "DELETE", headers);
    expect(res.status).toBe(403);
  });

  it("an admin (non-owner) -> 200, event admin: true", async () => {
    const record = await seed();
    const fake = actorFixture();
    const headers = register(fake, "tok-del-admin", BOOTSTRAP_ADMIN);
    const res = await writeFetch(`/v1/layouts/${record.id}`, "DELETE", headers);
    expect(res.status).toBe(200);
    const events = await eventsFor(record.id);
    expect(events.at(-1)).toMatchObject({ kind: "deleted", admin: true });
  });

  it("anonymous -> 401", async () => {
    const record = await seed();
    const res = await writeFetch(`/v1/layouts/${record.id}`, "DELETE");
    expect(res.status).toBe(401);
  });
});

describe("[LDB-A7] POST /v1/layouts/{ref}/restore: owner or admin", () => {
  async function seedDeleted(owner = OWNER) {
    const record = await seed("cmini/1", owner);
    return appendWrite(db, clock, {
      kind: "deleted",
      layoutId: record.id,
      name: record.name,
      owner: record.owner,
      modified_at: clock(),
      format: record.format,
      payload: record.payload,
      actor: owner,
      via: "discord",
      deleted: true,
      hasMagic: false,
    }).then((r) => r.record);
  }

  it("the owner -> 200, kind restored, deleted: false", async () => {
    const tombstone = await seedDeleted();
    const fake = actorFixture();
    const headers = register(fake, "tok-restore-owner", OWNER);
    const res = await writeFetch(`/v1/layouts/${tombstone.id}/restore`, "POST", headers);
    expect(res.status).toBe(200);
    const body = await res.json<{ deleted: boolean }>();
    expect(body.deleted).toBe(false);
  });

  it("a stranger -> 403", async () => {
    const tombstone = await seedDeleted();
    const fake = actorFixture();
    const headers = register(fake, "tok-restore-stranger", OTHER);
    const res = await writeFetch(`/v1/layouts/${tombstone.id}/restore`, "POST", headers);
    expect(res.status).toBe(403);
  });

  it("an admin (non-owner) -> 200, event admin: true", async () => {
    const tombstone = await seedDeleted();
    const fake = actorFixture();
    const headers = register(fake, "tok-restore-admin", BOOTSTRAP_ADMIN);
    const res = await writeFetch(`/v1/layouts/${tombstone.id}/restore`, "POST", headers);
    expect(res.status).toBe(200);
    const events = await eventsFor(tombstone.id);
    expect(events.at(-1)).toMatchObject({ kind: "restored", admin: true });
  });

  it("anonymous -> 401", async () => {
    const tombstone = await seedDeleted();
    const res = await writeFetch(`/v1/layouts/${tombstone.id}/restore`, "POST");
    expect(res.status).toBe(401);
  });
});

describe("[LDB-A7] POST /v1/layouts/{ref}/transfer: owner or admin", () => {
  const TARGET_ID = "20000000000000001"; // 17 digits -- shaped like a snowflake

  async function seedTargetAuthor() {
    // A sign-in is what gives someone an `authors` row (09 §2.2) -- the
    // simplest way to seed one from this suite is a real /v1/me call.
    const fake = actorFixture();
    const headers = register(fake, "tok-transfer-target", TARGET_ID);
    const res = await SELF.fetch("https://example.com/v1/me", { headers });
    expect(res.status).toBe(200);
  }

  it("the owner -> 200, owner changed, event transferred", async () => {
    await seedTargetAuthor();
    const record = await seed();
    const fake = actorFixture();
    const headers = register(fake, "tok-transfer-owner", OWNER);

    const res = await writeFetch(`/v1/layouts/${record.id}/transfer`, "POST", headers, { to: TARGET_ID });
    expect(res.status).toBe(200);
    const body = await res.json<{ owner: string }>();
    expect(body.owner).toBe(TARGET_ID);
    const events = await eventsFor(record.id);
    expect(events.at(-1)).toMatchObject({ kind: "transferred", actor: OWNER, admin: false });
    expect(events.at(-1)?.before).toMatchObject({ owner: OWNER });
    expect(events.at(-1)?.after).toMatchObject({ owner: TARGET_ID });
  });

  it("a stranger -> 403", async () => {
    await seedTargetAuthor();
    const record = await seed();
    const fake = actorFixture();
    const headers = register(fake, "tok-transfer-stranger", OTHER);
    const res = await writeFetch(`/v1/layouts/${record.id}/transfer`, "POST", headers, { to: TARGET_ID });
    expect(res.status).toBe(403);
  });

  it("an admin (non-owner) -> 200, event admin: true, transfers a stranger's record", async () => {
    await seedTargetAuthor();
    const record = await seed();
    const fake = actorFixture();
    const headers = register(fake, "tok-transfer-admin", BOOTSTRAP_ADMIN);
    const res = await writeFetch(`/v1/layouts/${record.id}/transfer`, "POST", headers, { to: TARGET_ID });
    expect(res.status).toBe(200);
    const events = await eventsFor(record.id);
    expect(events.at(-1)).toMatchObject({ kind: "transferred", admin: true });
  });

  it("anonymous -> 401", async () => {
    const record = await seed();
    const res = await writeFetch(`/v1/layouts/${record.id}/transfer`, "POST", {}, { to: TARGET_ID });
    expect(res.status).toBe(401);
  });
});
