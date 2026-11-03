// The cost projection ($/month at prod volume) from CloudWatch numbers; adapted from lane S's scripts/lab/report/cost.mjs
// (aws-port-rebase-1029). Never calls CloudWatch: the metrics are exported with `aws cloudwatch get-metric-data` and handed in.
//
// Metrics file (GetMetricData-shaped; Labels recognised, each datapoint a Sum over its period):
//   ConsumedReadCapacityUnits, ConsumedWriteCapacityUnits   DynamoDB, the log table
//   Invocations                                              Lambda requests (api + jobs functions)
//   Duration                                                 Lambda milliseconds (Sum)
//   ApiRequests                                              API Gateway `Count`
// Run file: { "window_hours": 168, "scale": 1, "lambda_memory_mb": 2048, "storage_gb": {"dynamodb": .., "s3": ..},
//             "logs_gb_per_window": .., "s3_gets": .., "s3_puts": .. }
// Projection = window total * (720 h / window_hours) * scale; storage is not scaled. The windows are shadow's own: shadow serves the
// replay's traffic and its own follower, so `scale` is prod volume / shadow volume (the replay's sampling factor) and is a
// stated assumption in the gate report, never inferred.
import fs from "node:fs";
import path from "node:path";
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

/** @returns {{lines: Record<string, number>, total: number, month_factor: number, totals_in_window: Record<string, number>}} */
export function costProjection(metrics, run, prices, scale = run.scale ?? 1) {
  const t = sumByLabel(metrics);
  const month = (720 / run.window_hours) * scale;
  const memGb = (run.lambda_memory_mb ?? 2048) / 1024;
  const lines = {
    dynamodb_reads: ((t.ConsumedReadCapacityUnits ?? 0) * month / 1e6) * prices.dynamodb_per_million_read_units,
    dynamodb_writes: ((t.ConsumedWriteCapacityUnits ?? 0) * month / 1e6) * prices.dynamodb_per_million_write_units,
    lambda_compute: ((t.Duration ?? 0) / 1000) * memGb * month * prices.lambda_per_gb_second,
    lambda_requests: ((t.Invocations ?? 0) * month / 1e6) * prices.lambda_per_million_requests,
    http_api: ((t.ApiRequests ?? 0) * month / 1e6) * prices.http_api_per_million_requests,
    s3_requests: (((run.s3_gets ?? 0) * month) / 1000) * prices.s3_per_thousand_get + (((run.s3_puts ?? 0) * month) / 1000) * prices.s3_per_thousand_put,
    logs: (run.logs_gb_per_window ?? 0) * month * prices.logs_ingest_per_gb,
    dynamodb_storage: (run.storage_gb?.dynamodb ?? 0) * prices.dynamodb_storage_per_gb_month,
    s3_storage: (run.storage_gb?.s3 ?? 0) * prices.s3_storage_per_gb_month,
  };
  for (const k of Object.keys(lines)) lines[k] = round(lines[k]);
  return { lines, total: round(Object.values(lines).reduce((a, b) => a + b, 0)), month_factor: month, totals_in_window: t };
}

export function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
