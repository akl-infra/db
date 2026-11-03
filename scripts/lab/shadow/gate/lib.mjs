// The phase D gate report (LDB-PV10): turns the run's evidence into the gate table of handoff/akldb-on-aws-build-plan.md's D row.
// Every function here is pure; scripts/lab/shadow/gate.mjs reads the files and prints.
//
// Rows: (1) seven consecutive clean days; (2a) latency from us-east-2 per route; (2b) from Denver, validated routes within +40 ms,
// static routes served from the edge; (2c) the traffic-weighted estimate; (3) cold share and cold p95; (4) cost; (5) the header-level
// diff versus prod. A row is PASS, FAIL, or OPEN (its evidence was not supplied or is too thin): the gate passes only when all are PASS.
import { costProjection } from "./cost.mjs";
import { VERDICTS } from "../replay/report.mjs";

export const CLEAN_DAYS_NEEDED = 7;
export const DENVER_BUDGET_MS = 40;
export const COLD_SHARE_MAX = 0.01;
export const COLD_P95_MAX_MS = 600;

/** latency-compare.py's pct(): nearest index, round half to even. */
export function pct(xs, p) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const x = p * (s.length - 1);
  const f = Math.floor(x);
  const d = x - f;
  const i = d < 0.5 ? f : d > 0.5 ? f + 1 : f % 2 === 0 ? f : f + 1;
  return s[Math.min(s.length - 1, i)];
}

const day = (iso) => String(iso).slice(0, 10);

// ---- log lines ---------------------------------------------------------------------------------------------------------------

/** Lines of a log export: a `filter-log-events` JSON ({events:[{timestamp,message}]}), an array of such pages, or plain text. */
export function logLines(text) {
  const out = [];
  const push = (message, ts) => {
    let m = String(message);
    // LogFormat JSON: {"timestamp":"...","level":"ERROR","message":"akldb-..."}
    if (m.startsWith("{")) {
      try {
        const j = JSON.parse(m);
        if (typeof j.message === "string") {
          out.push({ ts: ts ?? (j.timestamp ? Date.parse(j.timestamp) : undefined), message: j.message });
          return;
        }
      } catch {
        /* a plain line that starts with a brace */
      }
    }
    for (const line of m.split("\n")) if (line.trim() !== "") out.push({ ts, message: line });
  };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (parsed !== undefined) {
    const pages = Array.isArray(parsed) ? parsed : [parsed];
    for (const p of pages) for (const e of p.events ?? []) push(e.message ?? "", e.timestamp);
    return out;
  }
  for (const line of text.split("\n")) if (line.trim() !== "") push(line, undefined);
  return out;
}

/** Everything the gate reads from the shadow stack's logs. */
export function parseLogs(lines) {
  const r = { checkpoints: [], alarms: [], colds: [], reports: [], boots: 0 };
  for (const { ts, message } of lines) {
    const iso = ts === undefined ? undefined : new Date(ts).toISOString();
    let i;
    if ((i = message.indexOf("akldb-checkpoint: ")) >= 0) {
      try {
        r.checkpoints.push({ ...JSON.parse(message.slice(i + "akldb-checkpoint: ".length)), at: iso });
      } catch {
        /* a truncated line */
      }
    } else if ((i = message.indexOf("akldb-alarm: ")) >= 0) {
      const rest = message.slice(i + "akldb-alarm: ".length);
      r.alarms.push({ at: iso, component: rest.split(":")[0], text: rest.slice(0, 200) });
    } else if ((i = message.indexOf("akldb-cold: ")) >= 0) {
      try {
        r.colds.push({ ...JSON.parse(message.slice(i + "akldb-cold: ".length)), at: iso });
      } catch {
        /* skip */
      }
    } else if (message.includes("REPORT RequestId:")) {
      const init = /Init Duration: ([\d.]+) ms/.exec(message);
      const dur = /Duration: ([\d.]+) ms/.exec(message);
      r.reports.push({ at: iso, initMs: init === null ? null : Number(init[1]), durationMs: dur === null ? null : Number(dur[1]) });
    } else if (message.includes("akldb-boot: ")) r.boots++;
  }
  return r;
}

// ---- row 1: clean days -------------------------------------------------------------------------------------------------------

/**
 * Per UTC day: replay records (verdict counts), the checkpoints of that day, the alarm lines. A day is clean when it has compared
 * replay records, none of them `diff` or `error`, its checkpoint is `equal`, no replica halted and the follower raised no alarm.
 */
export function cleanDays(records, logs) {
  const days = new Map();
  const get = (d) => days.get(d) ?? days.set(d, { day: d, replay: Object.fromEntries(VERDICTS.map((v) => [v, 0])), checkpoints: [], halts: 0, followerAlarms: 0, otherAlarms: 0 }).get(d);
  for (const r of records) if (r.at) get(day(r.at)).replay[r.verdict] = (get(day(r.at)).replay[r.verdict] ?? 0) + 1;
  for (const c of logs.checkpoints) if (c.at) get(day(c.at)).checkpoints.push(c);
  for (const a of logs.alarms) {
    if (!a.at) continue;
    const d = get(day(a.at));
    if (/halted|ReplicaDivergedError/.test(a.text)) d.halts++;
    else if (a.component === "shadow-follower") d.followerAlarms++;
    else d.otherAlarms++;
  }
  const rows = [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  for (const d of rows) {
    const compared = d.replay.equal + d.replay.diff + d.replay["diff-state"];
    const reasons = [];
    if (compared === 0) reasons.push("no replay compared");
    if (d.replay.diff > 0) reasons.push(`${d.replay.diff} diff`);
    if (d.replay.error > 0) reasons.push(`${d.replay.error} replay error`);
    if (d.checkpoints.length === 0) reasons.push("no checkpoint");
    else if (d.checkpoints.some((c) => c.result !== "equal")) reasons.push(`checkpoint ${d.checkpoints.map((c) => c.result).join("/")}`);
    if (d.halts > 0) reasons.push(`${d.halts} replica halt`);
    if (d.followerAlarms > 0) reasons.push(`${d.followerAlarms} follower alarm`);
    if (d.otherAlarms > 0) reasons.push(`${d.otherAlarms} other alarm`);
    d.compared = compared;
    d.clean = reasons.length === 0;
    d.reasons = reasons;
  }
  // consecutive streak ending at the newest day, counted on consecutive calendar days
  let streak = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!rows[i].clean) break;
    if (i < rows.length - 1 && Date.parse(rows[i + 1].day) - Date.parse(rows[i].day) !== 86_400_000) break;
    streak++;
  }
  return { rows, streak };
}

// ---- rows 2a and 2b: latency --------------------------------------------------------------------------------------------------

/** Probe output (infra/probe/measure.mjs) -> per route rows: the two hosts' p50/p95 on the 200 and 304 paths. */
export function probeRows(probe, a = "prod", b = "shadow") {
  const rows = [];
  for (const r of probe.routes) {
    const pa = r.hosts[a];
    const pb = r.hosts[b];
    if (pa === undefined || pb === undefined) continue;
    rows.push({ path: r.path, kind: r.kind, "200": { prod: [pa.p50, pa.p95], shadow: [pb.p50, pb.p95], n: [pa.full.length, pb.full.length] }, "304": pa.revalid.length > 0 && pb.revalid.length > 0 ? { prod: [pa.p50_304, pa.p95_304], shadow: [pb.p50_304, pb.p95_304], n: [pa.revalid.length, pb.revalid.length] } : null, cache: [pa.cache, pb.cache] });
  }
  return rows;
}

/** Gate (a): per route, shadow p50 and p95 at or below prod's, on every path both sides measured. */
export function gateA(rows, minSamples = 10) {
  const bad = [];
  let thin = 0;
  for (const r of rows) {
    for (const path of ["200", "304"]) {
      const c = r[path];
      if (c === null) continue;
      if (Math.min(...c.n) < minSamples) thin++;
      for (const [i, q] of [[0, "p50"], [1, "p95"]]) if (c.shadow[i] > c.prod[i]) bad.push(`${r.path} ${path} ${q}: shadow ${c.shadow[i].toFixed(1)} ms > prod ${c.prod[i].toFixed(1)} ms`);
    }
  }
  if (rows.length === 0) return { status: "OPEN", detail: "no probe result" };
  if (bad.length > 0) return { status: "FAIL", detail: `${bad.length} cells over prod: ${bad.slice(0, 6).join("; ")}` };
  if (thin > 0) return { status: "OPEN", detail: `${thin} cells have fewer than ${minSamples} samples` };
  return { status: "PASS", detail: `${rows.length} routes, every p50 and p95 at or below prod's` };
}

/** Parse latency-compare.py's markdown (one or more tables); the LAST table wins. Cells: "p50 / p95" or "—". */
export function parseMac(md) {
  const blocks = [];
  let cur = null;
  for (const line of md.split("\n")) {
    if (/^\|\s*route\s*\|/.test(line)) {
      cur = [];
      blocks.push(cur);
      continue;
    }
    if (cur !== null && /^\|\s*`/.test(line)) cur.push(line);
    else if (cur !== null && !/^\|[-| ]+\|$/.test(line)) cur = null;
  }
  const last = blocks.length === 0 ? [] : blocks[blocks.length - 1];
  const cell = (c) => {
    const m = /^([\d.]+)\s*\/\s*([\d.]+)$/.exec(c.trim());
    return m === null ? null : [Number(m[1]), Number(m[2])];
  };
  return last.map((line) => {
    const c = line.split("|").slice(1, -1).map((x) => x.trim());
    const [p200, s200, p304, s304] = [cell(c[2]), cell(c[3]), cell(c[4]), cell(c[5])];
    return { path: c[0].replace(/`/g, ""), kind: c[1], prod200: p200, shadow200: s200, prod304: p304, shadow304: s304, prodCache: c[6] ?? "", shadowCache: c[7] ?? "" };
  });
}

/** Gate (b): Denver, validated routes within +40 ms at p50 and p95 (200 and 304); static `/v1/formats` served from the edge (HIT). */
export function gateB(rows, budget = DENVER_BUDGET_MS) {
  if (rows.length === 0) return { status: "OPEN", detail: "no latency-compare output" };
  const bad = [];
  let checked = 0;
  for (const r of rows) {
    const validated = r.kind.startsWith("validated");
    const edge = r.path === "/v1/formats";
    if (!validated && !edge) continue;
    for (const [pk, sk, label] of [["prod200", "shadow200", "200"], ["prod304", "shadow304", "304"]]) {
      if (r[pk] === null || r[sk] === null) continue;
      checked++;
      for (const [i, q] of [[0, "p50"], [1, "p95"]]) if (r[sk][i] > r[pk][i] + budget) bad.push(`${r.path} ${label} ${q}: ${r[sk][i]} ms vs prod ${r[pk][i]} ms (+${(r[sk][i] - r[pk][i]).toFixed(0)})`);
    }
    if (edge && !/HIT/.test(r.shadowCache)) bad.push(`/v1/formats is not served from the edge (cf-cache-status: ${r.shadowCache || "none"})`);
  }
  if (checked === 0) return { status: "OPEN", detail: "no validated-route cells in the latency-compare output" };
  return bad.length > 0 ? { status: "FAIL", detail: `${bad.length} over prod + ${budget} ms: ${bad.slice(0, 6).join("; ")}` } : { status: "PASS", detail: `${checked} cells within prod + ${budget} ms (p50 and p95); /v1/formats from the edge` };
}

/**
 * Gate (c): a traffic-weighted estimate over real-user colos. colos: [{colo, share, prod_ms, shadow_ms | {rtt_ms, origin_ms}}];
 * the shares are normalized. The estimate is as good as the inputs: the file says where its numbers came from.
 */
export function gateC(colos) {
  if (colos === undefined || colos.length === 0) return { status: "OPEN", detail: "no colo mix supplied (Workers Observability colo shares x measured or modelled RTT to Ohio)" };
  const total = colos.reduce((n, c) => n + c.share, 0);
  let prod = 0;
  let shadow = 0;
  for (const c of colos) {
    const w = c.share / total;
    prod += w * c.prod_ms;
    shadow += w * (c.shadow_ms ?? c.rtt_ms + c.origin_ms);
  }
  return { status: shadow <= prod ? "PASS" : "FAIL", detail: `weighted estimate over ${colos.length} colos: shadow ${shadow.toFixed(0)} ms vs prod ${prod.toFixed(0)} ms`, prod, shadow };
}

// ---- row 3: cold starts -------------------------------------------------------------------------------------------------------

/** Cold share = http-first containers / API requests; cold p95 on init + first request (what a user waits), REPORT Init Duration shown when present. */
export function gateCold(logs, metrics) {
  const colds = logs.colds.filter((c) => c.first === "http");
  const requests = metrics?.ApiRequests;
  if (requests === undefined || requests === 0) return { status: "OPEN", detail: "no API request count (CloudWatch AWS/ApiGateway Count) to divide by" };
  if (logs.colds.length === 0 && logs.reports.length === 0) return { status: "OPEN", detail: "no akldb-cold lines in the logs" };
  const share = colds.length / requests;
  const waits = colds.map((c) => c.initMs + c.requestMs);
  const p95 = pct(waits, 0.95);
  const inits = logs.reports.filter((r) => r.initMs !== null).map((r) => r.initMs);
  const bad = [];
  if (share > COLD_SHARE_MAX) bad.push(`cold share ${(share * 100).toFixed(2)}% > ${COLD_SHARE_MAX * 100}%`);
  if (p95 !== null && p95 > COLD_P95_MAX_MS) bad.push(`cold p95 ${Math.round(p95)} ms > ${COLD_P95_MAX_MS} ms`);
  const detail = `${colds.length} cold starts by a request in ${requests} requests (${(share * 100).toFixed(3)}%); cold p95 ${p95 === null ? "n/a" : `${Math.round(p95)} ms`} (init + first request)${inits.length > 0 ? `; REPORT Init Duration p95 ${Math.round(pct(inits, 0.95))} ms over ${inits.length}` : ""}`;
  return bad.length > 0 ? { status: "FAIL", detail: `${bad.join("; ")}; ${detail}` } : colds.length === 0 ? { status: "OPEN", detail: `no cold start by a request seen; ${detail}` } : { status: "PASS", detail };
}

// ---- row 4: cost ---------------------------------------------------------------------------------------------------------------

export function gateCost(metrics, run, prices) {
  if (metrics === undefined || run === undefined) return { status: "OPEN", detail: "no CloudWatch metrics or run parameters" };
  const one = costProjection(metrics, run, prices, run.scale ?? 1);
  const ten = costProjection(metrics, run, prices, (run.scale ?? 1) * 10);
  const ok = one.total <= prices.budget_usd_per_month_1x && ten.total <= prices.budget_usd_per_month_10x;
  return { status: ok ? "PASS" : "FAIL", detail: `projected $${one.total.toFixed(4)}/month at 1x (limit $${prices.budget_usd_per_month_1x}), $${ten.total.toFixed(4)} at 10x (limit $${prices.budget_usd_per_month_10x}); scale ${run.scale ?? 1} over ${run.window_hours} h`, one, ten };
}

// ---- row 5: headers ------------------------------------------------------------------------------------------------------------

export function gateHeaders(records, classesSeen) {
  if (records.length === 0) return { status: "OPEN", detail: "no replay records" };
  const compared = records.filter((r) => r.verdict === "equal" || r.verdict === "diff" || r.verdict === "diff-state");
  const headerDiffs = records.filter((r) => (r.problems ?? []).some((p) => p.kind === "header") && r.verdict !== "skipped");
  const classes = new Set(compared.map((r) => r.class));
  const missing = classesSeen.filter((c) => !classes.has(c));
  if (headerDiffs.length > 0) return { status: "FAIL", detail: `${headerDiffs.length} records with a header difference: ${headerDiffs.slice(0, 3).map((r) => `${r.path} ${r.problems.find((p) => p.kind === "header").detail}`).join("; ")}` };
  if (missing.length > 0) return { status: "OPEN", detail: `no compared record for: ${missing.join(", ")}` };
  return { status: "PASS", detail: `${compared.length} compared answers, ${classes.size} route classes, no header difference (platform headers not compared: content-length, ETag of dump files)` };
}

// ---- the whole table -----------------------------------------------------------------------------------------------------------

/**
 * @param {{records?:object[], logs?:object, probe?:object, mac?:object[], colos?:object[], metrics?:Record<string,number>, run?:object, prices:object, classes?:string[]}} e
 */
export function evaluate(e) {
  const records = e.records ?? [];
  const logs = e.logs ?? { checkpoints: [], alarms: [], colds: [], reports: [], boots: 0 };
  const days = cleanDays(records, logs);
  const rows = [];
  const dirty = days.rows.filter((d) => !d.clean).slice(-3);
  // still accumulating (all days so far clean, fewer than 7) is OPEN; an unclean day inside the evidence that has not been followed by 7 clean days is FAIL
  const status = days.streak >= CLEAN_DAYS_NEEDED ? "PASS" : days.rows.length === 0 ? "OPEN" : dirty.length > 0 ? "FAIL" : "OPEN";
  rows.push({ id: "1", what: `${CLEAN_DAYS_NEEDED} consecutive clean days (0 unexplained diffs, 0 replica halts, nightly checksums equal)`, status, detail: `${days.streak} consecutive clean day(s) ending ${days.rows.length > 0 ? days.rows[days.rows.length - 1].day : "-"}; ${days.rows.length} day(s) with evidence${dirty.length > 0 && status !== "PASS" ? `; unclean: ${dirty.map((d) => `${d.day} (${d.reasons.join(", ")})`).join("; ")}` : ""}` });
  const a = e.probe === undefined ? { status: "OPEN", detail: "no probe result" } : gateA(probeRows(e.probe));
  rows.push({ id: "2a", what: "latency (a): per route, p50 and p95 <= prod, from us-east-2 (probe Lambda)", ...a });
  rows.push({ id: "2b", what: `latency (b): from Denver, validated routes <= prod + ${DENVER_BUDGET_MS} ms; static routes from the edge`, ...gateB(e.mac ?? []) });
  rows.push({ id: "2c", what: "latency (c): traffic-weighted estimate over real-user colos <= prod's weighted wall", ...gateC(e.colos) });
  rows.push({ id: "3", what: `cold share <= ${COLD_SHARE_MAX * 100}% and cold p95 <= ${COLD_P95_MAX_MS} ms`, ...gateCold(logs, e.metrics) });
  rows.push({ id: "4", what: "projected cost <= $1.5/month at 1x, <= $5 at 10x", ...gateCost(e.metrics === undefined ? undefined : { MetricDataResults: Object.entries(e.metrics).map(([Label, v]) => ({ Label, Values: [v], StatusCode: "Complete" })) }, e.run, e.prices) });
  rows.push({ id: "5", what: "header-level diff vs prod identical apart from the listed platform headers", ...gateHeaders(records, e.classes ?? []) });
  return { rows, days, pass: rows.every((r) => r.status === "PASS") };
}

export function renderGate(g, meta = {}) {
  const out = [`# akldb phase D gate${meta.generated ? ` (${meta.generated})` : ""}`, "", `**${g.pass ? "PASS" : "NOT YET"}**: ${g.rows.filter((r) => r.status === "PASS").length} of ${g.rows.length} rows pass.`, "", "| row | gate | status | evidence |", "|---|---|---|---|"];
  for (const r of g.rows) out.push(`| ${r.id} | ${r.what} | ${r.status} | ${r.detail.replace(/\|/g, "/")} |`);
  out.push("", "## Days", "", "| day | compared | equal | diff | diff-state | skipped | error | checkpoint | halts | follower alarms | clean |", "|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---|");
  for (const d of g.days.rows) out.push(`| ${d.day} | ${d.compared} | ${d.replay.equal} | ${d.replay.diff} | ${d.replay["diff-state"]} | ${d.replay.skipped} | ${d.replay.error} | ${d.checkpoints.map((c) => c.result).join(", ") || "none"} | ${d.halts} | ${d.followerAlarms} | ${d.clean ? "yes" : `no: ${d.reasons.join(", ")}`} |`);
  return `${out.join("\n")}\n`;
}
