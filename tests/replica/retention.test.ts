// Retention and the nightly proof (design A phase B): RP3 (log retention covers the 35-day point-in-time window: an entry
// is marked for expiry only up to a verified, old-enough daily snapshot, and restore to any seq in the window equals a replay
// from 0) and RP4 (the nightly digest of a rebuild from the oldest retained snapshot plus the log equals the live replica;
// a mismatch throws). A fake clock drives 46 days; DynamoDB's TTL sweep is MemoryLog.purge.
import { describe, expect, it } from "vitest";
import { ulid } from "ulidx";
import { bootReplica, bootReportOf } from "../../src/replica/boot";
import { MemoryLog } from "../../src/replica/log-memory";
import { NIGHTLY_LEASE_MS, nightlyDue, runNightlyJobs } from "../../src/replica/jobs";
import { ProofMismatchError, nightlyProof, restoreAt } from "../../src/replica/proof";
import { EXPIRY_GRACE_S, SPILL_GRACE_MS, cleanSpills, dailyDue, runRetention } from "../../src/replica/retention";
import { DAILY_SLOTS, PITR_DAYS, dailyKey, dailySlot, writeSnapshot } from "../../src/replica/snapshot";
import { FAST, churn, digestOf, replayFrom0, world, type World } from "./support";

const DAY = 86_400_000;
const START = Date.parse("2026-11-02T00:00:00Z");

/** Append whatever `from` has that `to` lacks (so an archive keeps entries the TTL sweep later removes). */
async function mirror(to: MemoryLog, from: MemoryLog): Promise<void> {
  for (const e of from.entries().filter((x) => x.seq > to.length)) await to.append(e.seq - 1, { unitId: e.unitId, kind: e.kind, stmts: e.stmts, hash: e.hash, name: e.name, at: e.at });
}

async function simulate(w: World, days: number, opts: { purge?: boolean; unitsPerDay?: number; retention?: boolean } = {}) {
  const archive = new MemoryLog();
  // a log without expire(): the daily job then writes snapshots and proves, but marks nothing
  const plain = { head: () => w.log.head(), read: (a: number, b: number) => w.log.read(a, b), append: (h: number, e: Parameters<MemoryLog["append"]>[1]) => w.log.append(h, e), get: (s: number) => w.log.get(s) };
  for (let d = 0; d < days; d++) {
    w.clock.ms = START + d * DAY + 3 * 3_600_000 + 5 * 60_000;
    await churn(w.replica, opts.unitsPerDay ?? 3, d + 1);
    await runNightlyJobs(w.replica, { ...w.deps, log: opts.retention === false ? plain : w.log, replica: FAST });
    await mirror(archive, w.log);
    if (opts.purge !== false) w.log.purge(w.clock.ms / 1000);
  }
  return archive;
}

describe("daily snapshots and retention (RP3)", () => {
  it("[LDB-RP3] [LDB-RP10] one daily snapshot per UTC day from 03:00, rotating through 40 slots, started once per day by a claim", async () => {
    const w = await world();
    expect(dailyDue([], START + 2 * 3_600_000)).toBe(false); // 02:00
    expect(dailyDue([], START + 3 * 3_600_000)).toBe(true);
    await churn(w.replica, 3);
    w.clock.ms = START + 4 * 3_600_000;
    const jobs = () => runNightlyJobs(w.replica, { ...w.deps, log: w.log, replica: FAST });
    expect(await nightlyDue(w.deps)).toBe(true);
    expect((await jobs()).daily).toMatchObject({ status: "written" });
    expect(await nightlyDue(w.deps)).toBe(false); // today's exists
    expect((await jobs()).status).toBe("busy"); // the claim holds for the lease: a second start does nothing
    w.clock.ms += NIGHTLY_LEASE_MS + 1;
    expect((await jobs()).daily).toBe("exists"); // past the lease a rerun skips the daily that exists and redoes retention and the proof
    expect(await w.state.dailies()).toHaveLength(1);
    w.clock.ms = START + DAY + 4 * 3_600_000;
    await churn(w.replica, 2, 2);
    expect((await jobs()).daily).toMatchObject({ status: "written" });
    expect((await w.state.dailies()).map((d) => d.slot)).toEqual([dailySlot(START), dailySlot(START + DAY)]);
    expect(dailyKey(3)).toBe("snap/daily/03.sqlite.zst");
  });

  it("[LDB-RP3] nothing is marked for expiry until the oldest verified daily snapshot is 35 days old", async () => {
    const w = await world();
    await simulate(w, PITR_DAYS - 1); // days 0..33: the oldest daily is 33 days old at the end
    const r = await runRetention(w.log, w.deps);
    expect(r).toMatchObject({ boundary: null, marked: 0 });
    expect(r.reason).toMatch(/younger than 35 days/);
    for (let seq = 1; seq <= w.log.length; seq++) expect(w.log.ttlOf(seq)).toBeUndefined();
    expect(w.log.first).toBe(1);
  });

  it("[LDB-RP3] after 46 days: entries are marked only up to the oldest daily snapshot, expire, and every seq in the 35-day window restores to exactly what a replay from 0 gives", async () => {
    const w = await world();
    const archive = await simulate(w, 46);
    const dailies = await w.state.dailies();
    expect(dailies).toHaveLength(DAILY_SLOTS);
    const oldest = dailies[0]!;
    expect(oldest.day).toBe(new Date(START + 6 * DAY).toISOString().slice(0, 10)); // days 0..5 were overwritten by days 40..45
    // the log was cut at the oldest daily snapshot and keeps everything after it
    expect(w.log.first).toBeGreaterThan(1);
    expect(w.log.first).toBeLessThanOrEqual(oldest.seq + 1);
    expect(w.log.length).toBe(archive.length);
    // the window: any seq whose entry is newer than 35 days restores from a retained snapshot + retained log
    const windowStartSeq = (await w.state.dailies()).filter((d) => w.clock.ms - Date.parse(d.at) >= PITR_DAYS * DAY).at(-1)!.seq;
    expect(windowStartSeq).toBeGreaterThanOrEqual(oldest.seq);
    const ks: number[] = [];
    for (let k = windowStartSeq; k <= w.log.length; k += 7) ks.push(k);
    ks.push(windowStartSeq, windowStartSeq + 1, w.log.length);
    for (const k of new Set(ks)) {
      const { replica, base } = await restoreAt(k, { log: w.log, state: w.state, objects: w.objects, replica: FAST, logLine: () => {} });
      const reference = await replayFrom0(archive, k);
      expect(replica.seq).toBe(k);
      expect(digestOf(replica), `restore to seq ${k} from ${base?.key}`).toBe(digestOf(reference));
      replica.close();
      reference.close();
    }
  }, 120_000);

  it("[LDB-RP3] an entry that no verified snapshot covers never gets an expiry: damaged anchors are skipped, and with none verifying nothing is marked", async () => {
    const w = await world();
    await simulate(w, 41, { purge: false, retention: false });
    const dailies = await w.state.dailies();
    const [oldest, second] = [dailies[0]!, dailies[1]!];
    // damage the oldest: the anchor moves to the next one
    w.objects.peek(oldest.key)!.bytes[40]! ^= 0xff;
    const r = await runRetention(w.log, w.deps);
    expect(r.boundary).toBe(second.seq);
    expect(r.unverified).toHaveLength(1);
    for (let seq = 1; seq <= w.log.length; seq++) {
      if (seq <= second.seq) expect(w.log.ttlOf(seq), `seq ${seq}`).toBe(Math.floor(w.clock.ms / 1000) + EXPIRY_GRACE_S);
      else expect(w.log.ttlOf(seq), `seq ${seq}`).toBeUndefined();
    }
    // now every daily is damaged (fresh log, so the earlier marks are not in the way)
    const w2 = await world();
    await simulate(w2, 41, { purge: false, retention: false });
    for (const d of await w2.state.dailies()) w2.objects.peek(d.key)!.bytes[40]! ^= 0xff;
    const none = await runRetention(w2.log, w2.deps);
    expect(none).toMatchObject({ boundary: null, marked: 0 });
    for (let seq = 1; seq <= w2.log.length; seq++) expect(w2.log.ttlOf(seq)).toBeUndefined();
  }, 60_000);

  it("[LDB-RP3] retention resumes from its mark and is idempotent", async () => {
    const w = await world();
    await simulate(w, 41, { purge: false, retention: false });
    const first = await runRetention(w.log, w.deps);
    expect(first.marked).toBe(first.boundary);
    expect(await w.state.expiredThrough()).toBe(first.boundary);
    const again = await runRetention(w.log, w.deps);
    expect(again.marked).toBe(0);
    expect(again.through).toBe(first.boundary);
  }, 60_000);

  it("[LDB-RP3] with the log purged, a boot with no usable snapshot says the log no longer starts at 1 instead of serving a partial database", async () => {
    const w = await world();
    await simulate(w, 46);
    expect(w.log.first).toBeGreaterThan(1);
    const { bootReplica } = await import("../../src/replica/boot");
    await expect(bootReplica(w.log, { ...FAST, logLine: () => {} })).rejects.toThrow(/the log now starts at seq \d+: retention expired the entries before it/);
  }, 120_000);
});

describe("boot after retention (RP2, RP3)", () => {
  const boot = (w: World, lines: string[]) => bootReplica(w.log, { ...FAST, snapshots: { state: w.state, objects: w.objects }, logLine: (m) => void lines.push(m) });

  it("[LDB-RP2] after retention has cut the log start, a bad POINTER and PREV boot from the newest daily and its tail; the log cannot be replayed from 0", async () => {
    const w = await world();
    const archive = await simulate(w, 46);
    await writeSnapshot(w.replica, w.deps);
    await churn(w.replica, 2, 76);
    await writeSnapshot(w.replica, w.deps); // POINTER and PREV exist (and are newer than every daily)
    await churn(w.replica, 3, 77);
    expect(w.log.first).toBeGreaterThan(1);
    for (const k of [(await w.state.pointer())!.key, (await w.state.previous())!.key]) w.objects.peek(k)!.bytes[40]! ^= 0xff;
    await mirror(archive, w.log);
    const lines: string[] = [];
    const r = await boot(w, lines);
    const report = bootReportOf(r)!;
    expect(report.path).toBe("daily");
    expect(report.snapshot!.seq).toBe((await w.state.dailies()).at(-1)!.seq); // the newest daily
    expect(r.seq).toBe(w.log.length);
    expect(digestOf(r)).toBe(digestOf(await replayFrom0(archive)));
    expect(lines.filter((l) => l.startsWith("akldb-alarm: "))).toHaveLength(2);
    // and it really was the only path left: with no snapshots at all, the same log refuses to boot
    const none = await bootReplica(w.log, { ...FAST, logLine: () => {} }).catch((e: unknown) => e);
    expect((none as Error).message).toMatch(/the log now starts at seq/);
  }, 120_000);

  it("[LDB-RP2] when all four paths fail the boot throws, with one final alarm line after one per fallback", async () => {
    const w = await world();
    await simulate(w, 46);
    await writeSnapshot(w.replica, w.deps);
    await churn(w.replica, 2, 76);
    await writeSnapshot(w.replica, w.deps);
    const refs = [await w.state.pointer(), await w.state.previous(), ...(await w.state.dailies())];
    for (const ref of refs) w.objects.peek(ref!.key)!.bytes[40]! ^= 0xff;
    const lines: string[] = [];
    await expect(boot(w, lines)).rejects.toThrow(/the log now starts at seq/);
    const alarms = lines.filter((l) => l.startsWith("akldb-alarm: "));
    expect(alarms).toHaveLength(2 + DAILY_SLOTS + 1); // pointer, prev, every daily, then "no usable path"
    expect(alarms.slice(0, -1).every((l) => l.startsWith("akldb-alarm: boot: fallback: "))).toBe(true);
    expect(alarms.at(-1)).toMatch(/^akldb-alarm: boot: no usable path: every snapshot failed and the log cannot be replayed from seq 0: /);
    expect(lines.some((l) => l.startsWith("akldb-boot: path="))).toBe(false);
  }, 120_000);
});

describe("spilled bodies outlive their entries only briefly (RP7, RP3)", () => {
  it("[LDB-RP7] retention deletes log/* objects older than the oldest kept entry (less a grace), orphans included, and nothing else", async () => {
    const w = await world();
    await churn(w.replica, 12);
    const now = Date.now();
    const oldOrphan = `log/${ulid(now - 10 * DAY)}.json.zst`;
    const graceOrphan = `log/${ulid(now - SPILL_GRACE_MS + 3_600_000)}.json.zst`; // inside the grace
    const newer = `log/${ulid(now + DAY)}.json.zst`;
    for (const k of [oldOrphan, graceOrphan, newer, "log/not-a-ulid.json.zst", "snap/slot-0.sqlite.zst"]) w.blobs.objects.set(k, { bytes: new Uint8Array([1]), meta: {} });
    // nothing is marked yet: nothing is deleted
    expect(await cleanSpills(w.log, { ...w.deps, objects: w.blobs }, 0)).toBe(0);
    // entries 1..5 are marked: the oldest kept is seq 6, whose unit was minted just now
    const deleted = await cleanSpills(w.log, { ...w.deps, objects: w.blobs }, 5);
    expect(deleted).toBe(1);
    expect(w.blobs.keys().sort()).toEqual([graceOrphan, newer, "log/not-a-ulid.json.zst", "snap/slot-0.sqlite.zst"].sort());
  });
});

describe("the nightly proof (RP4)", () => {
  it("[LDB-RP4] a rebuild from the oldest retained daily snapshot plus the log has the live replica's digest, at the same seq", async () => {
    const w = await world();
    await simulate(w, 20, { purge: false });
    const oldest = (await w.state.dailies())[0]!;
    const out = await nightlyProof(w.replica, { log: w.log, state: w.state, objects: w.objects, replica: FAST, logLine: (m) => void w.lines.push(m) });
    expect(out.seq).toBe(w.log.length);
    expect(out.base?.key).toBe(oldest.key);
    expect(out.digest).toBe(digestOf(w.replica));
    expect(w.lines.at(-1)).toMatch(/^akldb-proof: ok seq=\d+ digest=[0-9a-f]{64} base=snap\/daily\/\d\d\.sqlite\.zst@\d+$/);
  }, 60_000);

  it("[LDB-RP4] a live replica that differs from what the log produces makes the proof throw", async () => {
    const w = await world();
    await simulate(w, 5, { purge: false });
    w.replica.db.exec("UPDATE churn SET v = 'edited outside the log' WHERE id = (SELECT min(id) FROM churn)"); // a replay bug, in effect
    const err = await nightlyProof(w.replica, { log: w.log, state: w.state, objects: w.objects, replica: FAST, logLine: () => {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProofMismatchError);
    expect((err as ProofMismatchError).seq).toBe(w.log.length);
    expect((err as Error).message).toMatch(/nightly proof FAILED at seq \d+: the live replica's image digest [0-9a-f]{64} != [0-9a-f]{64}/);
  });

  it("[LDB-RP4] the nightly job surfaces a mismatch as the page, after the other jobs ran", async () => {
    const w = await world();
    await simulate(w, 3, { purge: false });
    w.clock.ms = START + 5 * DAY + 4 * 3_600_000;
    await churn(w.replica, 2, 50);
    w.replica.db.exec("DELETE FROM churn WHERE id = (SELECT min(id) FROM churn)"); // outside the log: the live replica now differs from what the log produces
    const err = await runNightlyJobs(w.replica, { ...w.deps, log: w.log, replica: FAST }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProofMismatchError);
    // the daily snapshot was still written before the proof threw, and the failure raised exactly one alarm line
    expect((await w.state.dailies()).at(-1)!.day).toBe(new Date(w.clock.ms).toISOString().slice(0, 10));
    expect(w.lines.filter((l) => l.startsWith("akldb-alarm: "))).toEqual([expect.stringMatching(/^akldb-alarm: proof: nightly proof failed: nightly proof FAILED at seq \d+/)]);
  });

  it("[LDB-RP4] the proof skips a daily snapshot that does not verify and anchors on the next oldest", async () => {
    const w = await world();
    await simulate(w, 6, { purge: false });
    const dailies = await w.state.dailies();
    w.objects.peek(dailies[0]!.key)!.bytes[30]! ^= 0x11;
    const out = await nightlyProof(w.replica, { log: w.log, state: w.state, objects: w.objects, replica: FAST, logLine: (m) => void w.lines.push(m) });
    expect(out.base?.key).toBe(dailies[1]!.key);
    expect(w.lines.filter((l) => l.startsWith("akldb-alarm: "))).toEqual([expect.stringMatching(/^akldb-alarm: retention: daily snapshot snap\/daily\/\d\d\.sqlite\.zst \(seq \d+\) is unverified/)]);
  });

  it("[LDB-RP4] the live replica keeps committing while the proof rebuilds, and the proof still compares at the seq it captured", async () => {
    const w = await world();
    await simulate(w, 8, { purge: false });
    const proof = nightlyProof(w.replica, { log: w.log, state: w.state, objects: w.objects, replica: FAST, logLine: () => {} });
    await churn(w.replica, 25, 99);
    const out = await proof;
    expect(out.seq).toBeLessThanOrEqual(w.log.length);
    expect(w.replica.seq).toBe(w.log.length);
  }, 60_000);

  it("[LDB-RP4] a rolling snapshot never stands in for the daily anchor, and snapshots of the same seq give the same image on any replica", async () => {
    const w = await world();
    await churn(w.replica, 10);
    const a = await writeSnapshot(w.replica, w.deps);
    const b = await replayFrom0(w.log);
    const second = new (await import("../../src/replica/replica")).Replica(w.log, FAST);
    await second.catchUp();
    expect(digestOf(second)).toBe(digestOf(b));
    expect(a.status === "written" && a.ref.seq).toBe(w.log.length);
    expect(await w.state.dailies()).toEqual([]);
  });
});
