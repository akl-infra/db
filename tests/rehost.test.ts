// [LDB-G1] [LDB-P6] The rehost drill (07 §6 S7): dump -> gunzip ->
// restoreSql -> read back, proven two ways.
//
// Local mode (the default, `npm test`): seed the fixture, run the real
// `0 3 * * *` cron (on a 1st-of-month date so the monthly key gets
// exercised too), read the R2 object back, gunzip it, and restore it OVER
// the SAME D1 it came from -- `restoreSql`'s own `DELETE FROM` statements
// wipe every table first, so this proves restore is safe against a live,
// populated database (the real rehost target), not just an empty one: if
// restore-over-anything holds, restore-into-empty holds for free.
//
// Remote mode (`TEST_REHOST_DUMP_URL` set -- only db.yml's daily job sets
// the underlying `REHOST_DUMP_URL`, threaded in via vitest.config.ts):
// fetches the real, currently-deployed dump over the network and restores
// it into this test's own (empty) D1 instead of running the cron locally --
// this is the actual daily proof that a from-scratch rehost of the live
// service works. A network failure here is a hard failure, never a skip
// (07 §6 S8's ci-gate-split-256 lesson: "a skip nobody reads is a pass").
import { SELF, createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { Bindings } from "../src/env";
import { canonical } from "../src/core/canonical";
import { type EventDbRow, foldLayout, rowToEvent } from "../src/core/events";
import { rowToFormat, rowToLayout, type FormatDbRow, type LayoutDbRow } from "../src/core/records";
import type { Dump, LayoutRevDbRow } from "../src/dump/write";
import { restoreInto } from "../src/dump/restore";
import worker from "../src/index";
import { FakeUpstream } from "./import/fake-upstream";
import { assertConformanceCase, seedUpstream100 } from "./api/support";
import { CASES } from "./conformance/manifest";

const bindings = env as unknown as Bindings & { TEST_REHOST_DUMP_URL: string };
const db = bindings.DB;

async function gunzipJson<T>(gz: ArrayBuffer): Promise<T> {
  const stream = new Response(gz).body!.pipeThrough(new DecompressionStream("gzip"));
  const text = await new Response(stream).text();
  return JSON.parse(text) as T;
}

// Runs the real cron locally (seeding first) and returns the dump it wrote,
// read straight from the `DUMPS` binding (not the HTTP route -- the dump
// itself is the thing under test here, not the route layer, which
// tests/api/dump.test.ts already covers).
async function runCronAndReadDump(): Promise<Dump> {
  await seedUpstream100();

  // The cron consolidation (12 §3 X4 follow-up 2): every dispatch now ALSO
  // runs an import tick before the dump -- `seedUpstream100()` above
  // imported directly (bypassing HTTP, no global fetch stub of its own), so
  // without one here the tick's upstream call would hit the real,
  // unstubbed `fetch` in this sandbox. A fresh `FakeUpstream` serves the
  // identical fixture already imported (its `/meta` `revision` is a fixed
  // "seed-1", not random, matching the stored `cmini.meta_token`), so the
  // tick is fast and quiet.
  const fake = new FakeUpstream();
  vi.stubGlobal("fetch", fake.fetchImpl);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-01T03:00:00.000Z")); // the 1st -- exercises the monthly key too
  try {
    const ctx = createExecutionContext();
    const controller = createScheduledController({ cron: "*/5 * * * *" });
    await worker.scheduled(controller, bindings, ctx);
    await waitOnExecutionContext(ctx);
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }

  const latestObj = await bindings.DUMPS.get("latest.json");
  if (latestObj === null) throw new Error("rehost.test.ts: no dump was written");
  const latest = await latestObj.json<{ key: string }>();
  const dumpObj = await bindings.DUMPS.get(latest.key);
  if (dumpObj === null) throw new Error(`rehost.test.ts: R2 object '${latest.key}' is missing`);
  return gunzipJson<Dump>(await dumpObj.arrayBuffer());
}

async function fetchRemoteDump(url: string): Promise<Dump> {
  const res = await fetch(url); // real network -- daily job only; a failure here must fail loudly, never be swallowed
  if (!res.ok) throw new Error(`REHOST_DUMP_URL fetch failed: ${url} -> ${res.status}`);
  return gunzipJson<Dump>(await res.arrayBuffer());
}

// The dump's own equivalent of `readByIdWithFormats` (records.ts) -- built
// straight from the dump's raw rows rather than a D1 read, so this can run
// against a dump fetched over the network too (remote mode has no local D1
// of its own to read from before restoring).
function foldedFromDumpRows(rec: LayoutDbRow, formatRows: FormatDbRow[]): { layout: Record<string, unknown>; formats: Record<string, unknown> } {
  const layout = rowToLayout(rec);
  const { n: _n, ...layoutSansN } = layout;
  const formats: Record<string, unknown> = {};
  for (const f of formatRows) formats[f.lineage] = rowToFormat(f);
  return { layout: layoutSansN, formats };
}

describe("rehost drill", () => {
  // [LDB-D1] this replay is also the strongest proof the nightly dump is
  // COMPLETE: every table's rows survive `restoreInto` well enough that
  // `/v1/meta`, `/v1/changes?since=0` and the whole conformance replay all
  // agree with the pre-dump state -- a dump missing a table (or truncating
  // the event log to a tail) would desync one of those, not just look wrong
  // in isolation. `tests/api/dump.test.ts` covers the OTHER two clauses
  // (the `latest.json` sha256, the monthly-key timing) directly.
  it("[LDB-G1] [LDB-P6] [LDB-D1] [MF-3] [LDB-P18] [LDB-P11] restoreSql reproduces the exact dumped state", async () => {
    const remoteUrl = bindings.TEST_REHOST_DUMP_URL;
    const usingRemote = remoteUrl !== "";

    // Local mode only: capture the live state BEFORE touching anything, so
    // restoring the dump taken from it can be checked for exact agreement.
    let metaBefore: unknown;
    let changesBefore: string | undefined;
    const dump = usingRemote ? await fetchRemoteDump(remoteUrl) : await runCronAndReadDump();
    if (!usingRemote) {
      metaBefore = await (await SELF.fetch("https://example.com/v1/meta")).json();
      changesBefore = await (await SELF.fetch("https://example.com/v1/changes?since=0&limit=1000")).text();
    }

    await restoreInto(db, dump);

    // MF-3 replay: every dumped layout equals the fold of its own events
    // against the payloads `layout_revs` stored for each scope -- the same
    // identity tests/events/fold.test.ts's write model checks live, now
    // checked over a full dump/restore round trip.
    const eventsByLayout = new Map<string, EventDbRow[]>();
    for (const e of dump.events) {
      if (e.layout_id === null) continue;
      if (!eventsByLayout.has(e.layout_id)) eventsByLayout.set(e.layout_id, []);
      eventsByLayout.get(e.layout_id)!.push(e);
    }
    const revsByLayout = new Map<string, Map<string, { format: string | null; payload: unknown }>>();
    for (const r of dump.layout_revs as LayoutRevDbRow[]) {
      if (!revsByLayout.has(r.layout_id)) revsByLayout.set(r.layout_id, new Map());
      const payload = r.payload_json === null ? undefined : (JSON.parse(r.payload_json) as unknown);
      revsByLayout.get(r.layout_id)!.set(`${r.lineage ?? ""} ${r.rev}`, { format: r.format, payload });
    }
    const formatsByLayout = new Map<string, FormatDbRow[]>();
    for (const f of dump.layout_formats) {
      if (!formatsByLayout.has(f.layout_id)) formatsByLayout.set(f.layout_id, []);
      formatsByLayout.get(f.layout_id)!.push(f);
    }

    expect(dump.records.length).toBeGreaterThan(0);
    for (const rec of dump.records) {
      const events = (eventsByLayout.get(rec.id) ?? []).map(rowToEvent);
      const revs = revsByLayout.get(rec.id) ?? new Map();
      const folded = foldLayout(events, revs);
      expect(folded, `layout ${rec.id} ('${rec.name}') folded to null`).not.toBeNull();
      const foldedFormats: Record<string, unknown> = {};
      for (const [lineage, row] of folded!.formats) foldedFormats[lineage] = row;
      const expected = foldedFromDumpRows(rec, formatsByLayout.get(rec.id) ?? []);
      expect(canonical(folded!.layout), `layout ${rec.id} ('${rec.name}')`).toBe(canonical(expected.layout));
      expect(canonical(foldedFormats), `layout ${rec.id} ('${rec.name}') formats`).toBe(canonical(expected.formats));
    }

    if (usingRemote) {
      // No local "before" exists -- the dump's own `meta` is the ground
      // truth (it was computed from the exact same tables the dump's
      // `records`/`events` came from).
      const metaAfter = await (await SELF.fetch("https://example.com/v1/meta")).json();
      expect(metaAfter).toEqual(dump.meta);
    } else {
      const metaAfter = await (await SELF.fetch("https://example.com/v1/meta")).json();
      expect(metaAfter).toEqual(metaBefore);

      const changesAfter = await (await SELF.fetch("https://example.com/v1/changes?since=0&limit=1000")).text();
      expect(changesAfter).toBe(changesBefore);
    }

    // Every conformance case, replayed against the RESTORED database --
    // proves a rehosted service actually serves the real API, not just that
    // its rows look right in isolation.
    //
    // NOTE (F2 follow-up owed, same as tests/api/conformance.test.ts's own
    // note): every case's fixture still encodes the PRE-F2 wire shape, so
    // this loop is expected to fail at runtime until that dedicated
    // regeneration pass lands -- kept running (not skipped) so it starts
    // passing the moment the fixtures are fixed, per this repo's "a skip
    // nobody reads is a pass" rule.
    for (const kase of CASES) {
      // X1: `changes-stream/503-stream_unavailable` needs `STREAM_MAX_MS`
      // toggled to `"0"` for its one request only -- conformance.test.ts's
      // own `it()` loop does that around this specific id; this replay has
      // no equivalent hook, so it's excluded the same deliberate way the
      // dump/needsSeed cases are.
      if (kase.id.startsWith("dump") || kase.needsSeed || kase.id === "changes-stream/503-stream_unavailable") {
        continue;
      }
      await assertConformanceCase(kase);
    }
  });
});
