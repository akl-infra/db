// [LDB-PV10] The gate report: the D row of the build plan as a table, each row PASS, FAIL or OPEN from its evidence, and the whole
// passes only when every row does. Synthetic evidence; nothing here talks to AWS or a host.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain script, no declaration file
import * as libMod from "../../scripts/lab/shadow/gate/lib.mjs";
// @ts-expect-error -- plain script, no declaration file
import * as costMod from "../../scripts/lab/shadow/gate/cost.mjs";
import { createLambdaHandler } from "../../src/platform/lambda";
import type { Aws } from "../../src/platform/lambda-aws";
import { memoryBlobs } from "../../src/platform/node";
import { MemoryLog } from "../../src/replica/log-memory";
import { Replica } from "../../src/replica/replica";

/* eslint-disable @typescript-eslint/no-explicit-any */
const { evaluate, renderGate, parseLogs, logLines, parseMac, cleanDays, pct } = libMod as any;
const prices = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "..", "scripts", "lab", "shadow", "gate", "prices.json"), "utf8"));
const ROOT = path.resolve(import.meta.dirname, "..", "..");
void costMod;

const DAYS = ["2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11"];
const rec = (d: string, verdict = "equal", cls = "layouts-list", problems: unknown[] = []) => ({ at: `${d}T10:00:00.000Z`, n: 1, class: cls, group: "feed", path: "/v1/x", query: "", phase: "200", verdict, problems });
const goodRecords = (days = DAYS) => days.flatMap((d) => ["meta", "formats", "layouts-list", "layout", "layout-sub", "layout-rev", "changes", "authors", "comments", "wpm", "comment-counts", "layout-comments"].map((c) => rec(d, "equal", c)));
const cp = (d: string, result = "equal") => `akldb-checkpoint: ${JSON.stringify({ result, dumpKey: `dump-${d}.json.gz`, dumpSeq: 5, feedEqual: result === "equal", stateEqual: false, tables: {}, ms: 900 })}`;
const logsFor = (days = DAYS, extra: { ts?: string; message: string }[] = []) => parseLogs(logLines(JSON.stringify({ events: [...days.map((d) => ({ timestamp: Date.parse(`${d}T03:05:00Z`), message: JSON.stringify({ level: "ERROR", message: cp(d) }) })), ...extra.map((e) => ({ timestamp: Date.parse(e.ts ?? `${days[days.length - 1]}T12:00:00Z`), message: e.message }))] })));
const cell = (p50: number, p95: number, n = 20) => ({ full: Array(n).fill(p50), revalid: Array(n).fill(p50), p50, p95, p50_304: p50, p95_304: p95, statuses: [200, 304], cache: ["DYNAMIC"], bytes: 1, errors: 0 });
const probeOf = (shadowDelta = -1, n = 20) => ({ startedAt: "x", n, vantage: "us-east-2", routes: ["/v1/meta", "/v1/formats", "/v1/authors"].map((path) => ({ path, kind: "k", hosts: { prod: cell(20, 40, n), shadow: cell(20 + shadowDelta, 40 + shadowDelta, n) } })) });
const MAC = `latency-compare 2026-11-10T10:00:00Z, n=20 per cell, from this machine. ms p50/p95; 304 = If-None-Match revalidation.

| route | kind | prod 200 | stage 200 | prod 304 | stage 304 | prod status / cf-cache | stage status / cf-cache |
|---|---|---|---|---|---|---|---|
| \`/v1/meta\` | validated (head seq + authors + import state) | 54 / 81 | 88 / 100 | 41 / 55 | 71 / 90 | 200,304 DYNAMIC | 200,304 DYNAMIC |
| \`/v1/formats\` | static (code only, no DB) | 20 / 30 | 21 / 31 | — | — | 200 DYNAMIC | 200 HIT |
| \`/v1/dump/latest.json\` | blob (R2 / S3) | 87 / 120 | 96 / 130 | 91 / 100 | 84 / 90 | 200,304 - | 200,304 - |
`;
const evidence = (over: Record<string, unknown> = {}) => ({
  records: goodRecords(),
  logs: logsFor(DAYS, [
    ...Array.from({ length: 3 }, () => ({ message: JSON.stringify({ message: `akldb-cold: ${JSON.stringify({ first: "http", initMs: 180, requestMs: 260 })}` }) })),
    { message: "akldb-boot: path=pointer snapshot=snap/slot-0.sqlite.zst snapshotSeq=5 seq=5 replayed=0" },
  ]),
  probe: probeOf(),
  mac: parseMac(MAC),
  colos: [{ colo: "CMH", share: 0.6, prod_ms: 150, shadow_ms: 120 }, { colo: "FRA", share: 0.4, prod_ms: 470, shadow_ms: 400 }],
  metrics: { ApiRequests: 1000, Invocations: 1200, Duration: 60_000, ConsumedReadCapacityUnits: 20_000, ConsumedWriteCapacityUnits: 400 },
  run: { window_hours: 168, scale: 1, lambda_memory_mb: 2048, storage_gb: { dynamodb: 0.01, s3: 0.05 }, logs_gb_per_window: 0.005, s3_gets: 200, s3_puts: 2100 },
  prices,
  classes: ["meta", "formats", "layouts-list", "layout", "layout-sub", "layout-rev", "changes", "authors", "comments", "wpm"],
  ...over,
});
const row = (g: any, id: string) => g.rows.find((r: any) => r.id === id);

describe("the gate table", () => {
  it("[LDB-PV10] complete, good evidence passes every row and the report names each one", () => {
    const g = evaluate(evidence());
    expect(g.rows.map((r: any) => `${r.id}:${r.status}`), JSON.stringify(g.rows.filter((r: any) => r.status !== "PASS"))).toEqual(["1:PASS", "2a:PASS", "2b:PASS", "2c:PASS", "3:PASS", "4:PASS", "5:PASS"]);
    expect(g.pass).toBe(true);
    const md = renderGate(g, { generated: "2026-11-12" });
    expect(md).toContain("**PASS**");
    expect(md).toContain("| 2a | latency (a)");
    expect(md).toContain("| 2026-11-11 |");
  });

  it("[LDB-PV10] row 1: a diff, a missing or unequal checkpoint, a replica halt or a follower alarm makes the day unclean and restarts the count; fewer than seven clean days is OPEN, not PASS", () => {
    const lessThan7 = evaluate(evidence({ records: goodRecords(DAYS.slice(0, 5)), logs: logsFor(DAYS.slice(0, 5)) }));
    expect(row(lessThan7, "1").status).toBe("OPEN");
    expect(row(lessThan7, "1").detail).toContain("5 consecutive clean");
    const day = (d: string) => cleanDays(goodRecords(), logsFor()).rows.find((r: any) => r.day === d);
    expect(day("2026-11-07").clean).toBe(true);
    for (const [label, records, logs, why] of [
      ["a diff", [...goodRecords(), rec("2026-11-08", "diff")], logsFor(), /1 diff/],
      ["a replay error", [...goodRecords(), rec("2026-11-08", "error")], logsFor(), /1 replay error/],
      ["a differing checkpoint", goodRecords(), parseLogs(logLines(JSON.stringify({ events: DAYS.map((d) => ({ timestamp: Date.parse(`${d}T03:05:00Z`), message: cp(d, d === "2026-11-08" ? "differs" : "equal") })) }))), /checkpoint differs/],
      ["a missing checkpoint", goodRecords(), parseLogs(logLines(JSON.stringify({ events: DAYS.filter((d) => d !== "2026-11-08").map((d) => ({ timestamp: Date.parse(`${d}T03:05:00Z`), message: cp(d) })) }))), /no checkpoint/],
      ["a replica halt", goodRecords(), logsFor(DAYS, [{ ts: "2026-11-08T12:00:00Z", message: "akldb-alarm: replica: halted at seq 9: ReplicaDivergedError: x" }]), /1 replica halt/],
      ["a follower alarm", goodRecords(), logsFor(DAYS, [{ ts: "2026-11-08T12:00:00Z", message: "akldb-alarm: shadow-follower: apply seq 5 (x): y" }]), /1 follower alarm/],
      ["no replay that day", goodRecords(DAYS.filter((d) => d !== "2026-11-08")), logsFor(), /no replay compared/],
    ] as const) {
      const g = evaluate(evidence({ records, logs }));
      expect(row(g, "1").status, label).toBe("FAIL");
      expect(row(g, "1").detail, label).toMatch(why);
      expect(g.pass).toBe(false);
    }
    // a streak counts calendar days: the bad day on the 8th leaves 3 clean days after it, and eight clean days after a bad one pass
    const long = [...DAYS, "2026-11-12", "2026-11-13", "2026-11-14"];
    const healed = evaluate(evidence({ records: [...goodRecords(long), rec("2026-11-05", "diff")], logs: logsFor(long) }));
    expect(row(healed, "1").status).toBe("PASS");
    // diff-state and skipped are not unexplained diffs
    const informational = evaluate(evidence({ records: [...goodRecords(), rec("2026-11-08", "diff-state", "authors"), rec("2026-11-08", "skipped")] }));
    expect(row(informational, "1").status).toBe("PASS");
  });

  it("[LDB-PV10] row 2a: any p50 or p95 over prod's, on the 200 or the 304 path, fails; thin samples and no probe are OPEN", () => {
    expect(row(evaluate(evidence({ probe: probeOf(+1) })), "2a").status).toBe("FAIL");
    expect(row(evaluate(evidence({ probe: probeOf(-1, 3) })), "2a").status).toBe("OPEN");
    expect(row(evaluate(evidence({ probe: undefined })), "2a").status).toBe("OPEN");
    const p = probeOf(-1);
    p.routes[0]!.hosts.shadow.p95_304 = 41; // only the 304 p95 is over
    const g = evaluate(evidence({ probe: p }));
    expect(row(g, "2a").status).toBe("FAIL");
    expect(row(g, "2a").detail).toContain("/v1/meta 304 p95");
  });

  it("[LDB-PV10] row 2b: the latency-compare table is parsed; a validated route over prod + 40 ms fails, so does /v1/formats not served from the edge", () => {
    const rows = parseMac(MAC);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ path: "/v1/meta", prod200: [54, 81], shadow200: [88, 100], prod304: [41, 55], shadow304: [71, 90] });
    expect(rows[1]!.prod304).toBeNull();
    expect(row(evaluate(evidence({ mac: rows })), "2b").status).toBe("PASS"); // +34 / +19 / +30 / +35
    expect(row(evaluate(evidence({ mac: parseMac(MAC.replace("88 / 100", "96 / 100")) })), "2b").status).toBe("FAIL"); // meta 200 p50 +42
    const noEdge = evaluate(evidence({ mac: parseMac(MAC.replace("200 HIT", "200 DYNAMIC")) }));
    expect(row(noEdge, "2b").status).toBe("FAIL");
    expect(row(noEdge, "2b").detail).toContain("not served from the edge");
    // the LAST table wins, so a rerun appended to the same file is the one judged
    expect(parseMac(`${MAC.replace("88 / 100", "300 / 400")}\n${MAC}`)[0]!.shadow200).toEqual([88, 100]);
    expect(row(evaluate(evidence({ mac: [] })), "2b").status).toBe("OPEN");
  });

  it("[LDB-PV10] row 2c: the weighted estimate; shadow over prod fails; modelled rtt + origin is accepted; no mix is OPEN", () => {
    expect(row(evaluate(evidence()), "2c").detail).toMatch(/shadow 232 ms vs prod 278 ms/);
    expect(row(evaluate(evidence({ colos: [{ colo: "SYD", share: 1, prod_ms: 777, shadow_ms: 800 }] })), "2c").status).toBe("FAIL");
    expect(row(evaluate(evidence({ colos: [{ colo: "SYD", share: 2, prod_ms: 777, rtt_ms: 300, origin_ms: 30 }] })), "2c").status).toBe("PASS");
    expect(row(evaluate(evidence({ colos: undefined })), "2c").status).toBe("OPEN");
  });

  it("[LDB-PV10] row 3: cold share and cold p95 come from the akldb-cold lines over the API request count; either limit failing fails; no request count is OPEN", () => {
    const cold = (n: number, wait = 440) => Array.from({ length: n }, () => ({ message: `akldb-cold: ${JSON.stringify({ first: "http", initMs: wait - 100, requestMs: 100 })}` }));
    expect(row(evaluate(evidence({ logs: logsFor(DAYS, cold(5)) })), "3").status).toBe("PASS"); // 0.5%
    const share = evaluate(evidence({ logs: logsFor(DAYS, cold(15)) }));
    expect(row(share, "3").status).toBe("FAIL");
    expect(row(share, "3").detail).toMatch(/cold share 1\.50%/);
    const slow = evaluate(evidence({ logs: logsFor(DAYS, cold(5, 700)) }));
    expect(row(slow, "3").status).toBe("FAIL");
    expect(row(slow, "3").detail).toMatch(/cold p95 700 ms/);
    // keep-warm pings that got a fresh container are not a user's cold start
    const pings = Array.from({ length: 50 }, () => ({ message: `akldb-cold: ${JSON.stringify({ first: "warm", initMs: 300, requestMs: 500 })}` }));
    expect(row(evaluate(evidence({ logs: logsFor(DAYS, [...cold(5), ...pings]) })), "3").status).toBe("PASS");
    expect(row(evaluate(evidence({ metrics: { Invocations: 5 } })), "3").status).toBe("OPEN");
    // REPORT lines, when the function logs them, are read too
    const rep = parseLogs(logLines("REPORT RequestId: a Duration: 12.5 ms Billed Duration: 13 ms Memory Size: 2048 MB Max Memory Used: 300 MB Init Duration: 410.2 ms"));
    expect(rep.reports).toEqual([{ at: undefined, initMs: 410.2, durationMs: 12.5 }]);
  });

  it("[LDB-PV10] row 4: the projection at 1x and 10x against $1.5 and $5; no metrics is OPEN", () => {
    const ok = evaluate(evidence());
    expect(row(ok, "4").status).toBe("PASS");
    expect(row(ok, "4").detail).toMatch(/at 1x \(limit \$1\.5\), \$[\d.]+ at 10x/);
    const heavy = evaluate(evidence({ metrics: { ApiRequests: 1000, Invocations: 50_000_000, Duration: 9_000_000_000, ConsumedReadCapacityUnits: 9e9, ConsumedWriteCapacityUnits: 9e8 } }));
    expect(row(heavy, "4").status).toBe("FAIL");
    expect(row(evaluate(evidence({ metrics: undefined })), "4").status).toBe("OPEN");
    // at 1x fine, at 10x over: scaled lines are the variable ones, storage is not scaled
    const edge = evaluate(evidence({ metrics: { ApiRequests: 1000, Invocations: 5_000_000, Duration: 400_000_000, ConsumedReadCapacityUnits: 100_000_000, ConsumedWriteCapacityUnits: 5_000_000 }, run: { window_hours: 720, scale: 1, lambda_memory_mb: 2048 } }));
    expect(row(edge, "4").detail).toContain("at 1x");
  });

  it("[LDB-PV10] row 5: a header difference fails; a route class never compared is OPEN", () => {
    const withHeader = [...goodRecords(), rec("2026-11-08", "diff", "meta", [{ kind: "header", detail: 'header cache-control: "a" vs "b"' }])];
    expect(row(evaluate(evidence({ records: withHeader })), "5").status).toBe("FAIL");
    expect(row(evaluate(evidence({ records: goodRecords().filter((r) => r.class !== "wpm") })), "5").status).toBe("OPEN");
    expect(row(evaluate(evidence({ records: [] })), "5").status).toBe("OPEN");
  });

  it("[LDB-PV10] pct() is the probe's (index rule round half to even)", () => {
    expect(pct([5, 1, 3, 2, 4, 6, 7, 8, 9, 10], 0.5)).toBe(5);
    expect(pct([], 0.5)).toBeNull();
  });

  it("[LDB-PV10] log exports are read in every form they come in: filter-log-events JSON with JSON-format Lambda lines, pages, plain text", () => {
    const page = (msgs: string[]) => ({ events: msgs.map((m, i) => ({ timestamp: Date.parse("2026-11-06T03:00:00Z") + i, message: m })) });
    const lines = logLines(JSON.stringify([page([JSON.stringify({ timestamp: "2026-11-06T03:00:00Z", level: "ERROR", message: cp("2026-11-06") }), "akldb-alarm: shadow-egress: refused GET discord.com\n"]), page(["akldb-boot: path=replay seq=1 replayed=1"])]));
    const p = parseLogs(lines);
    expect(p.checkpoints).toHaveLength(1);
    expect(p.checkpoints[0]).toMatchObject({ result: "equal", at: "2026-11-06T03:00:00.000Z" });
    expect(p.alarms).toEqual([{ at: "2026-11-06T03:00:00.001Z", component: "shadow-egress", text: "shadow-egress: refused GET discord.com" }]);
    expect(p.boots).toBe(1);
    expect(parseLogs(logLines(`${cp("2026-11-06")}\nnoise\n`)).checkpoints).toHaveLength(1);
  });
});

describe("the gate CLI and the cold-start line", () => {
  it("[LDB-PV10] gate.mjs reads the evidence files, writes the table and exits 0 only when every row passes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akldb-gate-"));
    try {
      const e = evidence();
      const w = (name: string, v: unknown) => {
        fs.writeFileSync(path.join(dir, name), typeof v === "string" ? v : JSON.stringify(v));
        return path.join(dir, name);
      };
      const logs = w("logs.json", { events: [...DAYS.map((d) => ({ timestamp: Date.parse(`${d}T03:05:00Z`), message: cp(d) })), ...Array.from({ length: 3 }, () => ({ timestamp: Date.parse("2026-11-11T12:00:00Z"), message: `akldb-cold: ${JSON.stringify({ first: "http", initMs: 180, requestMs: 260 })}` }))] });
      const args = ["--replay", w("replay.ndjson", e.records.map((r) => JSON.stringify(r)).join("\n")), "--logs", logs, "--probe", w("probe.json", e.probe), "--mac", w("mac.md", MAC), "--colos", w("colos.json", e.colos), "--metrics", w("metrics.json", e.metrics), "--run", w("run.json", e.run)];
      const ok = spawnSync(process.execPath, [path.join(ROOT, "scripts", "lab", "shadow", "gate.mjs"), ...args], { encoding: "utf8" });
      expect(ok.status, ok.stderr + ok.stdout).toBe(0);
      expect(ok.stdout).toContain("**PASS**");
      const bad = spawnSync(process.execPath, [path.join(ROOT, "scripts", "lab", "shadow", "gate.mjs"), ...args.slice(0, 2), "--logs", logs, "--probe", w("probe2.json", probeOf(+5))], { encoding: "utf8" });
      expect(bad.status).toBe(1);
      expect(bad.stdout).toContain("**NOT YET**");
      expect(spawnSync(process.execPath, [path.join(ROOT, "scripts", "lab", "shadow", "gate.mjs"), "--nonsense"], { encoding: "utf8" }).status).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("[LDB-PV10] the Lambda host logs exactly one akldb-cold line per container, at its first invocation, saying what arrived and how long it took", async () => {
    const lines: string[] = [];
    const blobs = memoryBlobs();
    const aws: Aws = { dumps: blobs, async getParameters() { return { values: {}, missing: [] }; }, async invokeAsync() {}, async invokeLive() { return {}; } };
    const handler = createLambdaHandler({
      env: { STAGE: "staging" },
      aws,
      log: new MemoryLog(),
      migrationsDir: path.join(ROOT, "migrations"),
      boot: async (l) => new Replica(l, { sleep: async () => {}, backoffMs: 0 }),
      logError: () => {},
      logLine: (l) => void lines.push(l),
      sleep: async () => {},
    });
    await handler.ready();
    await handler({ akldb: "warm", k: 1 });
    await handler({ akldb: "warm", k: 1 });
    const cold = lines.filter((l) => l.startsWith("akldb-cold: "));
    expect(cold).toHaveLength(1);
    const j = JSON.parse(cold[0]!.slice("akldb-cold: ".length));
    expect(j.first).toBe("warm");
    expect(j.initMs).toBeGreaterThan(0);
    expect(typeof j.requestMs).toBe("number");
    expect(lines.some((l) => l.startsWith("akldb-alarm: "))).toBe(false); // information, not an alarm
  });
});
