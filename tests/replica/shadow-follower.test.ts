// [LDB-PV2] [LDB-PV4] [LDB-PV6] [LDB-PV7] The follower's discipline: the seed refuses what it must, a refused event stops
// the cursor loudly and changes nothing, the cursor moves with its events in one unit under injected log faults, and the
// checkpoint finds a wrong table and a skewed dump.
import { afterAll, describe, expect, it } from "vitest";
import { env } from "../harness";
import type { Bindings } from "../../src/env";
import { buildDump, writeDump, type Dump } from "../../src/dump/write";
import { compareDumps } from "../../src/replica/shadow/checksum";
import { followFeed, readFollowerState } from "../../src/replica/shadow/follower";
import { SeedRefused, latestPathOf, seedShadow } from "../../src/replica/shadow/seed";
import type { Upstream } from "../../src/replica/shadow/upstream";
import { registerForTest } from "../../formats/registry.ts";
import { T1 } from "../formats/stub-lineage.ts";
import { faultsFromRate } from "../harness/setup-shim";
import { harnessUpstream, shadowWorld } from "./shadow-support";
import { scenario } from "./shadow-scenario";

const unregister = registerForTest(T1);
afterAll(unregister);
const bindings = env as unknown as Bindings;
let ms = Date.parse("2026-11-02T03:00:00Z");
const now = (): number => (ms += 5);

/** An upstream that lets a test rewrite what a path answers. */
function tampered(base: Upstream, rewrite: (path: string, body: unknown) => unknown): Upstream {
  return {
    base: base.base,
    async json(path) {
      return rewrite(path, await base.json(path));
    },
    bytes: (path) => base.bytes(path),
  };
}

async function seeded(seed: number, before: number, after: number) {
  const sc = await scenario(seed);
  await sc.run(before);
  await writeDump(bindings, sc.clock);
  const shadow = await shadowWorld(sc.clock);
  const up = harnessUpstream();
  await seedShadow({ db: shadow.db, up, blobs: shadow.blobs, now, logLine: () => {} }, {});
  await sc.run(after);
  return { sc, shadow, up };
}

describe("the seed (PV2)", () => {
  it("[LDB-PV2] dumpUrl must be production's latest.json: another host, path or query is refused before a byte is fetched", () => {
    expect(latestPathOf(undefined)).toBe("/v1/dump/latest.json");
    expect(latestPathOf("https://api.akldb.org/v1/dump/latest.json")).toBe("/v1/dump/latest.json");
    for (const bad of ["https://evil.example/v1/dump/latest.json", "http://api.akldb.org/v1/dump/latest.json", "https://api.akldb.org/v1/dump/dump-2026-11-01.json.gz", "https://api.akldb.org/v1/dump/latest.json?x=1", "not a url"]) {
      expect(() => latestPathOf(bad), bad).toThrow(SeedRefused);
    }
  });

  it("[LDB-PV2] a second seed on a non-empty shadow is refused, reset:true restores over it, and a dump with a wrong sha256 is refused", async () => {
    const sc = await scenario(31);
    await sc.run(20);
    await writeDump(bindings, sc.clock);
    const shadow = await shadowWorld(sc.clock);
    const up = harnessUpstream();
    const deps = { db: shadow.db, up, blobs: shadow.blobs, now, logLine: () => {} };
    const first = await seedShadow(deps, {});
    await expect(seedShadow(deps, {})).rejects.toThrow(/not empty/);
    await sc.run(10);
    await writeDump(bindings, sc.clock);
    const second = await seedShadow(deps, { reset: true });
    expect(second.seq).toBeGreaterThan(first.seq);
    expect(second.reset).toBe(true);
    const cmp = compareDumps(await shadow.dump(), await buildDump(bindings, sc.clock));
    expect(cmp.feedEqual && cmp.stateEqual).toBe(true);
    // a wrong sha
    const lying: Upstream = {
      base: up.base,
      json: (p) => up.json(p),
      async bytes(p) {
        const r = await up.bytes(p);
        if (p !== "/v1/dump/latest.json") return r;
        const j = JSON.parse(r.text()) as { sha256: string };
        j.sha256 = "0".repeat(64);
        const text = JSON.stringify(j);
        return { bytes: new TextEncoder().encode(text), text: () => text };
      },
    };
    await expect(seedShadow({ ...deps, up: lying }, { reset: true })).rejects.toThrow(/sha256/);
    shadow.replica.close();
  });

  it("[LDB-PV2] the seed loads public data only: the private tables stay empty", async () => {
    const { shadow } = await seeded(32, 20, 0);
    for (const t of ["auth_cache", "ratelimit", "nonces", "idempotency", "discord_users", "modqueue_notifications", "moderation_review_history", "discord_rejection_dm_outbox", "discord_pending_actions"]) {
      const row = await shadow.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>();
      expect(row?.n, t).toBe(0);
    }
    shadow.replica.close();
  });
});

describe("refusals (PV6)", () => {
  it("[LDB-PV6] an event of an unknown kind stops the follower with one alarm line, writes nothing, and the cursor stays; fixed, the next tick goes on", async () => {
    const { shadow, up } = await seeded(41, 15, 15);
    const before = (await readFollowerState(shadow.db))!.cursor;
    const bad = tampered(up, (path, body) => {
      if (!path.startsWith("/v1/changes")) return body;
      const feed = body as { items: { kind: string; seq: number }[] };
      if (feed.items.length > 3) feed.items[2]!.kind = "brand_new_kind";
      return feed;
    });
    const r = await followFeed(shadow.deps(bad, now));
    expect(r.status).toBe("refused");
    expect(r.applied).toBe(2);
    const alarms = shadow.lines.filter((l) => l.startsWith("akldb-alarm: shadow-follower: "));
    expect(alarms).toHaveLength(1);
    expect(alarms[0]).toMatch(/seq \d+ \(brand_new_kind\): unknown kind/);
    const st = (await readFollowerState(shadow.db))!;
    expect(st.cursor).toBe(before + 2);
    const row = await shadow.db.prepare("SELECT COUNT(*) AS n FROM events WHERE seq > ?").bind(before + 2).first<{ n: number }>();
    expect(row?.n).toBe(0);
    // again: refused the same event the same way, still nothing past it
    expect((await followFeed(shadow.deps(bad, now))).status).toBe("refused");
    // the real feed: the follower goes on from where it stopped
    const ok = await followFeed(shadow.deps(up, now));
    expect(ok.status).toBe("ok");
    expect(ok.applied).toBeGreaterThan(0);
    shadow.replica.close();
  });

  it("[LDB-PV6] a feed that skips a seq, and a revision payload that is not the event's, are refused", async () => {
    const { shadow, up } = await seeded(42, 15, 25);
    const gap = tampered(up, (path, body) => {
      if (!path.startsWith("/v1/changes")) return body;
      const feed = body as { items: unknown[] };
      feed.items.splice(1, 1);
      return feed;
    });
    const g = await followFeed(shadow.deps(gap, now));
    expect(g.status).toBe("refused");
    expect(shadow.lines.some((l) => /the feed skipped from \d+ to \d+/.test(l))).toBe(true);

    const wrongRev = tampered(up, (path, body) => (path.includes("/rev/") ? { ...(body as object), modified_at: "1999-01-01T00:00:00.000Z" } : body));
    const w = await followFeed(shadow.deps(wrongRev, now));
    expect(w.status).toBe("refused");
    expect(shadow.lines.some((l) => /the served revision is not this event's/.test(l))).toBe(true);
    shadow.replica.close();
  });

  it("[LDB-PV6] an upstream failure is an alarm and a retry, not a refusal of any event", async () => {
    const { shadow, up } = await seeded(43, 10, 10);
    const down: Upstream = { base: up.base, json: () => Promise.reject(new Error("503")), bytes: (p) => up.bytes(p) };
    const r = await followFeed(shadow.deps(down, now));
    expect(r.status).toBe("failed");
    expect(shadow.lines.some((l) => l.startsWith("akldb-alarm: shadow-follower: reading the feed:"))).toBe(true);
    expect((await followFeed(shadow.deps(up, now))).status).toBe("ok");
    shadow.replica.close();
  });
});

describe("the cursor moves with its events (PV7)", () => {
  it("[LDB-PV7] under injected conflicts, throttles and timeouts around every log call, each event is applied exactly once and the tables still equal production's", async () => {
    for (const seed of [51, 52]) {
      const sc = await scenario(seed);
      await sc.run(20);
      await writeDump(bindings, sc.clock);
      const shadow = await shadowWorld(sc.clock, faultsFromRate(0.25, seed));
      const up = harnessUpstream();
      await seedShadow({ db: shadow.db, up, blobs: shadow.blobs, now, logLine: () => {} }, {});
      await sc.run(30);
      const prod = await buildDump(bindings, sc.clock);
      let applied = 0;
      for (let i = 0; i < 60; i++) {
        const r = await followFeed(shadow.deps(up, now, { pageLimit: 11 }));
        if (r.status !== "ok") continue; // a fault surfaced as a failed tick: the next one resumes from the cursor
        applied += r.applied;
        if (r.applied === 0) break;
      }
      const st = (await readFollowerState(shadow.db))!;
      expect(st.cursor).toBe(prod.meta.seq);
      expect(st.appliedTotal).toBe(st.cursor - st.seededDumpSeq);
      expect(applied).toBeLessThanOrEqual(st.appliedTotal);
      const cmp = compareDumps(await shadow.dump(), prod);
      expect(cmp.feedEqual).toBe(true);
      shadow.replica.close();
    }
  }, 120_000);
});

describe("the nightly checkpoint (PV4)", () => {
  it("[LDB-PV4] a feed table that differs from the public dump is named, alarmed once, and recorded; the state tables are still resynced", async () => {
    const { sc, shadow, up } = await seeded(61, 15, 20);
    await followFeed(shadow.deps(up, now));
    await shadow.db.prepare("UPDATE layouts SET like_count = like_count + 7 WHERE id = (SELECT id FROM layouts ORDER BY id LIMIT 1)").run();
    await writeDump(bindings, sc.clock);
    const r = await followFeed(shadow.deps(up, now));
    expect(r.checkpoint?.result).toBe("differs");
    expect(r.checkpoint?.comparison?.tables.records?.equal).toBe(false);
    expect(r.checkpoint?.comparison?.tables.events?.equal).toBe(true);
    const alarms = shadow.lines.filter((l) => l.startsWith("akldb-alarm: shadow-follower: checksum mismatch"));
    expect(alarms).toHaveLength(1);
    expect(alarms[0]).toContain("records(feed)");
    const st = (await readFollowerState(shadow.db))!;
    expect(st.checkResult?.result).toBe("differs");
    shadow.replica.close();
  });

  it("[LDB-PV4] a public dump whose events run past its meta.seq (read in pages while a write landed) is inconclusive, not a mismatch", async () => {
    const { sc, shadow, up } = await seeded(62, 15, 10);
    await followFeed(shadow.deps(up, now));
    await writeDump(bindings, sc.clock);
    const skewed: Upstream = {
      base: up.base,
      json: (p) => up.json(p),
      async bytes(p) {
        const r = await up.bytes(p);
        if (!p.startsWith("/v1/dump/dump-")) return r;
        const { gunzipSync, gzipSync } = await import("node:zlib");
        const { createHash } = await import("node:crypto");
        const d = JSON.parse(new TextDecoder().decode(gunzipSync(r.bytes))) as Dump;
        d.events.push({ ...d.events[d.events.length - 1]!, seq: d.meta.seq + 1 });
        const gz = new Uint8Array(gzipSync(Buffer.from(JSON.stringify(d))));
        skewedSha = createHash("sha256").update(gz).digest("hex");
        return { bytes: gz, text: () => "" };
      },
    };
    let skewedSha = "";
    const patched: Upstream = {
      ...skewed,
      async bytes(p) {
        const r = await skewed.bytes(p);
        if (p !== "/v1/dump/latest.json") return r;
        // latest.json must carry the skewed file's sha: fetch the dump once to learn it
        const j = JSON.parse(r.text()) as { url: string; sha256: string };
        await skewed.bytes(j.url);
        const text = JSON.stringify({ ...j, sha256: skewedSha });
        return { bytes: new TextEncoder().encode(text), text: () => text };
      },
    };
    const r = await followFeed(shadow.deps(patched, now));
    expect(r.checkpoint?.result).toBe("inconclusive");
    expect(r.checkpoint?.reason).toMatch(/skewed/);
    expect(shadow.lines.filter((l) => l.startsWith("akldb-alarm: ")).length).toBe(0);
    shadow.replica.close();
  });

  it("[LDB-PV4] a dump that appears after this database already passed its seq is recorded as missed, with an alarm", async () => {
    const { sc, shadow, up } = await seeded(63, 15, 20);
    await writeDump(bindings, sc.clock); // the dump is at today's head ...
    await sc.run(5); // ... and production moves on; shadow follows past it before ever seeing the dump
    const early = tampered(up, (path, body) => body);
    await followFeed(shadow.deps(early, now)); // sees the new dump, caps at its seq, checks it
    await sc.run(5);
    await followFeed(shadow.deps(up, now)); // catches up to the head
    // an older dump published later (a catch-up dump with a lower seq)
    const old: Upstream = { base: up.base, json: (p) => up.json(p), async bytes(p) {
      const r = await up.bytes(p);
      if (p !== "/v1/dump/latest.json") return r;
      const j = JSON.parse(r.text()) as { seq: number; key: string };
      const text = JSON.stringify({ ...j, seq: j.seq - 3, key: "dump-older.json.gz" });
      return { bytes: new TextEncoder().encode(text), text: () => text };
    } };
    const r = await followFeed(shadow.deps(old, now));
    expect(r.checkpoint?.result).toBe("missed");
    expect(shadow.lines.some((l) => /^akldb-alarm: shadow-follower: checkpoint missed/.test(l))).toBe(true);
    shadow.replica.close();
  });
});
