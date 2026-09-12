// [LDB-L2] Coordinator review (third batch, HIGH): appendLike's own
// not-liked check (events.ts) is a read BEFORE the batch. A LIKE race is
// already atomic through the `likes` table's own (layout_id, user_id) PK
// (caught as a UNIQUE constraint failure -> already_liked), but an UNLIKE
// has no such constraint: two concurrent unlikes from the same user could
// both pass the pre-batch "am I currently liked" check, both DELETE (the
// loser's own DELETE just removes 0 rows, no error), and both append an
// `unliked` event -- the loser wrongly gets 200 (breaks L2) and the fold
// subtracts twice (breaks MF-3).
//
// Forces the race deterministically the same way mf6-http-races.test.ts
// does, but the earlier read-spy tricks (byRefWithFormats/readById) don't
// fit here: appendLike does TWO reads (the layout, then the `likes` row)
// before its batch, and both must see the OLD state for the race to be
// real -- spying on either read lets the outer call's SECOND, un-spied
// read see the injected unlike's already-committed result, which trips
// appendLike's own pre-batch check and throws before the batch ever runs
// (a false negative that doesn't exercise the fix at all: verified by
// hand, an early version of this test spied on `readById` and passed
// even with the batch's own EXISTS/NOT EXISTS guard mutated away).
// Spying on the D1 binding's own `batch` method instead lands the
// injection at exactly the right point: on the FIRST `db.batch` call
// (the outer request's own real code path), run the injected request to
// full completion FIRST -- its own nested `db.batch` call, by then past
// the `fired` guard, goes straight to the real implementation and
// actually commits -- THEN let the outer's original (stale-read,
// real-batch) call proceed. The outer's own batch SQL re-evaluates its
// EXISTS/NOT EXISTS checks against the database at EXECUTION time, not
// at construction time, so it now sees the injected commit for real.
//
// GOTCHA (found the hard way, worth stating): `resolveBearer`
// (src/auth/discord.ts) ALSO calls `db.batch` -- once per token, only on
// a COLD cache miss -- to write the auth-cache row. The very first time
// ANY test in this file uses a brand-new token, THAT batch call (deep
// inside auth, before the route handler even runs) is what a naive
// `injectOnceOnBatch` intercepts as "the first call", injecting the race
// far too early (before `loadForLike`/`appendLike` even run) and proving
// nothing. Every actor used inside a race below is auth-cache-WARMED with
// one throwaway `GET /v1/me` (or an earlier unrelated request using the
// same token) before the spy is installed, so the spy's "first call" is
// really the write path's own.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { commitWrite, foldLayout, rowToEvent, type CommitInput, type EventDbRow } from "../../src/core/events";
import { readById } from "../../src/core/records";
import { fixedClock } from "../../src/core/time";
import { ulid } from "ulidx";
import { AKL_PAYLOAD, actorFixture, register, uniqueName, writeFetch } from "./write-support";

const db = (env as unknown as Bindings).DB;
const clock = fixedClock("2026-07-24T00:00:00.000Z");
const SOURCE = { client: "discord-app:test", version: null };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function seed(owner: string, name: string): Promise<string> {
  const input: CommitInput = {
    layoutId: ulid(),
    creating: true,
    currentN: 0,
    currentLayout: null,
    currentFormats: new Map(),
    layout: { kind: "created", name, owner, created_at: clock(), deleted: false },
    format: { kind: "format_added", lineage: "spark", format: "spark/1", payload: AKL_PAYLOAD, hasMagic: false },
    modified_at: clock(),
    actor: owner,
    via: "discord",
    source: SOURCE,
    upstream: null,
  };
  const { layout } = await commitWrite(db, clock, input);
  return layout.id;
}

// Forces `resolveBearer`'s own one-time-per-token `db.batch` auth-cache
// write to happen NOW, outside any spy's watch -- see the file header.
async function warmAuth(headers: Record<string, string>): Promise<void> {
  const res = await writeFetch("/v1/me", "GET", headers);
  expect(res.status, "auth cache warm-up request must itself succeed").toBe(200);
}

// Fires `inject()` to completion on the FIRST call to the D1 binding's own
// `batch()` (the outer request's own real code path, given every actor
// used has already been auth-cache-warmed), THEN calls through to the
// real implementation with the ORIGINAL (stale) arguments. Every later
// call (the injected request's own nested batch, any retry) is already
// past the `fired` guard and goes straight to the real thing.
function injectOnceOnBatch(dbInstance: Bindings["DB"], inject: () => Promise<void>) {
  const original = dbInstance.batch.bind(dbInstance);
  let fired = false;
  return vi.spyOn(dbInstance, "batch").mockImplementation(async (...args) => {
    if (!fired) {
      fired = true;
      await inject();
    }
    return original(...(args as Parameters<typeof original>));
  });
}

async function assertFoldMatchesRow(layoutId: string) {
  const eventRows = await db.prepare("SELECT * FROM events WHERE layout_id = ? ORDER BY seq ASC").bind(layoutId).all<EventDbRow>();
  const events = eventRows.results.map(rowToEvent);
  const revRows = await db
    .prepare("SELECT lineage, rev, format, payload_json FROM layout_revs WHERE layout_id = ?")
    .bind(layoutId)
    .all<{ lineage: string | null; rev: number; format: string | null; payload_json: string | null }>();
  const revs = new Map(revRows.results.map((r) => [`${r.lineage ?? ""} ${r.rev}`, { format: r.format, payload: r.payload_json === null ? undefined : (JSON.parse(r.payload_json) as unknown) }]));
  const folded = foldLayout(events, revs);
  const row = await readById(db, layoutId);
  const { n: _n, ...rowSansN } = row!;
  expect(folded!.layout, "MF-3: fold must equal the stored row after the race").toEqual(rowSansN);
}

describe("[LDB-L2] a same-user unlike race: exactly one 200, one 409 not_liked, one event, fold == row", () => {
  it("[LDB-L2] the injected unlike wins; the outer one's stale-read batch finds the like already gone", async () => {
    const OWNER = `mfl2-owner-${uniqueName("u")}`;
    const name = uniqueName("mfl2-race");
    const layoutId = await seed(OWNER, name);

    const fake = actorFixture();
    const likerHeaders = register(fake, `tok-${uniqueName("liker")}`, `mfl2-liker-${uniqueName("u")}`);

    // The pre-like ALSO warms the liker's auth cache (its own token is
    // used again below), so the spy's "first call" really is appendLike's.
    const preLike = await writeFetch(`/v1/layouts/${name}/like`, "PUT", likerHeaders);
    expect(preLike.status).toBe(200);

    const spy = injectOnceOnBatch(db, async () => {
      const injectedRes = await writeFetch(`/v1/layouts/${name}/like`, "DELETE", likerHeaders);
      expect(injectedRes.status, "the injected unlike must itself land").toBe(200);
      await expect(injectedRes.json()).resolves.toEqual({ like_count: 0 });
    });

    const outerRes = await writeFetch(`/v1/layouts/${name}/like`, "DELETE", likerHeaders);
    spy.mockRestore();

    // The injected unlike commits first (200); the outer one's own batch
    // was built from a stale pre-batch read and finds, at commit time,
    // that this user no longer has a like row to remove -> 409 not_liked,
    // never a second silent 200.
    expect(outerRes.status).toBe(409);
    await expect(outerRes.json()).resolves.toMatchObject({ error: "not_liked" });

    const row = await readById(db, layoutId);
    expect(row!.like_count).toBe(0);
    const unlikedEvents = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE layout_id = ? AND kind = 'unliked'").bind(layoutId).first<{ n: number }>();
    expect(unlikedEvents?.n, "MF-3: exactly one unliked event, not two").toBe(1);
    const likeRows = await db.prepare("SELECT COUNT(*) AS n FROM likes WHERE layout_id = ?").bind(layoutId).first<{ n: number }>();
    expect(likeRows?.n).toBe(0);
    await assertFoldMatchesRow(layoutId);
  });
});

// Coordinator follow-up (same HIGH fix, 3e52dc5b9): the event insert was
// gated on `layouts.deleted = 0`, but the `INSERT INTO likes` / `DELETE
// FROM likes` statements in the SAME batch were NOT. A like racing a
// delete could still INSERT a likes row (and have it counted) on a
// tombstone with no event -- row != fold (MF-3), and the stray like is
// then inherited by the next layout of that name (LDB-P9). An unlike
// racing a delete could still DELETE a real like row with no event. Both
// statements are now gated on the SAME live condition, re-evaluated at
// batch-commit time -- the whole batch is one transaction, so every
// statement in it sees the same answer.
describe("[LDB-L2] a like/unlike racing a delete: 404, no stray likes-table change, fold == row", () => {
  it("[LDB-L2] a like racing a delete that lands first -> 404, no likes row inserted, like_count unchanged, no event", async () => {
    const OWNER = `mfl2b-owner-${uniqueName("u")}`;
    const name = uniqueName("mfl2b-race");
    const layoutId = await seed(OWNER, name);

    // One shared FakeDiscord for both actors (mf1-like-race.test.ts's own
    // note explains why a second independent fixture is unsafe here).
    const fake = actorFixture();
    const ownerHeaders = register(fake, `tok-${uniqueName("owner")}`, OWNER);
    const likerHeaders = register(fake, `tok-${uniqueName("liker")}`, `mfl2b-liker-${uniqueName("u")}`);
    // Warm BOTH actors' auth caches -- the injected delete uses the
    // owner's token for the first time, and the outer like uses the
    // liker's for the first time; either being cold would make
    // `resolveBearer`'s own `db.batch` call the one the spy intercepts.
    await warmAuth(ownerHeaders);
    await warmAuth(likerHeaders);

    const spy = injectOnceOnBatch(db, async () => {
      const deleteRes = await writeFetch(`/v1/layouts/${name}`, "DELETE", { ...ownerHeaders, "If-Match": '"layout:1"' });
      expect(deleteRes.status, "the injected delete must itself land").toBe(200);
    });

    const outerRes = await writeFetch(`/v1/layouts/${name}/like`, "PUT", likerHeaders);
    spy.mockRestore();

    // The delete commits first; the like's own batch, built before the
    // delete landed, finds at commit time that the layout is now a
    // tombstone -> 404, never a like recorded on a deleted record.
    expect(outerRes.status).toBe(404);

    const row = await readById(db, layoutId);
    expect(row!.deleted).toBe(true);
    expect(row!.like_count, "the tombstone's like_count must not move").toBe(0);
    const likedEvents = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE layout_id = ? AND kind = 'liked'").bind(layoutId).first<{ n: number }>();
    expect(likedEvents?.n, "no liked event was appended on the loser's side").toBe(0);
    const likeRows = await db.prepare("SELECT COUNT(*) AS n FROM likes WHERE layout_id = ?").bind(layoutId).first<{ n: number }>();
    expect(likeRows?.n, "no stray likes row on the tombstone (LDB-P9: a reused name must not inherit a like that never really landed)").toBe(0);
    await assertFoldMatchesRow(layoutId);
  });

  it("[LDB-L2] an unlike racing a delete that lands first -> 404, the real like row survives untouched on the tombstone", async () => {
    const OWNER = `mfl2c-owner-${uniqueName("u")}`;
    const name = uniqueName("mfl2c-race");
    const layoutId = await seed(OWNER, name);

    const fake = actorFixture();
    const ownerHeaders = register(fake, `tok-${uniqueName("owner")}`, OWNER);
    const likerHeaders = register(fake, `tok-${uniqueName("liker")}`, `mfl2c-liker-${uniqueName("u")}`);

    // A real, pre-existing like -- ALSO warms the liker's auth cache for
    // its own later (outer) request.
    const preLike = await writeFetch(`/v1/layouts/${name}/like`, "PUT", likerHeaders);
    expect(preLike.status).toBe(200);
    // The injected delete uses the owner's token for the first time.
    await warmAuth(ownerHeaders);

    const spy = injectOnceOnBatch(db, async () => {
      const deleteRes = await writeFetch(`/v1/layouts/${name}`, "DELETE", { ...ownerHeaders, "If-Match": '"layout:1"' });
      expect(deleteRes.status, "the injected delete must itself land").toBe(200);
    });

    const outerRes = await writeFetch(`/v1/layouts/${name}/like`, "DELETE", likerHeaders);
    spy.mockRestore();

    // The delete commits first; the unlike's own batch, built before the
    // delete landed, finds at commit time that the layout is now a
    // tombstone -> 404, and must never remove a like that's now part of
    // the tombstone's own carried-over history (LDB-P8: delete/restore
    // keep every stored format AND likes untouched).
    expect(outerRes.status).toBe(404);

    const row = await readById(db, layoutId);
    expect(row!.deleted).toBe(true);
    expect(row!.like_count, "the tombstone keeps the like it already had").toBe(1);
    const unlikedEvents = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE layout_id = ? AND kind = 'unliked'").bind(layoutId).first<{ n: number }>();
    expect(unlikedEvents?.n, "no unliked event was appended on the loser's side").toBe(0);
    const likeRows = await db.prepare("SELECT COUNT(*) AS n FROM likes WHERE layout_id = ?").bind(layoutId).first<{ n: number }>();
    expect(likeRows?.n, "the real like row must survive -- it was never actually undone").toBe(1);
    await assertFoldMatchesRow(layoutId);
  });
});
