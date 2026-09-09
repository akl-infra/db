// [LDB-P1] [LDB-N1] [LDB-P7] PATCH /v1/layouts/{ref} (09 §2.6, §3 T4): one
// or more of {name, fingermap, board, magic}, applied in that order to a
// clone of the payload via the record's format `edits`, validated once as
// a whole, one event -- `renamed`/`fingermap` for exactly that one field,
// `updated` with `detail.fields` otherwise. `If-Match` as PUT/DELETE
// (tests/api/ifmatch.test.ts already sweeps that matrix generically; this
// file only re-checks stale and -- [LDB-P2], 2026-09-09 -- absent for PATCH
// itself). A verb the record's format has no `edits` entry for is `400
// unsupported_for_format`.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { type EventDbRow, appendWrite, rowToEvent } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import { BOOTSTRAP_ADMIN, actorFixture, pinTestClock, register, uniqueName, writeFetch } from "./write-support";

const db = (env as unknown as Bindings).DB;
const clock = fixedClock("2026-07-10T00:00:00.000Z");
pinTestClock(env as unknown as { TEST_CLOCK?: typeof clock }, clock);

const OWNER = "owner-patch-1";
const OTHER = "owner-patch-2";

// Both formats seeded with one real key ("a") -- PATCH's fingermap tests
// need a char to name; write-support.ts's own CMINI_PAYLOAD/AKL_PAYLOAD are
// deliberately keyless (they exist for tests that don't care).
const CMINI_KEYED = { board: "ortho" as const, keys: { a: { row: 0, col: 0, finger: "LP" } } };
const AKL_KEYED = { keys: { a: { row: 0, col: 0, finger: "LP" } } };

async function seed(format: "cmini/1" | "akl/1", owner = OWNER) {
  const payload = format === "cmini/1" ? CMINI_KEYED : AKL_KEYED;
  const { record } = await appendWrite(db, clock, {
    kind: "created",
    name: uniqueName("patch-seed"),
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
  const { results } = await db.prepare("SELECT * FROM events WHERE layout_id = ? ORDER BY seq ASC").bind(layoutId).all<EventDbRow>();
  return results.map(rowToEvent);
}

function ownerHeaders(token: string) {
  const fake = actorFixture();
  return register(fake, token, OWNER);
}

function patch(id: string, headers: Record<string, string>, body: unknown, ifMatch?: string) {
  return writeFetch(`/v1/layouts/${id}`, "PATCH", ifMatch !== undefined ? { ...headers, "If-Match": ifMatch } : headers, body);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("[LDB-P1] PATCH verb x format matrix", () => {
  for (const format of ["cmini/1", "akl/1"] as const) {
    describe(format, () => {
      it("name alone -> 200, kind renamed, rev + 1", async () => {
        const record = await seed(format);
        const headers = ownerHeaders(`tok-${uniqueName("name")}`);
        const newName = uniqueName("patch-renamed");
        const res = await patch(record.id, headers, { name: newName }, `"${record.rev}"`);
        expect(res.status).toBe(200);
        expect(res.headers.get("ETag")).toBe(`"${record.rev + 1}"`);
        const body = await res.json<{ name: string; rev: number }>();
        expect(body.name).toBe(newName);
        expect(body.rev).toBe(record.rev + 1);
        const events = await eventsFor(record.id);
        expect(events.at(-1)).toMatchObject({ kind: "renamed", actor: OWNER, admin: false, detail: null });
      });

      it("fingermap alone -> 200, kind fingermap, rev + 1, only the named char changes", async () => {
        const record = await seed(format);
        const headers = ownerHeaders(`tok-${uniqueName("fm")}`);
        const res = await patch(record.id, headers, { fingermap: { a: "RP" } }, `"${record.rev}"`);
        expect(res.status).toBe(200);
        const body = await res.json<{ rev: number; payload: { keys: Record<string, { finger: string }> } }>();
        expect(body.rev).toBe(record.rev + 1);
        expect(body.payload.keys.a?.finger).toBe("RP");
        const events = await eventsFor(record.id);
        expect(events.at(-1)).toMatchObject({ kind: "fingermap", actor: OWNER, admin: false, detail: null });
      });

      it("a fingermap naming a char not in keys -> 400 invalid_payload", async () => {
        const record = await seed(format);
        const headers = ownerHeaders(`tok-${uniqueName("fm-bad")}`);
        const res = await patch(record.id, headers, { fingermap: { z: "RP" } }, `"${record.rev}"`);
        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toMatchObject({ error: "invalid_payload", path: "/keys/z" });
      });

      it("board alone -> 200, kind updated, detail.fields = ['board']", async () => {
        const record = await seed(format);
        const headers = ownerHeaders(`tok-${uniqueName("board")}`);
        const board = { kind: "rowstag", stagger: [0, 0.25, 0.75], cmini: "stagger" };
        const res = await patch(record.id, headers, { board }, `"${record.rev}"`);
        expect(res.status).toBe(200);
        const events = await eventsFor(record.id);
        expect(events.at(-1)).toMatchObject({ kind: "updated", detail: { fields: ["board"] } });
        const body = await res.json<{ payload: { board: unknown } }>();
        expect(body.payload.board).toEqual(format === "akl/1" ? board : "stagger");
      });

      it("{} -> 400 bad_request", async () => {
        const record = await seed(format);
        const headers = ownerHeaders(`tok-${uniqueName("empty")}`);
        const res = await patch(record.id, headers, {});
        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toMatchObject({ error: "bad_request" });
      });

      it("an unknown key -> 400 bad_request", async () => {
        const record = await seed(format);
        const headers = ownerHeaders(`tok-${uniqueName("unk")}`);
        const res = await patch(record.id, headers, { color: "blue" });
        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toMatchObject({ error: "bad_request", param: "/color" });
      });

      it("If-Match stale -> 409", async () => {
        const record = await seed(format);
        const headers = ownerHeaders(`tok-${uniqueName("stale")}`);
        const res = await patch(record.id, headers, { fingermap: { a: "RP" } }, `"${record.rev + 5}"`);
        expect(res.status).toBe(409);
        await expect(res.json()).resolves.toMatchObject({ error: "stale" });
      });

      it("a stranger -> 403, an admin (non-owner) -> 200 admin: true, anonymous -> 401", async () => {
        const stranger = await seed(format);
        const strangerRes = await patch(stranger.id, register(actorFixture(), `tok-${uniqueName("s")}`, OTHER), { fingermap: { a: "RP" } }, `"${stranger.rev}"`);
        expect(strangerRes.status).toBe(403);

        const forAdmin = await seed(format);
        const adminRes = await patch(
          forAdmin.id,
          register(actorFixture(), `tok-${uniqueName("a")}`, BOOTSTRAP_ADMIN),
          { fingermap: { a: "RP" } },
          `"${forAdmin.rev}"`,
        );
        expect(adminRes.status).toBe(200);
        const events = await eventsFor(forAdmin.id);
        expect(events.at(-1)).toMatchObject({ admin: true });

        const anon = await seed(format);
        const anonRes = await patch(anon.id, {}, { fingermap: { a: "RP" } });
        expect(anonRes.status).toBe(401);
      });

      // [LDB-P2] saltorbit's rule (2026-09-09): no If-Match at all -> refused
      // before any read or mutation, even for the owner.
      it("no If-Match -> 400 if_match_required, record unchanged", async () => {
        const record = await seed(format);
        const headers = ownerHeaders(`tok-${uniqueName("noifmatch")}`);
        const res = await patch(record.id, headers, { fingermap: { a: "RP" } });
        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toMatchObject({ error: "if_match_required" });
        expect(await eventsFor(record.id)).toHaveLength(1); // just the seed's own "created"
      });
    });
  }

  it("[LDB-P4] magic on akl/1 -> 200, kind updated", async () => {
    const record = await seed("akl/1");
    const headers = ownerHeaders(`tok-${uniqueName("magic")}`);
    const res = await patch(record.id, headers, { magic: { rules: [{ inputs: "aa", output: "ab" }] } }, `"${record.rev}"`);
    expect(res.status).toBe(200);
    const events = await eventsFor(record.id);
    expect(events.at(-1)).toMatchObject({ kind: "updated", detail: { fields: ["magic"] } });
    const body = await res.json<{ payload: { magic: { rules: unknown[] } } }>();
    expect(body.payload.magic.rules).toHaveLength(1);
  });

  it("magic on cmini/1 -> 400 unsupported_for_format", async () => {
    const record = await seed("cmini/1");
    const headers = ownerHeaders(`tok-${uniqueName("magic-cmini")}`);
    const res = await patch(record.id, headers, { magic: { rules: [{ inputs: "aa", output: "ab" }] } }, `"${record.rev}"`);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "unsupported_for_format", format: "cmini/1", verb: "magic" });
    // nothing applied -- rev unchanged
    const row = await db.prepare("SELECT rev FROM layouts WHERE id = ?").bind(record.id).first<{ rev: number }>();
    expect(row?.rev).toBe(record.rev);
  });

  it("a hint-less colstag board on cmini/1 -> 400 unsupported_for_format", async () => {
    const record = await seed("cmini/1");
    const headers = ownerHeaders(`tok-${uniqueName("colstag")}`);
    const res = await patch(record.id, headers, { board: { kind: "colstag", stagger: [0] } }, `"${record.rev}"`);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "unsupported_for_format", format: "cmini/1", verb: "board" });
  });
});

describe("[LDB-P1] combined patches", () => {
  it("{name, fingermap} -> one event 'updated', detail.fields = ['name','fingermap']", async () => {
    const record = await seed("cmini/1");
    const headers = ownerHeaders(`tok-${uniqueName("combo")}`);
    const newName = uniqueName("patch-combo");
    const res = await patch(record.id, headers, { name: newName, fingermap: { a: "RP" } }, `"${record.rev}"`);
    expect(res.status).toBe(200);
    const events = await eventsFor(record.id);
    expect(events).toHaveLength(2); // seed's "created" + this one
    expect(events.at(-1)).toMatchObject({ kind: "updated", detail: { fields: ["name", "fingermap"] } });
    const body = await res.json<{ name: string; payload: { keys: Record<string, { finger: string }> } }>();
    expect(body.name).toBe(newName);
    expect(body.payload.keys.a?.finger).toBe("RP");
  });

  it("a failing later verb (magic on cmini/1) leaves the earlier ones (fingermap) unapplied -- one batch or nothing", async () => {
    const record = await seed("cmini/1");
    const headers = ownerHeaders(`tok-${uniqueName("partial")}`);
    const res = await patch(record.id, headers, { fingermap: { a: "RP" }, magic: { rules: [{ inputs: "aa", output: "ab" }] } }, `"${record.rev}"`);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "unsupported_for_format" });

    const row = await db.prepare("SELECT rev, payload_json FROM layouts WHERE id = ?").bind(record.id).first<{ rev: number; payload_json: string }>();
    expect(row?.rev).toBe(record.rev);
    expect((JSON.parse(row!.payload_json) as { keys: Record<string, { finger: string }> }).keys.a?.finger).toBe("LP");
    const events = await eventsFor(record.id);
    expect(events).toHaveLength(1); // just the seed's own "created" -- nothing appended
  });
});

describe("[LDB-N1] PATCH {name} rename semantics", () => {
  it("check_name refuses an invalid new name -> 400 invalid_name, verbatim bot message", async () => {
    const record = await seed("cmini/1");
    const headers = ownerHeaders(`tok-${uniqueName("badname")}`);
    const res = await patch(record.id, headers, { name: "_bad" }, `"${record.rev}"`);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_name", message: "names cannot start with an underscore" });
  });

  it("rename to an existing live name -> 409 name_taken with holder", async () => {
    const taken = await seed("cmini/1");
    const record = await seed("cmini/1");
    const headers = ownerHeaders(`tok-${uniqueName("taken")}`);
    const res = await patch(record.id, headers, { name: taken.name }, `"${record.rev}"`);
    expect(res.status).toBe(409);
    const body = await res.json<{ error: string; holder: { id: string; owner: string } }>();
    expect(body.error).toBe("name_taken");
    expect(body.holder).toEqual({ id: taken.id, owner: taken.owner });
  });

  it("rename by case only -> 200 renamed", async () => {
    const record = await seed("cmini/1");
    const headers = ownerHeaders(`tok-${uniqueName("case")}`);
    const res = await patch(record.id, headers, { name: record.name.toUpperCase() }, `"${record.rev}"`);
    expect(res.status).toBe(200);
    const events = await eventsFor(record.id);
    expect(events.at(-1)?.kind).toBe("renamed");
    const body = await res.json<{ name: string }>();
    expect(body.name).toBe(record.name.toUpperCase());
  });

  it("a rename frees the old name in the same request -- a POST with it immediately after -> 201", async () => {
    const record = await seed("cmini/1");
    const oldName = record.name;
    const headers = ownerHeaders(`tok-${uniqueName("free")}`);
    const renameRes = await patch(record.id, headers, { name: uniqueName("patch-newname") }, `"${record.rev}"`);
    expect(renameRes.status).toBe(200);

    const postRes = await writeFetch("/v1/layouts", "POST", headers, { name: oldName, format: "cmini/1", payload: CMINI_KEYED });
    expect(postRes.status).toBe(201);
  });
});
