// Lane S: coverage, latency and cost reports (scripts/lab/report/). Fixture inputs only: nothing calls CloudWatch or any cloud.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/* eslint-disable @typescript-eslint/no-explicit-any */
const R = path.join(process.cwd(), "scripts/lab/report");
const FIX = path.join(process.cwd(), "tests/lab/fixtures");
const load = async (f: string): Promise<any> => import(/* @vite-ignore */ path.join(R, f));
const inventory = (): any[] => JSON.parse(fs.readFileSync(path.join(FIX, "coverage/akldb-inventory.json"), "utf8")).items;
const golden = (): any[] => JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests/contract/route-table.golden.json"), "utf8"));
const routeIds = () => inventory().filter((i) => i.component === "akldb" && i.kind === "http_route").map((i) => i.id);

/** A concrete request for each template. */
function concrete(id: string): { method: string; path: string } {
  const [method, p] = id.split(" ") as [string, string];
  return { method, path: p.replace(/:(\w+)/g, "x1") };
}

describe("report (lane S)", () => {
  it("[LDB-PG52] the coverage inventory lists exactly the app's routes (route-table golden), and 74 routes (73 under /v1 plus /discord/interactions), 13 jobs, 4 background steps", () => {
    const app = new Set(golden().map((r) => `${r.method} ${r.route}`));
    const listed = new Set(routeIds());
    expect([...app].filter((r) => !listed.has(r)), "routes in the app but not in the coverage list").toEqual([]);
    // the one route outside /v1, hence outside the /v1 route table
    expect([...listed].filter((r) => !app.has(r)), "routes in the coverage list but not in the app").toEqual(["POST /discord/interactions"]);
    const inv = inventory().filter((i) => i.component === "akldb");
    expect(inv.filter((i) => i.kind === "http_route")).toHaveLength(74);
    expect(inv.filter((i) => i.kind === "scheduled_job")).toHaveLength(13);
    expect(inv.filter((i) => i.kind === "background_step")).toHaveLength(4);
    expect(inventory().filter((i) => i.component === "akldb-site")).toHaveLength(6);
    for (const i of inv.filter((x) => x.kind !== "http_route")) expect(typeof i.key).toBe("string");
  });

  it("[LDB-PG53] a request lands on its route template: params match one segment, literals beat params, the site proxy wildcard matches a suffix", async () => {
    const { matchRoute } = await load("coverage.mjs");
    const ids = [...routeIds(), "* /api/v1/*"];
    expect(matchRoute("GET", "/v1/dump/latest.json", ids)).toBe("GET /v1/dump/latest.json");
    expect(matchRoute("GET", "/v1/dump/dump-2026-10-25.json.gz", ids)).toBe("GET /v1/dump/:key");
    expect(matchRoute("GET", "/v1/dump/monthly/dump-2026-10.json.gz", ids)).toBe("GET /v1/dump/monthly/:key");
    expect(matchRoute("get", "/v1/layouts/abc?x=1", ids)).toBe("GET /v1/layouts/:ref");
    expect(matchRoute("GET", "/v1/layouts", ids)).toBe("GET /v1/layouts");
    expect(matchRoute("GET", "/v1/layouts/abc/rev/3", ids)).toBe("GET /v1/layouts/:ref/rev/:n");
    expect(matchRoute("DELETE", "/v1/layouts/abc/comments/u1/like", ids)).toBe("DELETE /v1/layouts/:ref/comments/:author_id/like");
    expect(matchRoute("PATCH", "/v1/layouts", ids)).toBeNull();
    expect(matchRoute("GET", "/nope", ids)).toBeNull();
    expect(matchRoute("POST", "/api/v1/layouts/abc/restore", ids)).toBe("* /api/v1/*");
    // every template matches its own concrete request
    for (const id of routeIds()) {
      const c = concrete(id);
      expect(matchRoute(c.method, c.path, routeIds()), id).toBe(id);
    }
  });

  it("[LDB-PG54] the daily coverage report is complete only when all 74 routes, 13 jobs and 4 steps were seen; it names what is unseen and flags unknown observations", async () => {
    const { coverageReport, renderCoverage, parseObservations } = await load("coverage.mjs");
    const items = inventory();
    const all: any[] = [
      ...routeIds().map((id) => ({ day: "2026-11-02", kind: "route", ...concrete(id) })),
      ...items.filter((i) => i.component === "akldb" && i.kind === "scheduled_job").map((i) => ({ day: "2026-11-02", kind: "job", id: i.key })),
      ...items.filter((i) => i.component === "akldb" && i.kind === "background_step").map((i) => ({ day: "2026-11-02", kind: "step", id: i.id })),
    ];
    const full = coverageReport(items, all);
    expect(full.ok).toBe(true);
    expect(full.kinds).toEqual({ route: { total: 74, seen: 74 }, job: { total: 13, seen: 13 }, step: { total: 4, seen: 4 } });
    expect(full.perDay).toEqual([{ day: "2026-11-02", route: 74, job: 13, step: 4 }]);
    // drop one of each kind
    const partial = all.filter((o) => !(o.kind === "route" && o.path === "/v1/meta") && o.id !== "modqueue-notify" && o.id !== "step-link-notify" && !(o.kind === "step" && o.id.includes("notifyPending")));
    const p = coverageReport(items, partial);
    expect(p.ok).toBe(false);
    expect(p.unseen.route.map((u: any) => u.id)).toEqual(["GET /v1/meta"]);
    expect(p.unseen.job.map((u: any) => u.id)).toEqual(["modqueue-notify"]);
    expect(p.unseen.step.map((u: any) => u.id)).toEqual(["step-link-notify"]);
    expect(renderCoverage(p)).toContain("unseen route: GET /v1/meta");
    // a known gap shows beside the unseen item
    const gap = coverageReport(items, all.filter((o) => !(o.kind === "route" && o.path === "/v1/admin/magic-seed")));
    expect(gap.unseen.route[0].gap).toBe("G2");
    // an observation matching nothing means the inventory drifted
    const unk = coverageReport(items, [...all, { day: "2026-11-02", kind: "route", method: "GET", path: "/v1/new-route" }, { kind: "job", id: "mystery" }]);
    expect(unk.ok).toBe(false);
    expect(unk.unknown.map((u: any) => u.what)).toEqual(["GET /v1/new-route", "mystery"]);
    // NDJSON in; counts accumulate over days
    const two = coverageReport(items, parseObservations(`${JSON.stringify({ day: "d1", kind: "route", method: "GET", path: "/v1/meta" })}\n${JSON.stringify({ day: "d2", kind: "route", method: "GET", path: "/v1/me" })}\n`));
    expect(two.perDay).toEqual([{ day: "d1", route: 1, job: 0, step: 0 }, { day: "d2", route: 1, job: 0, step: 0 }]);
    expect(two.kinds.route.seen).toBe(2);
    // the site Worker is opt-in
    expect(coverageReport(items, [], { components: ["akldb", "akldb-site"] }).kinds.route.total).toBe(79);
  });

  it("[LDB-PG54] the coverage CLI exits nonzero on a gap", async () => {
    const { spawnSync } = await import("node:child_process");
    const os = await import("node:os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pg54-"));
    try {
      const f = path.join(dir, "obs.ndjson");
      fs.writeFileSync(f, `${JSON.stringify({ day: "d", kind: "route", method: "GET", path: "/v1/meta" })}\n`);
      const r = spawnSync(process.execPath, [path.join(R, "coverage.mjs"), path.join(FIX, "coverage/akldb-inventory.json"), f], { encoding: "utf8" });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("coverage FAIL: routes 1/74, jobs 0/13, steps 0/4");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[LDB-PG55] latency: nearest-rank p50/p95/p99 per route and vantage, concrete paths folded into templates, cold starts counted apart", async () => {
    const { latencyReport, percentile } = await load("latency.mjs");
    expect([1, 2, 3, 4].map((_, i, a) => percentile(a.map((x) => x * 10), [50, 95, 99][i % 3]))).toEqual([20, 40, 40, 20]);
    expect(percentile([], 50)).toBeNull();
    const samples = fs.readFileSync(path.join(FIX, "report/latency-samples.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const r = latencyReport(samples, routeIds());
    const row = (v: string, route: string) => r.rows.find((x: any) => x.vantage === v && x.route === route);
    expect(row("iad", "GET /v1/meta")).toEqual({ vantage: "iad", route: "GET /v1/meta", n: 4, p50: 20, p95: 40, p99: 40, cold: { count: 1, p50: 900, max: 900 } });
    expect(row("iad", "GET /v1/layouts/:ref")).toMatchObject({ n: 2, p50: 50, p95: 70 });
    expect(row("lax", "GET /v1/layouts/:ref")).toMatchObject({ n: 1, p99: 60 });
    expect(r.cold_total).toBe(1);
    expect(r.requests).toBe(8);
  });

  it("[LDB-PG56] the latency gate fails when a route's p95 is above the production baseline", async () => {
    const { latencyReport, renderLatency } = await load("latency.mjs");
    const samples = fs.readFileSync(path.join(FIX, "report/latency-samples.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const base = JSON.parse(fs.readFileSync(path.join(FIX, "report/latency-baseline.json"), "utf8"));
    expect(latencyReport(samples, routeIds(), base).ok).toBe(true);
    const tight = latencyReport(samples, routeIds(), { ...base, "GET /v1/meta": { p95: 39 } });
    expect(tight.ok).toBe(false);
    expect(tight.regressions).toEqual([{ vantage: "iad", route: "GET /v1/meta", p95: 40, baseline: 39 }]);
    expect(renderLatency(tight)).toContain("REGRESSION iad GET /v1/meta: p95 40 > baseline 39");
  });

  it("[LDB-PG57] the cost projection prices the CloudWatch-shaped fixtures to the dollar: units x (720 h / window) x scale x unit price", async () => {
    const { costProjection, sumByLabel } = await load("cost.mjs");
    const prices = JSON.parse(fs.readFileSync(path.join(R, "prices.json"), "utf8"));
    const read = (f: string) => JSON.parse(fs.readFileSync(path.join(FIX, "report", f), "utf8"));
    const metrics = { MetricDataResults: [...read("cloudwatch-dynamodb.json").MetricDataResults, ...read("cloudwatch-lambda.json").MetricDataResults] };
    expect(sumByLabel(metrics)).toEqual({ ConsumedReadCapacityUnits: 20000, ConsumedWriteCapacityUnits: 5000, Invocations: 5000, Duration: 400000 });
    const r = costProjection(metrics, read("run.json"), prices);
    expect(r.month_factor).toBe(30);
    expect(r.lines).toEqual({
      dynamodb_reads: 0.075, // 20,000 RCU/day x 30 = 0.6 M x $0.125
      dynamodb_writes: 0.09375, // 5,000 WCU/day x 30 = 0.15 M x $0.625
      lambda_compute: 0.08, // 400 s x 0.5 GB x 30 = 6,000 GB-s x $0.0000133334
      lambda_requests: 0.03, // 150 k x $0.20 / M
      logs: 0.075, // 0.005 GB x 30 x $0.50
      dynamodb_storage: 0.0125,
      s3_storage: 0.0046,
    });
    expect(r.total_usd_per_month).toBeCloseTo(0.37085, 5);
    expect(r.ok).toBe(true);
    // scale and window are respected: 10x volume over a 12 h window
    const big = costProjection(metrics, { ...read("run.json"), window_hours: 12, scale: 10 }, prices);
    expect(big.month_factor).toBe(600);
    expect(big.lines.dynamodb_reads).toBeCloseTo(1.5, 6);
  });

  it("[LDB-PG58] the cost gate is the budget in prices.json ($2/month): over it fails, partial CloudWatch data is refused", async () => {
    const { costProjection, renderCost, sumByLabel } = await load("cost.mjs");
    const prices = JSON.parse(fs.readFileSync(path.join(R, "prices.json"), "utf8"));
    expect(prices.budget_usd_per_month).toBe(2);
    const read = (f: string) => JSON.parse(fs.readFileSync(path.join(FIX, "report", f), "utf8"));
    const metrics = { MetricDataResults: [...read("cloudwatch-dynamodb.json").MetricDataResults, ...read("cloudwatch-lambda.json").MetricDataResults] };
    const over = costProjection(metrics, { ...read("run.json"), scale: 10 }, prices);
    expect(over.total_usd_per_month).toBeGreaterThan(2);
    expect(over.ok).toBe(false);
    expect(renderCost(over)).toContain("cost FAIL");
    expect(() => sumByLabel({ MetricDataResults: [{ Label: "Invocations", Values: [1], StatusCode: "PartialData" }] })).toThrow(/PartialData/);
    // the CLI agrees
    return import("node:child_process").then(({ spawnSync }) => {
      const run = (extra: string[]) => spawnSync(process.execPath, [path.join(R, "cost.mjs"), path.join(FIX, "report/cloudwatch-dynamodb.json"), path.join(FIX, "report/cloudwatch-lambda.json"), "--run", path.join(FIX, "report/run.json"), ...extra], { encoding: "utf8" });
      expect(run([]).status).toBe(0);
      expect(run([]).stdout).toContain("cost OK");
      const dir = fs.mkdtempSync(path.join(process.cwd(), ".pg58-"));
      try {
        const f = path.join(dir, "big.json");
        fs.writeFileSync(f, JSON.stringify({ ...read("run.json"), scale: 10 }));
        const r = spawnSync(process.execPath, [path.join(R, "cost.mjs"), path.join(FIX, "report/cloudwatch-dynamodb.json"), path.join(FIX, "report/cloudwatch-lambda.json"), "--run", f], { encoding: "utf8" });
        expect(r.status).toBe(1);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it("[LDB-PG59] the differ and report tools never reach a network: no fetch, http, AWS SDK, or CLI spawn in scripts/lab/diff or scripts/lab/report", () => {
    for (const dir of ["diff", "report"]) {
      for (const f of fs.readdirSync(path.join(process.cwd(), "scripts/lab", dir)).filter((x) => x.endsWith(".mjs"))) {
        const src = fs.readFileSync(path.join(process.cwd(), "scripts/lab", dir, f), "utf8").replace(/^\s*\/\/.*$/gm, "");
        expect(src, `${dir}/${f}`).not.toMatch(/\bfetch\(|node:https?|node:net|node:child_process|@aws-sdk|aws-sdk|WebSocket|XMLHttpRequest/);
      }
    }
  });
});
