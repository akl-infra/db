// [LDB-C4] [LDB-M1] The diff cron (12 §3 X4): `diffTick()` runs the shrunk
// upstream diff (LEDGER.md L4: layout count + a sampled compare) against
// OUR OWN D1 (`d1Ours`), never over HTTP, and writes
// `import_state['cmini.last_diff']` on every run -- success or failure.
// Tests below pass an explicit `sampleSize` >= the fixture's own 100
// records so the sample is exhaustive and deterministic (never flaky on
// `ORDER BY RANDOM()`'s pick).
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
    const record = await diffTick(diffEnv, fixedClock("2026-07-02T00:00:00.000Z"), strictUpstreamOnly(fake), 100);

    // design/layout-db/23-geometry.md's LDB-F27 (a thumb key must sit on a
    // thumb row) postdates this fixture: `upstream-100`'s `test12222` has a
    // thumb-labelled key physically on a finger row, so its `fromCmini`
    // projection now fails spark's own stricter `validate()` -- the SAME
    // known, permanent exception `tests/formats/cmini-envelope.test.ts`'s
    // `[LDB-I13]` case documents, reported here as ONE `invalidUpstream`
    // entry (never thrown), so an exhaustive (sampleSize:100) "identical
    // mirror" run is no longer all-`matched`/`ok:true` -- it is exactly
    // one short, forever, until test12222 itself is fixed upstream.
    expect(record.ok).toBe(false);
    expect(record.at).toBe("2026-07-02T00:00:00.000Z");
    expect(record.sample_size).toBe(100);
    expect(record.matched).toBe(99);
    expect(record.missing).toBe(0);
    expect(record.invalid_upstream).toBe(1);
    expect(record.content_diffs).toBe(0);
    expect(record.layout_count).toEqual({ upstream: 100, ours: 100, equal: true });

    const stored = await importState("cmini.last_diff");
    expect(stored).toEqual(record);
  });

  it("[LDB-C4] [LDB-P5] a layout created in akldb itself (no upstream link) never counts against upstream's layout_count", async () => {
    const fake = new FakeUpstream();
    await tick(bindings, fixedClock("2026-07-01T00:00:00.000Z"), fake.fetchImpl, fake.sleepImpl);
    // An akldb-native record (bot/client `POST /v1/layouts`): no `upstream_*`
    // columns -- the shape of the 5 live ones that turned the daily job red
    // on 2026-09-14. Only its `layouts` row matters to the count.
    await db
      .prepare(
        `INSERT INTO layouts (id, name, owner, n, layout_rev, created_at, modified_at, source_client)
         VALUES ('01NATIVE0000000000000000AA', 'native-test', '111111111111111111', 1, 1, '2026-07-01T12:00:00.000Z', '2026-07-01T12:00:00.000Z', 'discord-app:test')`,
      )
      .run();

    const record = await diffTick(envWithSource(fake.baseUrl), fixedClock("2026-07-02T00:00:00.000Z"), strictUpstreamOnly(fake), 100);
    expect(record.layout_count).toEqual({ upstream: 100, ours: 100, equal: true });
    expect(record.sample_size).toBe(100); // not sampled either: only `following` layouts are
  });

  it("[LDB-C4] one upstream layout mutated after import is reported as a content diff, with a sample", async () => {
    const fake = new FakeUpstream();
    await tick(bindings, fixedClock("2026-07-03T00:00:00.000Z"), fake.fetchImpl, fake.sleepImpl);
    // A key's finger flipped: a genuine CONTENT difference that reaches the
    // stored spark/1 payload (a cmini board-word change alone no longer
    // does -- design/layout-db/26-no-board.md, see the next case), not a
    // shape failure that would land in `invalidUpstream` instead.
    const keys = structuredClone(fake.detailByName("graphite").keys) as Record<string, { row: number; col: number; finger: string }>;
    const firstChar = Object.keys(keys).sort()[0]!;
    keys[firstChar]!.finger = keys[firstChar]!.finger === "LP" ? "LR" : "LP";
    fake.mutateDetailByName("graphite", { keys });

    const diffEnv = envWithSource(fake.baseUrl);
    const record = await diffTick(diffEnv, fixedClock("2026-07-04T00:00:00.000Z"), strictUpstreamOnly(fake), 100);

    expect(record.ok).toBe(false);
    expect(record.content_diffs).toBe(1);
    // 20-spark.md S3b: comparison happens in spark, so the path indexes
    // the converted keys LIST (`/payload/keys/<i>/finger`), never cmini's
    // own char-keyed map.
    expect(record.samples?.content_diffs).toEqual([{ name: "graphite", path: expect.stringMatching(/^\/payload\/keys\/\d+\/finger$/) }]);
    // LDB-F27 (see the "identical mirror" test's own comment): test12222
    // is ALSO an invalidUpstream entry on every exhaustive sample now,
    // independent of graphite's mutation.
    expect(record.invalid_upstream).toBe(1);
  });

  it("[LDB-C4] [LDB-F40] an upstream BOARD-word change alone is NOT a content diff -- spark/1 carries no board (design/layout-db/26-no-board.md)", async () => {
    const fake = new FakeUpstream();
    await tick(bindings, fixedClock("2026-07-03T00:00:00.000Z"), fake.fetchImpl, fake.sleepImpl);
    // graphite's fixture board is "ortho" (07 §5.3); "angle" is a different
    // valid cmini word for the SAME keys -- dropped on import, so nothing
    // stored can differ.
    fake.mutateDetailByName("graphite", { board: "angle" });

    const diffEnv = envWithSource(fake.baseUrl);
    const record = await diffTick(diffEnv, fixedClock("2026-07-04T00:00:00.000Z"), strictUpstreamOnly(fake), 100);

    expect(record.content_diffs).toBe(0);
    expect(record.samples?.content_diffs ?? []).toEqual([]);
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
    expect(record.matched).toBeUndefined();

    const stored = await importState("cmini.last_diff");
    expect(stored).toEqual(record);
  });

  // LDB-I27 (saltorbit 2026-09-15: "pine has taken down his api"): the
  // upstream kill switch `import/cmini.ts`'s `tick()` reads is checked here
  // too -- same function, cron or the manual `POST /v1/admin/diff/tick`.
  it("[LDB-I27] a disabled diffTick makes zero upstream fetches and never touches cmini.last_diff", async () => {
    const fake = new FakeUpstream();
    const diffEnv: Bindings = { ...envWithSource(fake.baseUrl), IMPORT_ENABLED: "off" };
    await tick(bindings, fixedClock("2026-07-05T12:00:00.000Z"), fake.fetchImpl, fake.sleepImpl);
    const before = await importState("cmini.last_diff");

    const noFetch: FetchImpl = () => {
      throw new Error("diffTick fetched while IMPORT_ENABLED=off");
    };
    const record = await diffTick(diffEnv, fixedClock("2026-07-05T13:00:00.000Z"), noFetch);

    expect(record).toEqual({ at: "2026-07-05T13:00:00.000Z", ok: true, disabled: true });
    // The previous real record is left exactly as it was -- never
    // overwritten with a synthetic "checked, nothing to report" entry.
    const after = await importState("cmini.last_diff");
    expect(after).toEqual(before);
  });

  it("[LDB-I27] flipping it back on runs diffTick exactly as if it had never been off", async () => {
    const fake = new FakeUpstream();
    const diffEnv = envWithSource(fake.baseUrl);
    await tick(bindings, fixedClock("2026-07-05T14:00:00.000Z"), fake.fetchImpl, fake.sleepImpl);

    const disabled = await diffTick({ ...diffEnv, IMPORT_ENABLED: "off" }, fixedClock("2026-07-05T15:00:00.000Z"));
    expect(disabled.disabled).toBe(true);

    // Not `ok: true` -- `upstream-100`'s own `test12222` is a known,
    // permanent `invalidUpstream` entry (the first test above's own
    // comment) -- what matters here is that a REAL run happened at all
    // (unlike the disabled call above) and its record was persisted.
    const backOn = await diffTick(diffEnv, fixedClock("2026-07-05T16:00:00.000Z"), strictUpstreamOnly(fake), 100);
    expect(backOn.disabled).toBeUndefined();
    expect(backOn.sample_size).toBe(100);
    const stored = await importState("cmini.last_diff");
    expect(stored).toEqual(backOn);
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

  // 21-formats.md D12 deleted the legacy fallback (`legacyUpstreamMap`,
  // LDB-I2a) this describe used to have an "[LDB-P5] with every stored
  // upstream column NULL ... the Worker's diff still compares every
  // following record through the legacy rule" test for: after the D8
  // wipe, every imported record's `upstream` column is set directly at
  // create time and never legitimately goes back to NULL, so there is no
  // window left to simulate -- a record with a NULL `upstream` column now
  // correctly reports `unresolved` (LDB-P5's own "nothing compared never
  // reads as clean" rule), not `matched`.

  it("[LDB-C4] reads our side in a bounded number of D1 queries -- no per-record query", async () => {
    const fake = new FakeUpstream();
    await tick(bindings, fixedClock("2026-07-08T00:00:00.000Z"), fake.fetchImpl, fake.sleepImpl);

    const { db: proxyDb, reads } = countingDb(db);
    const diffEnv = { ...envWithSource(fake.baseUrl), DB: proxyDb };
    const before = reads();
    // Explicit, exhaustive sampleSize (see the "identical mirror" test's
    // own LDB-F27 comment): the default 50-of-100 `ORDER BY RANDOM()` pick
    // would make `record.ok`/`matched` flaky now that test12222 is a
    // permanent, known invalidUpstream entry -- this test cares about the
    // QUERY COUNT, not that value, so pin the sample instead of asserting
    // around it.
    const record = await diffTick(diffEnv, fixedClock("2026-07-09T00:00:00.000Z"), strictUpstreamOnly(fake), 100);
    const issued = reads() - before;

    expect(record.sample_size).toBe(100);
    // LEDGER.md L4: one `linkedLayoutCount()` read, one `ORDER BY RANDOM() LIMIT
    // n` sample read, one likes chunk -- nowhere near "one query per
    // record" (100+), which is what a regression back to full-corpus
    // enumeration would look like here.
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
    // Not `ok: true`: `scheduled()` has no hook to pin diffTick's sample
    // size, and the default random 50-of-100 pick may or may not land on
    // test12222 (the LDB-F27 permanent invalidUpstream entry the
    // "identical mirror" test's own comment explains) -- this test is
    // about ROUTING (the cron slot reaches diffTick at all), proven by a
    // record actually landing with a real sample, not by its `ok` value.
    expect((stored as { sample_size?: number }).sample_size).toBeGreaterThan(0);
  });
});
