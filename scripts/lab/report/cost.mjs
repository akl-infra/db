// Lane S: the cost projection ($/month at prod volume, from the replay's CloudWatch numbers). Never calls CloudWatch:
// the main session exports the metrics with `aws cloudwatch get-metric-data` and hands this tool the JSON files.
//
// Input (CloudWatch GetMetricData-shaped, one file or several concatenated under "MetricDataResults"):
//   { "MetricDataResults": [ { "Id": "wru", "Label": "ConsumedWriteCapacityUnits", "Timestamps": [...], "Values": [...], "StatusCode": "Complete" }, ... ] }
// Recognised Labels (every datapoint is the Sum over its period):
//   ConsumedReadCapacityUnits, ConsumedWriteCapacityUnits   DynamoDB, summed across the table and its indexes
//   Invocations                                              Lambda requests
//   Duration                                                 Lambda billed milliseconds (Sum)
// Run parameters (a second JSON, `run.json`):
//   { "window_hours": 24,       how long the numbers cover
//     "scale": 1,               prod volume / replay volume (1 for a 1x replay of the prod window)
//     "lambda_memory_mb": 512,
//     "storage_gb": {"dynamodb": 0.05, "s3": 0.2},    steady-state size, not scaled
//     "logs_gb_per_window": 0.01 }                    CloudWatch Logs ingested in the window, scaled
// Projection = window total * (720 h / window_hours) * scale, priced with prices.json. Gate: <= budget_usd_per_month.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import url from "node:url";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
export const PRICES_FILE = path.join(HERE, "prices.json");

export function sumByLabel(metrics) {
  const out = {};
  for (const m of metrics.MetricDataResults ?? []) {
    if (m.StatusCode && m.StatusCode !== "Complete") throw new Error(`metric ${m.Label}: StatusCode ${m.StatusCode} (partial data)`);
    out[m.Label] = (out[m.Label] ?? 0) + (m.Values ?? []).reduce((a, b) => a + b, 0);
  }
  return out;
}

const round = (x) => Math.round(x * 1e6) / 1e6;

export function costProjection(metrics, run, prices) {
  const t = sumByLabel(metrics);
  const month = (720 / run.window_hours) * (run.scale ?? 1);
  const memGb = (run.lambda_memory_mb ?? 512) / 1024;
  const lines = {
    dynamodb_reads: ((t.ConsumedReadCapacityUnits ?? 0) * month / 1e6) * prices.dynamodb_per_million_read_units,
    dynamodb_writes: ((t.ConsumedWriteCapacityUnits ?? 0) * month / 1e6) * prices.dynamodb_per_million_write_units,
    lambda_compute: ((t.Duration ?? 0) / 1000) * memGb * month * prices.lambda_per_gb_second,
    lambda_requests: ((t.Invocations ?? 0) * month / 1e6) * prices.lambda_per_million_requests,
    logs: (run.logs_gb_per_window ?? 0) * month * prices.logs_ingest_per_gb,
    dynamodb_storage: (run.storage_gb?.dynamodb ?? 0) * prices.dynamodb_storage_per_gb_month,
    s3_storage: (run.storage_gb?.s3 ?? 0) * prices.s3_storage_per_gb_month,
  };
  for (const k of Object.keys(lines)) lines[k] = round(lines[k]);
  const total = round(Object.values(lines).reduce((a, b) => a + b, 0));
  return { totals_in_window: t, month_factor: month, lines, total_usd_per_month: total, budget_usd_per_month: prices.budget_usd_per_month, ok: total <= prices.budget_usd_per_month };
}

export function renderCost(r) {
  const lines = [`cost ${r.ok ? "OK" : "FAIL"}: projected $${r.total_usd_per_month.toFixed(4)}/month against a $${r.budget_usd_per_month} budget`];
  for (const [k, v] of Object.entries(r.lines)) lines.push(`  ${k}: $${v.toFixed(4)}`);
  return lines.join("\n");
}

// node scripts/lab/report/cost.mjs <metrics.json>... --run run.json [--prices prices.json]
if (process.argv[1] && url.fileURLToPath(import.meta.url) === process.argv[1]) {
  const a = process.argv.slice(2);
  const opt = (n) => (a.indexOf(n) === -1 ? null : a[a.indexOf(n) + 1]);
  const files = a.filter((x, i) => !x.startsWith("--") && !(i > 0 && a[i - 1].startsWith("--")));
  const metrics = { MetricDataResults: files.flatMap((f) => JSON.parse(fs.readFileSync(f, "utf8")).MetricDataResults) };
  const r = costProjection(metrics, JSON.parse(fs.readFileSync(opt("--run"), "utf8")), JSON.parse(fs.readFileSync(opt("--prices") ?? PRICES_FILE, "utf8")));
  console.log(renderCost(r));
  process.exit(r.ok ? 0 : 1);
}
