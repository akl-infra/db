// [LDB-L1] PUT/DELETE /v1/layouts/{ref}/like (09 §3 T5): idempotent
// (repeat likes/unlikes append no second event); `rev`, `modified_at` and
// `layouts_modified_at` never move, `like_count` and `meta.revision`/`seq`
// do; `qwerty` is refused with the bot's exact string; a tombstone is 404;
// anonymous is 401; concurrent likes from different users are all counted,
// a concurrent double-like from the SAME user is one event; the fold
// always equals the stored row.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { appendWrite, foldRecord, rowToEvent, type EventDbRow } from "../../src/core/events";
import { readById } from "../../src/core/records";
import { fixedClock } from "../../src/core/time";
import { CMINI_PAYLOAD, actorFixture, register, uniqueName, writeFetch } from "./write-support";

const db = (env as unknown as Bindings).DB;
const clock = fixedClock("2026-07-09T00:00:00.000Z");
const OWNER = "owner-likes-1";

afterEach(() => {
  vi.unstubAllGlobals();
});

function ownerHeaders(token: string) {
  const fake = actorFixture();
  return register(fake, token, OWNER);
}

async function seed(name = uniqueName("likes-seed")) {
  const { record } = await appendWrite(db, clock, {
    kind: "created",
    name,
    owner: OWNER,
    modified_at: clock(),
    format: "cmini/1",
    payload: CMINI_PAYLOAD,
    actor: OWNER,
    via: "discord",
    hasMagic: false,
  });
  return record;
}

// [LDB-L1] the record equals the fold of its own events -- the same check
// tests/events/fold.test.ts's property runs, here asserted after each HTTP
// case rather than over random sequences.
async function assertFoldMatchesRow(layoutId: string) {
  const eventRows = await db
    .prepare("SELECT * FROM events WHERE layout_id = ? ORDER BY seq ASC")
    .bind(layoutId)
    .all<EventDbRow>();
  const events = eventRows.results.map(rowToEvent);
  const revRows = await db
    .prepare("SELECT rev, format, payload_json FROM layout_revs WHERE layout_id = ?")
    .bind(layoutId)
    .all<{ rev: number; format: string; payload_json: string }>();
  const revs = new Map(revRows.results.map((r) => [r.rev, { format: r.format, payload: JSON.parse(r.payload_json) as unknown }]));
  const folded = foldRecord(events, revs);
  const row = await readById(db, layoutId);
  expect(folded).toEqual(row);
}

describe("[LDB-L1] PUT/DELETE /v1/layouts/{ref}/like", () => {
  it("like -> 200 {like_count: 1}, one 'liked' event, a likes row", async () => {
    const record = await seed();
    const headers = ownerHeaders(`tok-${uniqueName("like")}`);
    const res = await writeFetch(`/v1/layouts/${record.id}/like`, "PUT", headers);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ like_count: 1 });

    const events = await db
      .prepare("SELECT kind, rev, actor, via FROM events WHERE layout_id = ? AND kind = 'liked'")
      .bind(record.id)
      .all<{ kind: string; rev: number | null; actor: string; via: string }>();
    expect(events.results).toHaveLength(1);
    expect(events.results[0]).toMatchObject({ kind: "liked", rev: null, actor: OWNER, via: "discord" });

    const likeRow = await db.prepare("SELECT 1 FROM likes WHERE layout_id = ? AND user_id = ?").bind(record.id, OWNER).first();
    expect(likeRow).not.toBeNull();
    await assertFoldMatchesRow(record.id);
  });

  it("like again -> 200, no second event, count still 1", async () => {
    const record = await seed();
    const headers = ownerHeaders(`tok-${uniqueName("like")}`);
    await writeFetch(`/v1/layouts/${record.id}/like`, "PUT", headers);
    const res = await writeFetch(`/v1/layouts/${record.id}/like`, "PUT", headers);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ like_count: 1 });

    const events = await db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE layout_id = ? AND kind = 'liked'")
      .bind(record.id)
      .first<{ n: number }>();
    expect(events?.n).toBe(1);
    await assertFoldMatchesRow(record.id);
  });

  it("unlike twice -> one 'unliked' event, count 0", async () => {
    const record = await seed();
    const headers = ownerHeaders(`tok-${uniqueName("like")}`);
    await writeFetch(`/v1/layouts/${record.id}/like`, "PUT", headers);

    const first = await writeFetch(`/v1/layouts/${record.id}/like`, "DELETE", headers);
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ like_count: 0 });

    const second = await writeFetch(`/v1/layouts/${record.id}/like`, "DELETE", headers);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({ like_count: 0 });

    const events = await db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE layout_id = ? AND kind = 'unliked'")
      .bind(record.id)
      .first<{ n: number }>();
    expect(events?.n).toBe(1);
    await assertFoldMatchesRow(record.id);
  });

  it("[LDB-L1] rev/modified_at/layouts_modified_at never move; like_count and meta.revision/seq do", async () => {
    const record = await seed();
    const before = await writeFetch(`/v1/layouts/${record.id}`, "GET");
    const beforeBody = await before.json<{ rev: number; modified_at: string }>();
    const metaBefore = await (await writeFetch("/v1/meta", "GET")).json<{ seq: number; revision: string | null; layouts_modified_at: string | null }>();

    const headers = ownerHeaders(`tok-${uniqueName("like")}`);
    const res = await writeFetch(`/v1/layouts/${record.id}/like`, "PUT", headers);
    expect(res.status).toBe(200);

    const after = await writeFetch(`/v1/layouts/${record.id}`, "GET");
    const afterBody = await after.json<{ rev: number; modified_at: string; like_count: number }>();
    expect(afterBody.rev).toBe(beforeBody.rev);
    expect(afterBody.modified_at).toBe(beforeBody.modified_at);
    expect(afterBody.like_count).toBe(1);

    const metaAfter = await (await writeFetch("/v1/meta", "GET")).json<{ seq: number; revision: string | null; layouts_modified_at: string | null }>();
    expect(metaAfter.seq).toBeGreaterThan(metaBefore.seq);
    expect(metaAfter.layouts_modified_at).toBe(metaBefore.layouts_modified_at);
  });

  it("?as=cmini/1 detail's likes are sorted by user id", async () => {
    const record = await seed();
    const ids = ["user-c", "user-a", "user-b"];
    for (const id of ids) {
      const fake = actorFixture();
      const headers = register(fake, `tok-${uniqueName("sort")}`, id);
      const res = await writeFetch(`/v1/layouts/${record.id}/like`, "PUT", headers);
      expect(res.status).toBe(200);
    }
    const detail = await writeFetch(`/v1/layouts/${record.id}?as=cmini/1`, "GET");
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

  it("[LDB-L1] race: the same user liking twice at once -> one event, count 1, both 200", async () => {
    const record = await seed();
    const fake = actorFixture();
    const headers = register(fake, `tok-${uniqueName("dup")}`, "race-dup-user");

    const [a, b] = await Promise.all([
      writeFetch(`/v1/layouts/${record.id}/like`, "PUT", headers),
      writeFetch(`/v1/layouts/${record.id}/like`, "PUT", headers),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const row = await readById(db, record.id);
    expect(row?.like_count).toBe(1);
    const events = await db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE layout_id = ? AND kind = 'liked'")
      .bind(record.id)
      .first<{ n: number }>();
    expect(events?.n).toBe(1);
    await assertFoldMatchesRow(record.id);
  });
});
