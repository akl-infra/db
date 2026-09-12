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
import * as applyModule from "../../src/import/apply";
import * as cminiModule from "../../src/import/cmini";
import { tick } from "../../src/import/cmini";
import * as difftickModule from "../../src/import/difftick";
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
beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM events"),
    db.prepare("DELETE FROM layout_revs"),
    db.prepare("DELETE FROM likes"),
    db.prepare("DELETE FROM layouts"),
    db.prepare("DELETE FROM authors"),
    db.prepare("DELETE FROM import_map"),
    db.prepare("DELETE FROM import_state"),
  ]);
});

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
    fake.mutateDetailByName("abyss", { board: "ortho" });
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
    expect((JSON.parse(abyssRow!.payload_json) as { board?: unknown }).board).not.toEqual({ kind: "ortho", cmini: "ortho" });
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
