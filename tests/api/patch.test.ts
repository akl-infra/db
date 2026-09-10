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
      upstream: null,
    kind: "created",
    name: uniqueName("patch-seed"),
    owner,
    modified_at: clock(),
    format,
    payload,
    actor: owner,
    via: "discord",
    source: { client: "discord-app:test", version: null },
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

      // 20-spark.md S2: a `cmini/1`-stored record is converted to spark
      // FIRST (`storedAsSpark`, whatever the PATCH names), so `board` is
      // ALWAYS applied through spark's own `setBoard` (raw passthrough) --
      // not, as before S2, through the cmini adapter's own word-deriving
      // `setBoard`. Both formats' loops now produce the identical raw
      // object.
      it("board alone -> 200, kind updated, detail.fields = ['board']", async () => {
        const record = await seed(format);
        const headers = ownerHeaders(`tok-${uniqueName("board")}`);
        const board = { kind: "rowstag", stagger: [0, 0.25, 0.75], cmini: "stagger" };
        const res = await patch(record.id, headers, { board }, `"${record.rev}"`);
        expect(res.status).toBe(200);
        const events = await eventsFor(record.id);
        expect(events.at(-1)).toMatchObject({ kind: "updated", detail: { fields: ["board"] } });
        const body = await res.json<{ payload: { board: unknown } }>();
        expect(body.payload.board).toEqual(board);
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

  // 20-spark.md S2 (saltorbit's decision 6): magic edits fork like any other
  // write now -- `isMagicOnlyReplace`/`detail.magic_only` are gone.
  // `modified_at` bumps unconditionally and the event carries a plain
  // `detail: {fields}`, same shape a fingermap-only PATCH always got.
  // `modified_at` bumping unconditionally (this file's clock is pinned to
  // one fixed instant throughout, so it can't distinguish "bumped" from
  // "left alone" here) is covered with a mutable clock in
  // tests/api/write.test.ts's own [LDB-P4] case.
  it("[LDB-P4] magic on akl/1 -> 200, kind updated, plain detail.fields, no magic_only marker", async () => {
    const record = await seed("akl/1");
    const headers = ownerHeaders(`tok-${uniqueName("magic")}`);
    const res = await patch(record.id, headers, { magic: { rules: [{ inputs: "aa", output: "ab" }] } }, `"${record.rev}"`);
    expect(res.status).toBe(200);
    const events = await eventsFor(record.id);
    expect(events.at(-1)).toMatchObject({ kind: "updated", detail: { fields: ["magic"] } });
    expect((events.at(-1)?.detail as { magic_only?: unknown } | null)?.magic_only).toBeUndefined();
    const body = await res.json<{ payload: { magic: { rules: unknown[] } } }>();
    expect(body.payload.magic.rules).toHaveLength(1);
  });

  // 20-spark.md S2 (LDB-F16/F21): a `cmini/1`-stored record is converted
  // to spark FIRST, whatever the PATCH names -- always `spark/1`, never
  // `akl/1` (S1's alias is byte-identical payload-wise, but the STORED
  // format a carry-forward write picks is always the native id).
  it("[LDB-F16] [LDB-F21] [LDB-I12] magic on cmini/1 -> 200, converts to spark/1 (storedAsSpark), keys/board preserved, no magic_only marker", async () => {
    const record = await seed("cmini/1");
    const headers = ownerHeaders(`tok-${uniqueName("magic-cmini")}`);
    const res = await patch(record.id, headers, { magic: { rules: [{ inputs: "aa", output: "ab" }] } }, `"${record.rev}"`);
    expect(res.status).toBe(200);
    const events = await eventsFor(record.id);
    expect(events.at(-1)).toMatchObject({ kind: "updated", detail: { fields: ["magic"] } });
    expect((events.at(-1)?.detail as { magic_only?: unknown } | null)?.magic_only).toBeUndefined();
    const body = await res.json<{ format: string; payload: { keys: unknown; board: unknown; magic: { rules: unknown[] } } }>();
    expect(body.format).toBe("spark/1"); // converted, not lifted to the akl/1 alias
    expect(body.payload.keys).toEqual(CMINI_KEYED.keys); // fromCmini: lossless
    expect(body.payload.board).toEqual({ kind: "ortho", cmini: "ortho" }); // fromCmini's boardFromCmini("ortho")
    expect(body.payload.magic.rules).toHaveLength(1);
    const row = await db.prepare("SELECT format FROM layouts WHERE id = ?").bind(record.id).first<{ format: string }>();
    expect(row?.format).toBe("spark/1");
  });
});

// 20-spark.md S2: `unsupported_for_format` on PATCH is now GENUINELY
// UNREACHABLE, not just untested. `patchLayout` runs EVERY record through
// `storedAsSpark` unconditionally (correct per spec: in the real registry
// a stored record's format is always `spark/1` or a legacy id --
// `storedAsSpark` is an identity for the former), so `module` is always
// spark's own -- which has `edits` for fingermap/board/magic uniformly.
// Even a test-registered second "stored" format (the mechanism
// `held.test.ts`'s LDB-F9 uses for `unknown`/`held`) would be silently
// coerced through `storedAsSpark` into spark's module too, so it can't
// stand in for "a stored format with no edits" either -- that shape
// doesn't exist while spark/1 is the only stored format (phase 1-4; S5's
// chain is the first format that could ever lack a verb). Two tests are
// therefore genuinely gone, not merely moved: "a hint-less colstag board
// on cmini/1 -> 400 unsupported_for_format" (cmini's own `setBoard`
// refused a hint-less colstag; spark's `setBoard` never refuses ANY
// board) and the "combined patches" partial-failure case built on it.
// `runEdit`'s `edit === undefined` branch itself is still real code (a
// future format module that omits an edit still gets refused this way),
// it just has no live caller today -- `tests/formats/edits.test.ts`'s own
// note pointed here for the end-to-end half, and is corrected alongside
// this file.

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

  // 20-spark.md S2: the pre-S2 failure mode here was a hint-less colstag
  // board on a `cmini/1` record ("unsupported_for_format") -- genuinely
  // unreachable now (see the comment above this describe). A later verb's
  // `invalid_payload` (fingermap naming a char not in keys) exercises the
  // exact same "one batch or nothing" atomicity property with a failure
  // mode that still exists.
  it("a failing later verb (a fingermap naming a char not in keys) leaves the earlier ones (name) unapplied -- one batch or nothing", async () => {
    const record = await seed("cmini/1");
    const headers = ownerHeaders(`tok-${uniqueName("partial")}`);
    const newName = uniqueName("patch-partial-newname");
    const res = await patch(record.id, headers, { name: newName, fingermap: { z: "RP" } }, `"${record.rev}"`);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_payload", path: "/keys/z" });

    const row = await db.prepare("SELECT rev, name FROM layouts WHERE id = ?").bind(record.id).first<{ rev: number; name: string }>();
    expect(row?.rev).toBe(record.rev);
    expect(row?.name).toBe(record.name); // the earlier "name" field never landed
    const events = await eventsFor(record.id);
    expect(events).toHaveLength(1); // just the seed's own "created" -- nothing appended
  });
});

describe("[LDB-N1] PATCH {name} rename semantics", () => {
  it("[LDB-N1] check_name refuses an invalid new name -> 400 invalid_name, verbatim bot message", async () => {
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

    const postRes = await writeFetch("/v1/layouts", "POST", headers, { name: oldName, format: "akl/1", payload: AKL_KEYED });
    expect(postRes.status).toBe(201);
  });
});

// [LDB-P10] design/layout-db/18-command-decisions.md §2 D2: a rename never
// loses the id. Already true at the record level (a rename is a PATCH on
// the same id -- likes, history and the rev chain continue, LDB-P4 owns
// "the old name is freed"); this pins the OTHER half explicitly -- every
// read that identifies the record (by new name, by id, `/history`,
// `/likes`, and a `full=1` list row) agrees on the same id across the
// rename.
describe("[LDB-P10] a rename never loses the id", () => {
  it("[LDB-P10] create -> like x3 -> rename -> GET by new name / by id / history / likes agree; a full=1 row carries the same id", async () => {
    const fake = actorFixture();
    const owner = register(fake, `tok-${uniqueName("p10-owner")}`, "p10-owner");
    const likers = [
      register(fake, `tok-${uniqueName("p10-l1")}`, "p10-liker-1"),
      register(fake, `tok-${uniqueName("p10-l2")}`, "p10-liker-2"),
      register(fake, `tok-${uniqueName("p10-l3")}`, "p10-liker-3"),
    ];

    const oldName = uniqueName("p10-old");
    const createRes = await writeFetch("/v1/layouts", "POST", owner, { name: oldName, format: "akl/1", payload: AKL_KEYED });
    expect(createRes.status).toBe(201);
    const created = await createRes.json<{ id: string; rev: number }>();

    for (const liker of likers) {
      const res = await writeFetch(`/v1/layouts/${created.id}/like`, "PUT", liker);
      expect(res.status).toBe(200);
    }

    const newName = uniqueName("p10-new");
    const renameRes = await writeFetch(`/v1/layouts/${created.id}`, "PATCH", { ...owner, "If-Match": `"${created.rev}"` }, { name: newName });
    expect(renameRes.status).toBe(200);
    const renamed = await renameRes.json<{ id: string; name: string }>();
    expect(renamed.id).toBe(created.id);
    expect(renamed.name).toBe(newName);

    // by the new name
    const byNameRes = await writeFetch(`/v1/layouts/${newName}`, "GET");
    expect(byNameRes.status).toBe(200);
    expect((await byNameRes.json<{ id: string }>()).id).toBe(created.id);

    // by id -- and it now carries the new name
    const byIdRes = await writeFetch(`/v1/layouts/${created.id}`, "GET");
    expect(byIdRes.status).toBe(200);
    const byId = await byIdRes.json<{ id: string; name: string }>();
    expect(byId.id).toBe(created.id);
    expect(byId.name).toBe(newName);

    // history: same id's rev chain, unbroken across the rename
    const historyRes = await writeFetch(`/v1/layouts/${created.id}/history`, "GET");
    expect(historyRes.status).toBe(200);
    const history = await historyRes.json<{ kind: string }[]>();
    expect(history.map((h) => h.kind)).toEqual(["created", "liked", "liked", "liked", "renamed"]);

    // likes: the same 3 users, reachable through the NEW name
    const likesRes = await writeFetch(`/v1/layouts/${newName}/likes`, "GET");
    expect(likesRes.status).toBe(200);
    const likes = await likesRes.json<{ user_ids: string[] }>();
    expect([...likes.user_ids].sort()).toEqual(["p10-liker-1", "p10-liker-2", "p10-liker-3"]);

    // the old name is free (LDB-P4) -- a fresh POST with it succeeds
    const reuseRes = await writeFetch("/v1/layouts", "POST", owner, { name: oldName, format: "akl/1", payload: AKL_KEYED });
    expect(reuseRes.status).toBe(201);

    // a `full=1` list row carries the SAME id -- the site's own `_dbId`
    // projection (18 §2 D2: "the sync carries `_dbId` on every row")
    const fullRes = await writeFetch("/v1/layouts?full=1&as=cmini/1", "GET");
    expect(fullRes.status).toBe(200);
    const full = await fullRes.json<{ items: { id: string; name: string }[] }>();
    const fullRow = full.items.find((r) => r.name === newName);
    expect(fullRow?.id).toBe(created.id);
  });
});
