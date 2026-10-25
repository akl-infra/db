// The fuzzer gate on AWS (lane F): units, lanes, capacity plan, scheduling, aggregation, determinism and the template's
// guard rules. Pure and local; the one end-to-end proof (a sequence alone vs inside a range) is gated by
// AKLDB_FUZZ_E2E=1 because it needs sqlite3, wrangler dev and two free ports.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

/* eslint-disable @typescript-eslint/no-explicit-any */
const load = async (f: string): Promise<any> => import(/* @vite-ignore */ path.join(process.cwd(), "scripts/lab/fuzz", f));

const unitOf = (seed: number, from: number, count = 500) => ({ seed, from, count });
const goodResult = (u: { seed: number; from: number; count: number }, commit = "abc") => ({
  run: "r", commit, seed: u.seed, from: u.from, count: u.count, sequences_run: u.count, steps: u.count * 10, duration_ms: 1000,
  response_state_diffs: [], catalog_mismatches: [], index_problems: [], diff_totals: { response_state: 0, catalog: 0, index: 0 }, errors: [], clean: true,
});

describe("units and lanes", () => {
  it("[LDB-FZ2] the gate is 20 seeds x 20 units of 500 sequences, each (seed, sequence) in exactly one unit; lanes partition a unit", async () => {
    const u = await load("units.mjs");
    const units = u.expectedUnits();
    expect(units).toHaveLength(400);
    const seen = new Set<string>();
    for (const x of units) for (let i = x.from; i < x.from + x.count; i++) seen.add(`${x.seed}/${i}`);
    expect(seen.size).toBe(20 * 10000);
    expect(new Set(units.map(u.unitKey)).size).toBe(400);
    for (const lanes of [1, 3, 6, 7, 500, 900]) {
      const parts = u.splitLanes(1000, 500, lanes);
      expect(parts.reduce((s: number, p: any) => s + p.count, 0)).toBe(500);
      expect(parts[0].from).toBe(1000);
      parts.forEach((p: any, k: number) => {
        expect(p.count).toBeGreaterThan(0);
        if (k > 0) expect(p.from).toBe(parts[k - 1].from + parts[k - 1].count);
      });
      expect(Math.max(...parts.map((p: any) => p.count)) - Math.min(...parts.map((p: any) => p.count))).toBeLessThanOrEqual(1);
    }
    expect(u.splitLanes(0, 6, 6).map((p: any) => p.count)).toEqual([1, 1, 1, 1, 1, 1]);
  });
});

describe("capacity and wall time", () => {
  it("[LDB-FZ3] the plan uses the most of the quota, never exceeds it, and reports the expected wall time", async () => {
    const u = await load("units.mjs");
    expect(u.planCapacity(12)).toMatchObject({ vcpu: 4, concurrent: 3, used: 12, lanes: 3, memoryMiB: 8192 });
    expect(u.planCapacity(160)).toMatchObject({ vcpu: 8, concurrent: 20, used: 160, lanes: 6, memoryMiB: 16384 });
    expect(u.planCapacity(0)).toBeNull();
    for (let q = 1; q <= 200; q++) {
      const c = u.planCapacity(q);
      expect(c.concurrent * c.vcpu).toBeLessThanOrEqual(q);
    }
    const e160 = u.estimate({ units: 400, quotaVcpu: 160 });
    expect(e160.waves).toBe(20);
    expect(e160.wallHours).toBeGreaterThan(4);
    expect(e160.wallHours).toBeLessThan(7); // the design's "about 5-6 h at 20 tasks"
    const e12 = u.estimate({ units: 400, quotaVcpu: 12 });
    expect(e12.wallHours).toBeGreaterThan(e160.wallHours * 5);
    expect(u.formatEstimate(e12)).toMatch(/3 tasks of 4 vCPU.*about \d+\.\d h/);
    const run = await load("aws-run.mjs");
    expect(run.chooseSize("8", 12)).toMatchObject({ vcpu: 8, concurrent: 1 });
    expect(run.chooseSize("8", 4)).toBeNull();
    expect(run.chooseSize("auto", 12).vcpu).toBe(4);
  });

  it("[LDB-FZ7] the scheduler never runs more tasks than the slots allow and gives a unit up after its retries", async () => {
    const run = await load("aws-run.mjs");
    const pending = [unitOf(1, 0), unitOf(1, 500), unitOf(2, 0), unitOf(2, 500)];
    expect(run.nextLaunches({ pending, running: 0, slots: 3, attempts: {}, retries: 2 }).launch).toHaveLength(3);
    expect(run.nextLaunches({ pending, running: 2, slots: 3, attempts: {}, retries: 2 }).launch).toHaveLength(1);
    expect(run.nextLaunches({ pending, running: 5, slots: 3, attempts: {}, retries: 2 }).launch).toHaveLength(0);
    const r = run.nextLaunches({ pending, running: 0, slots: 9, attempts: { "1/0.json": 3 }, retries: 2 });
    expect(r.gaveUp).toEqual([unitOf(1, 0)]);
    expect(r.launch).toHaveLength(3);
    expect(run.nextLaunches({ pending, running: 0, slots: 9, attempts: { "1/0.json": 2 }, retries: 2 }).gaveUp).toHaveLength(0);
  });
});

describe("unit results and the verdict", () => {
  it("[LDB-FZ5] diffs are sorted into response/state, catalog and index buckets; a unit is clean only if it ran everything and found nothing", async () => {
    const u = await load("units.mjs");
    const b = u.classifyDiffs([
      { kind: "response", seed: 1, sequence: 2, step: 3, problems: ["status 200 vs 500"] },
      { kind: "state", seed: 1, sequence: 2, step: 9, problems: ["layouts: 1 vs 2 rows"] },
      { kind: "check", seed: 1, sequence: 4, step: 1, problems: ["catalog.current() != rebuildFromScan() x", "index checker: missing index item"] },
      { kind: "check", seed: 1, sequence: 5, step: 1, problems: ["something else"] },
    ]);
    expect(b.response_state_diffs.map((d: any) => d.kind)).toEqual(["response", "state", "check"]);
    expect(b.catalog_mismatches).toHaveLength(1);
    expect(b.index_problems).toHaveLength(1);
    const ok = goodResult(unitOf(1, 0));
    expect(u.isClean(ok)).toBe(true);
    expect(u.isClean({ ...ok, sequences_run: 499 })).toBe(false);
    expect(u.isClean({ ...ok, errors: ["x"] })).toBe(false);
    expect(u.isClean({ ...ok, index_problems: [{}] })).toBe(false);
  });

  it("[LDB-FZ5] a unit result merges its lanes and is not clean when a lane crashed, fell short or found a diff", async () => {
    const t = await load("task.mjs");
    const a = { run: "r", commit: "abc", seed: 1, from: 0, count: 6, steps: 10 };
    const lane = (k: number, over: any = {}) => ({ lane: { lane: k, from: k, count: 1 }, exit: 0, report: { steps_run: 10, sequences_run: 1, requests: 25, checks: 10, diffs: [], ...over } });
    const clean = t.mergeUnit(a, [0, 1, 2, 3, 4, 5].map((k) => lane(k)), 1000, 6000);
    expect(clean).toMatchObject({ clean: true, sequences_run: 6, steps: 60, duration_ms: 5000, errors: [] });
    const diff = t.mergeUnit(a, [0, 1, 2, 3, 4, 5].map((k) => lane(k, k === 2 ? { diffs: [{ kind: "response", seed: 1, sequence: 2, step: 0, problems: ["x"] }] } : {})).map((l, k) => (k === 2 ? { ...l, exit: 1 } : l)), 0, 1);
    expect(diff.clean).toBe(false);
    expect(diff.diff_totals.response_state).toBe(1);
    const crashed = t.mergeUnit(a, [lane(0), { lane: { lane: 1, from: 1, count: 5 }, exit: 2, report: null, tail: "boom" }], 0, 1);
    expect(crashed.clean).toBe(false);
    expect(crashed.errors.join()).toContain("boom");
    const short = t.mergeUnit(a, [0, 1, 2, 3, 4, 5].map((k) => lane(k, k === 5 ? { sequences_run: 0 } : {})), 0, 1);
    expect(short.clean).toBe(false);
  });

  it("[LDB-FZ4] the gate passes only with every unit present, for one commit, and clean; otherwise it names the missing and the first diffs", async () => {
    const g = await load("aggregate.mjs");
    const u = await load("units.mjs");
    const units = u.expectedUnits();
    const store = new Map<string, any>(units.map((x: any) => [u.unitKey(x), goodResult(x)]));
    const read = (k: string) => store.get(k);
    expect(g.aggregate({ units, read, commit: "abc" })).toMatchObject({ verdict: "PASS", clean: 400 });

    store.delete("3/500.json");
    const inc = g.aggregate({ units, read, commit: "abc" });
    expect(inc).toMatchObject({ verdict: "INCOMPLETE", clean: 399 });
    expect(inc.missing).toEqual([unitOf(3, 500)]);

    store.set("4/0.json", { ...goodResult(unitOf(4, 0)), clean: false, response_state_diffs: [{ kind: "response", seed: 4, sequence: 17, step: 2, problems: ["body differs"] }], diff_totals: { response_state: 1, catalog: 0, index: 0 } });
    const bad = g.aggregate({ units, read, commit: "abc" });
    expect(bad.verdict).toBe("FAIL");
    expect(bad.bad).toHaveLength(1);
    expect(bad.firstDiffs[0]).toMatchObject({ unit: "4/0.json", sequence: 17 });

    store.set("4/0.json", goodResult(unitOf(4, 0)));
    store.set("5/0.json", goodResult(unitOf(5, 0), "other"));
    expect(g.aggregate({ units, read, commit: "abc" })).toMatchObject({ verdict: "FAIL" });
    // a result for the wrong range is not accepted for this unit
    store.set("5/0.json", goodResult(unitOf(5, 500)));
    expect(g.aggregate({ units, read, commit: "abc" }).verdict).toBe("FAIL");
  });

  it("[LDB-FZ4] aggregate.mjs reads a results directory and exits 0 / 1 / 3", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fz-agg-"));
    try {
      const write = (seed: number, from: number, r: object) => {
        fs.mkdirSync(path.join(dir, String(seed)), { recursive: true });
        fs.writeFileSync(path.join(dir, String(seed), `${from}.json`), JSON.stringify(r));
      };
      const run = () => spawnSync(process.execPath, ["scripts/lab/fuzz/aggregate.mjs", "--results", dir, "--commit", "abc", "--seeds", "2", "--sequences", "1000", "--unit", "500"], { encoding: "utf8" });
      for (const seed of [1, 2]) for (const from of [0, 500]) write(seed, from, goodResult(unitOf(seed, from)));
      expect(run().status).toBe(0);
      fs.rmSync(path.join(dir, "2", "500.json"));
      const inc = run();
      expect(inc.status).toBe(3);
      expect(inc.stdout).toContain("INCOMPLETE");
      expect(inc.stdout).toContain("2/500.json");
      write(2, 500, { ...goodResult(unitOf(2, 500)), clean: false, errors: ["boom"] });
      const fail = run();
      expect(fail.status).toBe(1);
      expect(fail.stdout).toContain("boom");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("determinism", () => {
  it("[LDB-FZ1] a generated sequence depends only on (seed, index): alone or inside a range it is the same request stream", async () => {
    const { Generator } = await load("generator.mjs");
    const { mixSeed } = await load("rng.mjs");
    const corpus = [{ keys: [] }];
    // a stub oracle: the generator is fed the same answers either way
    const sequence = (seed: number, i: number) => {
      const gen = new Generator({ seed: mixSeed(seed, 1, i), corpus });
      const steps: string[] = [];
      for (let k = 0; k < 10; k++) {
        const s = gen.next();
        steps.push(JSON.stringify([s.label, s.method, s.path, s.json ?? null, s.stepMs]));
        gen.observe(s, { status: 200, json: { id: `01JAB${String(k).padStart(21, "0")}`, name: "x" }, etag: undefined });
      }
      return steps;
    };
    const alone = sequence(7, 123);
    const inRange: string[][] = [];
    for (let i = 120; i < 130; i++) inRange.push(sequence(7, i));
    expect(inRange[3]).toEqual(alone);
    expect(new Set(inRange.map((s) => s.join("|"))).size).toBeGreaterThan(8); // different indexes differ
    expect(sequence(8, 123)).not.toEqual(alone);
  });

  it.skipIf(process.env.AKLDB_FUZZ_E2E !== "1")("[LDB-FZ1] end to end: sequences 3..5 run alone and inside 0..5 give the same transcript, state hashes included", async () => {
    const { runFuzz } = await load("run.mjs");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fz-e2e-"));
    try {
      const go = async (from: number, sequences: number, name: string) => {
        const transcript = path.join(dir, `${name}.jsonl`);
        const rep = await runFuzz({ seeds: [1], from, sequences, steps: 10, mode: "self", ports: [18562, 18563, 18564, 18565], work: path.join(dir, name), transcript, log: () => {} });
        expect(rep.ok).toBe(true);
        return fs.readFileSync(transcript, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      };
      const alone = await go(3, 3, "alone");
      const range = (await go(0, 6, "range")).filter((l: any) => l.sequence >= 3);
      expect(range).toEqual(alone);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 600000);
});

describe("infra/fuzz.yaml", () => {
  const guard = ["/opt/homebrew/bin/cfn-guard", "/usr/local/bin/cfn-guard"].find((p) => fs.existsSync(p));
  const template = fs.readFileSync("infra/fuzz.yaml", "utf8");
  const check = (text: string): number => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fz-guard-"));
    try {
      const f = path.join(dir, "t.yaml");
      fs.writeFileSync(f, text);
      return spawnSync(guard!, ["validate", "-d", f, "-r", "infra/fuzz.guard"], { encoding: "utf8" }).status ?? -1;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  const add = (resources: string) => template.replace("\nOutputs:", `\n${resources}\nOutputs:`);

  it("[LDB-FZ6] the template has no inbound rule, NAT, VPC endpoint or wildcard action, and a public-subnet task role that can only put results", () => {
    expect(template).toMatch(/s3:PutObject/);
    expect(template).not.toMatch(/NatGateway|VPCEndpoint|SecurityGroupIngress/);
    expect(template).toMatch(/RetentionInDays: 3/);
    expect(template).toMatch(/ExpirationInDays: 30/);
    expect(template).toMatch(/countNumber":2/);
    expect(template).toMatch(/CpuArchitecture: ARM64/);
  });

  it.skipIf(guard === undefined)("[LDB-FZ6] cfn-guard passes the template and rejects each forbidden mutation", () => {
    expect(check(template)).toBe(0);
    const role = (action: string) => `  Evil:\n    Type: AWS::IAM::Role\n    Properties:\n      AssumeRolePolicyDocument: {}\n      Policies:\n        - PolicyName: p\n          PolicyDocument:\n            Version: "2012-10-17"\n            Statement:\n              - Effect: Allow\n                Action: ${action}\n                Resource: ["*"]\n`;
    const mutations: Record<string, string> = {
      nat: add(`  Nat:\n    Type: AWS::EC2::NatGateway\n    Properties: {}\n`),
      endpoint: add(`  Ep:\n    Type: AWS::EC2::VPCEndpoint\n    Properties: {}\n`),
      ingress: add(`  In:\n    Type: AWS::EC2::SecurityGroupIngress\n    Properties:\n      IpProtocol: tcp\n      FromPort: 22\n      ToPort: 22\n      CidrIp: 0.0.0.0/0\n`),
      "inline ingress": template.replace("      SecurityGroupEgress:", "      SecurityGroupIngress:\n        - IpProtocol: tcp\n          FromPort: 22\n          ToPort: 22\n          CidrIp: 0.0.0.0/0\n      SecurityGroupEgress:"),
      "star action": add(role('["*"]')),
      "service wildcard": add(role('["s3:*"]')),
      "wildcard in task role": template.replace('Action: ["s3:PutObject"]', 'Action: ["s3:Put*"]'),
      "egress all": template.replace("FromPort: 443\n          ToPort: 443", "FromPort: 0\n          ToPort: 65535"),
    };
    // control: a harmless addition still passes, so the failures below come from the rules and not from a broken mutation
    expect(check(add(`  Param:\n    Type: AWS::SSM::Parameter\n    Properties:\n      Type: String\n      Value: x\n`))).toBe(0);
    for (const [name, text] of Object.entries(mutations)) {
      expect(text, name).not.toBe(template);
      expect(check(text), name).not.toBe(0);
    }
  });
});
