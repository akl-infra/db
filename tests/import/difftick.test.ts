// [LDB-C4] [LDB-M1] The diff cron (12 §3 X4): `diffTick()` runs the D12
// diff against OUR OWN D1 (`d1Ours`), never over HTTP, and writes
// `import_state['cmini.last_diff']` on every run -- success or failure.
import { createExecutionContext, createScheduledController, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { fixedClock } from "../../src/core/time";
import type { FetchImpl } from "../../src/import/diff";
import { tick } from "../../src/import/cmini";
import { diffTick } from "../../src/import/difftick";
import worker from "../../src/index";
import { FakeUpstream } from "./fake-upstream";

const bindings = env as unknown as Bindings;
const db = bindings.DB;

function envWithSource(baseUrl: string): Bindings {
  return { ...bindings, IMPORT_SOURCE_URL: baseUrl };
}

// LDB-C4's own proof, in fetchImpl form: throws for any URL not under the
// fake's own base, so a `diffTick` run that completes successfully through
// THIS fetchImpl could not have fetched anything else -- the Worker's own
// origin included. `d1Ours` (src/import/difftick.ts) never calls
// `fetchImpl` at all (it reads D1 directly) -- this wrapper is what would
// catch a regression that made it do so.
function strictUpstreamOnly(fake: FakeUpstream): FetchImpl {
  return async (url, init) => {
    if (!url.startsWith(fake.baseUrl)) throw new Error(`diffTick fetched a non-upstream URL: ${url}`);
    return fake.fetchImpl(url, { headers: init?.headers ?? {} });
  };
}

async function importState(key: string): Promise<unknown> {
  const row = await db.prepare("SELECT value FROM import_state WHERE key = ?").bind(key).first<{ value: string }>();
  return row === null ? null : JSON.parse(row.value);
}

// A statement-counting proxy over a D1Database (LDB-H5's own mechanism in
// tests/api/webhooks.test.ts, 09 §3 T1's pattern), counting `.all()` calls
// instead of `.run()` -- `d1Ours` is read-only.
function wrapStmt(stmt: D1PreparedStatement, reads: { n: number }): D1PreparedStatement {
  return new Proxy(stmt, {
    get(target, prop, receiver) {
      if (prop === "all") {
        return async (...args: unknown[]) => {
          reads.n++;
          return (target.all as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      if (prop === "bind") {
        return (...args: unknown[]) => wrapStmt((target.bind as (...a: unknown[]) => D1PreparedStatement).apply(target, args), reads);
      }
      const val = Reflect.get(target, prop, receiver);
      return typeof val === "function" ? (val as (...a: unknown[]) => unknown).bind(target) : val;
    },
  }) as D1PreparedStatement;
}
function countingDb(real: D1Database): { db: D1Database; reads: () => number } {
  const reads = { n: 0 };
  const proxy = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "prepare") return (sql: string) => wrapStmt(target.prepare(sql), reads);
      const val = Reflect.get(target, prop, receiver);
      return typeof val === "function" ? (val as (...a: unknown[]) => unknown).bind(target) : val;
    },
  });
  return { db: proxy as D1Database, reads: () => reads.n };
}

// vitest-pool-workers isolates storage per TEST FILE, not per `it` (07 §2).
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

describe("diffTick()", () => {
  it("[LDB-C4] an identical mirror reports ok:true and writes cmini.last_diff on every run", async () => {
    const fake = new FakeUpstream();
    await tick(bindings, fixedClock("2026-07-01T00:00:00.000Z"), fake.fetchImpl, fake.sleepImpl); // seed our side from the same fixture

    const diffEnv = envWithSource(fake.baseUrl);
    const record = await diffTick(diffEnv, fixedClock("2026-07-02T00:00:00.000Z"), strictUpstreamOnly(fake));

    expect(record.ok).toBe(true);
    expect(record.at).toBe("2026-07-02T00:00:00.000Z");
    expect(record.corpus?.matched).toBe(100);
    expect(record.corpus?.missing).toBe(0);
    expect(record.corpus?.content_diffs).toBe(0);
    expect(record.layout_count).toEqual({ upstream: 100, ours: 100, equal: true });

    const stored = await importState("cmini.last_diff");
    expect(stored).toEqual(record);
  });

  it("[LDB-C4] one upstream layout mutated after import is reported as a content diff, with a sample", async () => {
    const fake = new FakeUpstream();
    await tick(bindings, fixedClock("2026-07-03T00:00:00.000Z"), fake.fetchImpl, fake.sleepImpl);
    // graphite's fixture board is "ortho" (07 §5.3) -- "angle" is a
    // different valid `cmini/1` board enum value, so this is a genuine
    // CONTENT difference, not a shape failure that would land in
    // `invalidUpstream` instead.
    fake.mutateDetailByName("graphite", { board: "angle" });

    const diffEnv = envWithSource(fake.baseUrl);
    const record = await diffTick(diffEnv, fixedClock("2026-07-04T00:00:00.000Z"), strictUpstreamOnly(fake));

    expect(record.ok).toBe(false);
    expect(record.corpus?.content_diffs).toBe(1);
    // 20-spark.md S3b: comparison happens in spark now, nested under
    // `payload` (unlike cmini/1's flat `board` word).
    expect(record.samples?.content_diffs).toEqual([{ name: "graphite", path: "/payload/board/cmini" }]);
  });

  it("[LDB-C4] a fake refusing every attempt writes { ok: false, error } -- a stale `at` never hides an outage", async () => {
    const fake = new FakeUpstream();
    const diffEnv = envWithSource(fake.baseUrl);
    const alwaysFails: FetchImpl = () => {
      throw new Error("network down");
    };
    const record = await diffTick(diffEnv, fixedClock("2026-07-05T00:00:00.000Z"), alwaysFails);

    expect(record.ok).toBe(false);
    expect(record.error).toBeDefined();
    expect(record.at).toBe("2026-07-05T00:00:00.000Z");
    expect(record.corpus).toBeUndefined();

    const stored = await importState("cmini.last_diff");
    expect(stored).toEqual(record);
  });

  it("[LDB-M1] /v1/meta.last_diff equals {at, ok} after a run, and the ETag changes with it", async () => {
    const fake = new FakeUpstream();
    await tick(bindings, fixedClock("2026-07-06T00:00:00.000Z"), fake.fetchImpl, fake.sleepImpl);

    const before = await SELF.fetch("https://example.com/v1/meta");
    const etagBefore = before.headers.get("ETag");

    const diffEnv = envWithSource(fake.baseUrl);
    const record = await diffTick(diffEnv, fixedClock("2026-07-07T00:00:00.000Z"), strictUpstreamOnly(fake));

    const after = await SELF.fetch("https://example.com/v1/meta");
    const body = await after.json<{ last_diff: { at: string; ok: boolean } | null }>();
    expect(body.last_diff).toEqual({ at: record.at, ok: record.ok });
    // `diffTick` appends no event -- `seq` alone would leave this ETag
    // unchanged; the meta route folds `last_diff.at` in for exactly this
    // reason (src/index.ts's own header note).
    expect(after.headers.get("ETag")).not.toBe(etagBefore);
  });

  it("[LDB-P5] with every stored upstream column NULL (the window between the 0005 deploy and the record migration), the Worker's diff still compares every following record through the legacy rule", async () => {
    const fake = new FakeUpstream();
    await tick(bindings, fixedClock("2026-07-10T00:00:00.000Z"), fake.fetchImpl, fake.sleepImpl);
    await db.prepare("UPDATE layouts SET upstream_source = NULL, upstream_id = NULL, upstream_state = NULL").run();

    const record = await diffTick(envWithSource(fake.baseUrl), fixedClock("2026-07-11T00:00:00.000Z"), strictUpstreamOnly(fake));
    expect(record.ok).toBe(true);
    expect(record.corpus?.matched).toBe(100);
    expect(record.corpus?.divergent).toBe(0);
    expect(record.corpus?.unresolved).toBe(0);
    expect(record.corpus?.content_diffs).toBe(0);
  });

  it("[LDB-C4] reads our side in a bounded number of D1 queries -- no per-record query", async () => {
    const fake = new FakeUpstream();
    await tick(bindings, fixedClock("2026-07-08T00:00:00.000Z"), fake.fetchImpl, fake.sleepImpl);

    const { db: proxyDb, reads } = countingDb(db);
    const diffEnv = { ...envWithSource(fake.baseUrl), DB: proxyDb };
    const before = reads();
    const record = await diffTick(diffEnv, fixedClock("2026-07-09T00:00:00.000Z"), strictUpstreamOnly(fake));
    const issued = reads() - before;

    expect(record.ok).toBe(true);
    // 100 records at a 500-record page size: one list page, one likes
    // chunk, plus the fixed handful of authors/layoutCount reads --
    // nowhere near "one query per record" (100+), which is what a
    // regression back to per-record I/O would look like here.
    expect(issued).toBeLessThan(20);
  });
});

describe("scheduled() wiring", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("[LDB-C4] the hour=4 minute=0 slot of the exported scheduled() handler routes to diffTick", async () => {
    const fake = new FakeUpstream();
    await tick(bindings, fixedClock("2026-07-10T00:00:00.000Z"), fake.fetchImpl, fake.sleepImpl);
    vi.stubGlobal("fetch", strictUpstreamOnly(fake));

    // The cron consolidation (X4 follow-up 2): one '*/5' trigger, the diff
    // dispatched by `scheduledTime`'s hour=4/minute=0, not a separate
    // '0 4 * * *' cron string. The SAME import tick also runs first, on
    // this SAME `fake` (already imported above, so it's quiet) --
    // `strictUpstreamOnly` still proves neither job ever fetches its own
    // origin.
    const envForScheduled = envWithSource(fake.baseUrl);
    const ctx = createExecutionContext();
    const controller = createScheduledController({ cron: "*/5 * * * *", scheduledTime: new Date(Date.UTC(2026, 6, 10, 4, 0)) });
    await worker.scheduled(controller, envForScheduled, ctx);
    await waitOnExecutionContext(ctx);

    const stored = await importState("cmini.last_diff");
    expect(stored).not.toBeNull();
    expect((stored as { ok: boolean }).ok).toBe(true);
  });
});
