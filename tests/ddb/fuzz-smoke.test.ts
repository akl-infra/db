// [LDB-DDB85] The differential fuzzer, smoke size (lane L): 50 seeded
// sequences of organic requests run against the D1 Worker (oracle) and the
// DynamoDB lab server; every response and the final state must be identical,
// and after every step the catalog must equal a full scan and the index
// checker must be clean. Team-lead runs the gate size (10k x 20 seeds, and
// again at a 20% conflict rate) through scripts/lab/fuzz/fuzz.mjs.
//
// Heavy: boots wrangler dev (workerd) and the lab server. Lane ports
// 18317 (D1 Worker), 18318 (DynamoDB server), 18319 (fake Discord).
import { describe, expect, it } from "vitest";

const RUNNER = "../../scripts/lab/fuzz/run.mjs";
const GENERATOR = "../../scripts/lab/fuzz/generator.mjs";

describe("fuzzer", () => {
  it("[LDB-DDB85] 50 sequences: zero response or state diffs against D1, catalog == scan, index checker clean", async () => {
    const { runFuzz } = (await import(/* @vite-ignore */ RUNNER)) as { runFuzz(o: Record<string, unknown>): Promise<{ diffs: unknown[]; steps_run: number; checks: number }> };
    const report = await runFuzz({
      seeds: [1],
      sequences: 50,
      steps: 8,
      mode: "ddb",
      ddbEndpoint: process.env.AKLDB_DDB_ENDPOINT ?? "http://127.0.0.1:18307",
      ports: [18317, 18318, 18319, 18320],
      log: () => {},
    });
    expect(report.diffs).toEqual([]);
    expect(report.steps_run).toBe(400);
    expect(report.checks).toBeGreaterThan(300);
  }, 20 * 60_000);

  it("[LDB-DDB86] the generator is a pure function of its seed and the responses it observed", async () => {
    const { Generator } = (await import(/* @vite-ignore */ GENERATOR)) as { Generator: new (o: { seed: number; corpus: object[] }) => { next(): { label: string; path: string }; observe(s: unknown, r: unknown): void } };
    const run = (seed: number) => {
      const g = new Generator({ seed, corpus: [{ keys: [] }] });
      const out: string[] = [];
      for (let i = 0; i < 300; i++) {
        const s = g.next();
        out.push(`${s.label} ${s.path}`);
        g.observe(s, { status: i % 3 === 0 ? 201 : 200, json: { id: `L${i % 7}`, name: `n${i % 5}`, owner: "100000000000000002", deleted: false }, etag: `"layout:${i % 4}"` });
      }
      return out;
    };
    expect(run(5)).toEqual(run(5));
    expect(run(5)).not.toEqual(run(6));
    expect(new Set(run(5).map((l) => l.split(" ")[0])).size).toBeGreaterThan(10);
  });
});
