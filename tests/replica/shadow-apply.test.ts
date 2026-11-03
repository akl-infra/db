// [LDB-PV5] [LDB-PV6] [LDB-PV7] The shadow feed follower reproduces production exactly on the feed tables: seed a fresh
// database from production's dump S1, run more of production's REAL writes, apply the public feed S1..S2 with the follower,
// and the shadow's dump equals production's dump S2 on every feed table (events, layouts, layout_formats, layout_revs, likes,
// and layouts_head by its triggers). The state tables the feed cannot rebuild are counted stale and replaced from the next
// public dump, never approximated.
import { afterAll, describe, expect, it } from "vitest";
import { env } from "../harness";
import type { Bindings } from "../../src/env";
import { buildDump, writeDump } from "../../src/dump/write";
import { KNOWN_KINDS } from "../../src/routes/changes";
import { FEED_TABLES, KINDS, STATE_TABLES, FollowerRefusal, applyKindOf, type FeedEvent } from "../../src/replica/shadow/apply";
import { compareDumps, differingTables } from "../../src/replica/shadow/checksum";
import { followFeed, readFollowerState } from "../../src/replica/shadow/follower";
import { seedShadow } from "../../src/replica/shadow/seed";
import { registerForTest } from "../../formats/registry.ts";
import { T1 } from "../formats/stub-lineage.ts";
import { harnessUpstream, shadowWorld } from "./shadow-support";
import { scenario } from "./shadow-scenario";

const unregister = registerForTest(T1);
afterAll(unregister);
const bindings = env as unknown as Bindings;
const kindsApplied = new Set<string>();

describe("the applier's kind table", () => {
  it("[LDB-PV6] KINDS names exactly the kinds /v1/changes can serve, so a new kind cannot arrive unclassified", () => {
    expect(Object.keys(KINDS).filter((k) => k !== "admin.likes_set").sort()).toEqual([...KNOWN_KINDS].sort());
  });

  it("[LDB-PV6] an unknown kind, a rev on a non-write kind, a write kind without a rev and an ambiguous source are refused, not guessed", () => {
    const base: FeedEvent = { seq: 5, at: "2026-11-02T00:00:00.000Z", kind: "created", layout_id: "L", name: "n", owner: "o", format: null, rev: 1, actor: "a", via: "discord", admin: false, detail: null, before: null, after: null, source: { client: "c", version: null } };
    expect(() => applyKindOf({ ...base, kind: "brand_new_kind" })).toThrow(FollowerRefusal);
    expect(() => applyKindOf({ ...base, kind: "liked", rev: 3 })).toThrow(/not a write kind/);
    expect(() => applyKindOf({ ...base, kind: "updated", rev: null })).toThrow(/without a rev/);
    expect(applyKindOf({ ...base, kind: "upstream_deleted", rev: null })).toBe("row");
    expect(applyKindOf({ ...base, kind: "upstream_deleted", rev: 4 })).toBe("write");
    expect(applyKindOf({ ...base, kind: "admin.user_banned", rev: null })).toBe("row");
    expect(FEED_TABLES.length + STATE_TABLES.length).toBe(15);
  });
});

describe("dump(S1) + apply(feed S1..S2) = dump(S2)", () => {
  for (const seed of [11, 12, 13, 14]) {
    it(`[LDB-PV4] [LDB-PV5] [LDB-PV7] seed ${seed}: every feed table equals production's, the state tables are tracked stale, and a checkpoint resyncs them`, async () => {
      const sc = await scenario(seed);
      await sc.run(25);
      await sc.stateChange(`${seed}-a`);
      const up = harnessUpstream();
      const ms = { v: Date.parse("2026-11-02T03:00:00Z") };
      const now = () => (ms.v += 5);

      // S1: production's dump, and a shadow seeded from it
      await writeDump(bindings, sc.clock);
      const shadow = await shadowWorld(sc.clock);
      const seeded = await seedShadow({ db: shadow.db, up, blobs: shadow.blobs, now, logLine: (l) => void shadow.lines.push(l) }, {});
      expect(seeded.ok).toBe(true);
      const cmp0 = compareDumps(await shadow.dump(), await buildDump(bindings, sc.clock));
      expect(cmp0.feedEqual, `after the seed: ${differingTables(cmp0).join(",")}`).toBe(true);
      expect(cmp0.stateEqual).toBe(true);

      // S2: more of production's writes, and one more state change
      await sc.run(45);
      await sc.stateChange(`${seed}-b`);
      const prodS2 = await buildDump(bindings, sc.clock);
      expect(prodS2.meta.seq).toBeGreaterThan(seeded.seq);

      // apply the feed, a small page at a time; production's latest dump is still S1, so no checkpoint yet
      const small = { pageLimit: 7 };
      let total = 0;
      for (let i = 0; i < 40; i++) {
        const r = await followFeed(shadow.deps(up, now, small));
        expect(r.status, shadow.lines.join("\n")).toBe("ok");
        total += r.applied;
        if (r.applied === 0) break;
      }
      expect(total).toBe(prodS2.meta.seq - seeded.seq);
      for (const e of prodS2.events) if (e.seq > seeded.seq) kindsApplied.add(`${e.kind}${e.rev === null ? "" : e.format === null ? ":layout" : ":format"}`);
      const mine = await shadow.dump();
      const cmp = compareDumps(mine, prodS2);
      expect(cmp.feedEqual, `feed tables differ: ${differingTables(cmp).join(", ")} ${JSON.stringify(Object.values(cmp.tables).find((t) => !t.equal)?.firstDiff)}`).toBe(true);
      for (const t of ["records", "layout_formats", "layout_revs", "likes", "events"]) expect(cmp.tables[t]!.equal, t).toBe(true);
      expect(mine.meta.layout_count).toBe(prodS2.meta.layout_count);
      expect(mine.meta.seq).toBe(prodS2.meta.seq);
      // the state tables: authors and bans changed in production, shadow has not followed them, and says so
      expect(cmp.stateEqual).toBe(false);
      expect(cmp.tables.bans!.equal).toBe(false);
      const st = (await readFollowerState(shadow.db))!;
      expect(st.cursor).toBe(prodS2.meta.seq);
      expect(st.stale.bans).toBe(1);
      expect(st.appliedTotal).toBe(total);

      // production publishes S2: the next tick checks the feed tables against it and resyncs the state tables from it
      await writeDump(bindings, sc.clock);
      const r2 = await followFeed(shadow.deps(up, now, small));
      expect(r2.status, shadow.lines.join("\n")).toBe("ok");
      expect(r2.applied).toBe(0);
      expect(r2.checkpoint?.result).toBe("equal");
      expect(r2.checkpoint?.comparison?.stateEqual).toBe(false); // read before the resync
      const after = compareDumps(await shadow.dump(), prodS2);
      expect(after.feedEqual && after.stateEqual, differingTables(after).join(",")).toBe(true);
      const st2 = (await readFollowerState(shadow.db))!;
      expect(st2.stale).toEqual({});
      expect(st2.checkedDumpSeq).toBe(prodS2.meta.seq);
      // shadow's own /v1/dump/latest.json now names the dump it was synchronized at
      expect(JSON.parse(new TextDecoder().decode((await new Response((await shadow.blobs.get("latest.json"))!.body).arrayBuffer()))).seq).toBe(prodS2.meta.seq);
      // a tick with nothing new changes nothing
      const r3 = await followFeed(shadow.deps(up, now, small));
      expect(r3.applied).toBe(0);
      expect(r3.checkpoint).toBeUndefined();
      shadow.replica.close();
    }, 120_000);
  }
});

describe("what the proof exercised", () => {
  it("[LDB-PV5] the scenarios covered both scopes of every write kind the proof claims, upstream forks, tombstones, likes and links", () => {
    for (const k of ["created:layout", "imported:layout", "imported:format", "updated:format", "format_added:format", "fingermap:format", "renamed:layout", "transferred:layout", "deleted:layout", "restored:layout", "upstream_deleted:layout", "liked", "unliked", "link_approved", "link_cleared", "admin.user_banned"]) {
      expect([...kindsApplied].sort().join(' '), k).toContain(k);
    }
  });
});
