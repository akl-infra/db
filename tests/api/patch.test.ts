// [LDB-P1] [LDB-N1] [LDB-P7] PATCH /v1/layouts/{ref} (21-formats.md
// §2.2/§2.4): EITHER `{name}` (layout scope, `If-Match: "layout:<rev>"`) OR
// `{format, <one or more of fingermap/board/magic>}` (that format's scope,
// `If-Match: "<lineage>:<rev>"`) -- applied in order to a clone of the
// format's payload via its `edits`, validated once as a whole, one event:
// `renamed`/`fingermap` for exactly that one field, `updated` with
// `detail.fields` otherwise. Mixing `name` with a format edit is `400
// mixed_patch`; a format edit with no `format` is `400 format_required`.
// `If-Match` as PUT/DELETE (tests/api/ifmatch.test.ts sweeps that matrix
// generically). A verb the record's format has no `edits` entry for is
// `400 unsupported_for_format`.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { type EventDbRow, commitWrite, rowToEvent, type CommitInput } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import { ulid } from "ulidx";
import { BOOTSTRAP_ADMIN, actorFixture, pinTestClock, register, uniqueName, writeFetch } from "./write-support";

const db = (env as unknown as Bindings).DB;
const clock = fixedClock("2026-07-10T00:00:00.000Z");
pinTestClock(env as unknown as { TEST_CLOCK?: typeof clock }, clock);

const OWNER = "owner-patch-1";
const OTHER = "owner-patch-2";
const SOURCE = { client: "discord-app:test", version: null };

// Seeded with one real key ("a") -- PATCH's fingermap tests need a char to
// name.
const AKL_KEYED = { keys: { a: { row: 0, col: 0, finger: "LP" } } };

interface Seeded {
  id: string;
  name: string;
  owner: string;
  layoutRev: number;
  formatRev: number;
}

async function seed(owner = OWNER): Promise<Seeded> {
  const input: CommitInput = {
    layoutId: ulid(),
    creating: true,
    currentN: 0,
    currentLayout: null,
    currentFormats: new Map(),
    layout: { kind: "created", name: uniqueName("patch-seed"), owner, created_at: clock(), deleted: false },
    format: { kind: "format_added", lineage: "spark", format: "spark/1", payload: AKL_KEYED, hasMagic: false },
    modified_at: clock(),
    actor: owner,
    via: "discord",
    source: SOURCE,
    upstream: null,
  };
  const { layout, formats } = await commitWrite(db, clock, input);
  return { id: layout.id, name: layout.name, owner: layout.owner, layoutRev: layout.layout_rev, formatRev: formats.get("spark")!.rev };
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

describe("[LDB-P1] PATCH {name}: layout scope", () => {
  it("name alone -> 200, kind renamed, layout_rev + 1", async () => {
    const record = await seed();
    const headers = ownerHeaders(`tok-${uniqueName("name")}`);
    const newName = uniqueName("patch-renamed");
    const res = await patch(record.id, headers, { name: newName }, `"layout:${record.layoutRev}"`);
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe(`"layout:${record.layoutRev + 1}"`);
    const body = await res.json<{ name: string; layout_rev: number }>();
    expect(body.name).toBe(newName);
    expect(body.layout_rev).toBe(record.layoutRev + 1);
    const events = await eventsFor(record.id);
    expect(events.at(-1)).toMatchObject({ kind: "renamed", actor: OWNER, admin: false, detail: null, format: null });
  });

  it("[LDB-N1] check_name refuses an invalid new name -> 400 invalid_name, verbatim bot message", async () => {
    const record = await seed();
    const headers = ownerHeaders(`tok-${uniqueName("badname")}`);
    const res = await patch(record.id, headers, { name: "_bad" }, `"layout:${record.layoutRev}"`);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_name", message: "names cannot start with an underscore" });
  });

  it("rename to an existing live name -> 409 name_taken with holder", async () => {
    const taken = await seed();
    const record = await seed();
    const headers = ownerHeaders(`tok-${uniqueName("taken")}`);
    const res = await patch(record.id, headers, { name: taken.name }, `"layout:${record.layoutRev}"`);
    expect(res.status).toBe(409);
    const body = await res.json<{ error: string; holder: { id: string; owner: string } }>();
    expect(body.error).toBe("name_taken");
    expect(body.holder).toEqual({ id: taken.id, owner: taken.owner });
  });

  it("rename by case only -> 200 renamed", async () => {
    const record = await seed();
    const headers = ownerHeaders(`tok-${uniqueName("case")}`);
    const res = await patch(record.id, headers, { name: record.name.toUpperCase() }, `"layout:${record.layoutRev}"`);
    expect(res.status).toBe(200);
    const events = await eventsFor(record.id);
    expect(events.at(-1)?.kind).toBe("renamed");
    const body = await res.json<{ name: string }>();
    expect(body.name).toBe(record.name.toUpperCase());
  });

  it("[LDB-P4] a rename frees the old name in the same request -- a POST with it immediately after -> 201", async () => {
    const record = await seed();
    const oldName = record.name;
    const headers = ownerHeaders(`tok-${uniqueName("free")}`);
    const renameRes = await patch(record.id, headers, { name: uniqueName("patch-newname") }, `"layout:${record.layoutRev}"`);
    expect(renameRes.status).toBe(200);

    const postRes = await writeFetch("/v1/layouts", "POST", headers, { name: oldName, format: "spark/1", payload: AKL_KEYED });
    expect(postRes.status).toBe(201);
  });
});

describe("[LDB-P1] PATCH {format, fingermap|board|magic}: that format's scope", () => {
  it("fingermap alone -> 200, kind fingermap, format rev + 1, only the named char changes", async () => {
    const record = await seed();
    const headers = ownerHeaders(`tok-${uniqueName("fm")}`);
    const res = await patch(record.id, headers, { format: "spark/1", fingermap: { a: "RP" } }, `"spark:${record.formatRev}"`);
    expect(res.status).toBe(200);
    const body = await res.json<{ formats: Record<string, { rev: number }>; payload: { keys: Record<string, { finger: string }> } }>();
    expect(body.formats["spark/1"]!.rev).toBe(record.formatRev + 1);
    expect(body.payload.keys.a?.finger).toBe("RP");
    const events = await eventsFor(record.id);
    expect(events.at(-1)).toMatchObject({ kind: "fingermap", actor: OWNER, admin: false, detail: null, format: "spark/1" });
  });

  it("a fingermap naming a char not in keys -> 400 invalid_payload", async () => {
    const record = await seed();
    const headers = ownerHeaders(`tok-${uniqueName("fm-bad")}`);
    const res = await patch(record.id, headers, { format: "spark/1", fingermap: { z: "RP" } }, `"spark:${record.formatRev}"`);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_payload", path: "/keys/z" });
  });

  it("board alone -> 200, kind updated, detail.fields = ['board']", async () => {
    const record = await seed();
    const headers = ownerHeaders(`tok-${uniqueName("board")}`);
    const board = { kind: "rowstag", stagger: [0, 0.25, 0.75], cmini: "stagger" };
    const res = await patch(record.id, headers, { format: "spark/1", board }, `"spark:${record.formatRev}"`);
    expect(res.status).toBe(200);
    const events = await eventsFor(record.id);
    expect(events.at(-1)).toMatchObject({ kind: "updated", detail: { fields: ["board"] } });
    const body = await res.json<{ payload: { board: unknown } }>();
    expect(body.payload.board).toEqual(board);
  });

  it("magic on spark/1 -> 200, kind updated, plain detail.fields, no magic_only marker", async () => {
    const record = await seed();
    const headers = ownerHeaders(`tok-${uniqueName("magic")}`);
    const res = await patch(record.id, headers, { format: "spark/1", magic: { rules: [{ inputs: "aa", output: "ab" }] } }, `"spark:${record.formatRev}"`);
    expect(res.status).toBe(200);
    const events = await eventsFor(record.id);
    expect(events.at(-1)).toMatchObject({ kind: "updated", detail: { fields: ["magic"] } });
    expect((events.at(-1)?.detail as { magic_only?: unknown } | null)?.magic_only).toBeUndefined();
    const body = await res.json<{ payload: { magic: { rules: unknown[] } } }>();
    expect(body.payload.magic.rules).toHaveLength(1);
  });

  it("fingermap AND board together -> one event 'updated', detail.fields = ['fingermap','board']", async () => {
    const record = await seed();
    const headers = ownerHeaders(`tok-${uniqueName("combo-fmt")}`);
    const board = { kind: "ortho" };
    const res = await patch(record.id, headers, { format: "spark/1", fingermap: { a: "RP" }, board }, `"spark:${record.formatRev}"`);
    expect(res.status).toBe(200);
    const events = await eventsFor(record.id);
    expect(events.at(-1)).toMatchObject({ kind: "updated", detail: { fields: ["fingermap", "board"] } });
    const body = await res.json<{ payload: { keys: Record<string, { finger: string }>; board: unknown } }>();
    expect(body.payload.keys.a?.finger).toBe("RP");
    expect(body.payload.board).toEqual(board);
  });

  it("a failing later verb (a fingermap naming a char not in keys) leaves the earlier one (board) unapplied -- one batch or nothing", async () => {
    const record = await seed();
    const headers = ownerHeaders(`tok-${uniqueName("partial")}`);
    const res = await patch(record.id, headers, { format: "spark/1", board: { kind: "ortho" }, fingermap: { z: "RP" } }, `"spark:${record.formatRev}"`);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_payload", path: "/keys/z" });

    const row = await db.prepare("SELECT rev FROM layout_formats WHERE layout_id = ? AND lineage = 'spark'").bind(record.id).first<{ rev: number }>();
    expect(row?.rev).toBe(record.formatRev);
    const events = await eventsFor(record.id);
    expect(events).toHaveLength(2); // just the seed's own created + format_added -- nothing appended
  });

  it("{format: 'spark/1'} with no edit field -> 400 (schema requires at least one key)", async () => {
    const record = await seed();
    const headers = ownerHeaders(`tok-${uniqueName("format-only")}`);
    const res = await patch(record.id, headers, { format: "spark/1" }, `"spark:${record.formatRev}"`);
    expect(res.status).toBe(400);
  });

  it("If-Match stale -> 409", async () => {
    const record = await seed();
    const headers = ownerHeaders(`tok-${uniqueName("stale")}`);
    const res = await patch(record.id, headers, { format: "spark/1", fingermap: { a: "RP" } }, `"spark:${record.formatRev + 5}"`);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "stale" });
  });

  it("a stranger -> 403, an admin (non-owner) -> 200 admin: true, anonymous -> 401", async () => {
    const stranger = await seed();
    const strangerRes = await patch(stranger.id, register(actorFixture(), `tok-${uniqueName("s")}`, OTHER), { format: "spark/1", fingermap: { a: "RP" } }, `"spark:${stranger.formatRev}"`);
    expect(strangerRes.status).toBe(403);

    const forAdmin = await seed();
    const adminRes = await patch(forAdmin.id, register(actorFixture(), `tok-${uniqueName("a")}`, BOOTSTRAP_ADMIN), { format: "spark/1", fingermap: { a: "RP" } }, `"spark:${forAdmin.formatRev}"`);
    expect(adminRes.status).toBe(200);
    const events = await eventsFor(forAdmin.id);
    expect(events.at(-1)).toMatchObject({ admin: true });

    const anon = await seed();
    const anonRes = await patch(anon.id, {}, { format: "spark/1", fingermap: { a: "RP" } });
    expect(anonRes.status).toBe(401);
  });

  it("no If-Match -> 400 if_match_required, record unchanged", async () => {
    const record = await seed();
    const headers = ownerHeaders(`tok-${uniqueName("noifmatch")}`);
    const res = await patch(record.id, headers, { format: "spark/1", fingermap: { a: "RP" } });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "if_match_required" });
    expect(await eventsFor(record.id)).toHaveLength(2); // just created + format_added
  });

  it("{} -> 400 bad_request", async () => {
    const record = await seed();
    const headers = ownerHeaders(`tok-${uniqueName("empty")}`);
    const res = await patch(record.id, headers, {});
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "bad_request" });
  });

  it("an unknown key -> 400 bad_request", async () => {
    const record = await seed();
    const headers = ownerHeaders(`tok-${uniqueName("unk")}`);
    const res = await patch(record.id, headers, { color: "blue" });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "bad_request", param: "/color" });
  });
});

// `unsupported_for_format` on PATCH is GENUINELY UNREACHABLE here, not just
// untested: every stored record is spark/1, and spark's own `edits` covers
// fingermap/board/magic uniformly, never refusing any of them. `runEdit`'s
// `edit === undefined` branch is still real code (a future format module
// that omits an edit still gets refused this way); `tests/formats/
// edits.test.ts` covers the format-level half.

describe("[LDB-P7] mixed_patch: name can never combine with a format edit", () => {
  it("{name, fingermap} -> 400 mixed_patch, before any read (works with either If-Match value)", async () => {
    const record = await seed();
    const headers = ownerHeaders(`tok-${uniqueName("mixed")}`);
    const res = await patch(record.id, headers, { name: uniqueName("mixed-name"), format: "spark/1", fingermap: { a: "RP" } }, `"layout:${record.layoutRev}"`);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "mixed_patch" });
    expect(await eventsFor(record.id)).toHaveLength(2); // untouched
  });

  it("{name, board} without format -> still 400 mixed_patch (not format_required -- mixing wins)", async () => {
    const record = await seed();
    const headers = ownerHeaders(`tok-${uniqueName("mixed2")}`);
    const res = await patch(record.id, headers, { name: uniqueName("mixed-name-2"), board: { kind: "ortho" } }, `"layout:${record.layoutRev}"`);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "mixed_patch" });
  });

  it("[MF-4 = LDB-G11] {fingermap} without format -> 400 format_required", async () => {
    const record = await seed();
    const headers = ownerHeaders(`tok-${uniqueName("noformat")}`);
    const res = await patch(record.id, headers, { fingermap: { a: "RP" } }, `"spark:${record.formatRev}"`);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "format_required" });
  });
});

// [LDB-P10] design/layout-db/18-command-decisions.md §2 D2: a rename never
// loses the id.
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
    const createRes = await writeFetch("/v1/layouts", "POST", owner, { name: oldName, format: "spark/1", payload: AKL_KEYED });
    expect(createRes.status).toBe(201);
    const created = await createRes.json<{ id: string; layout_rev: number }>();

    for (const liker of likers) {
      const res = await writeFetch(`/v1/layouts/${created.id}/like`, "PUT", liker);
      expect(res.status).toBe(200);
    }

    const newName = uniqueName("p10-new");
    const renameRes = await writeFetch(`/v1/layouts/${created.id}`, "PATCH", { ...owner, "If-Match": `"layout:${created.layout_rev}"` }, { name: newName });
    expect(renameRes.status).toBe(200);
    const renamed = await renameRes.json<{ id: string; name: string }>();
    expect(renamed.id).toBe(created.id);
    expect(renamed.name).toBe(newName);

    const byNameRes = await writeFetch(`/v1/layouts/${newName}?format=spark/1`, "GET");
    expect(byNameRes.status).toBe(200);
    expect((await byNameRes.json<{ id: string }>()).id).toBe(created.id);

    const byIdRes = await writeFetch(`/v1/layouts/${created.id}?format=spark/1`, "GET");
    expect(byIdRes.status).toBe(200);
    const byId = await byIdRes.json<{ id: string; name: string }>();
    expect(byId.id).toBe(created.id);
    expect(byId.name).toBe(newName);

    const historyRes = await writeFetch(`/v1/layouts/${created.id}/history`, "GET");
    expect(historyRes.status).toBe(200);
    const history = await historyRes.json<{ kind: string }[]>();
    expect(history.map((h) => h.kind)).toEqual(["created", "format_added", "liked", "liked", "liked", "renamed"]);

    const likesRes = await writeFetch(`/v1/layouts/${newName}/likes`, "GET");
    expect(likesRes.status).toBe(200);
    const likes = await likesRes.json<{ user_ids: string[] }>();
    expect([...likes.user_ids].sort()).toEqual(["p10-liker-1", "p10-liker-2", "p10-liker-3"]);

    const reuseRes = await writeFetch("/v1/layouts", "POST", owner, { name: oldName, format: "spark/1", payload: AKL_KEYED });
    expect(reuseRes.status).toBe(201);

    const fullRes = await writeFetch("/v1/layouts?full=1&format=spark/1", "GET");
    expect(fullRes.status).toBe(200);
    const full = await fullRes.json<{ items: { id: string; name: string }[] }>();
    const fullRow = full.items.find((r) => r.name === newName);
    expect(fullRow?.id).toBe(created.id);
  });
});
