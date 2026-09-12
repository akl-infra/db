// [LDB-P21] Coordinator review (M1): `commitWrite`'s own `layouts` upsert
// used to bind a STALE pre-read `like_count` (`finalLikeCount`, falling
// back to `input.currentLayout.like_count` for any write that isn't
// itself about a like) into `like_count = excluded.like_count` -- an
// ordinary format/layout write racing a concurrent like/unlike could
// silently revert it. `foldLayout` had the parallel bug: a layout-scope
// event's `after.like_count` (baked in at THAT write's own time, from the
// same stale source) overwrote the fold's own running `withLikeDelta`
// tally instead of being overridden by it.
//
// This drives the SAME injection technique `tests/api/mf6-http-races.
// test.ts` uses (a spy on `byRefWithFormats`, the read every write verb's
// `loadForWrite` starts with) to land a real like HTTP request strictly
// between a PUT's own fresh read and its commit, then checks: the PUT
// still lands, `like_count` reflects the injected like (not reverted),
// the row equals `COUNT(DISTINCT likes.user_id)` (LDB-L4), and
// `foldLayout`'s replay agrees with the row (MF-3) -- not just the value
// right after the like, but after the racing write on top of it too.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { commitWrite, foldLayout, rowToEvent, type CommitInput, type EventDbRow } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import { ulid } from "ulidx";
import * as recordsModule from "../../src/core/records";
import { readById } from "../../src/core/records";
import { AKL_PAYLOAD, actorFixture, register, uniqueName, writeFetch } from "./write-support";

const db = (env as unknown as Bindings).DB;
const clock = fixedClock("2026-07-22T00:00:00.000Z");
const SOURCE = { client: "discord-app:test", version: null };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface Seeded {
  id: string;
  owner: string;
  formatRev: number;
}

async function seed(owner: string): Promise<Seeded> {
  const input: CommitInput = {
    layoutId: ulid(),
    creating: true,
    currentN: 0,
    currentLayout: null,
    currentFormats: new Map(),
    layout: { kind: "created", name: uniqueName("mf1-like-race"), owner, created_at: clock(), deleted: false },
    format: { kind: "format_added", lineage: "spark", format: "spark/1", payload: AKL_PAYLOAD, hasMagic: false },
    modified_at: clock(),
    actor: owner,
    via: "discord",
    source: SOURCE,
    upstream: null,
  };
  const { layout, formats } = await commitWrite(db, clock, input);
  return { id: layout.id, owner, formatRev: formats.get("spark")!.rev };
}

// Same shape as mf6-http-races.test.ts's own helper: runs `inject()` to
// completion exactly once, the first time `byRefWithFormats` is called for
// `layoutId`, before returning control to the write that triggered it.
function injectOnce(layoutId: string, inject: () => Promise<void>) {
  const original = recordsModule.byRefWithFormats;
  let fired = false;
  return vi.spyOn(recordsModule, "byRefWithFormats").mockImplementation(async (...args) => {
    const result = await original(...args);
    if (!fired && args[1] === layoutId) {
      fired = true;
      await inject();
    }
    return result;
  });
}

async function assertFoldMatchesRowAndLikeCount(layoutId: string) {
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
  expect(folded!.layout, "MF-3: fold must equal the stored row, like_count included").toEqual(rowSansN);

  const likeRows = await db.prepare("SELECT COUNT(DISTINCT user_id) AS n FROM likes WHERE layout_id = ?").bind(layoutId).first<{ n: number }>();
  expect(row!.like_count, "LDB-L4: like_count === COUNT(DISTINCT likes.user_id)").toBe(likeRows?.n ?? 0);
}

describe("[LDB-P21] M1: a like landing between a write's read and its commit is never reverted", () => {
  it("a like injected mid-write survives the write's own upsert; fold == row; like_count == COUNT(likes)", async () => {
    const OWNER = `mf1-owner-${uniqueName("u")}`;
    const seeded = await seed(OWNER);
    // One shared FakeDiscord for both actors (see the unlike test below
    // for why a second independent fixture is unsafe here).
    const fake = actorFixture();
    const ownerHeaders = register(fake, `tok-${uniqueName("owner")}`, OWNER);
    const likerHeaders = register(fake, `tok-${uniqueName("liker")}`, `mf1-liker-${uniqueName("u")}`);

    const spy = injectOnce(seeded.id, async () => {
      const likeRes = await writeFetch(`/v1/layouts/${seeded.id}/like`, "PUT", likerHeaders);
      expect(likeRes.status, "the injected like must itself land").toBe(200);
    });

    const putRes = await writeFetch(
      `/v1/layouts/${seeded.id}`,
      "PUT",
      { ...ownerHeaders, "If-Match": `"spark:${seeded.formatRev}"` },
      { format: "spark/1", payload: { keys: { a: { row: 0, col: 0, finger: "LP" } } } },
    );
    spy.mockRestore();

    // Different scopes (the PUT is format-scope, the like is layout-scope
    // but untouched by If-Match, per D13 L3) never block each other --
    // the PUT lands, unaffected by the concurrent like.
    expect(putRes.status).toBe(200);

    const row = await readById(db, seeded.id);
    expect(row!.like_count, "M1: the write's own upsert must not revert the concurrent like").toBe(1);
    await assertFoldMatchesRowAndLikeCount(seeded.id);
  });

  it("an UNLIKE injected mid-write also survives the write's own upsert", async () => {
    const OWNER = `mf1b-owner-${uniqueName("u")}`;
    const seeded = await seed(OWNER);
    // One shared FakeDiscord for both actors -- actorFixture() re-stubs
    // the global `fetch`, so a second independent fixture created after
    // the owner's would silently break the owner's own token lookup on
    // its later request (this is exactly that bug, caught by this test).
    const fake = actorFixture();
    const ownerHeaders = register(fake, `tok-${uniqueName("owner")}`, OWNER);
    const likerId = `mf1b-liker-${uniqueName("u")}`;
    const likerHeaders = register(fake, `tok-${uniqueName("liker")}`, likerId);

    // Pre-like from a third party so there's something to unlike mid-race.
    const preLike = await writeFetch(`/v1/layouts/${seeded.id}/like`, "PUT", likerHeaders);
    expect(preLike.status).toBe(200);

    const spy = injectOnce(seeded.id, async () => {
      const unlikeRes = await writeFetch(`/v1/layouts/${seeded.id}/like`, "DELETE", likerHeaders);
      expect(unlikeRes.status, "the injected unlike must itself land").toBe(200);
    });

    const putRes = await writeFetch(
      `/v1/layouts/${seeded.id}`,
      "PUT",
      { ...ownerHeaders, "If-Match": `"spark:${seeded.formatRev}"` },
      { format: "spark/1", payload: { keys: { a: { row: 0, col: 0, finger: "LP" } } } },
    );
    spy.mockRestore();

    expect(putRes.status).toBe(200);
    const row = await readById(db, seeded.id);
    expect(row!.like_count, "M1: the write's own upsert must not revert the concurrent unlike").toBe(0);
    await assertFoldMatchesRowAndLikeCount(seeded.id);
  });
});
