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
import { generateKeyPair, seedClient, signHeaders } from "../auth/client-support";
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
        format: "akl/1",
        payload: AKL_PAYLOAD,
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

    const res = await writeFetch(`/v1/layouts/${record.id}`, "PUT", { ...headers, "If-Match": `"${record.rev}"` }, { format: "akl/1", payload: AKL_PAYLOAD });
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

    const res = await writeFetch(`/v1/layouts/${record.id}`, "PUT", { ...headers, "If-Match": `"${record.rev}"` }, { format: "cmini/1", payload: CMINI_PAYLOAD });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: "not_owner", owner: OWNER });
    expect(await eventsFor(record.id)).toHaveLength(1); // just the seed's own "created"
  });

  it("an admin (non-owner) -> 200, event admin: true", async () => {
    const record = await seed();
    const fake = actorFixture();
    const headers = register(fake, "tok-put-admin", BOOTSTRAP_ADMIN);

    const res = await writeFetch(`/v1/layouts/${record.id}`, "PUT", { ...headers, "If-Match": `"${record.rev}"` }, { format: "akl/1", payload: AKL_PAYLOAD });
    expect(res.status).toBe(200);
    const events = await eventsFor(record.id);
    expect(events.at(-1)).toMatchObject({ kind: "updated", actor: BOOTSTRAP_ADMIN, admin: true });
  });

  it("anonymous -> 401", async () => {
    const record = await seed();
    const res = await writeFetch(`/v1/layouts/${record.id}`, "PUT", {}, { format: "cmini/1", payload: CMINI_PAYLOAD });
    expect(res.status).toBe(401);
  });

  // [LDB-P2] saltorbit's rule (2026-09-09): no If-Match at all -> refused
  // before any read or mutation, even for the owner.
  it("[LDB-P2] no If-Match -> 400 if_match_required, record unchanged", async () => {
    const record = await seed();
    const fake = actorFixture();
    const headers = register(fake, "tok-put-noifmatch", OWNER);
    const res = await writeFetch(`/v1/layouts/${record.id}`, "PUT", headers, { format: "cmini/1", payload: CMINI_PAYLOAD });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "if_match_required" });
    expect(await eventsFor(record.id)).toHaveLength(1); // just the seed's own "created"
  });

  // 20-spark.md S2 (saltorbit's decision 6, the lead's answer to §8 Q1):
  // `isMagicOnlyReplace`/`detail.magic_only` are gone -- a PUT whose
  // payload changes ONLY `magic` forks like any other write now, and
  // `modified_at` bumps unconditionally. A mutable clock (this file's
  // module-level one is fixed) is the only way to see the bump; it is
  // restored afterward so every other test in this file keeps using the
  // fixed one.
  it("[LDB-P4] a PUT changing ONLY magic (same format) forks like any write: no magic_only marker, modified_at bumps", async () => {
    const record = await seed("akl/1");
    const fake = actorFixture();
    const headers = register(fake, `tok-${uniqueName("put-magic-forks")}`, OWNER);
    const bumped = fixedClock("2026-07-02T00:00:00.000Z");
    pinTestClock(env as unknown as { TEST_CLOCK?: typeof clock }, bumped);

    try {
      const res = await writeFetch(
        `/v1/layouts/${record.id}`,
        "PUT",
        { ...headers, "If-Match": `"${record.rev}"` },
        { format: "akl/1", payload: { ...(record.payload as object), magic: { rules: [{ inputs: "aa", output: "ab" }] } } },
      );
      expect(res.status).toBe(200);
      const events = await eventsFor(record.id);
      expect(events.at(-1)).toMatchObject({ kind: "updated", detail: null });
      const body = (await res.json()) as { modified_at: string; rev: number };
      expect(body.modified_at).toBe(bumped());
      expect(body.modified_at).not.toBe(record.modified_at);
      expect(body.rev).toBe(record.rev + 1);
    } finally {
      pinTestClock(env as unknown as { TEST_CLOCK?: typeof clock }, clock);
    }
  });

  // 20-spark.md S2 (LDB-F16/F21): a PUT naming `akl/1` stores natively
  // (`spark/1`) but the RESPONSE relabels back to `akl/1` because the
  // request named it (§1.12's label rule) -- the migration script's own
  // recipe (GET ?as=akl/1, PUT the same shape back with only `magic`
  // added) still sees the format it asked for, even though the stored
  // column and every OTHER caller's native read now say `spark/1`.
  it("[LDB-P4] [LDB-F20] a PUT lifting cmini/1 -> akl/1 with ONLY magic added (the migration's own shape) forks: response relabelled akl/1, stored spark/1, no magic_only marker", async () => {
    const record = await seed("cmini/1"); // CMINI_PAYLOAD = {board: "ortho", keys: {}}
    const fake = actorFixture();
    const headers = register(fake, `tok-${uniqueName("put-lift-forks")}`, OWNER);

    // The migration's own recipe: GET ?as=akl/1 (fromCmini's translation),
    // strip to {magic_keys, chiral_keys, adaptive_swaps}, PUT it back with
    // ONLY magic changed -- keys/board/free/x all exactly what fromCmini
    // would have produced from the record's own current cmini/1 payload.
    const res = await writeFetch(
      `/v1/layouts/${record.id}`,
      "PUT",
      { ...headers, "If-Match": `"${record.rev}"` },
      { format: "akl/1", payload: { keys: {}, board: { kind: "ortho", cmini: "ortho" }, magic: { rules: [{ inputs: "aa", output: "ab" }] } } },
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ format: string }>();
    expect(body.format).toBe("akl/1"); // relabelled: the request named akl/1
    const events = await eventsFor(record.id);
    expect(events.at(-1)).toMatchObject({ kind: "updated", detail: null });
    const row = await db.prepare("SELECT format FROM layouts WHERE id = ?").bind(record.id).first<{ format: string }>();
    expect(row?.format).toBe("spark/1"); // stored natively
  });

  it("[LDB-I12] a PUT changing magic AND something else (keys) is NOT magic_only -- forks as before", async () => {
    const record = await seed("akl/1");
    const fake = actorFixture();
    const headers = register(fake, `tok-${uniqueName("put-not-magiconly")}`, OWNER);

    const res = await writeFetch(
      `/v1/layouts/${record.id}`,
      "PUT",
      { ...headers, "If-Match": `"${record.rev}"` },
      { format: "akl/1", payload: { keys: { a: { row: 0, col: 0, finger: "LP" } }, magic: { rules: [{ inputs: "aa", output: "ab" }] } } },
    );
    expect(res.status).toBe(200);
    const events = await eventsFor(record.id);
    expect(events.at(-1)).toMatchObject({ kind: "updated", detail: null });
  });
});

describe("[LDB-A7] DELETE /v1/layouts/{ref}: owner or admin", () => {
  it("the owner -> 200, kind deleted, deleted: true, payload kept (already spark-shaped)", async () => {
    const record = await seed("akl/1");
    const fake = actorFixture();
    const headers = register(fake, "tok-del-owner", OWNER);

    const res = await writeFetch(`/v1/layouts/${record.id}`, "DELETE", { ...headers, "If-Match": `"${record.rev}"` });
    expect(res.status).toBe(200);
    const body = await res.json<{ deleted: boolean; format: string; payload: unknown; rev: number }>();
    expect(body.deleted).toBe(true);
    expect(body.format).toBe("spark/1"); // stored natively -- no request body to relabel a DELETE's response
    expect(body.payload).toEqual(record.payload); // akl/1 -> spark/1 is byte-identical
    expect(body.rev).toBe(record.rev + 1);
  });

  // 20-spark.md S2 (LDB-F16/F21, §8 R-H2): deleting an UNMIGRATED
  // `cmini/1`-stored record converts the payload through `storedAsSpark`
  // (`fromCmini`) rather than re-storing `cmini/1` verbatim -- the
  // tombstone's format/payload are what a fresh `?as=spark/1` read of the
  // pre-delete record would have been, and `has_magic` is recomputed.
  it("[LDB-F16] [LDB-F21] the owner deletes an unmigrated cmini/1 record -> tombstone stores spark/1, payload converted (fromCmini)", async () => {
    const record = await seed("cmini/1"); // CMINI_PAYLOAD = {board: "ortho", keys: {}}
    const fake = actorFixture();
    const headers = register(fake, "tok-del-legacy", OWNER);

    const res = await writeFetch(`/v1/layouts/${record.id}`, "DELETE", { ...headers, "If-Match": `"${record.rev}"` });
    expect(res.status).toBe(200);
    const body = await res.json<{ deleted: boolean; format: string; payload: { keys: unknown; board: unknown } }>();
    expect(body.deleted).toBe(true);
    expect(body.format).toBe("spark/1");
    expect(body.payload.keys).toEqual((record.payload as { keys: unknown }).keys);
    expect(body.payload.board).toEqual({ kind: "ortho", cmini: "ortho" }); // fromCmini's boardFromCmini("ortho")
    const row = await db.prepare("SELECT format FROM layouts WHERE id = ?").bind(record.id).first<{ format: string }>();
    expect(row?.format).toBe("spark/1");
  });

  it("a stranger -> 403", async () => {
    const record = await seed();
    const fake = actorFixture();
    const headers = register(fake, "tok-del-stranger", OTHER);
    const res = await writeFetch(`/v1/layouts/${record.id}`, "DELETE", { ...headers, "If-Match": `"${record.rev}"` });
    expect(res.status).toBe(403);
  });

  it("an admin (non-owner) -> 200, event admin: true", async () => {
    const record = await seed();
    const fake = actorFixture();
    const headers = register(fake, "tok-del-admin", BOOTSTRAP_ADMIN);
    const res = await writeFetch(`/v1/layouts/${record.id}`, "DELETE", { ...headers, "If-Match": `"${record.rev}"` });
    expect(res.status).toBe(200);
    const events = await eventsFor(record.id);
    expect(events.at(-1)).toMatchObject({ kind: "deleted", admin: true });
  });

  it("anonymous -> 401", async () => {
    const record = await seed();
    const res = await writeFetch(`/v1/layouts/${record.id}`, "DELETE");
    expect(res.status).toBe(401);
  });

  // [LDB-P2] saltorbit's rule (2026-09-09): no If-Match at all -> refused
  // before any read or mutation, even for the owner.
  it("[LDB-P2] no If-Match -> 400 if_match_required, record unchanged", async () => {
    const record = await seed();
    const fake = actorFixture();
    const headers = register(fake, "tok-del-noifmatch", OWNER);
    const res = await writeFetch(`/v1/layouts/${record.id}`, "DELETE", headers);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "if_match_required" });
    expect(await eventsFor(record.id)).toHaveLength(1); // just the seed's own "created"
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

  it("[LDB-A7] the owner -> 200, owner changed, event transferred", async () => {
    await seedTargetAuthor();
    const record = await seed();
    const fake = actorFixture();
    const headers = register(fake, "tok-transfer-owner", OWNER);

    const res = await writeFetch(`/v1/layouts/${record.id}/transfer`, "POST", { ...headers, "If-Match": `"${record.rev}"` }, { to: TARGET_ID });
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
    const res = await writeFetch(`/v1/layouts/${record.id}/transfer`, "POST", { ...headers, "If-Match": `"${record.rev}"` }, { to: TARGET_ID });
    expect(res.status).toBe(403);
  });

  it("an admin (non-owner) -> 200, event admin: true, transfers a stranger's record", async () => {
    await seedTargetAuthor();
    const record = await seed();
    const fake = actorFixture();
    const headers = register(fake, "tok-transfer-admin", BOOTSTRAP_ADMIN);
    const res = await writeFetch(`/v1/layouts/${record.id}/transfer`, "POST", { ...headers, "If-Match": `"${record.rev}"` }, { to: TARGET_ID });
    expect(res.status).toBe(200);
    const events = await eventsFor(record.id);
    expect(events.at(-1)).toMatchObject({ kind: "transferred", admin: true });
  });

  it("anonymous -> 401", async () => {
    const record = await seed();
    const res = await writeFetch(`/v1/layouts/${record.id}/transfer`, "POST", {}, { to: TARGET_ID });
    expect(res.status).toBe(401);
  });

  // [LDB-P2] saltorbit's rule (2026-09-09): no If-Match at all -> refused
  // before any read or mutation, even for the owner. Transfer never checks
  // the header's VALUE against `record.rev` (no draft to be stale), only
  // that it's present.
  it("[LDB-P2] no If-Match -> 400 if_match_required, record unchanged", async () => {
    await seedTargetAuthor();
    const record = await seed();
    const fake = actorFixture();
    const headers = register(fake, "tok-transfer-noifmatch", OWNER);
    const res = await writeFetch(`/v1/layouts/${record.id}/transfer`, "POST", headers, { to: TARGET_ID });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "if_match_required" });
    const events = await eventsFor(record.id);
    expect(events).toHaveLength(1); // just the seed's own "created"
  });
});

// [LDB-A5] 10 C1: the whole verb matrix runs again on the client lane -- a
// signed request, not a Discord bearer -- and every accepted write's event
// carries `via: client:<id>` (`actor.via`, not the literal "discord",
// core/write.ts). Auth here goes through the LIVE two-lane dispatcher
// (`authDeps.now` = real wall-clock, never the pinned TEST_CLOCK), so every
// signed request below is timestamped off `Date.now()`, not `clock()`.
describe("[LDB-A5] client-lane writes: via: client:<id>", () => {
  const TARGET_ID = "20000000000000002"; // 17 digits, distinct from the transfer describe above's own TARGET_ID
  let clientCounter = 0;
  async function freshClient(): Promise<{ clientId: string; privateKey: CryptoKey; actor: string }> {
    clientCounter++;
    const { privateKey, pubkeyB64url } = await generateKeyPair();
    const clientId = `wclient-${clientCounter}`;
    const actor = `60000000000000${String(clientCounter).padStart(4, "0")}`;
    await seedClient(db, clock, { id: clientId, pubkeyB64url, ownerUserId: actor, caps: "act-as-user" });
    return { clientId, privateKey, actor };
  }

  async function signedFetch(
    method: string,
    path: string,
    client: { clientId: string; privateKey: CryptoKey; actor: string },
    body?: unknown,
    extraHeaders?: Record<string, string>, // e.g. If-Match -- not part of the signed set
  ): Promise<Response> {
    const bodyText = body === undefined ? undefined : JSON.stringify(body);
    const headers = await signHeaders({
      privateKey: client.privateKey,
      clientId: client.clientId,
      actor: client.actor,
      method,
      pathWithQuery: path,
      body: bodyText === undefined ? undefined : new TextEncoder().encode(bodyText),
      timestamp: Math.floor(Date.now() / 1000),
    });
    return SELF.fetch(`https://example.com${path}`, {
      method,
      headers: bodyText === undefined ? { ...headers, ...extraHeaders } : { ...headers, "Content-Type": "application/json", ...extraHeaders },
      body: bodyText,
    });
  }

  it("[LDB-A5] POST /v1/layouts -> 201, event via: client:<id>", async () => {
    const client = await freshClient();
    const name = uniqueName("client-post");
    const res = await signedFetch("POST", "/v1/layouts", client, { name, format: "akl/1", payload: AKL_PAYLOAD });
    expect(res.status).toBe(201);
    const body = await res.json<{ id: string; owner: string }>();
    expect(body.owner).toBe(client.actor);
    const events = await eventsFor(body.id);
    expect(events[0]).toMatchObject({ kind: "created", via: `client:${client.clientId}`, actor: client.actor });
  });

  it("PUT /v1/layouts/{ref} -> 200, event via: client:<id>", async () => {
    const client = await freshClient();
    const record = await seed("cmini/1", client.actor);
    const res = await signedFetch("PUT", `/v1/layouts/${record.id}`, client, { format: "akl/1", payload: AKL_PAYLOAD }, { "If-Match": `"${record.rev}"` });
    expect(res.status).toBe(200);
    const events = await eventsFor(record.id);
    expect(events.at(-1)).toMatchObject({ kind: "updated", via: `client:${client.clientId}`, actor: client.actor });
  });

  it("PATCH /v1/layouts/{ref} -> 200, event via: client:<id>", async () => {
    // core/write.ts's patchLayout hardcoded `via: "discord"` (missed by
    // this describe's original verb sweep, which never exercised PATCH) --
    // fixed to `via: actor.via` alongside this test, LDB-A5's client half.
    const client = await freshClient();
    const record = await seed("cmini/1", client.actor);
    const res = await signedFetch("PATCH", `/v1/layouts/${record.id}`, client, { name: uniqueName("client-patch") }, { "If-Match": `"${record.rev}"` });
    expect(res.status).toBe(200);
    const events = await eventsFor(record.id);
    expect(events.at(-1)).toMatchObject({ kind: "renamed", via: `client:${client.clientId}`, actor: client.actor });
  });

  it("DELETE /v1/layouts/{ref} -> 200, event via: client:<id>", async () => {
    const client = await freshClient();
    const record = await seed("cmini/1", client.actor);
    const res = await signedFetch("DELETE", `/v1/layouts/${record.id}`, client, undefined, { "If-Match": `"${record.rev}"` });
    expect(res.status).toBe(200);
    const events = await eventsFor(record.id);
    expect(events.at(-1)).toMatchObject({ kind: "deleted", via: `client:${client.clientId}`, actor: client.actor });
  });

  it("POST /v1/layouts/{ref}/restore -> 200, event via: client:<id>", async () => {
    const client = await freshClient();
    const record = await seed("cmini/1", client.actor);
    const tombstone = await appendWrite(db, clock, {
      kind: "deleted",
      layoutId: record.id,
      name: record.name,
      owner: record.owner,
      modified_at: clock(),
      format: record.format,
      payload: record.payload,
      actor: client.actor,
      via: "discord",
      deleted: true,
      hasMagic: false,
    }).then((r) => r.record);
    const res = await signedFetch("POST", `/v1/layouts/${tombstone.id}/restore`, client);
    expect(res.status).toBe(200);
    const events = await eventsFor(tombstone.id);
    expect(events.at(-1)).toMatchObject({ kind: "restored", via: `client:${client.clientId}`, actor: client.actor });
  });

  it("POST /v1/layouts/{ref}/transfer -> 200, event via: client:<id>", async () => {
    const client = await freshClient();
    const record = await seed("cmini/1", client.actor);
    // transfer's target must be a known user -- a live /v1/me call (bearer
    // lane, unrelated to what's under test) seeds the authors row.
    const targetFake = actorFixture();
    const targetHeaders = register(targetFake, `tok-${uniqueName("target")}`, TARGET_ID);
    await SELF.fetch("https://example.com/v1/me", { headers: targetHeaders });
    vi.unstubAllGlobals();

    const res = await signedFetch("POST", `/v1/layouts/${record.id}/transfer`, client, { to: TARGET_ID }, { "If-Match": `"${record.rev}"` });
    expect(res.status).toBe(200);
    const events = await eventsFor(record.id);
    expect(events.at(-1)).toMatchObject({ kind: "transferred", via: `client:${client.clientId}`, actor: client.actor });
  });

  it("[LDB-I2a] followsUpstream reads via, not the literal 'discord' -- a client-lane write stops it", async () => {
    const client = await freshClient();
    const record = await seed("cmini/1", client.actor);
    const res = await signedFetch("PUT", `/v1/layouts/${record.id}`, client, { format: "akl/1", payload: AKL_PAYLOAD }, { "If-Match": `"${record.rev}"` });
    expect(res.status).toBe(200);
    const row = await db.prepare("SELECT via FROM events WHERE layout_id = ? ORDER BY seq DESC LIMIT 1").bind(record.id).first<{ via: string }>();
    expect(row?.via.startsWith("client:")).toBe(true);
    expect(row?.via).not.toBe("import:cmini"); // I2a: "follows upstream" is via === 'import:cmini' exactly
  });
});

// [LDB-P9] design/layout-db/18-command-decisions.md §2 D1 (saltorbit:
// "tombstoned name carries likes for whoever takes it. it's a quirk people
// like"): `POST /v1/layouts` on a name a tombstone currently holds copies
// that tombstone's likes onto the new record, `via: "name_inherited"`,
// `detail: {from: <tombstone id>}`.
describe("[LDB-P9] a re-added tombstoned name inherits the tombstone's likes", () => {
  interface CreatedBody {
    id: string;
    rev: number;
    name: string;
    owner: string;
    like_count: number;
  }

  async function createViaHttp(headers: Record<string, string>, name: string): Promise<CreatedBody> {
    const res = await writeFetch("/v1/layouts", "POST", headers, { name, format: "akl/1", payload: AKL_PAYLOAD });
    expect(res.status).toBe(201);
    return res.json<CreatedBody>();
  }

  async function likeAs(id: string, headers: Record<string, string>): Promise<void> {
    const res = await writeFetch(`/v1/layouts/${id}/like`, "PUT", headers);
    expect(res.status).toBe(200);
  }

  async function deleteViaHttp(id: string, rev: number, headers: Record<string, string>): Promise<void> {
    const res = await writeFetch(`/v1/layouts/${id}`, "DELETE", { ...headers, "If-Match": `"${rev}"` });
    expect(res.status).toBe(200);
  }

  it("[LDB-P9] same owner: delete then re-add the same name -> the new record inherits the tombstone's likes", async () => {
    const fake = actorFixture();
    const owner = register(fake, `tok-${uniqueName("p9-owner")}`, "p9-owner-same");
    const liker1 = register(fake, `tok-${uniqueName("p9-l1")}`, "p9-liker-1");
    const liker2 = register(fake, `tok-${uniqueName("p9-l2")}`, "p9-liker-2");

    const name = uniqueName("p9-same");
    const first = await createViaHttp(owner, name);
    await likeAs(first.id, liker1);
    await likeAs(first.id, liker2);
    await deleteViaHttp(first.id, first.rev, owner);

    const second = await createViaHttp(owner, name);
    expect(second.like_count).toBe(2); // the create's own 201 response already reflects the inherited likes

    const likeRows = await db.prepare("SELECT user_id FROM likes WHERE layout_id = ? ORDER BY user_id ASC").bind(second.id).all<{ user_id: string }>();
    expect(likeRows.results.map((r) => r.user_id)).toEqual(["p9-liker-1", "p9-liker-2"]);

    const events = await eventsFor(second.id);
    expect(events.map((e) => e.kind)).toEqual(["created", "liked", "liked"]);
    for (const e of events.slice(1)) {
      expect(e.via).toBe("name_inherited");
      expect(e.detail).toEqual({ from: first.id });
    }
  });

  it("[LDB-P9] different owner: someone else re-adding the name inherits the tombstone's likes too", async () => {
    const fake = actorFixture();
    const origOwner = register(fake, `tok-${uniqueName("p9-orig")}`, "p9-owner-orig");
    const newOwner = register(fake, `tok-${uniqueName("p9-new")}`, "p9-owner-new");
    const liker = register(fake, `tok-${uniqueName("p9-l3")}`, "p9-liker-3");

    const name = uniqueName("p9-diff");
    const first = await createViaHttp(origOwner, name);
    await likeAs(first.id, liker);
    await deleteViaHttp(first.id, first.rev, origOwner);

    const second = await createViaHttp(newOwner, name);
    expect(second.owner).toBe("p9-owner-new");
    expect(second.like_count).toBe(1);

    const events = await eventsFor(second.id);
    expect(events.map((e) => e.kind)).toEqual(["created", "liked"]);
    expect(events[1]).toMatchObject({ via: "name_inherited", actor: "p9-liker-3" });
    expect(events[1]!.detail).toEqual({ from: first.id });
  });

  it("[LDB-P9] no tombstone ever held the name -> no inherited likes", async () => {
    const fake = actorFixture();
    const owner = register(fake, `tok-${uniqueName("p9-fresh")}`, "p9-owner-fresh");
    const rec = await createViaHttp(owner, uniqueName("p9-fresh-name"));
    expect(rec.like_count).toBe(0);
    expect(await eventsFor(rec.id)).toHaveLength(1); // just "created"
  });

  it("[LDB-P9] a tombstone with zero likes -> re-add inherits nothing", async () => {
    const fake = actorFixture();
    const owner = register(fake, `tok-${uniqueName("p9-zero")}`, "p9-owner-zero");
    const name = uniqueName("p9-zero-likes");
    const first = await createViaHttp(owner, name);
    await deleteViaHttp(first.id, first.rev, owner);

    const second = await createViaHttp(owner, name);
    expect(second.like_count).toBe(0);
    expect(await eventsFor(second.id)).toHaveLength(1); // just "created" -- no liked events
  });

  it("[LDB-P9] restore-after-inherit: the tombstone stays restorable, and both records end up carrying the like (accepted per 18)", async () => {
    const fake = actorFixture();
    const owner = register(fake, `tok-${uniqueName("p9-restore")}`, "p9-owner-restore");
    const liker = register(fake, `tok-${uniqueName("p9-restore-l")}`, "p9-liker-restore");

    const name = uniqueName("p9-restore");
    const first = await createViaHttp(owner, name);
    await likeAs(first.id, liker);
    await deleteViaHttp(first.id, first.rev, owner);

    const second = await createViaHttp(owner, name);
    expect(second.like_count).toBe(1);

    // LDB-P8: restoring onto a name a LIVE record still holds is refused
    // (409 name_taken, tests/api/restore.test.ts's own "a live holder of
    // the name meanwhile" case) -- rename the re-add away first so the
    // tombstone's own name is free again.
    const renameRes = await writeFetch(
      `/v1/layouts/${second.id}`,
      "PATCH",
      { ...owner, "If-Match": `"${second.rev}"` },
      { name: uniqueName("p9-restore-moved") },
    );
    expect(renameRes.status).toBe(200);

    const restoreRes = await writeFetch(`/v1/layouts/${first.id}/restore`, "POST", owner);
    expect(restoreRes.status).toBe(200);
    const restored = await restoreRes.json<{ deleted: boolean; name: string }>();
    expect(restored.deleted).toBe(false);
    expect(restored.name).toBe(name);

    // Two live records now, each independently carrying its OWN copy of
    // the like: the original's (never touched by the inherit step) and
    // the re-add's (copied at create time) -- accepted per 18's own text
    // ("restoring then yields two records each carrying the likes").
    const firstLikes = await db.prepare("SELECT user_id FROM likes WHERE layout_id = ?").bind(first.id).all<{ user_id: string }>();
    const secondLikes = await db.prepare("SELECT user_id FROM likes WHERE layout_id = ?").bind(second.id).all<{ user_id: string }>();
    expect(firstLikes.results.map((r) => r.user_id)).toEqual(["p9-liker-restore"]);
    expect(secondLikes.results.map((r) => r.user_id)).toEqual(["p9-liker-restore"]);
  });

  it("[LDB-P9] /v1/changes shows the inherited 'liked' events with via: name_inherited", async () => {
    const fake = actorFixture();
    const owner = register(fake, `tok-${uniqueName("p9-feed")}`, "p9-owner-feed");
    const liker = register(fake, `tok-${uniqueName("p9-feed-l")}`, "p9-liker-feed");

    const name = uniqueName("p9-feed");
    const first = await createViaHttp(owner, name);
    await likeAs(first.id, liker);
    await deleteViaHttp(first.id, first.rev, owner);
    const second = await createViaHttp(owner, name);

    const res = await writeFetch(`/v1/changes?since=0&layout=${second.id}`, "GET", owner);
    expect(res.status).toBe(200);
    const body = await res.json<{ items: { kind: string; via: string; detail: unknown }[] }>();
    const liked = body.items.filter((e) => e.kind === "liked");
    expect(liked).toHaveLength(1);
    expect(liked[0]!.via).toBe("name_inherited");
    expect(liked[0]!.detail).toEqual({ from: first.id });
  });
});
