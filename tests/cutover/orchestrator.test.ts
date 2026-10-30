// [LDB-CUT13..CUT19] The cutover orchestrator (scripts/cutover/*, design/aws-port.md §5.2) against the local stand-in of
// tests/cutover/world.ts: the plan, both directions, every abort and rollback path, and the real ports' commands with a fake `aws`.
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain script, no .d.ts (like tests/tools/codeowners.test.ts)
import { main, parseArgs, readPrimary } from "../../scripts/cutover/run.mjs";
// @ts-expect-error -- plain script, no .d.ts (like tests/tools/codeowners.test.ts)
import { createRealPorts, UNWIRED } from "../../scripts/cutover/ports-real.mjs";
// @ts-expect-error -- plain script, no .d.ts (like tests/tools/codeowners.test.ts)
import { describePlan, DEFAULTS, FLAG_WRITES, runPlan } from "../../scripts/cutover/steps.mjs";
// @ts-expect-error -- plain script, no .d.ts (like tests/tools/codeowners.test.ts)
import { proveRows } from "../../scripts/cutover/proof.mjs";
import { boom, makeWorld, type World } from "./world";

const idx = (w: World, call: string) => w.calls.indexOf(call);
const after = (w: World, a: string, b: string) => {
  expect(idx(w, a), `${a} ran`).toBeGreaterThanOrEqual(0);
  expect(idx(w, b), `${b} ran`).toBeGreaterThanOrEqual(0);
  expect(idx(w, a), `${a} before ${b}`).toBeLessThan(idx(w, b));
};
/** Writes the serving side accepted must still be on the side that serves at the end; refused writes are exactly the pause. */
function noWriteLost(w: World, servedBy: "d1" | "aws") {
  const side = servedBy === "d1" ? w.d1 : w.aws;
  const ids = new Set((side.rows.layouts ?? []).map((r: any) => r.id));
  for (const x of w.writes) if (x.side !== null) expect(ids.has(`w${x.id}`), `write ${x.id} accepted by ${x.side} is on ${servedBy}`).toBe(true);
}
function pauseSeen(w: World): number {
  const refused = w.writes.filter((x) => x.side === null);
  return refused.length === 0 ? 0 : refused[refused.length - 1]!.at - refused[0]!.at + 100;
}

describe("[LDB-CUT13] --dry-run prints the plan and touches nothing", () => {
  it("[LDB-CUT13] prints both plans, with the failure policy of each step, and needs no credentials", async () => {
    for (const to of ["aws", "d1"]) {
      const out: string[] = [];
      const code = await main(["--to", to, "--dry-run"], { env: {}, out: (s: string) => out.push(s) });
      expect(code).toBe(0);
      const text = out.join("\n");
      expect(text).toContain(`--to ${to}`);
      for (let n = 1; n <= 7; n++) expect(text).toMatch(new RegExp(`^  ${n}\\. `, "m"));
      expect(text).toContain("on failure:");
      expect(text).toContain("write pause budget 30000 ms");
    }
    expect(describePlan("aws")).toContain("rollback once prod is open");
    expect(describePlan("aws")).toContain("d1.setMode(proxy)");
    expect(describePlan("d1")).toContain("aws.setMode(read_only)");
  });

  it("[LDB-CUT13] refuses bad arguments, and never lets --rehearse name production", () => {
    expect(() => parseArgs([])).toThrow(/--to/);
    expect(() => parseArgs(["--to", "mars"])).toThrow(/--to/);
    expect(() => parseArgs(["--to", "aws", "--rehearse", "akl-db"])).toThrow(/rehearsal/);
    expect(() => parseArgs(["--to", "aws", "--rehearse", "akl-db-rehearsal"])).toThrow(/stage/);
    expect(() => parseArgs(["--to", "aws", "--rehearse", "akl-db-rehearsal", "--stage", "prod"])).toThrow(/stage/);
    expect(parseArgs(["--to", "aws", "--rehearse", "akl-db-rehearsal", "--stage", "lab"]).stage).toBe("lab");
    expect(() => parseArgs(["--to", "aws", "--max-pause-ms", "0"])).toThrow(/positive/);
    expect(parseArgs(["--status"]).status).toBe(true);
  });

  it("[LDB-CUT13] cutover/akldb.json says d1 until the cutover PR flips it", () => {
    expect(readPrimary()).toBe("d1");
  });
});

describe("[LDB-CUT14] --to aws runs steps 1-7 in order and the write pause stays under the gate", () => {
  it("[LDB-CUT14] freezes D1, settles, proves, hands over, opens prod with its recorder on, then smokes", async () => {
    const w = makeWorld();
    const r = await runPlan("aws", w.ports);
    expect(r.ok).toBe(true);
    expect(r.steps.map((s: any) => s.n)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const order = [
      "d1.setMode(read_only)", "d1.maxSeq", "mirror.waitApplied(d1->aws)", "ephemeral.copy(d1->aws)", "proof.run",
      "aws.setMode(read_only)", "d1.setMode(proxy)", "aws.setMirrorMode(record)", "aws.setMode(null)", "aws.setJobsEnabled(true)",
      "smoke.run(aws)", "cloudflare.setCron(false)",
    ];
    for (let i = 1; i < order.length; i++) after(w, order[i - 1]!, order[i]!);
    // The recorder is on before the first write AWS can accept.
    after(w, "aws.setMirrorMode(record)", "aws.setMode(null)");
    expect(w.d1.mode).toBe("proxy");
    expect(w.aws.mode).toBeNull();
    expect(w.aws.mirrorMode).toBe("record");
    expect(w.aws.jobsOn).toBe(true);
    expect(w.cron).toBe(false);
    // Writes: refused during the pause, accepted by D1 before it and by AWS after it; none lost, none on both.
    expect(w.writes.some((x) => x.side === "d1")).toBe(true);
    expect(w.writes.some((x) => x.side === "aws")).toBe(true);
    expect(r.pauseMs).toBeGreaterThan(0);
    expect(r.pauseMs).toBeLessThanOrEqual(30_000);
    expect(Math.abs(pauseSeen(w) - r.pauseMs!)).toBeLessThanOrEqual(1500);
    noWriteLost(w, "aws");
  });

  it("[LDB-CUT14] is idempotent: run again when prod already serves, it says so and changes nothing", async () => {
    const w = makeWorld({ direction: "aws" });
    const before = JSON.stringify([w.d1.mode, w.aws.mode, w.cron]);
    const r = await runPlan("aws", w.ports);
    expect(r.ok).toBe(true);
    expect(r.noop).toBe("already on aws");
    expect(JSON.stringify([w.d1.mode, w.aws.mode, w.cron])).toBe(before);
    expect(w.calls.some((c) => c.startsWith("d1.setMode") || c.startsWith("aws.setMode"))).toBe(false);
  });
});

describe("[LDB-CUT15] --to d1 is the reverse path and reopens D1", () => {
  it("[LDB-CUT15] freezes prod, waits for the reverse mirror, copies, proves, then D1 serves again with prod frozen", async () => {
    const w = makeWorld({ direction: "aws" });
    const r = await runPlan("d1", w.ports);
    expect(r.ok).toBe(true);
    const order = ["aws.setMode(read_only)", "aws.maxSeq", "mirror.waitApplied(aws->d1)", "ephemeral.copy(aws->d1)", "proof.run", "d1.setMode(null)", "cloudflare.setCron(true)", "aws.setMirrorMode(apply)", "aws.setJobsEnabled(false)", "smoke.run(d1)"];
    for (let i = 1; i < order.length; i++) after(w, order[i - 1]!, order[i]!);
    expect(w.d1.mode).toBeNull();
    expect(w.aws.mode).toBe("read_only"); // "prod writes stay frozen"
    expect(w.cron).toBe(true);
    expect(w.aws.mirrorMode).toBe("apply");
    expect(w.aws.jobsOn).toBe(false);
    expect(r.pauseMs!).toBeLessThanOrEqual(30_000);
    noWriteLost(w, "d1");
  });

  it("[LDB-CUT15] a round trip, to aws and back, ends where it began with every accepted write kept", async () => {
    const w = makeWorld();
    expect((await runPlan("aws", w.ports)).ok).toBe(true);
    expect((await runPlan("d1", w.ports)).ok).toBe(true);
    expect([w.d1.mode, w.aws.mode, w.cron, w.aws.mirrorMode]).toEqual([null, "read_only", true, "apply"]);
    noWriteLost(w, "d1");
  });
});

describe("[LDB-CUT16] a failure before the handover aborts: D1 back to normal, prod untouched", () => {
  const cases: [string, Parameters<typeof makeWorld>[0]][] = [
    ["the mirror has diverged", { mirror: { diverged: true, lagS: 0, stuck: false } }],
    ["the mirror is too far behind", { mirror: { diverged: false, lagS: 60, stuck: false } }],
    ["prod's Discord parameters are missing", { discordReady: false }],
    ["freezing D1 throws", { faults: { "d1.setMode": (n: number) => (n === 1 ? boom("cf api 500") : undefined) } }],
    ["the applier never reaches the final seq", { mirror: { diverged: false, lagS: 1, stuck: true } }],
    ["copying the ephemeral tables throws", { faults: { "ephemeral.copy": boom("ddb throttled") } }],
    ["the row-for-row proof finds a difference", { proofLie: true }],
    ["the pause budget is already spent", { cost: { "proof.run": 40_000 } }],
    ["freezing prod throws", { faults: { "aws.setMode": (n: number) => (n === 1 ? boom("sts expired") : undefined) } }],
  ];
  for (const [name, init] of cases) {
    it(`[LDB-CUT16] ${name}`, async () => {
      const w = makeWorld(init);
      const r = await runPlan("aws", w.ports);
      expect(r.ok).toBe(false);
      expect(r.recovery).toBe("abort");
      expect(w.d1.mode).toBeNull();
      expect(w.aws.mode).toBeNull();
      expect(w.cron).toBe(true);
      expect(w.aws.mirrorMode).toBe("apply");
      expect(w.calls).not.toContain("aws.setMode(null)");
      expect(w.calls).not.toContain("cloudflare.setCron(false)");
      noWriteLost(w, "d1");
    });
  }

  it("[LDB-CUT16] --max-pause-ms is honoured: the same run passes with a larger budget", async () => {
    const slow = { "proof.run": 40_000 };
    const w = makeWorld({ cost: slow });
    expect((await runPlan("aws", w.ports, { maxPauseMs: 120_000 })).ok).toBe(true);
    expect(DEFAULTS.maxPauseMs).toBe(30_000);
  });
});

describe("[LDB-CUT17] a failure after the handover rolls back", () => {
  it("[LDB-CUT17] before prod opens it is only D1 back to normal and prod back where it was, mirror mode restored", async () => {
    for (const [name, faults] of [
      ["D1 proxy flip", { "d1.setMode": (n: number) => (n === 2 ? boom("cf api 500") : undefined) }],
      ["second nonce copy", { "ephemeral.copy": (n: number) => (n === 2 ? boom("ddb throttled") : undefined) }],
      ["recorder switch", { "aws.setMirrorMode": (n: number) => (n === 1 ? boom("lambda throttled") : undefined) }],
    ] as const) {
      const w = makeWorld({ faults: faults as any });
      const r = await runPlan("aws", w.ports);
      expect(r.ok, name).toBe(false);
      expect(r.recovery, name).toBe("rollback");
      expect([w.d1.mode, w.aws.mode, w.cron, w.aws.mirrorMode], name).toEqual([null, null, true, "apply"]);
      noWriteLost(w, "d1");
    }
  });

  it("[LDB-CUT17] once prod is open it is the reverse path: freeze prod, reverse mirror, copy, prove, D1 normal, cron on", async () => {
    const w = makeWorld({ smokeOk: false });
    const r = await runPlan("aws", w.ports);
    expect(r.ok).toBe(false);
    expect(r.failedStep).toBe(7);
    expect(r.recovery).toBe("rollback-full");
    expect([w.d1.mode, w.aws.mode, w.cron, w.aws.mirrorMode, w.aws.jobsOn]).toEqual([null, "read_only", true, "apply", false]);
    const afterOpen = w.calls.slice(idx(w, "aws.setMode(null)"));
    for (const c of ["aws.setMode(read_only)", "mirror.waitApplied(aws->d1)", "ephemeral.copy(aws->d1)", "proof.run", "d1.setMode(null)"]) expect(afterOpen).toContain(c);
    // Writes AWS accepted between opening and the rollback are in D1 now.
    expect(w.writes.some((x) => x.side === "aws")).toBe(true);
    noWriteLost(w, "d1");
  });

  it("[LDB-CUT17] opening prod throwing half way is treated as open: it is frozen again and D1 gets everything back", async () => {
    const w = makeWorld({ faults: { "aws.setMode": (n: number) => (n === 2 ? boom("timeout after sending") : undefined) } });
    const r = await runPlan("aws", w.ports);
    expect(r.recovery).toBe("rollback-full");
    expect([w.d1.mode, w.aws.mode]).toEqual([null, "read_only"]);
    noWriteLost(w, "d1");
  });

  it("[LDB-CUT17] a rollback that cannot finish leaves the safe state (D1 proxying to a frozen prod) and says so", async () => {
    const w = makeWorld({ smokeOk: false });
    w.mirror.stuck = false;
    // The reverse mirror breaks only after the cutover opened prod.
    const orig = w.ports.aws.setMode;
    w.ports.aws.setMode = async (m: any) => {
      await orig(m);
      if (m === null) w.mirror.stuck = true;
    };
    const r = await runPlan("aws", w.ports);
    expect(r.recovery).toBe("failed");
    expect(r.recoveryError).toMatch(/reverse mirror did not reach/);
    expect([w.d1.mode, w.aws.mode]).toEqual(["proxy", "read_only"]);
  });

  it("[LDB-CUT17] a failed Cloudflare cron switch after a good smoke does not undo the switch; it is reported", async () => {
    const w = makeWorld({ faults: { "cloudflare.setCron": boom("cf api 500") } });
    const r = await runPlan("aws", w.ports);
    expect(r.ok).toBe(true);
    expect(r.warning).toMatch(/cron is still on/);
    expect([w.d1.mode, w.aws.mode]).toEqual(["proxy", null]);
  });
});

describe("[LDB-CUT18] --to d1 aborts by reopening prod, and has nothing to undo once D1 serves", () => {
  it("[LDB-CUT18] a stuck reverse mirror, a failed proof and a spent pause budget each reopen prod and leave D1 proxying", async () => {
    for (const init of [{ mirror: { diverged: false, lagS: 1, stuck: true } }, { proofLie: true }, { cost: { "proof.run": 40_000 } }]) {
      const w = makeWorld({ direction: "aws", ...init });
      const r = await runPlan("d1", w.ports);
      expect(r.ok).toBe(false);
      expect(r.recovery).toBe("abort");
      expect([w.d1.mode, w.aws.mode, w.cron]).toEqual(["proxy", null, false]);
      noWriteLost(w, "aws");
    }
  });

  it("[LDB-CUT18] refuses to start from the wrong state: D1 not proxying, or prod not normal", async () => {
    const a = makeWorld({ direction: "aws", d1Mode: "read_only" });
    const ra = await runPlan("d1", a.ports);
    expect(ra.ok).toBe(false);
    expect(ra.error).toMatch(/expected proxy/);
    expect(a.calls.some((c) => c.startsWith("aws.setMode"))).toBe(false);
    const b = makeWorld({ awsMode: "read_only", d1Mode: null });
    expect((await runPlan("d1", b.ports)).noop).toBe("already on d1");
  });

  it("[LDB-CUT18] a failure after D1 serves again changes nothing (there is nothing to undo)", async () => {
    const w = makeWorld({ direction: "aws", smokeOk: false });
    const r = await runPlan("d1", w.ports);
    expect(r.ok).toBe(false);
    expect(r.recovery).toBe("report");
    expect([w.d1.mode, w.aws.mode]).toEqual([null, "read_only"]);
  });

  it("[LDB-CUT18] the forward run refuses to start over a half-done cutover", async () => {
    const w = makeWorld({ d1Mode: "read_only" });
    const r = await runPlan("aws", w.ports);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/in progress or half done/);
    expect(w.d1.mode).toBe("read_only"); // not ours to touch
  });
});

describe("[LDB-CUT19] the real ports, the proof and the CLI never reach out in tests", () => {
  it("[LDB-CUT19] proveRows compares multisets over every non-ephemeral table, ignoring the flag row", () => {
    const base = { layouts: [{ id: "a", v: 1 }, { id: "b" }, { id: "b" }], nonces: [{ n: 1 }], import_state: [{ key: "cutover.mode", value: "proxy" }, { key: "x", value: "1" }] };
    const same = { layouts: [{ v: 1, id: "a" }, { id: "b" }, { id: "b" }], nonces: [{ n: 9 }], import_state: [{ key: "x", value: "1" }] };
    expect(proveRows(base, same).ok).toBe(true);
    const dup = proveRows(base, { ...same, layouts: [{ id: "a", v: 1 }, { id: "b" }] });
    expect(dup.ok).toBe(false);
    expect(dup.diffs).toEqual([{ table: "layouts", onlyLeft: 1, onlyRight: 0 }]);
    expect(proveRows(base, { ...same, layouts: [...same.layouts, { id: "c" }] }).diffs[0]).toMatchObject({ onlyRight: 1 });
  });

  it("[LDB-CUT19] a real run refuses before freezing anything while ports are unwired, and without credentials", async () => {
    const out: string[] = [];
    expect(await main(["--to", "aws"], { env: {}, out: (s: string) => out.push(s) })).toBe(2);
    expect(out.join("\n")).toMatch(/missing credentials/);
    const env = { CLOUDFLARE_DB_TOKEN: "t", CLOUDFLARE_DB_ACCOUNT_ID: "acct", AWS_ACCESS_KEY_ID: "k", AWS_SECRET_ACCESS_KEY: "s" };
    const calls: string[] = [];
    const out2: string[] = [];
    const code = await main(["--to", "aws"], {
      env,
      out: (s: string) => out2.push(s),
      exec: async (...a: any[]) => (calls.push(a.join(" ")), ""),
      fetchImpl: (async (u: string) => (calls.push(String(u)), new Response("{}")) ) as any,
    });
    expect(code).toBe(2);
    expect(out2.join("\n")).toContain(UNWIRED[0]);
    expect(calls).toEqual([]);
  });

  it("[LDB-CUT19] the real ports issue the intended commands (fake aws and fetch): one role assumption, flag items as data, cron; no control-plane call", async () => {
    const execs: { cmd: string; args: string[]; env: Record<string, string> }[] = [];
    const exec = async (cmd: string, args: string[], env: Record<string, string>) => {
      execs.push({ cmd, args, env });
      const a = args.join(" ");
      if (a.startsWith("sts assume-role")) return JSON.stringify({ Credentials: { AccessKeyId: "ASIA", SecretAccessKey: "sec", SessionToken: "tok" } });
      if (a.startsWith("dynamodb get-item")) return JSON.stringify({ Item: { value: { S: "read_only" } } });
      if (a.startsWith("ssm get-parameters")) return JSON.stringify({ Parameters: [{}, {}, {}, {}] });
      return "{}";
    };
    const fetches: { url: string; init: any }[] = [];
    const fetchImpl = (async (url: string, init: any) => (fetches.push({ url, init }), new Response(JSON.stringify({ success: true, result: [{ results: [{ value: "proxy" }] }] })))) as any;
    const p = createRealPorts({ env: { CLOUDFLARE_DB_TOKEN: "cf", CLOUDFLARE_DB_ACCOUNT_ID: "acct", AWS_ACCESS_KEY_ID: "ci", AWS_SECRET_ACCESS_KEY: "cisec" }, exec, fetchImpl, clock: {} as any, log: () => {}, d1Id: "db1" });
    expect(await p.aws.getMode()).toBe("read_only");
    await p.aws.setMode(null);
    await p.aws.setMode("read_only");
    await p.aws.setMirrorMode("record");
    await p.aws.setJobsEnabled(true);
    expect(await p.aws.maxSeq()).toBe(0);
    expect(await p.aws.discordReady()).toBe(true);
    expect(await p.d1.getMode()).toBe("proxy");
    await p.d1.setMode("read_only");
    await p.cloudflare.setCron(false);
    const assume = execs[0]!;
    expect(assume.args.join(" ")).toContain("role/akldb-cutover-role");
    expect(assume.env.AWS_ACCESS_KEY_ID).toBe("ci");
    expect(execs.slice(1).every((e) => e.env.AWS_SESSION_TOKEN === "tok")).toBe(true); // everything after runs as the role
    expect(execs.some((e) => e.args.join(" ").startsWith("dynamodb delete-item"))).toBe(true);
    const puts = execs.filter((e) => e.args[0] === "dynamodb" && e.args[1] === "put-item").map((e) => JSON.parse(e.args[e.args.indexOf("--item") + 1]!));
    expect(puts).toContainEqual({ pk: { S: "STATE" }, sk: { S: "mirror.mode" }, value: { S: "record" } });
    expect(puts).toContainEqual({ pk: { S: "STATE" }, sk: { S: "jobs.enabled" }, value: { S: "on" } });
    // The switch makes no control-plane call: only sts (once), dynamodb item calls and ssm reads.
    const allowed = new Set(["sts assume-role", "dynamodb get-item", "dynamodb put-item", "dynamodb delete-item", "ssm get-parameters"]);
    for (const e of execs) expect(allowed.has(`${e.args[0]} ${e.args[1]}`), e.args.slice(0, 2).join(" ")).toBe(true);
    expect(fetches.every((f) => f.url.startsWith("https://api.cloudflare.com/client/v4/accounts/acct/"))).toBe(true);
    expect(fetches.every((f) => f.init.headers.Authorization === "Bearer cf")).toBe(true);
    expect(fetches.at(-1)!.url).toContain("/workers/scripts/akl-db/schedules");
    expect(JSON.parse(fetches.at(-1)!.init.body)).toEqual([]);
  });

  it("[LDB-CUT19] the switch touches only flag writes: every mutating call of both plans is on the flag-write list, none is a control-plane operation", async () => {
    const reads = new Set(["d1.maxSeq", "aws.maxSeq", "d1.getMode", "aws.getMode", "mirror.status", "mirror.waitApplied", "aws.discordReady", "proof.run", "smoke.run"]);
    const seen = new Set<string>();
    for (const [dir, init] of [["aws", {}], ["d1", { direction: "aws" as const }], ["aws", { smokeOk: false }]] as const) {
      const w = makeWorld(init);
      await runPlan(dir, w.ports);
      for (const c of w.calls) seen.add(c.replace(/\(.*$/, ""));
    }
    for (const name of seen) expect(FLAG_WRITES.includes(name) || reads.has(name), name).toBe(true);
    for (const name of ["aws.setMirrorMode", "aws.setJobsEnabled", "aws.setMode", "d1.setMode"]) expect(seen.has(name), name).toBe(true);
    for (const e of describePlan("aws").concat(describePlan("d1")).split("\n")) expect(e).not.toMatch(/reconcile|setSchedules|UpdateStack|update-function|UpdateFunction/);
    // And the sources themselves name no control-plane operation.
    const fs = await import("node:fs");
    for (const f of ["steps.mjs", "ports-real.mjs"]) {
      const text = fs.readFileSync(`${import.meta.dirname}/../../scripts/cutover/${f}`, "utf8").replace(/^\s*\/\/.*$/gm, "");
      expect(text, f).not.toMatch(/update-stack|update-function-configuration|update-schedule|cloudformation|scheduler|"lambda"/i);
    }
  });

  it("[LDB-CUT19] --status prints both modes from the ports and changes nothing", async () => {
    const w = makeWorld({ direction: "aws" });
    const out: string[] = [];
    // A stand-in ports module, loaded the way tests/cutover and rehearsals load one.
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cutover-ports-"));
    const file = path.join(dir, "ports.mjs");
    fs.writeFileSync(file, "export function createPorts() { return globalThis.__cutoverWorld.ports; }\n");
    (globalThis as any).__cutoverWorld = w;
    try {
      expect(await main(["--status", "--ports", file], { env: {}, out: (s: string) => out.push(s) })).toBe(0);
    } finally {
      fs.rmSync(file, { force: true });
      fs.rmdirSync(dir);
      delete (globalThis as any).__cutoverWorld;
    }
    expect(JSON.parse(out[0]!)).toEqual({ d1: "proxy", aws: null });
    expect(w.calls).toEqual([]);
  });
});
