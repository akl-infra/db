// [LDB-I1] [LDB-I7] tick(): the full meta-gate -> plan -> fetch -> apply ->
// authors -> state cycle, against the FakeUpstream's upstream-100 snapshot.
import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { fixedClock } from "../../src/core/time";
import { tick } from "../../src/import/cmini";
import worker from "../../src/index";
import { FakeUpstream } from "./fake-upstream";

const bindings = env as unknown as Bindings;
const db = bindings.DB;

function envWithCap(cap: number): Bindings {
  return { ...bindings, IMPORT_MAX_WRITES_PER_TICK: String(cap) };
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
  });

  // `SELF.scheduled(...)` (the form 07 §6 S5 names) throws a DataCloneError
  // in this pinned @cloudflare/vitest-pool-workers (0.22.0) -- reproduced
  // even with no fetch stubbing involved, so it's an environment gap, not
  // something this code can work around. `createScheduledController` +
  // calling the exported `scheduled()` directly is pool-workers' own
  // documented alternative for driving a modules-format `scheduled()`
  // handler in a test, and exercises the exact same cron-dispatch code path
  // in src/index.ts.
  it("the exported scheduled() handler routes '*/5 * * * *' to an import tick", async () => {
    const fake = new FakeUpstream();
    vi.stubGlobal("fetch", fake.fetchImpl);

    const before = await countEvents();
    const ctx = createExecutionContext();
    const controller = createScheduledController({ cron: "*/5 * * * *" });
    await worker.scheduled(controller, bindings, ctx);
    await waitOnExecutionContext(ctx);

    expect(await countEvents()).toBeGreaterThan(before);
    expect(await liveLayoutCount()).toBe(100);
  });

  // T1: the '0 3 * * *' cron also prunes expired auth_cache rows (09 §3
  // T1). No FakeUpstream/fetch stubbing needed -- this branch never calls
  // Discord or cmini, only src/auth/discord.ts's pruneAuthCache().
  it("the exported scheduled() handler routes '0 3 * * *' to an auth_cache prune", async () => {
    await db.batch([
      db
        .prepare("INSERT INTO auth_cache (token_hash, user_id, name, ok, expires_at) VALUES ('expired', 'u1', 'n1', 1, '2020-01-01T00:00:00.000Z')"),
      db
        .prepare("INSERT INTO auth_cache (token_hash, user_id, name, ok, expires_at) VALUES ('live', 'u2', 'n2', 1, '2099-01-01T00:00:00.000Z')"),
    ]);

    const ctx = createExecutionContext();
    const controller = createScheduledController({ cron: "0 3 * * *" });
    await worker.scheduled(controller, bindings, ctx);
    await waitOnExecutionContext(ctx);

    const rows = await db.prepare("SELECT token_hash FROM auth_cache").all<{ token_hash: string }>();
    expect(rows.results.map((r) => r.token_hash)).toEqual(["live"]);
  });

  // X1 (12 §2.4, §3 X1): the webhook drain cron. A minimal wiring check --
  // tests/api/webhooks.test.ts's own "scheduled() wiring" describe covers
  // the delivery behavior in depth; this just proves `*/1 * * * *` reaches
  // `drainWebhooks()` through the real dispatcher, same as the other two
  // cases in this describe.
  it("the exported scheduled() handler routes '*/1 * * * *' to a webhook drain", async () => {
    await db
      .prepare(
        `INSERT INTO webhooks (id, owner_user_id, url, secret, kinds, owner_filter, status, cursor, failures, failing_since, next_at, last_error, created_at)
         VALUES ('wh-tick-1', 'u-tick', 'https://receiver.example/hook', 'tick-secret-1234567890ab', NULL, NULL, 'active', 0, 0, NULL, '2026-01-01T00:00:00.000Z', NULL, '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO events (at, kind, layout_id, name, owner, rev, actor, via, admin)
         VALUES ('2026-01-01T00:00:00.000Z', 'created', NULL, NULL, NULL, NULL, 'system:cmini-import', 'import:cmini', 0)`,
      )
      .run();

    vi.stubGlobal("fetch", async () => new Response(null, { status: 200 }));
    const ctx = createExecutionContext();
    const controller = createScheduledController({ cron: "*/1 * * * *" });
    await worker.scheduled(controller, bindings, ctx);
    await waitOnExecutionContext(ctx);

    const row = await db.prepare("SELECT cursor FROM webhooks WHERE id = 'wh-tick-1'").first<{ cursor: number }>();
    expect(row!.cursor).toBeGreaterThan(0);
  });

  // The '0 3 * * *' prune (auth_cache/ratelimit/nonces/dump) must not touch
  // `webhooks` (12 §3 X1's own note: "the 0 3 prune leaves webhooks alone").
  it("the '0 3 * * *' cron leaves `webhooks` untouched", async () => {
    await db
      .prepare(
        `INSERT INTO webhooks (id, owner_user_id, url, secret, kinds, owner_filter, status, cursor, failures, failing_since, next_at, last_error, created_at)
         VALUES ('wh-prune-1', 'u-prune', 'https://receiver.example/hook', 'prune-secret-1234567890ab', NULL, NULL, 'active', 0, 0, NULL, '2026-01-01T00:00:00.000Z', NULL, '2026-01-01T00:00:00.000Z')`,
      )
      .run();

    const ctx = createExecutionContext();
    const controller = createScheduledController({ cron: "0 3 * * *" });
    await worker.scheduled(controller, bindings, ctx);
    await waitOnExecutionContext(ctx);

    const row = await db.prepare("SELECT id FROM webhooks WHERE id = 'wh-prune-1'").first();
    expect(row).not.toBeNull();
  });
});
