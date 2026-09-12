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
// (the outer unlike's own, built from its stale reads), run the injected
// unlike to full completion FIRST -- its own nested `db.batch` call, by
// then past the `fired` guard, goes straight to the real implementation
// and actually commits -- THEN let the outer's original (stale-read,
// real-batch) call proceed. The outer's own batch SQL re-evaluates its
// EXISTS/NOT EXISTS checks against the database at EXECUTION time, not
// at construction time, so it now sees the injected commit for real.
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

// Fires `inject()` to completion on the FIRST call to the D1 binding's own
// `batch()` (whichever request reaches it first -- here, the outer
// unlike's own real code path), THEN calls through to the real
// implementation with the ORIGINAL (stale) arguments. Every later call
// (the injected unlike's own nested batch, any retry) is already past
// the `fired` guard and goes straight to the real thing.
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

  // LOW (coordinator review, third batch): the same conditional-insert
  // fix also closes a like racing a delete -- `loadForLike` checks
  // `deleted` before the batch, same TOCTOU shape as the unlike race
  // above, this time against `layouts.deleted` instead of `likes`.
  it("[LDB-L2] a like racing a delete that lands first -> 404, not a like on a tombstone", async () => {
    const OWNER = `mfl2b-owner-${uniqueName("u")}`;
    const name = uniqueName("mfl2b-race");
    const layoutId = await seed(OWNER, name);

    // One shared FakeDiscord for both actors (mf1-like-race.test.ts's own
    // note explains why a second independent fixture is unsafe here).
    const fake = actorFixture();
    const ownerHeaders = register(fake, `tok-${uniqueName("owner")}`, OWNER);
    const likerHeaders = register(fake, `tok-${uniqueName("liker")}`, `mfl2b-liker-${uniqueName("u")}`);

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
    expect(row!.like_count).toBe(0);
    const likedEvents = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE layout_id = ? AND kind = 'liked'").bind(layoutId).first<{ n: number }>();
    expect(likedEvents?.n, "no liked event was appended on the loser's side").toBe(0);
    const likeRows = await db.prepare("SELECT COUNT(*) AS n FROM likes WHERE layout_id = ?").bind(layoutId).first<{ n: number }>();
    expect(likeRows?.n).toBe(0);
  });
});
