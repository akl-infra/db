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
import { type EventDbRow, foldRecord, rowToEvent } from "../src/core/events";
import type { LayoutDbRow } from "../src/core/records";
import type { Dump } from "../src/dump/write";
import { restoreInto } from "../src/dump/restore";
import worker from "../src/index";
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

  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-01T03:00:00.000Z")); // the 1st -- exercises the monthly key too
  try {
    const ctx = createExecutionContext();
    const controller = createScheduledController({ cron: "0 3 * * *" });
    await worker.scheduled(controller, bindings, ctx);
    await waitOnExecutionContext(ctx);
  } finally {
    vi.useRealTimers();
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

function foldedFromDump(rec: LayoutDbRow): Record<string, unknown> {
  return {
    id: rec.id,
    name: rec.name,
    owner: rec.owner,
    rev: rec.rev,
    created_at: rec.created_at,
    modified_at: rec.modified_at,
    deleted: rec.deleted !== 0,
    like_count: rec.like_count,
    has_magic: rec.has_magic !== 0,
    format: rec.format,
    payload: JSON.parse(rec.payload_json) as unknown,
  };
}

describe("rehost drill", () => {
  it("[LDB-G1] [LDB-P6] restoreSql reproduces the exact dumped state", async () => {
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

    // P1 replay: every dumped record equals the fold of its own events
    // against the payloads `layout_revs` stored for it -- the same identity
    // tests/events/fold.test.ts checks live, now checked over a full
    // dump/restore round trip.
    const eventsByLayout = new Map<string, EventDbRow[]>();
    for (const e of dump.events) {
      if (e.layout_id === null) continue;
      if (!eventsByLayout.has(e.layout_id)) eventsByLayout.set(e.layout_id, []);
      eventsByLayout.get(e.layout_id)!.push(e);
    }
    const revsByLayout = new Map<string, Map<number, { format: string; payload: unknown }>>();
    for (const r of dump.layout_revs) {
      if (!revsByLayout.has(r.layout_id)) revsByLayout.set(r.layout_id, new Map());
      revsByLayout.get(r.layout_id)!.set(r.rev, { format: r.format, payload: JSON.parse(r.payload_json) as unknown });
    }

    expect(dump.records.length).toBeGreaterThan(0);
    for (const rec of dump.records) {
      const events = (eventsByLayout.get(rec.id) ?? []).map(rowToEvent);
      const revs = revsByLayout.get(rec.id) ?? new Map();
      const folded = foldRecord(events, revs);
      expect(folded, `record ${rec.id} ('${rec.name}') folded to null`).not.toBeNull();
      expect(canonical(folded), `record ${rec.id} ('${rec.name}')`).toBe(canonical(foldedFromDump(rec)));
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
    // its rows look right in isolation. Real upstream layout names are
    // stable enough (07 §0.1 measured them off the live corpus) that this
    // also passes in remote mode against a real production dump. Deliberate
    // exclusions: the four `dump*` cases assume NO dump has been written yet
    // (the plain conformance seed's world); this test has, by construction,
    // just written or fetched one. Every `needsSeed` case (09 §3 T6's flag,
    // manifest.ts) assumes tests/api/conformance.test.ts's OWN lazily-seeded
    // write fixtures (`cw-put-1`, `cw-like-1`, the `QWERTY` record, the
    // ratelimited/second-owner/admin actors, the `__CW_RESTORE*_ID__`
    // placeholders, ...) and its stubbed FakeDiscord -- none of which exist
    // here (only `seedUpstream100()` + the cron ran), so they'd 404, 401 (no
    // matching FakeDiscord answer), or address a literal, unresolved
    // placeholder string. Deriving this from the flag (rather than a
    // hand-listed set of id prefixes) is what keeps this set in sync with
    // conformance.test.ts's own trigger as new needsSeed cases are added.
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
