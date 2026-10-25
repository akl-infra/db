// Shared by task.mjs, aws-run.mjs and aggregate.mjs (lane F; design/aws-port.md §4.3, "Running the fuzzer gate on AWS").
//
// A work UNIT is (seed, from, count): `count` consecutive sequences of one seed starting at sequence `from`. Sequence i of
// seed s is a pure function of (s, i) (run.mjs), so a unit can run anywhere, in any order, and be run again.
// A unit's result lives at <run>/<seed>/<from>.json.

export const GATE = { seeds: 20, sequences: 10000, unit: 500, steps: 10 };

/** The units of a gate: seeds 1..N, each split into `unit`-sized ranges. */
export function expectedUnits({ seeds = GATE.seeds, sequences = GATE.sequences, unit = GATE.unit } = {}) {
  const list = Array.isArray(seeds) ? seeds : Array.from({ length: seeds }, (_, i) => i + 1);
  const out = [];
  for (const seed of list) for (let from = 0; from < sequences; from += unit) out.push({ seed, from, count: Math.min(unit, sequences - from) });
  return out;
}

export const unitKey = (u) => `${u.seed}/${u.from}.json`;

/** Split a unit's range over `lanes` contiguous, non-empty sub-ranges (sizes differ by at most one). */
export function splitLanes(from, count, lanes) {
  const n = Math.max(1, Math.min(lanes, count));
  const base = Math.floor(count / n);
  const extra = count % n;
  const out = [];
  let at = from;
  for (let lane = 0; lane < n; lane++) {
    const c = base + (lane < extra ? 1 : 0);
    out.push({ lane, from: at, count: c });
    at += c;
  }
  return out;
}

/** Sort a runner report's diffs into the three buckets a unit result keeps. */
export function classifyDiffs(diffs) {
  const response_state_diffs = [];
  const catalog_mismatches = [];
  const index_problems = [];
  for (const d of diffs) {
    if (d.kind === "check") {
      const rest = [];
      for (const p of d.problems ?? []) {
        if (String(p).startsWith("index checker:")) index_problems.push({ seed: d.seed, sequence: d.sequence, step: d.step, problem: p });
        else if (String(p).startsWith("catalog.current()")) catalog_mismatches.push({ seed: d.seed, sequence: d.sequence, step: d.step, problem: p });
        else rest.push(p);
      }
      if (rest.length > 0) response_state_diffs.push({ ...d, problems: rest });
    } else response_state_diffs.push(d);
  }
  return { response_state_diffs, catalog_mismatches, index_problems };
}

/** A unit result is clean when it ran every sequence it was given and found nothing. */
export function isClean(r) {
  return r.errors.length === 0 && r.sequences_run === r.count && r.response_state_diffs.length === 0 && r.catalog_mismatches.length === 0 && r.index_problems.length === 0;
}

/** Fargate task sizes (vCPU) with 2 GB per vCPU, and the six fuzz lanes per 8 vCPU (3/4 lane per vCPU, as designed). */
export const TASK_SIZES = [8, 4, 2, 1];
export const lanesFor = (vcpu) => Math.max(1, Math.round(vcpu * 0.75));
export const memoryMiB = (vcpu) => vcpu * 2048;

/**
 * The task size that uses the most of a vCPU quota (ties: the larger task, fewer image pulls and cold starts), and the
 * concurrency it gives.
 */
export function planCapacity(quotaVcpu) {
  let best = null;
  for (const vcpu of TASK_SIZES) {
    const concurrent = Math.floor(quotaVcpu / vcpu);
    if (concurrent < 1) continue;
    const used = concurrent * vcpu;
    if (best === null || used > best.used) best = { vcpu, concurrent, used, lanes: lanesFor(vcpu), memoryMiB: memoryMiB(vcpu) };
  }
  return best;
}

/**
 * Expected wall time of `units` units: waves of `concurrent` tasks, each wave one unit long. `stepSeconds` is the
 * design's conservative 1 s per step per lane (measured locally nearer 0.2 s); `startupMinutes` covers the image pull,
 * DynamoDB Local, the migrated template and the wrangler boots.
 */
export function estimate({ units, count = GATE.unit, steps = GATE.steps, quotaVcpu, stepSeconds = 1, startupMinutes = 2 }) {
  const cap = planCapacity(quotaVcpu);
  if (cap === null) return { ok: false, reason: `quota of ${quotaVcpu} vCPU cannot run even a 1 vCPU task` };
  const unitMinutes = (count * steps * stepSeconds) / cap.lanes / 60 + startupMinutes;
  const waves = Math.ceil(units / cap.concurrent);
  return { ok: true, ...cap, unitMinutes, waves, wallHours: (waves * unitMinutes) / 60 };
}

export const formatEstimate = (e) =>
  e.ok
    ? `${e.concurrent} tasks of ${e.vcpu} vCPU / ${e.memoryMiB / 1024} GB (${e.lanes} fuzz lanes each), ${e.unitMinutes.toFixed(0)} min per unit, ${e.waves} waves: about ${e.wallHours.toFixed(1)} h`
    : e.reason;
