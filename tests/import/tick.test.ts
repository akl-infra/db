// [LDB-I1] [LDB-I7] tick(): the full meta-gate -> plan -> fetch -> apply ->
// authors -> state cycle, against the FakeUpstream's upstream-100 snapshot.
import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import * as clientModule from "../../src/auth/client";
import * as discordModule from "../../src/auth/discord";
import { RevConflictError } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import * as ratelimitModule from "../../src/core/ratelimit";
import * as dumpModule from "../../src/dump/write";
import { dumpDue } from "../../src/dump/write";
import { restoreInto } from "../../src/dump/restore";
import * as applyModule from "../../src/import/apply";
import * as cminiModule from "../../src/import/cmini";
import { tick } from "../../src/import/cmini";
import * as difftickModule from "../../src/import/difftick";
import { diffDue } from "../../src/import/difftick";
import * as planModule from "../../src/import/plan";
import worker from "../../src/index";
import { FakeUpstream } from "./fake-upstream";

const bindings = env as unknown as Bindings;
const db = bindings.DB;

function envWithCap(cap: number): Bindings {
  return { ...bindings, IMPORT_MAX_WRITES_PER_TICK: String(cap) };
}

// Only hour:minute (UTC) drives scheduled()'s dispatch since the cron
// consolidation (one `*/5 * * * *` trigger, 12 §3 X4 follow-up 2) -- the
// date itself is arbitrary.
function atUTC(hour: number, minute: number): Date {
  return new Date(Date.UTC(2026, 6, 15, hour, minute));
}

async function countEvents(): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>();
  return row?.n ?? 0;
}

async function liveLayoutCount(): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM layouts WHERE deleted = 0").first<{ n: number }>();
  return row?.n ?? 0;
}

// vitest-pool-workers isolates storage per TEST FILE, not per `it` (07 §2):
// every test in this file shares one D1. The fixture reuses the same real
// upstream ids/names across tests, so each test needs a clean slate.
//
// LDB-D8: the "scheduled() wiring"/"scheduled() dispatch matrix" describes
// below drive `scheduled()` at every hour of `atUTC`'s fictional 2026-07-15
// -- a FRESH `dump.last_at`/`cmini.last_diff` (absent) is "due" immediately
// on the very first tick of any hour, which is correct catch-up behavior
// but would make an ordinary "safe hour" test (atUTC(12, 0), say) ALSO run
// a real writeDump/diffTick, unrelated to what that test means to check.
// Seeding both as "just run, at the top of this same fictional day" keeps
// every test in this file that never explicitly exercises catch-up (LDB-D8's
// own describe below does, with an explicitly STALE seed instead) on the
// pre-LDB-D8 behavior: dump/diff only at their preferred hour=3/hour=4
// slot, exactly as `[LDB-C5]`'s matrix asserts.
const SAME_DAY_START = "2026-07-15T00:00:00.000Z";
beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM events"),
    db.prepare("DELETE FROM layout_revs"),
    db.prepare("DELETE FROM likes"),
    db.prepare("DELETE FROM layouts"),
    db.prepare("DELETE FROM authors"),
    db.prepare("DELETE FROM import_map"),
    db.prepare("DELETE FROM import_state"),
    db
      .prepare("INSERT INTO import_state (key, value) VALUES ('dump.last_at', ?)")
      .bind(JSON.stringify({ at: SAME_DAY_START, seq: 0, key: "seed-dump-2026-07-15.json.gz" })),
    db.prepare("INSERT INTO import_state (key, value) VALUES ('cmini.last_diff', ?)").bind(JSON.stringify({ at: SAME_DAY_START, ok: true })),
  ]);
});


// design/layout-db/26-no-board.md: cmini's board word is dropped on import,
// so a board-only upstream change is NOT a content change any more -- the
// tests below that need "abyss changed upstream" flip one key's finger
// instead, a change that does reach the stored spark/1 payload.
function flipFirstKeyFinger(fake: FakeUpstream, name: string): { char: string; finger: string } {
  const keys = structuredClone(fake.detailByName(name).keys) as Record<string, { row: number; col: number; finger: string }>;
  const char = Object.keys(keys).sort()[0]!;
  const finger = keys[char]!.finger === "LP" ? "LR" : "LP";
  keys[char]!.finger = finger;
  fake.mutateDetailByName(name, { keys });
  return { char, finger };
}

function storedFinger(payloadJson: string, char: string): string | undefined {
  const payload = JSON.parse(payloadJson) as { keys: { char?: string; finger: string }[] };
  return payload.keys.find((k) => k.char === char)?.finger;
}

describe("tick()", () => {
  it("[LDB-I1] importing the fixture twice: the second tick is quiet, zero new events", async () => {
    const fake = new FakeUpstream();
    const clock = fixedClock("2026-06-01T00:00:00.000Z");

    const first = await tick(bindings, clock, fake.fetchImpl, fake.sleepImpl);
    expect(first.quiet).toBe(false);
    expect(await liveLayoutCount()).toBe(100);
    const eventsAfterFirst = await countEvents();

    const second = await tick(bindings, clock, fake.fetchImpl, fake.sleepImpl);
    expect(second.quiet).toBe(true);
    expect(await countEvents()).toBe(eventsAfterFirst);
  });

  it("[LDB-I1] a changed meta revision with identical content appends zero new events (daily full pass)", async () => {
    const fake = new FakeUpstream();
    const t0 = fixedClock("2026-06-02T00:00:00.000Z");
    const t1 = fixedClock("2026-06-03T02:00:00.000Z"); // +26h -- a full pass is due again

    await tick(bindings, t0, fake.fetchImpl, fake.sleepImpl);
    const before = await countEvents();

    fake.bumpMeta(); // forces the gate open again; no layout content changed
    const result = await tick(bindings, t1, fake.fetchImpl, fake.sleepImpl);
    expect(result.quiet).toBe(false); // the gate was open, so this isn't a "quiet" tick...
    expect(await countEvents()).toBe(before); // ...but nothing to write either
  });

  it("[LDB-I7] a tick whose /meta token is unchanged makes no list/detail/authors request", async () => {
    const fake = new FakeUpstream();
    const clock = fixedClock("2026-06-04T00:00:00.000Z");
    await tick(bindings, clock, fake.fetchImpl, fake.sleepImpl);

    fake.requestLog.length = 0;
    const result = await tick(bindings, clock, fake.fetchImpl, fake.sleepImpl);
    expect(result.quiet).toBe(true);
    expect(fake.requestLog).toHaveLength(1); // exactly the one /meta GET
    expect(fake.requestLog[0]!.url).toContain("/meta");
  });

  it("[LDB-I1] the fixture (100 layouts) imports in a single tick at the default write cap", async () => {
    const fake = new FakeUpstream();
    const clock = fixedClock("2026-06-05T00:00:00.000Z");
    const result = await tick(bindings, clock, fake.fetchImpl, fake.sleepImpl);
    expect(result.quiet).toBe(false);
    expect(await liveLayoutCount()).toBe(100);
  });

  it("[LDB-I1] with IMPORT_MAX_WRITES_PER_TICK=20, all 100 layouts exist within 5 ticks, and the import eventually goes idempotent", async () => {
    const fake = new FakeUpstream();
    const cappedEnv = envWithCap(20);
    const clock = fixedClock("2026-06-06T00:00:00.000Z");

    for (let i = 0; i < 5; i++) {
      await tick(cappedEnv, clock, fake.fetchImpl, fake.sleepImpl);
    }
    expect(await liveLayoutCount()).toBe(100); // every layout imported within 5 ticks

    // Keep ticking (the daily full-pass sweep over already-imported records
    // still needs to drain under the same tiny cap) until quiet, bounded so
    // a real regression fails fast instead of hanging.
    let quiet = false;
    for (let i = 0; i < 20 && !quiet; i++) {
      const result = await tick(cappedEnv, clock, fake.fetchImpl, fake.sleepImpl);
      quiet = result.quiet;
    }
    expect(quiet).toBe(true);

    const eventsAtQuiet = await countEvents();
    const again = await tick(cappedEnv, clock, fake.fetchImpl, fake.sleepImpl);
    expect(again.quiet).toBe(true);
    expect(await countEvents()).toBe(eventsAtQuiet); // idempotent
  });

  it("uses ?full=1 when more than 50 ids need fetching, and per-id GETs otherwise", async () => {
    const fake = new FakeUpstream();
    const clock = fixedClock("2026-06-07T00:00:00.000Z");
    await tick(bindings, clock, fake.fetchImpl, fake.sleepImpl); // 100 ids > 50 -> full=1
    expect(fake.requestLog.some((r) => r.url.includes("full=1"))).toBe(true);
    expect(fake.requestLog.some((r) => /\/layouts\/[^?]+$/.test(r.url))).toBe(false);
  });

  it("uses per-id GETs when 50 or fewer ids need fetching", async () => {
    const fake = new FakeUpstream();
    // Trim the fixture list/full sets down to <=50 so the very first tick's
    // backlog is small.
    for (const id of fake.ids().slice(50)) fake.removeFromList(id);
    const clock = fixedClock("2026-06-08T00:00:00.000Z");
    const result = await tick(bindings, clock, fake.fetchImpl, fake.sleepImpl);
    expect(result.quiet).toBe(false);
    expect(fake.requestLog.some((r) => r.url.includes("full=1"))).toBe(false);
    expect(fake.requestLog.some((r) => /\/layouts\/[^?]+$/.test(r.url))).toBe(true);
    expect(await liveLayoutCount()).toBe(50);
  });

  it("a 404 on a listed id becomes a tombstone that same tick", async () => {
    const fake = new FakeUpstream();
    const targetName = fake.listEntry("graphite").name;
    const clock = fixedClock("2026-06-09T00:00:00.000Z");
    await tick(bindings, clock, fake.fetchImpl, fake.sleepImpl); // graphite imported

    fake.set404("graphite");
    fake.removeFromList("graphite"); // it also leaves the list -- a real deletion
    fake.bumpMeta();
    await tick(bindings, clock, fake.fetchImpl, fake.sleepImpl);

    const row = await db.prepare("SELECT deleted FROM layouts WHERE name = ?").bind(targetName).first<{ deleted: number }>();
    expect(row?.deleted).toBe(1);
  });

  // 20-spark.md S3b (LDB-P14's importer case, §8 R-H4): every system write
  // in `applyFetchedId`/`applyDeleteAction` carries `expectRev`, and
  // `tick()` itself is what turns a lost race into a counted `raced`
  // rather than an unhandled throw that would abort the whole tick (and
  // every other id it was about to process). Simulated here by making the
  // apply layer itself throw `RevConflictError` for one id -- the same
  // exception `appendWrite` throws for real when a user write lands
  // between a system writer's read and its own write.
  it("[LDB-P14] a RevConflictError from one id's apply is caught, counted as 'raced', and never aborts the tick", async () => {
    const fake = new FakeUpstream();
    const clock = fixedClock("2026-06-09T12:00:00.000Z");
    await tick(bindings, clock, fake.fetchImpl, fake.sleepImpl); // graphite + 99 others imported

    fake.set404("graphite");
    fake.removeFromList("graphite"); // graphite is now a delete case
    const abyssId = fake.ids().find((id) => fake.listEntry(id).name === "abyss")!;
    const flipped = flipFirstKeyFinger(fake, "abyss");
    // `planTick` decides "fetch" off the LIST entry's own modified_at/
    // like_count, not the detail -- the list entry must move too, or abyss
    // would never be selected for re-fetch this tick.
    fake.mutateListEntry(abyssId, { modified_at: "2026-06-09T13:00:00.000Z" });
    fake.bumpMeta();

    const realApplyFetchedId = applyModule.applyFetchedId;
    const applyFetchedIdSpy = vi.spyOn(applyModule, "applyFetchedId").mockImplementation(async (db, now, id, raw) => {
      if (id === "abyss") throw new RevConflictError("some-layout-id");
      return realApplyFetchedId(db, now, id, raw);
    });
    const realApplyDeleteAction = applyModule.applyDeleteAction;
    const applyDeleteActionSpy = vi.spyOn(applyModule, "applyDeleteAction").mockImplementation(async (db, now, action) => {
      throw new RevConflictError(action.layoutId);
    });

    let result: Awaited<ReturnType<typeof tick>>;
    try {
      result = await tick(bindings, clock, fake.fetchImpl, fake.sleepImpl);
    } finally {
      applyFetchedIdSpy.mockRestore();
      applyDeleteActionSpy.mockRestore();
    }

    expect(result.stats.raced).toBe(2); // abyss's update, graphite's delete
    expect(result.stats.errors).toEqual([]); // a race is never reported as a shape error
    // Neither raced write landed: abyss keeps its pre-tick content, graphite stays live.
    const abyssRow = await db
      .prepare("SELECT payload_json FROM layout_formats f JOIN layouts l ON l.id = f.layout_id WHERE l.name = 'abyss' AND f.lineage = 'spark'")
      .first<{ payload_json: string }>();
    expect(storedFinger(abyssRow!.payload_json, flipped.char)).not.toBe(flipped.finger);
    const graphiteRow = await db.prepare("SELECT deleted FROM layouts WHERE name = 'graphite'").first<{ deleted: number }>();
    expect(graphiteRow?.deleted).toBe(0);

    // Re-verify the delete alone abolishes 'raced' via `applyDeleteAction`'s
    // real path can still be re-evaluated next tick undisturbed: without
    // this catch, the thrown error above would have aborted the tick before
    // `cmini.last_tick` was ever written.
    const stored = await db.prepare("SELECT value FROM import_state WHERE key = 'cmini.last_tick'").first<{ value: string }>();
    expect(stored).not.toBeNull();
    expect((JSON.parse(stored!.value) as { raced?: number }).raced).toBe(2);
  });

  it("a shape-invalid detail is skipped and reported in cmini.last_tick, never a tick failure", async () => {
    const fake = new FakeUpstream();
    fake.mutateDetailByName("graphite", { board: "not-a-real-board" });
    const clock = fixedClock("2026-06-10T00:00:00.000Z");

    const result = await tick(bindings, clock, fake.fetchImpl, fake.sleepImpl);
    expect(result.quiet).toBe(false);
    expect(result.stats.errors).toBeDefined();
    expect(result.stats.errors!.some((e) => e.id === "graphite")).toBe(true);
    expect(await db.prepare("SELECT 1 FROM layouts WHERE name = 'graphite'").first()).toBeNull();

    const stored = await db.prepare("SELECT value FROM import_state WHERE key = 'cmini.last_tick'").first<{ value: string }>();
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!.value) as { errors: { id: string }[] };
    expect(parsed.errors.some((e) => e.id === "graphite")).toBe(true);
  });

  // B5 (design/layout-db/review/audit-db.md B5): any non-conflict error
  // thrown by one id's `applyFetchedId` (a real bug, a D1 hiccup -- not a
  // `RevConflictError`, which is `raced`'s own job) used to propagate
  // straight out of `tick()`, aborting every id queued behind it AND
  // leaving `cmini.meta_token` unmoved (so the next tick reruns the whole
  // backlog, hitting the same bad id forever). It's now caught per id,
  // recorded as an `import_error` info event, and counted -- the tick
  // still completes and stores the token.
  it("[LDB-I21] a non-conflict error from one id's apply is recorded, counted, and never aborts the tick -- the meta token still stores", async () => {
    const fake = new FakeUpstream();
    const clock = fixedClock("2026-06-11T00:00:00.000Z");
    await tick(bindings, clock, fake.fetchImpl, fake.sleepImpl); // 100 imported

    const targetName = "abyss";
    const abyssId = fake.ids().find((id) => fake.listEntry(id).name === targetName)!;
    flipFirstKeyFinger(fake, targetName);
    // `planTick` decides "fetch" off the LIST entry's own modified_at --
    // the list entry must move too, or abyss would never be re-selected.
    fake.mutateListEntry(abyssId, { modified_at: "2026-06-11T01:00:00.000Z" });
    fake.bumpMeta();

    const realApplyFetchedId = applyModule.applyFetchedId;
    const applyFetchedIdSpy = vi.spyOn(applyModule, "applyFetchedId").mockImplementation(async (db, now, id, raw) => {
      if (id === abyssId) throw new Error("boom: simulated apply failure");
      return realApplyFetchedId(db, now, id, raw);
    });

    let result: Awaited<ReturnType<typeof tick>>;
    try {
      result = await tick(bindings, clock, fake.fetchImpl, fake.sleepImpl);
    } finally {
      applyFetchedIdSpy.mockRestore();
    }

    expect(result.stats.errored).toBe(1);
    expect(result.stats.raced ?? 0).toBe(0);
    expect(result.stats.errors).toEqual([]); // a thrown error is never reported as a shape error

    const abyssRow = await db.prepare("SELECT id FROM layouts WHERE name = ?").bind(targetName).first<{ id: string }>();
    const errEvents = await db
      .prepare("SELECT detail_json FROM events WHERE layout_id = ? AND kind = 'import_error'")
      .bind(abyssRow!.id)
      .all<{ detail_json: string }>();
    expect(errEvents.results).toHaveLength(1);
    expect(JSON.parse(errEvents.results[0]!.detail_json)).toMatchObject({ upstream_id: abyssId, message: expect.stringContaining("boom") });

    // the tick still stored the meta token (never wedged) -- a following
    // tick against the SAME (unchanged since) upstream state is quiet.
    const again = await tick(bindings, clock, fake.fetchImpl, fake.sleepImpl);
    expect(again.quiet).toBe(true);
  });

  // LDB-I24 (migrations/0018): before this fix, `layouts.modified_at` never
  // caught up with upstream's when an upstream change writes nothing at
  // all -- an upstream cmini change confined to the board word (spark/1
  // carries no board, docs/decisions/26-no-board.md) plus its own bumped
  // `modified_at` is a real listed change (fetched once), but leaves
  // nothing for `applyMapped` to write (`layoutDiffers`/`payloadDiffers`
  // both false), so the OLD plan.ts (comparing against `layouts.modified_at`
  // directly) would re-fetch the SAME id forever. `import_map.upstream_
  // modified_at` is what actually catches up (`applyFetchedId` records it
  // regardless of whether the apply wrote anything), so the following tick
  // does not fetch it again.
  it("[LDB-I24] a board-only upstream change (spark/1 drops it) is fetched once, then not re-fetched", async () => {
    const fake = new FakeUpstream();
    const clock = fixedClock("2026-06-12T00:00:00.000Z");
    await tick(bindings, clock, fake.fetchImpl, fake.sleepImpl); // 100 imported

    const targetName = "abyss";
    const targetId = fake.ids().find((id) => fake.listEntry(id).name === targetName)!;
    const detailUrlPattern = new RegExp(`/layouts/${targetId}$`);

    const currentBoard = fake.detailByName(targetName).board as string;
    // Both the LIST entry's own `modified_at` (what `planTick` selects on)
    // and the DETAIL's own `modified_at` (what `applyFetchedId` actually
    // records into `upstream_modified_at`) must move -- a real upstream
    // record bump touches both at once.
    fake.mutateDetailByName(targetName, { board: currentBoard === "ortho" ? "angle" : "ortho", modified_at: "2026-06-12T01:00:00.000Z" });
    fake.mutateListEntry(targetId, { modified_at: "2026-06-12T01:00:00.000Z" });
    fake.bumpMeta();
    fake.requestLog.length = 0;

    const first = await tick(bindings, clock, fake.fetchImpl, fake.sleepImpl);
    expect(first.quiet).toBe(false);
    expect(fake.requestLog.filter((r) => detailUrlPattern.test(r.url))).toHaveLength(1); // fetched exactly once
    const row = await db.prepare("SELECT upstream_modified_at FROM import_map WHERE upstream_id = ?").bind(targetId).first<{ upstream_modified_at: string }>();
    expect(row!.upstream_modified_at).toBe("2026-06-12T01:00:00.000Z"); // caught up even though nothing was written

    // Nothing else changed -- open the meta gate again with no new content
    // change, so a following tick with the SAME list entry must not
    // re-select this id.
    fake.bumpMeta();
    fake.requestLog.length = 0;
    const second = await tick(bindings, clock, fake.fetchImpl, fake.sleepImpl);
    expect(second.quiet).toBe(false); // the gate was open (bumpMeta), but nothing was planned for THIS id
    expect(fake.requestLog.filter((r) => detailUrlPattern.test(r.url))).toHaveLength(0); // not re-fetched
  });

  // LDB-I24: a REAL content change (one spark/1 carries) is re-imported as
  // before -- but a content-only write has no layout part, so it does NOT
  // move `layouts.modified_at` (`core/events.ts`'s `commitWrite`). The old
  // plan.ts, comparing against that, re-fetched this id on every tick
  // forever (the live `packet`/`dopamine` case, 2026-09-14); with
  // `upstream_modified_at` caught up, the following tick leaves it alone.
  it("[LDB-I24] a real content change is re-imported once, then not re-fetched", async () => {
    const fake = new FakeUpstream();
    const clock = fixedClock("2026-06-12T12:00:00.000Z");
    await tick(bindings, clock, fake.fetchImpl, fake.sleepImpl); // 100 imported

    const targetName = "abyss";
    const targetId = fake.ids().find((id) => fake.listEntry(id).name === targetName)!;
    const detailUrlPattern = new RegExp(`/layouts/${targetId}$`);

    const flipped = flipFirstKeyFinger(fake, targetName);
    // The list entry AND the detail's own `modified_at` both move, same as
    // a real upstream edit would.
    fake.mutateDetailByName(targetName, { modified_at: "2026-06-12T13:00:00.000Z" });
    fake.mutateListEntry(targetId, { modified_at: "2026-06-12T13:00:00.000Z" });
    fake.bumpMeta();
    fake.requestLog.length = 0;

    const first = await tick(bindings, clock, fake.fetchImpl, fake.sleepImpl);
    expect(first.quiet).toBe(false);
    expect(fake.requestLog.filter((r) => detailUrlPattern.test(r.url))).toHaveLength(1);
    const abyssRow = await db
      .prepare("SELECT payload_json FROM layout_formats f JOIN layouts l ON l.id = f.layout_id WHERE l.name = ? AND f.lineage = 'spark'")
      .bind(targetName)
      .first<{ payload_json: string }>();
    expect(storedFinger(abyssRow!.payload_json, flipped.char)).toBe(flipped.finger);
    const mapRow = await db.prepare("SELECT upstream_modified_at FROM import_map WHERE upstream_id = ?").bind(targetId).first<{ upstream_modified_at: string }>();
    expect(mapRow!.upstream_modified_at).toBe("2026-06-12T13:00:00.000Z");

    fake.bumpMeta();
    fake.requestLog.length = 0;
    const second = await tick(bindings, clock, fake.fetchImpl, fake.sleepImpl);
    expect(second.quiet).toBe(false);
    expect(fake.requestLog.filter((r) => detailUrlPattern.test(r.url))).toHaveLength(0);
  });

  // LDB-I24: `import_map.upstream_modified_at` round-trips through
  // dump/restore like `upstream_name` (migrations/0013) already does.
  it("[LDB-I24] upstream_modified_at round-trips through buildDump/restoreInto", async () => {
    const fake = new FakeUpstream();
    const clock = fixedClock("2026-06-13T00:00:00.000Z");
    await tick(bindings, clock, fake.fetchImpl, fake.sleepImpl); // 100 imported, import_map populated

    const targetId = fake.ids().find((id) => fake.listEntry(id).name === "abyss")!;
    const before = await db.prepare("SELECT upstream_modified_at FROM import_map WHERE upstream_id = ?").bind(targetId).first<{ upstream_modified_at: string }>();
    expect(before!.upstream_modified_at).not.toBeNull();

    const dump = await dumpModule.buildDump(bindings, clock);
    const dumpedRow = dump.import_map.find((r) => r.upstream_id === targetId);
    expect(dumpedRow?.upstream_modified_at).toBe(before!.upstream_modified_at);

    await restoreInto(db, dump);
    const after = await db.prepare("SELECT upstream_modified_at FROM import_map WHERE upstream_id = ?").bind(targetId).first<{ upstream_modified_at: string }>();
    expect(after!.upstream_modified_at).toBe(before!.upstream_modified_at);
  });

  // A dump written before migrations/0018 has no `upstream_modified_at` key
  // on its `import_map` rows at all -- `restore.ts`'s own `?? null` fallback
  // (the same one `upstream_name` already relies on) must restore it as
  // NULL, not throw or coerce it to some other value.
  it("[LDB-I24] a dump row without upstream_modified_at (pre-0018 shape) restores as NULL", async () => {
    const fake = new FakeUpstream();
    const clock = fixedClock("2026-06-13T01:00:00.000Z");
    await tick(bindings, clock, fake.fetchImpl, fake.sleepImpl);

    const targetId = fake.ids().find((id) => fake.listEntry(id).name === "abyss")!;
    const dump = await dumpModule.buildDump(bindings, clock);
    const legacyImportMap = dump.import_map.map((r) => {
      if (r.upstream_id !== targetId) return r;
      const { upstream_modified_at: _dropped, ...rest } = r; // simulate a pre-0018 dump row
      return rest;
    });

    await restoreInto(db, { ...dump, import_map: legacyImportMap });
    const restored = await db.prepare("SELECT upstream_modified_at FROM import_map WHERE upstream_id = ?").bind(targetId).first<{ upstream_modified_at: string | null }>();
    expect(restored!.upstream_modified_at).toBeNull();
  });

  // LDB-I22 (saltorbit 2026-09-13, hostile-upstream concern): the per-tick
  // bound (LDB-I3, max(5, 5%)) alone lets a "slow drip" through -- this
  // proves the ROLLING 24h budget catches exactly that, end to end
  // (real D1-backed `countDeletesAppliedSince`, not just planTick's own
  // pure unit tests).
  describe("[LDB-I22] the rolling 24h delete budget", () => {
    it("[LDB-I22] 4 rounds of 5 deletes (within the per-tick bound each time) apply in full; the 5th, which would push the rolling total to 25, stalls entirely -- [LDB-M3] cmini.stalled reflects it", async () => {
      const fake = new FakeUpstream();
      const t0 = fixedClock("2026-06-11T12:00:00.000Z");
      await tick(bindings, t0, fake.fetchImpl, fake.sleepImpl); // 100 imported

      // 100 live records: per-tick bound = max(5, 5%) = 5 throughout (the
      // corpus only shrinks by 5 each round, never enough to change the
      // floor); rolling budget = max(20, 2%) = 20 throughout too.
      const ids = fake.ids();
      for (let round = 0; round < 4; round++) {
        for (const id of ids.slice(round * 5, round * 5 + 5)) fake.removeFromList(id);
        fake.bumpMeta();
        const result = await tick(bindings, t0, fake.fetchImpl, fake.sleepImpl);
        expect(result.stats.deletes_planned, `round ${round}`).toBe(5);
        expect(result.stats.deletes_applied, `round ${round}`).toBe(5);
        expect(result.stats.delete_stalled, `round ${round}`).toBeNull();
      }
      expect(await liveLayoutCount()).toBe(80); // 100 - 4*5

      // Round 5: 5 more unlisted ids -- within the PER-TICK bound (5) on
      // its own, but 20 (already applied) + 5 = 25 > the rolling budget
      // (20) -- stalled entirely, never partially applied.
      for (const id of ids.slice(20, 25)) fake.removeFromList(id);
      fake.bumpMeta();
      const stalled = await tick(bindings, t0, fake.fetchImpl, fake.sleepImpl);
      expect(stalled.stats.deletes_planned).toBe(5);
      expect(stalled.stats.deletes_applied).toBe(0);
      expect(stalled.stats.delete_stalled).toMatch(/rolling 24h budget/);
      expect(await liveLayoutCount()).toBe(80); // unchanged

      // `cmini.stalled` itself (what `/v1/meta`'s health.import surfaces --
      // tested end to end with real-relative timestamps in meta.test.ts,
      // since that route's `nowIso` is real wall-clock, never this test's
      // fictional `fixedClock`).
      const stalledState = await db.prepare("SELECT value FROM import_state WHERE key = 'cmini.stalled'").first<{ value: string }>();
      expect(stalledState).not.toBeNull();
      expect(JSON.parse(stalledState!.value).reason).toMatch(/rolling 24h budget/);
    });
  });

  // LDB-I23: `IMPORT_DELETES=off` -- the kill switch for a hostile/broken
  // upstream. Zero tombstones regardless of the listing, with the same
  // stalled-style visibility LDB-I3/I22 use.
  describe("[LDB-I23] IMPORT_DELETES kill switch", () => {
    function envWithDeletesOff(): Bindings {
      return { ...bindings, IMPORT_DELETES: "off" };
    }

    it("[LDB-I23] a real delete candidate is never tombstoned while the switch is off, and re-stalls visibly", async () => {
      const fake = new FakeUpstream();
      const t0 = fixedClock("2026-06-11T18:00:00.000Z");
      const offEnv = envWithDeletesOff();
      await tick(offEnv, t0, fake.fetchImpl, fake.sleepImpl); // 100 imported

      const targetName = fake.listEntry("graphite").name;
      fake.removeFromList("graphite");
      fake.bumpMeta();
      const result = await tick(offEnv, t0, fake.fetchImpl, fake.sleepImpl);

      expect(result.stats.deletes_disabled).toBe(true);
      expect(result.stats.deletes_planned).toBe(1);
      expect(result.stats.deletes_applied).toBe(0);
      expect(result.stats.delete_stalled).toMatch(/IMPORT_DELETES=off/);

      const row = await db.prepare("SELECT deleted FROM layouts WHERE name = ?").bind(targetName).first<{ deleted: number }>();
      expect(row?.deleted).toBe(0); // never tombstoned

      const stalledState = await db.prepare("SELECT value FROM import_state WHERE key = 'cmini.stalled'").first<{ value: string }>();
      expect(stalledState).not.toBeNull();

      // The next tick, still off, re-evaluates from scratch and re-stalls
      // identically -- the switch is a standing state, not a one-shot skip.
      fake.bumpMeta();
      const again = await tick(offEnv, t0, fake.fetchImpl, fake.sleepImpl);
      expect(again.stats.deletes_applied).toBe(0);
      expect(again.stats.delete_stalled).toMatch(/IMPORT_DELETES=off/);

      // Flipping it back on lets the SAME pending delete through on the
      // very next tick.
      fake.bumpMeta();
      const backOn = await tick(bindings, t0, fake.fetchImpl, fake.sleepImpl);
      expect(backOn.stats.deletes_applied).toBe(1);
      expect(backOn.stats.delete_stalled).toBeNull();
      const rowAfter = await db.prepare("SELECT deleted FROM layouts WHERE name = ?").bind(targetName).first<{ deleted: number }>();
      expect(rowAfter?.deleted).toBe(1);
    });

    it("[LDB-I23] never blocks fetches, and reports no stall when nothing is actually pending to delete", async () => {
      const fake = new FakeUpstream();
      const t0 = fixedClock("2026-06-11T19:00:00.000Z");
      const offEnv = envWithDeletesOff();
      const result = await tick(offEnv, t0, fake.fetchImpl, fake.sleepImpl); // 100 imported, nothing to delete
      expect(result.stats.deletes_disabled).toBe(true);
      expect(result.stats.deletes_planned).toBe(0);
      expect(result.stats.delete_stalled).toBeNull(); // nothing was actually suppressed
      expect(await liveLayoutCount()).toBe(100);
    });

    it("[LDB-I23] does not stall the whole tick -- an unrelated fetch still lands while a delete is suppressed", async () => {
      const fake = new FakeUpstream();
      const t0 = fixedClock("2026-06-11T20:00:00.000Z");
      const offEnv = envWithDeletesOff();
      await tick(offEnv, t0, fake.fetchImpl, fake.sleepImpl); // 100 imported

      fake.removeFromList("graphite"); // suppressed delete candidate
      const abyssId = fake.ids().find((id) => fake.listEntry(id).name === "abyss")!;
      const flipped = flipFirstKeyFinger(fake, "abyss");
      fake.mutateListEntry(abyssId, { modified_at: "2026-06-11T20:30:00.000Z" });
      fake.bumpMeta();

      const result = await tick(offEnv, t0, fake.fetchImpl, fake.sleepImpl);
      expect(result.stats.deletes_applied).toBe(0);
      expect(result.stats.applied).toBeGreaterThan(0); // abyss's own fetch still landed
      const abyssRow = await db
        .prepare("SELECT payload_json FROM layout_formats f JOIN layouts l ON l.id = f.layout_id WHERE l.name = 'abyss' AND f.lineage = 'spark'")
        .first<{ payload_json: string }>();
      expect(storedFinger(abyssRow!.payload_json, flipped.char)).toBe(flipped.finger);
    });
  });

  // LDB-I6 explicit cases (saltorbit 2026-09-13's hostile-upstream ask):
  // "upstream empty or gone" must never delete anything.
  describe("[LDB-I6] upstream empty / gone", () => {
    it("[LDB-I6] an upstream that empties its ENTIRE listing collapses the tick and deletes nothing", async () => {
      const fake = new FakeUpstream();
      const t0 = fixedClock("2026-06-11T21:00:00.000Z");
      await tick(bindings, t0, fake.fetchImpl, fake.sleepImpl); // 100 imported

      for (const id of fake.ids()) fake.removeFromList(id);
      fake.bumpMeta();
      const result = await tick(bindings, t0, fake.fetchImpl, fake.sleepImpl);
      expect(result.stats.collapsed).toBe(true);
      expect(await liveLayoutCount()).toBe(100); // untouched
    });

    it("[LDB-I6] a non-2xx listing throws, applies nothing, and the lock is released for the next attempt", async () => {
      const fake = new FakeUpstream();
      const t0 = fixedClock("2026-06-11T22:00:00.000Z");
      await tick(bindings, t0, fake.fetchImpl, fake.sleepImpl); // 100 imported
      fake.bumpMeta();
      fake.failNextRequestsMatching("/layouts", 3); // exhausts list()'s own retry budget (LDB-I8)

      await expect(tick(bindings, t0, fake.fetchImpl, fake.sleepImpl)).rejects.toThrow();
      expect(await liveLayoutCount()).toBe(100); // untouched -- the tick threw before any write

      // the lock was released in `finally` despite the throw -- a fresh
      // attempt right after (no more forced failures) proceeds normally.
      const recovered = await tick(bindings, t0, fake.fetchImpl, fake.sleepImpl);
      expect(recovered.quiet).toBe(false);
      expect(await liveLayoutCount()).toBe(100);
    });
  });

  // B4 (design/layout-db/review/audit-db.md B4): overlapping ticks (the
  // `*/5` cron and a manual admin kick both landing while a slow tick is
  // still running) had no lock. `import_state['cmini.running']` now gates
  // the whole tick body.
  describe("[LDB-C7] the import lock (import_state['cmini.running'])", () => {
    it("[LDB-C7] a tick finds the lock already held (not expired) and skips quietly, touching nothing", async () => {
      const fake = new FakeUpstream();
      const clock = fixedClock("2026-06-12T00:00:00.000Z");

      await db
        .prepare("INSERT INTO import_state (key, value) VALUES ('cmini.running', ?)")
        .bind(JSON.stringify({ at: clock(), id: "other-invocation" }))
        .run();

      const result = await tick(bindings, clock, fake.fetchImpl, fake.sleepImpl);
      expect(result.quiet).toBe(true);
      expect(result.stats.skipped_locked).toBe(true);
      expect(await liveLayoutCount()).toBe(0); // the tick body never ran

      const lockRow = await db.prepare("SELECT value FROM import_state WHERE key = 'cmini.running'").first<{ value: string }>();
      expect(JSON.parse(lockRow!.value)).toMatchObject({ id: "other-invocation" }); // untouched -- still the other holder's
    });

    it("[LDB-C7] an expired lock (>10 minutes old) is reclaimed and the tick proceeds normally", async () => {
      const fake = new FakeUpstream();
      const t0 = fixedClock("2026-06-13T00:00:00.000Z");
      const staleAt = "2026-06-12T23:49:00.000Z"; // 11 minutes before t0()

      await db
        .prepare("INSERT INTO import_state (key, value) VALUES ('cmini.running', ?)")
        .bind(JSON.stringify({ at: staleAt, id: "dead-invocation" }))
        .run();

      const result = await tick(bindings, t0, fake.fetchImpl, fake.sleepImpl);
      expect(result.quiet).toBe(false);
      expect(result.stats.skipped_locked).toBeUndefined();
      expect(await liveLayoutCount()).toBe(100); // the tick body ran normally

      // released after a successful tick -- nothing left held
      const lockRow = await db.prepare("SELECT value FROM import_state WHERE key = 'cmini.running'").first();
      expect(lockRow).toBeNull();
    });

    it("[LDB-C7] a lock held just under 10 minutes is still held; exactly 10 minutes counts as expired", async () => {
      const fake = new FakeUpstream();
      const t0 = fixedClock("2026-06-13T12:00:00.000Z");

      // 9m59s: still held.
      await db
        .prepare("INSERT INTO import_state (key, value) VALUES ('cmini.running', ?)")
        .bind(JSON.stringify({ at: "2026-06-13T11:50:01.000Z", id: "borderline-invocation" }))
        .run();
      const stillHeld = await tick(bindings, t0, fake.fetchImpl, fake.sleepImpl);
      expect(stillHeld.stats.skipped_locked).toBe(true);
      expect(await liveLayoutCount()).toBe(0);

      // exactly 10m: reclaimed, tick proceeds.
      await db
        .prepare("UPDATE import_state SET value = ? WHERE key = 'cmini.running'")
        .bind(JSON.stringify({ at: "2026-06-13T11:50:00.000Z", id: "borderline-invocation" }))
        .run();
      const reclaimed = await tick(bindings, t0, fake.fetchImpl, fake.sleepImpl);
      expect(reclaimed.stats.skipped_locked).toBeUndefined();
      expect(await liveLayoutCount()).toBe(100);
    });

    it("[LDB-C7] the lock is released even when the tick body throws, so the next tick can still acquire it", async () => {
      const fake = new FakeUpstream();
      const clock = fixedClock("2026-06-14T00:00:00.000Z");

      const planSpy = vi.spyOn(planModule, "planTick").mockImplementationOnce(() => {
        throw new Error("boom: simulated tick-body failure");
      });
      await expect(tick(bindings, clock, fake.fetchImpl, fake.sleepImpl)).rejects.toThrow("boom");
      planSpy.mockRestore();

      const lockRow = await db.prepare("SELECT value FROM import_state WHERE key = 'cmini.running'").first();
      expect(lockRow).toBeNull(); // released in `finally` despite the throw

      const result = await tick(bindings, clock, fake.fetchImpl, fake.sleepImpl);
      expect(result.stats.skipped_locked).toBeUndefined(); // acquires cleanly, runs normally
      expect(await liveLayoutCount()).toBe(100);
    });

    it("[LDB-C7] a quiet tick (meta token unchanged) never touches the lock at all", async () => {
      const fake = new FakeUpstream();
      const clock = fixedClock("2026-06-15T00:00:00.000Z");
      await tick(bindings, clock, fake.fetchImpl, fake.sleepImpl); // real tick, lock taken+released

      const before = await db.prepare("SELECT value FROM import_state WHERE key = 'cmini.running'").first();
      expect(before).toBeNull();

      const result = await tick(bindings, clock, fake.fetchImpl, fake.sleepImpl); // token unchanged -> quiet
      expect(result.quiet).toBe(true);
      expect(result.stats.skipped_locked).toBeUndefined();

      const after = await db.prepare("SELECT value FROM import_state WHERE key = 'cmini.running'").first();
      expect(after).toBeNull(); // still never touched
    });
  });
});

describe("scheduled() wiring", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // `SELF.scheduled(...)` (the form 07 §6 S5 names) throws a DataCloneError
  // in this pinned @cloudflare/vitest-pool-workers (0.22.0) -- reproduced
  // even with no fetch stubbing involved, so it's an environment gap, not
  // something this code can work around. `createScheduledController` +
  // calling the exported `scheduled()` directly is pool-workers' own
  // documented alternative for driving a modules-format `scheduled()`
  // handler in a test, and exercises the exact same cron-dispatch code path
  // in src/index.ts. `scheduledTime` (UTC) is what chooses the job set now
  // (the cron consolidation, X4 follow-up 2) -- every case below pins one.
  it("every '*/5 * * * *' slot reaches an import tick", async () => {
    const fake = new FakeUpstream();
    vi.stubGlobal("fetch", fake.fetchImpl);

    const before = await countEvents();
    const ctx = createExecutionContext();
    const controller = createScheduledController({ cron: "*/5 * * * *", scheduledTime: atUTC(12, 0) });
    await worker.scheduled(controller, bindings, ctx);
    await waitOnExecutionContext(ctx);

    expect(await countEvents()).toBeGreaterThan(before);
    expect(await liveLayoutCount()).toBe(100);
  });

  it("a cron string other than '*/5 * * * *' still throws", async () => {
    const ctx = createExecutionContext();
    const controller = createScheduledController({ cron: "*/1 * * * *" });
    await expect(worker.scheduled(controller, bindings, ctx)).rejects.toThrow(/unrecognized cron/);
  });

  // T1: hour=3 minute=0 also prunes expired auth_cache rows (09 §3 T1) --
  // the same slot's import tick still runs underneath it (fake stubbed so
  // the tick doesn't itself fail).
  it("the hour=3 minute=0 slot also prunes auth_cache", async () => {
    await db.batch([
      db
        .prepare("INSERT INTO auth_cache (token_hash, user_id, name, ok, expires_at) VALUES ('expired', 'u1', 'n1', 1, '2020-01-01T00:00:00.000Z')"),
      db
        .prepare("INSERT INTO auth_cache (token_hash, user_id, name, ok, expires_at) VALUES ('live', 'u2', 'n2', 1, '2099-01-01T00:00:00.000Z')"),
    ]);
    const fake = new FakeUpstream();
    vi.stubGlobal("fetch", fake.fetchImpl);

    const ctx = createExecutionContext();
    const controller = createScheduledController({ cron: "*/5 * * * *", scheduledTime: atUTC(3, 0) });
    await worker.scheduled(controller, bindings, ctx);
    await waitOnExecutionContext(ctx);

    const rows = await db.prepare("SELECT token_hash FROM auth_cache").all<{ token_hash: string }>();
    expect(rows.results.map((r) => r.token_hash)).toEqual(["live"]);
  });

  // Fault isolation (src/index.ts's `runJob`): previously-independent cron
  // triggers must not become one shared failure domain just because they
  // now share a dispatch -- a broken import tick (say, upstream down) must
  // never stop the invocation itself, or the nightly/diff jobs sharing it
  // at 3:00/4:00.
  it("[isolation] a thrown import-tick error is logged, not rethrown, and the invocation still completes", async () => {
    const tickSpy = vi.spyOn(cminiModule, "tick").mockRejectedValue(new Error("boom"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const ctx = createExecutionContext();
    const controller = createScheduledController({ cron: "*/5 * * * *", scheduledTime: atUTC(12, 0) });
    await expect(worker.scheduled(controller, bindings, ctx)).resolves.toBeUndefined();
    await waitOnExecutionContext(ctx);

    expect(tickSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});

// The clock dispatch as an enumerated invariant (12 §3 X4 follow-up 2):
// every underlying job (`tick`, the three prunes, `writeDump`, `diffTick`)
// is mocked so this runs fast and touches no real D1/network --
// what's under test is `scheduled()`'s OWN routing from `scheduledTime` to
// "which jobs run", not any one job's own behavior (already covered
// elsewhere).
describe("scheduled() dispatch matrix", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("[LDB-C5] [matrix] every 5-minute slot of a day (288 total) runs exactly the jobs its UTC hour:minute implies", async () => {
    const tickSpy = vi.spyOn(cminiModule, "tick").mockResolvedValue({ quiet: true, stats: { at: "x", quiet: true } });
    const pruneAuthSpy = vi.spyOn(discordModule, "pruneAuthCache").mockResolvedValue(undefined);
    const pruneRateSpy = vi.spyOn(ratelimitModule, "pruneRateLimits").mockResolvedValue(undefined);
    const pruneNonceSpy = vi.spyOn(clientModule, "pruneNonces").mockResolvedValue(undefined);
    const dumpSpy = vi.spyOn(dumpModule, "writeDump").mockResolvedValue({} as Awaited<ReturnType<typeof dumpModule.writeDump>>);
    const diffSpy = vi.spyOn(difftickModule, "diffTick").mockResolvedValue({ at: "x", ok: true });

    const nightlySlots: string[] = [];
    const diffSlots: string[] = [];
    let slots = 0;
    for (let hour = 0; hour < 24; hour++) {
      for (let minute = 0; minute < 60; minute += 5) {
        slots++;
        const isNightly = hour === 3 && minute === 0;
        const isDiff = hour === 4 && minute === 0;
        const before = {
          tick: tickSpy.mock.calls.length,
          prune: pruneAuthSpy.mock.calls.length,
          diff: diffSpy.mock.calls.length,
        };

        const ctx = createExecutionContext();
        const controller = createScheduledController({ cron: "*/5 * * * *", scheduledTime: atUTC(hour, minute) });
        await worker.scheduled(controller, bindings, ctx);
        await waitOnExecutionContext(ctx);

        // Every slot: exactly one more tick, whatever else did or didn't run.
        expect(tickSpy.mock.calls.length, `${hour}:${minute} tick`).toBe(before.tick + 1);
        expect(pruneAuthSpy.mock.calls.length, `${hour}:${minute} prune`).toBe(before.prune + (isNightly ? 1 : 0));
        expect(diffSpy.mock.calls.length, `${hour}:${minute} diff`).toBe(before.diff + (isDiff ? 1 : 0));

        if (isNightly) nightlySlots.push(`${hour}:${minute}`);
        if (isDiff) diffSlots.push(`${hour}:${minute}`);
      }
    }

    expect(slots).toBe(288);
    expect(tickSpy).toHaveBeenCalledTimes(288);
    // The four nightly jobs move together -- one row each, same count.
    expect(pruneAuthSpy).toHaveBeenCalledTimes(1);
    expect(pruneRateSpy).toHaveBeenCalledTimes(1);
    expect(pruneNonceSpy).toHaveBeenCalledTimes(1);
    expect(dumpSpy).toHaveBeenCalledTimes(1);
    expect(diffSpy).toHaveBeenCalledTimes(1);
    expect(nightlySlots).toEqual(["3:0"]);
    expect(diffSlots).toEqual(["4:0"]);
  }, 30000);

  // A property, not just the one enumerated day above: for ANY two
  // five-minute slots exactly 5 minutes apart (hour rolling over at
  // 23:55 -> 0:00), they never both satisfy the nightly window.
  it("[property] no two ticks 5 minutes apart both fall in the nightly (hour=3,minute=0) window", () => {
    const isNightly = (hour: number, minute: number) => hour === 3 && minute === 0;
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 11 }), (hour, slotIndex) => {
        const minute = slotIndex * 5;
        const rollsOver = minute + 5 === 60;
        const nextHour = rollsOver ? (hour + 1) % 24 : hour;
        const nextMinute = rollsOver ? 0 : minute + 5;
        return !(isNightly(hour, minute) && isNightly(nextHour, nextMinute));
      }),
    );
  });
});

// LDB-D8: a dropped hour=3/hour=4 dispatch must not skip a whole day (H
// item 3, audit-db.md §C/D) -- any tick catches up once the relevant
// `import_state` record is missing or >24h old, and never re-runs within
// 24h of a real one.
describe("[LDB-D8] dump/diff catch-up", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const ISO_DAY_MS = 24 * 60 * 60 * 1000;

  it("[LDB-D8] [property] dumpDue/diffDue: due iff never run, or run more than 24h before now", () => {
    fc.assert(
      fc.property(fc.option(fc.integer({ min: 0, max: 3 * ISO_DAY_MS })), fc.integer({ min: 0, max: 3 * ISO_DAY_MS }), (ageMs, nowOffsetMs) => {
        const now = new Date(nowOffsetMs).toISOString();
        if (ageMs === null) {
          expect(dumpDue(null, now)).toBe(true);
          expect(diffDue(null, now)).toBe(true);
          return;
        }
        const at = new Date(nowOffsetMs - ageMs).toISOString();
        const expected = ageMs > ISO_DAY_MS;
        expect(dumpDue({ at, seq: 0, key: "k" }, now)).toBe(expected);
        expect(diffDue({ at, ok: true }, now)).toBe(expected);
      }),
    );
  });

  it("[LDB-D8] a non-preferred-hour tick runs the dump when `dump.last_at` is missing", async () => {
    // The shared beforeEach seeds a fresh `dump.last_at` -- clear it back to
    // "never dumped" for this one test.
    await db.prepare("DELETE FROM import_state WHERE key = 'dump.last_at'").run();
    const dumpSpy = vi.spyOn(dumpModule, "writeDump").mockResolvedValue({} as Awaited<ReturnType<typeof dumpModule.writeDump>>);

    const ctx = createExecutionContext();
    const controller = createScheduledController({ cron: "*/5 * * * *", scheduledTime: atUTC(12, 0) }); // not hour=3
    await worker.scheduled(controller, bindings, ctx);
    await waitOnExecutionContext(ctx);

    expect(dumpSpy).toHaveBeenCalledTimes(1);
  });

  it("[LDB-D8] a non-preferred-hour tick runs the dump when `dump.last_at` is >24h old, but not when it's fresh", async () => {
    const dumpSpy = vi.spyOn(dumpModule, "writeDump").mockResolvedValue({} as Awaited<ReturnType<typeof dumpModule.writeDump>>);

    await db
      .prepare("UPDATE import_state SET value = ? WHERE key = 'dump.last_at'")
      .bind(JSON.stringify({ at: "2026-07-13T23:00:00.000Z", seq: 0, key: "stale" })) // >24h before 07-15 12:00
      .run();
    const staleCtx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "*/5 * * * *", scheduledTime: atUTC(12, 0) }), bindings, staleCtx);
    await waitOnExecutionContext(staleCtx);
    expect(dumpSpy).toHaveBeenCalledTimes(1); // caught up

    // Never twice within 24h: immediately after, even at another
    // non-preferred hour, it does NOT fire again -- `writeDump`'s mock
    // never actually wrote `dump.last_at`, so re-seed a fresh record the
    // way a real `writeDump` would have, then prove the SAME invocation
    // pattern stays quiet.
    await db
      .prepare("UPDATE import_state SET value = ? WHERE key = 'dump.last_at'")
      .bind(JSON.stringify({ at: "2026-07-15T12:00:00.000Z", seq: 1, key: "fresh" }))
      .run();
    const freshCtx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "*/5 * * * *", scheduledTime: atUTC(13, 0) }), bindings, freshCtx);
    await waitOnExecutionContext(freshCtx);
    expect(dumpSpy).toHaveBeenCalledTimes(1); // still 1 -- not re-run
  });

  it("[LDB-D8] the same catch-up rule applies to the diff", async () => {
    const diffSpy = vi.spyOn(difftickModule, "diffTick").mockResolvedValue({ at: "x", ok: true });

    await db
      .prepare("UPDATE import_state SET value = ? WHERE key = 'cmini.last_diff'")
      .bind(JSON.stringify({ at: "2026-07-13T23:00:00.000Z", ok: true }))
      .run();
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "*/5 * * * *", scheduledTime: atUTC(12, 0) }), bindings, ctx); // not hour=4
    await waitOnExecutionContext(ctx);

    expect(diffSpy).toHaveBeenCalledTimes(1);
  });

  it("[LDB-D8] the diff runs before the dump on a tick where both catch up (the dump's own snapshot then includes the fresh diff state)", async () => {
    await db.prepare("DELETE FROM import_state WHERE key IN ('dump.last_at', 'cmini.last_diff')").run();
    const order: string[] = [];
    vi.spyOn(difftickModule, "diffTick").mockImplementation(async () => {
      order.push("diff");
      return { at: "x", ok: true };
    });
    vi.spyOn(dumpModule, "writeDump").mockImplementation(async () => {
      order.push("dump");
      return {} as Awaited<ReturnType<typeof dumpModule.writeDump>>;
    });

    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "*/5 * * * *", scheduledTime: atUTC(12, 0) }), bindings, ctx);
    await waitOnExecutionContext(ctx);

    expect(order).toEqual(["diff", "dump"]);
  });
});
