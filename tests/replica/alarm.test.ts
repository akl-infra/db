// The uniform failure prefix (RP9): every boot fallback taken, every snapshot, retention or proof failure, an unverified daily
// slot and a replica divergence logs EXACTLY ONE line starting `akldb-alarm: <component>: `; successes keep their info lines.
import { describe, expect, it } from "vitest";
import { ALARM_PREFIX, alarmLine } from "../../src/replica/alarm";
import { bootReplica } from "../../src/replica/boot";
import { runNightlyJobs, runRollingJob } from "../../src/replica/jobs";
import type { CommitLog, LogEntry } from "../../src/replica/log";
import { Replica, ReplicaDivergedError } from "../../src/replica/replica";
import { writeDaily } from "../../src/replica/retention";
import { writeSnapshot } from "../../src/replica/snapshot";
import { FAST, churn, world } from "./support";

const alarms = (lines: string[]) => lines.filter((l) => l.startsWith(ALARM_PREFIX));

describe("akldb-alarm lines (RP9)", () => {
  it("[LDB-RP9] an alarm line is one line: the prefix, the component, the message with newlines folded", () => {
    expect(ALARM_PREFIX).toBe("akldb-alarm: ");
    expect(alarmLine("boot", "a\nb\r\n  c")).toBe("akldb-alarm: boot: a b c");
  });

  it("[LDB-RP9] a healthy boot, snapshot and nightly run raise no alarm line", async () => {
    const w = await world();
    await churn(w.replica, 8);
    await writeSnapshot(w.replica, w.deps);
    const r = await bootReplica(w.log, { ...FAST, snapshots: { state: w.state, objects: w.objects }, logLine: (m) => void w.lines.push(m) });
    expect(r.seq).toBe(w.log.length);
    w.clock.ms = Date.parse("2026-11-02T04:00:00Z");
    await runNightlyJobs(w.replica, { ...w.deps, log: w.log, replica: FAST });
    expect(alarms(w.lines)).toEqual([]);
    expect(w.lines.some((l) => l.startsWith("akldb-boot: path=pointer"))).toBe(true);
    expect(w.lines.some((l) => l.startsWith("akldb-snapshot: "))).toBe(true);
  });

  it("[LDB-RP9] a boot fallback taken is one line each (pointer, then prev), whatever the reason", async () => {
    const w = await world();
    await churn(w.replica, 8);
    await writeSnapshot(w.replica, w.deps);
    await churn(w.replica, 4, 2);
    await writeSnapshot(w.replica, w.deps);
    const pointer = (await w.state.pointer())!;
    w.objects.failGet.add(pointer.key); // a GET failure
    w.objects.objects.delete((await w.state.previous())!.key); // a missing object
    const lines: string[] = [];
    await bootReplica(w.log, { ...FAST, snapshots: { state: w.state, objects: w.objects }, logLine: (m) => void lines.push(m) });
    expect(alarms(lines)).toHaveLength(2);
    expect(alarms(lines)[0]).toMatch(/^akldb-alarm: boot: fallback: pointer unusable: /);
    expect(alarms(lines)[1]).toMatch(/^akldb-alarm: boot: fallback: prev unusable: .*missing/);
  });

  it("[LDB-RP9] a failed rolling snapshot is one line, and the error still propagates", async () => {
    const w = await world();
    await churn(w.replica, 8);
    w.objects.failPut.add("snap/");
    const lines: string[] = [];
    await expect(runRollingJob(w.replica, { ...w.deps, log: w.log, logLine: (m) => void lines.push(m) })).rejects.toThrow(/injected PUT failure/);
    expect(alarms(lines)).toHaveLength(1);
    expect(alarms(lines)[0]).toMatch(/^akldb-alarm: snapshot: rolling snapshot failed: .*injected PUT failure/);
  });

  it("[LDB-RP9] a failed daily snapshot is one line from the nightly job; retention and the proof still run and add none of their own", async () => {
    const w = await world();
    await churn(w.replica, 8);
    w.clock.ms = Date.parse("2026-11-02T04:00:00Z");
    w.objects.failPut.add("snap/daily/");
    await expect(runNightlyJobs(w.replica, { ...w.deps, log: w.log, replica: FAST })).rejects.toThrow(/nightly jobs failed: daily snapshot: .*injected PUT failure/);
    expect(alarms(w.lines)).toHaveLength(1);
    expect(alarms(w.lines)[0]).toMatch(/^akldb-alarm: snapshot: daily snapshot failed: /);
  });

  it("[LDB-RP9] a failed retention is one line", async () => {
    const w = await world();
    await churn(w.replica, 8);
    w.clock.ms = Date.parse("2026-11-02T04:00:00Z");
    const broken = Object.assign(Object.create(w.log) as typeof w.log, {
      expire: async () => {
        throw new Error("injected: expire failed");
      },
      head: () => w.log.head(),
      read: (a: number, b: number) => w.log.read(a, b),
      append: (h: number, e: Parameters<typeof w.log.append>[1]) => w.log.append(h, e),
      get: (s: number) => w.log.get(s),
    });
    // retention only reaches expire() once an anchor is 35 days old; make the anchor look old
    w.state.set("pointer", null);
    const r = await runNightlyJobs(w.replica, { ...w.deps, log: broken, replica: FAST });
    expect(alarms(w.lines)).toEqual([]);
    expect(r.retention?.boundary).toBeNull();
    // 36 days on, retention reaches expire() and its failure is one line
    w.clock.ms += 36 * 86_400_000;
    await churn(w.replica, 2, 3);
    await expect(runNightlyJobs(w.replica, { ...w.deps, log: broken, replica: FAST })).rejects.toThrow(/nightly jobs failed: log retention: injected: expire failed/);
    expect(alarms(w.lines)).toHaveLength(1);
    expect(alarms(w.lines)[0]).toMatch(/^akldb-alarm: retention: log retention failed: injected: expire failed/);
  });

  it("[LDB-RP9] an unverified daily slot is one line per run, shared by retention and the proof", async () => {
    const w = await world();
    await churn(w.replica, 6);
    w.clock.ms = Date.parse("2026-11-02T04:00:00Z");
    await writeDaily(w.replica, w.deps);
    await churn(w.replica, 3, 2);
    w.clock.ms += 86_400_000;
    await writeDaily(w.replica, w.deps);
    await churn(w.replica, 3, 3);
    const oldest = (await w.state.dailies())[0]!;
    w.objects.peek(oldest.key)!.bytes[30]! ^= 0x33;
    w.clock.ms += 86_400_000;
    w.lines.length = 0;
    await runNightlyJobs(w.replica, { ...w.deps, log: w.log, replica: FAST });
    expect(alarms(w.lines)).toHaveLength(1);
    expect(alarms(w.lines)[0]).toMatch(new RegExp(`^akldb-alarm: retention: daily snapshot ${oldest.key.replace(/[.]/g, "\\.")} \\(seq ${oldest.seq}\\) is unverified`));
  });

  it("[LDB-RP9] a replica divergence is one line when it halts, however many calls fail afterwards", async () => {
    const w = await world();
    await churn(w.replica, 4);
    const tampered: CommitLog = {
      head: () => w.log.head(),
      append: (h, e) => w.log.append(h, e),
      get: (s) => w.log.get(s),
      read: async (a, b) => (await w.log.read(a, b)).map((e): LogEntry => (e.seq === w.log.length ? { ...e, hash: "f".repeat(64) } : e)),
    };
    const lines: string[] = [];
    const bad = new Replica(tampered, { ...FAST, alarm: (l) => void lines.push(l) });
    await expect(bad.catchUp()).rejects.toBeInstanceOf(ReplicaDivergedError);
    await expect(bad.catchUp()).rejects.toBeInstanceOf(ReplicaDivergedError);
    await expect(bad.runUnit([{ sql: "SELECT 1", params: [] }])).rejects.toBeInstanceOf(ReplicaDivergedError);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^akldb-alarm: replica: halted at seq \d+: ReplicaDivergedError: seq \d+ \(unit \w+\): changeset hash/);
  });

  it("[LDB-RP9] a snapshot whose tail does not replay is ONE line (the boot fallback), not a second one from the discarded replica", async () => {
    const w = await world();
    await churn(w.replica, 6);
    await writeSnapshot(w.replica, w.deps);
    await churn(w.replica, 4, 2);
    const corruptTail: CommitLog = {
      head: () => w.log.head(),
      append: (h, e) => w.log.append(h, e),
      get: (s) => w.log.get(s),
      read: async (a, b) => (await w.log.read(a, b)).map((e): LogEntry => (e.seq === w.log.length ? { ...e, hash: "e".repeat(64) } : e)),
    };
    const lines: string[] = [];
    // the corrupt entry also breaks the from-0 replay, so the boot ends in the final path; what matters: the pointer attempt is one line
    await bootReplica(corruptTail, { ...FAST, snapshots: { state: w.state, objects: w.objects }, logLine: (m) => void lines.push(m) }).catch(() => undefined);
    expect(alarms(lines).filter((l) => l.startsWith("akldb-alarm: boot: fallback: pointer"))).toHaveLength(1);
    expect(alarms(lines).filter((l) => l.startsWith("akldb-alarm: replica: "))).toHaveLength(1); // the final replay path's own halt, once
  });
});
