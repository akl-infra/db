// [LDB-L1] PUT/DELETE /v1/layouts/{ref}/like (layout scope, informational):
// idempotent (repeat likes/unlikes append no second event); `layout_rev`,
// `modified_at`, `layouts_modified_at` and every format's own `rev`/
// `modified_at` never move, `like_count` and `meta.revision`/`seq` do;
// `qwerty` is refused with the bot's exact string; a tombstone is 404;
// anonymous is 401; concurrent likes from different users are all
// counted, a concurrent double-like from the SAME user is one event; the
// fold always equals the stored row.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { commitWrite, foldLayout, rowToEvent, type CommitInput, type EventDbRow } from "../../src/core/events";
import { readById } from "../../src/core/records";
import { fixedClock } from "../../src/core/time";
import { ulid } from "ulidx";
import { AKL_PAYLOAD, actorFixture, register, uniqueName, writeFetch } from "./write-support";

const db = (env as unknown as Bindings).DB;
const clock = fixedClock("2026-07-09T00:00:00.000Z");
const OWNER = "owner-likes-1";
const SOURCE = { client: "discord-app:test", version: null };

afterEach(() => {
  vi.unstubAllGlobals();
});

function ownerHeaders(token: string) {
  const fake = actorFixture();
  return register(fake, token, OWNER);
}

async function seed(name = uniqueName("likes-seed")) {
  const input: CommitInput = {
    layoutId: ulid(),
    creating: true,
    currentN: 0,
    currentLayout: null,
    currentFormats: new Map(),
    layout: { kind: "created", name, owner: OWNER, created_at: clock(), deleted: false },
    format: { kind: "format_added", lineage: "spark", format: "spark/1", payload: AKL_PAYLOAD, hasMagic: false },
    modified_at: clock(),
    actor: OWNER,
    via: "discord",
    source: SOURCE,
    upstream: null,
  };
  const { layout } = await commitWrite(db, clock, input);
  return layout;
}

// [LDB-L1] the layout equals the LAYOUT-scope fold of its own events -- the
// same check tests/events/fold.test.ts's write model runs, here asserted
// after each HTTP case rather than over random sequences.
async function assertFoldMatchesRow(layoutId: string) {
  const eventRows = await db.prepare("SELECT * FROM events WHERE layout_id = ? ORDER BY seq ASC").bind(layoutId).all<EventDbRow>();
  const events = eventRows.results.map(rowToEvent);
  const revRows = await db.prepare("SELECT lineage, rev, format, payload_json FROM layout_revs WHERE layout_id = ?").bind(layoutId).all<{ lineage: string | null; rev: number; format: string | null; payload_json: string | null }>();
  const revs = new Map(revRows.results.map((r) => [`${r.lineage ?? ""} ${r.rev}`, { format: r.format, payload: r.payload_json === null ? undefined : (JSON.parse(r.payload_json) as unknown) }]));
  const folded = foldLayout(events, revs);
  const row = await readById(db, layoutId);
  const { n: _n, ...rowSansN } = row!;
  expect(folded!.layout).toEqual(rowSansN);
}

describe("[LDB-L1] PUT/DELETE /v1/layouts/{ref}/like", () => {
  it("[LDB-L5] like -> 200 {like_count: 1}, one 'liked' event, a likes row", async () => {
    const record = await seed();
    const headers = ownerHeaders(`tok-${uniqueName("like")}`);
    const res = await writeFetch(`/v1/layouts/${record.id}/like`, "PUT", headers);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ like_count: 1 });

    const events = await db.prepare("SELECT kind, rev, actor, via FROM events WHERE layout_id = ? AND kind = 'liked'").bind(record.id).all<{ kind: string; rev: number | null; actor: string; via: string }>();
    expect(events.results).toHaveLength(1);
    expect(events.results[0]).toMatchObject({ kind: "liked", rev: null, actor: OWNER, via: "discord" });

    // LDB-B1 (migrations/0011): the `likes` row itself carries `via`, the
    // same value the event does -- so a later reconciliation can tell a
    // real user's like from an imported one without guessing.
    const likeRow = await db.prepare("SELECT via FROM likes WHERE layout_id = ? AND user_id = ?").bind(record.id, OWNER).first<{ via: string }>();
    expect(likeRow).not.toBeNull();
    expect(likeRow!.via).toBe("discord");
    await assertFoldMatchesRow(record.id);
  });

  it("[LDB-L1] like again -> 409 already_liked (D13 L1), no second event, count still 1, nothing else changes", async () => {
    const record = await seed();
    const headers = ownerHeaders(`tok-${uniqueName("like")}`);
    await writeFetch(`/v1/layouts/${record.id}/like`, "PUT", headers);
    const res = await writeFetch(`/v1/layouts/${record.id}/like`, "PUT", headers);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "already_liked" });

    const events = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE layout_id = ? AND kind = 'liked'").bind(record.id).first<{ n: number }>();
    expect(events?.n).toBe(1);
    const row = await readById(db, record.id);
    expect(row?.like_count).toBe(1);
    await assertFoldMatchesRow(record.id);
  });

  it("[LDB-L1] [LDB-L2] unlike twice -> one 'unliked' event, then 409 not_liked (D13 L2), count 0", async () => {
    const record = await seed();
    const headers = ownerHeaders(`tok-${uniqueName("like")}`);
    await writeFetch(`/v1/layouts/${record.id}/like`, "PUT", headers);

    const first = await writeFetch(`/v1/layouts/${record.id}/like`, "DELETE", headers);
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ like_count: 0 });

    const second = await writeFetch(`/v1/layouts/${record.id}/like`, "DELETE", headers);
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({ error: "not_liked" });

    const events = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE layout_id = ? AND kind = 'unliked'").bind(record.id).first<{ n: number }>();
    expect(events?.n).toBe(1);
    const row = await readById(db, record.id);
    expect(row?.like_count).toBe(0);
    await assertFoldMatchesRow(record.id);
  });

  it("[LDB-L2] unliking a layout never liked -> 409 not_liked, no event", async () => {
    const record = await seed();
    const headers = ownerHeaders(`tok-${uniqueName("never-liked")}`);
    const res = await writeFetch(`/v1/layouts/${record.id}/like`, "DELETE", headers);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "not_liked" });
    const events = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE layout_id = ? AND kind = 'unliked'").bind(record.id).first<{ n: number }>();
    expect(events?.n).toBe(0);
  });

  it("[LDB-L1] layout_rev/modified_at/layouts_modified_at never move (nor a format's own rev/modified_at); like_count and meta.revision/seq do", async () => {
    const record = await seed();
    const before = await writeFetch(`/v1/layouts/${record.id}?format=spark/1`, "GET");
    const beforeBody = await before.json<{ layout_rev: number; modified_at: string; formats: Record<string, { rev: number; modified_at: string }> }>();
    const metaBefore = await (await writeFetch("/v1/meta", "GET")).json<{ seq: number; revision: string | null; layouts_modified_at: string | null }>();

    const headers = ownerHeaders(`tok-${uniqueName("like")}`);
    const res = await writeFetch(`/v1/layouts/${record.id}/like`, "PUT", headers);
    expect(res.status).toBe(200);

    const after = await writeFetch(`/v1/layouts/${record.id}?format=spark/1`, "GET");
    const afterBody = await after.json<{ layout_rev: number; modified_at: string; like_count: number; formats: Record<string, { rev: number; modified_at: string }> }>();
    expect(afterBody.layout_rev).toBe(beforeBody.layout_rev);
    expect(afterBody.modified_at).toBe(beforeBody.modified_at);
    expect(afterBody.like_count).toBe(1);
    // A like is layout-scope only (MF-1): the format's own rev/modified_at
    // never move either -- not just the layout's.
    expect(afterBody.formats["spark/1"]).toEqual(beforeBody.formats["spark/1"]);

    const metaAfter = await (await writeFetch("/v1/meta", "GET")).json<{ seq: number; revision: string | null; layouts_modified_at: string | null }>();
    expect(metaAfter.seq).toBeGreaterThan(metaBefore.seq);
    expect(metaAfter.layouts_modified_at).toBe(metaBefore.layouts_modified_at);
  });

  it("a detail's likes are sorted by user id", async () => {
    const record = await seed();
    const ids = ["user-c", "user-a", "user-b"];
    for (const id of ids) {
      const fake = actorFixture();
      const headers = register(fake, `tok-${uniqueName("sort")}`, id);
      const res = await writeFetch(`/v1/layouts/${record.id}/like`, "PUT", headers);
      expect(res.status).toBe(200);
    }
    const detail = await writeFetch(`/v1/layouts/${record.id}?format=spark/1`, "GET");
    const body = await detail.json<{ likes: string[] }>();
    expect(body.likes).toEqual(["user-a", "user-b", "user-c"]);
  });

  it("qwerty -> 400 with the bot's exact refusal", async () => {
    await seed("QWERTY");
    const headers = ownerHeaders(`tok-${uniqueName("qwerty")}`);
    const res = await writeFetch("/v1/layouts/qwerty/like", "PUT", headers);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "bad_request",
      message: "You can't like Qwerty :yellow_circle:",
      param: "/ref",
    });
  });

  it("a tombstone -> 404", async () => {
    const record = await seed();
    const current = (await readById(db, record.id))!;
    await commitWrite(db, clock, {
      layoutId: record.id,
      creating: false,
      currentN: current.n,
      currentLayout: current,
      currentFormats: new Map(),
      layout: { kind: "deleted", name: record.name, owner: record.owner, created_at: record.created_at, deleted: true },
      modified_at: clock(),
      actor: OWNER,
      via: "discord",
      source: SOURCE,
      upstream: current.upstream,
    });
    const headers = ownerHeaders(`tok-${uniqueName("tomb")}`);
    const res = await writeFetch(`/v1/layouts/${record.id}/like`, "PUT", headers);
    expect(res.status).toBe(404);
  });

  it("anonymous -> 401", async () => {
    const record = await seed();
    const res = await writeFetch(`/v1/layouts/${record.id}/like`, "PUT");
    expect(res.status).toBe(401);
  });

  it("[LDB-L1] race: 5 different users liking at once -> like_count = 5, 5 rows", async () => {
    const record = await seed();
    const fake = actorFixture();
    const users = ["ru1", "ru2", "ru3", "ru4", "ru5"];
    const headersList = users.map((u) => register(fake, `tok-${u}-${uniqueName("race")}`, u));

    const responses = await Promise.all(headersList.map((h) => writeFetch(`/v1/layouts/${record.id}/like`, "PUT", h)));
    for (const res of responses) expect(res.status).toBe(200);

    const row = await readById(db, record.id);
    expect(row?.like_count).toBe(5);
    const rows = await db.prepare("SELECT COUNT(*) AS n FROM likes WHERE layout_id = ?").bind(record.id).first<{ n: number }>();
    expect(rows?.n).toBe(5);
    await assertFoldMatchesRow(record.id);
  });

  it("[LDB-L1] race: the same user liking twice at once -> one event, count 1, exactly one 200 and one 409 already_liked (D13 E2)", async () => {
    const record = await seed();
    const fake = actorFixture();
    const headers = register(fake, `tok-${uniqueName("dup")}`, "race-dup-user");

    const [a, b] = await Promise.all([writeFetch(`/v1/layouts/${record.id}/like`, "PUT", headers), writeFetch(`/v1/layouts/${record.id}/like`, "PUT", headers)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    await expect(loser.json()).resolves.toMatchObject({ error: "already_liked" });

    const row = await readById(db, record.id);
    expect(row?.like_count).toBe(1);
    const events = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE layout_id = ? AND kind = 'liked'").bind(record.id).first<{ n: number }>();
    expect(events?.n).toBe(1);
    await assertFoldMatchesRow(record.id);
  });

  // D13 L3: "likes never change any version, so a like never fails an
  // edit and an edit never fails a like." Races a like against a format
  // write AND a rename to the same layout -- all three land.
  it("[LDB-L3] a like races a format write and a rename -- all three land, none blocks another", async () => {
    const record = await seed();
    const headers = ownerHeaders(`tok-${uniqueName("l3")}`);
    const newName = uniqueName("l3-renamed");

    const [likeRes, patchRes, putRes] = await Promise.all([
      writeFetch(`/v1/layouts/${record.id}/like`, "PUT", headers),
      writeFetch(`/v1/layouts/${record.id}`, "PATCH", { ...headers, "If-Match": `"layout:${record.layout_rev}"` }, { name: newName }),
      writeFetch(`/v1/layouts/${record.id}`, "PUT", { ...headers, "If-Match": '"spark:1"' }, { format: "spark/1", payload: { keys: { a: { row: 0, col: 0, finger: "LP" } } } }),
    ]);

    expect(likeRes.status, "L3: a like never fails an edit and an edit never fails a like").toBe(200);
    expect(patchRes.status).toBe(200);
    expect(putRes.status).toBe(200);

    const row = await readById(db, record.id);
    expect(row?.like_count).toBe(1);
    expect(row?.name).toBe(newName);
    await assertFoldMatchesRow(record.id);
  });
});
