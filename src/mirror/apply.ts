// The mirror's applier (design/aws-port.md §5.2 item 2; lane Z). Platform-neutral: it runs on AWS against the DynamoDB
// `Store` (direction "d1->ddb") and inside the D1 Worker against the D1 `Store` (direction "ddb->d1"), from the same code.
//
// Order. Calls that committed events apply strictly in prod's seq order: a call whose first seq is k waits for k-1. Every other
// call applies by the time it returned, merged between them: of the next in-line event call and the oldest other call, the earlier
// `atMs` goes first, and only once it is `settleMs` old (so a late batch can still slot in before it).
//
// Checks per call: the outcome equals prod's (the result deep-equal, or the same error class, status and body), the event seqs the
// target committed equal prod's, and every Clock argument was read exactly as often as it was in prod. Any mismatch HALTS the
// applier: it raises MIRROR_DIVERGED, keeps the divergent record, and never applies past it. Only a reseed clears a halt.
import type { Clock } from "../core/time";
import type { Store } from "../store/port";
import { decodeTee, type TeeBatch, type TeeCall } from "./record";
import { updateState, type Halt, type MirrorQueue, type MirrorState, type QueuedCall } from "./queue";
import { compareClockReads, compareOutcome, compareSeqs, isMirrorWrite, outcomeOfError, outcomeOfResult, seqsBetween, type Mismatch } from "./verify";

export type Direction = TeeBatch["direction"];

/** The port methods that are a `sequence` of independent writes (src/store/port.ts): a failure in the middle leaves a prefix. */
export const SEQUENCE_METHODS: ReadonlySet<string> = new Set([
  "auth.touchClientAuthor", "auth.cacheAuthSuccess", "links.submit", "discord.claimAction", "discord.expireActions", "discord.disableActions",
]);

/** Error classes that are deterministic functions of the state the call saw. Anything else on prod's side was infrastructure or a race. */
const DOMAIN_ERRORS: ReadonlySet<string> = new Set(["ApiError", "DuplicateInteractionError"]);

/** An error that says nothing about the state: not a domain error, or a 5xx. */
function isInfraError(e: { name: string; status?: number }): boolean {
  return !DOMAIN_ERRORS.has(e.name) || (e.name === "ApiError" && (e.status ?? 0) >= 500);
}

export interface MirrorEventLog {
  /** One structured line: `{code, ...}`; the Lambda forwards it to its log group, where a metric filter raises the alarm. */
  (line: Record<string, unknown>): void;
}

export interface ApplyDeps {
  store: Store;
  queue: MirrorQueue;
  nowMs(): number;
  sleep?(ms: number): Promise<void>;
  /** A non-event call applies once it is this old (default 1500 ms). Event calls too, so the merge by `atMs` is not cut short by a late batch. */
  settleMs?: number;
  /** A missing event seq that stays missing this long halts into a reseed (default 10 minutes). */
  gapTimeoutMs?: number;
  /** Lease length; every applied call renews it (default 60 s). */
  leaseMs?: number;
  /** Stop after this many calls or this long, whichever first (defaults 500 and 10 minutes). */
  maxCalls?: number;
  maxRunMs?: number;
  log?: MirrorEventLog;
  /** Metric hook (CloudWatch EMF lines by default via `emfMetrics`). */
  metrics?(m: { lagP50Ms: number; lagP99Ms: number; lagMaxMs: number; applied: number; queueAgeMs: number | null; pendingEvents: boolean; halted: boolean }): void;
  /** Attempts for a call whose target store failed on infrastructure (default 3). */
  targetRetries?: number;
}

export interface ApplyReport {
  /** Another invocation holds the lease. */
  busy: boolean;
  applied: number;
  skipped: number;
  halted: Halt | null;
  /** Waiting on a missing event seq (and for how long). */
  gap: { seq: number; sinceMs: number } | null;
  /** The pause point is reached: nothing the pause allows is left. */
  paused: boolean;
  /** Nothing is ready to apply and nothing is held back (empty, unsettled, gap or pause). */
  idle: boolean;
  lagsMs: number[];
  appliedSeq: number;
}

class ClockExhausted extends Error {
  constructor() {
    super("a Clock recorded with no values was read");
    this.name = "ClockExhausted";
  }
}

/**
 * A Clock that returns the recorded values in order. D1 and DynamoDB legitimately read a Clock a different number of times in one
 * call (D1's commitWrite reads it a second time for the budget window, DynamoDB reuses the first value), so a read past the
 * recording repeats the last recorded value (the same instant, to the millisecond); a call recorded with NO clock values that
 * reads one anyway throws. `reads` counts what was asked, and a difference in count is only counted (clockDrift), not a halt.
 */
function replayClock(values: readonly string[]): Clock & { reads: number } {
  let i = 0;
  const clock = (() => {
    clock.reads++;
    if (values.length === 0) throw new ClockExhausted();
    return values[Math.min(i++, values.length - 1)]!;
  }) as Clock & { reads: number };
  clock.reads = 0;
  return clock;
}

function isClockTag(v: unknown): v is { $clock: string[] } {
  return v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && Array.isArray((v as { $clock?: unknown }).$clock);
}

/** Decode recorded arguments: `{"$clock": [...]}` becomes a replaying Clock, tagged values go through decodeTee. */
export function decodeArgs(args: readonly unknown[]): { args: unknown[]; clocks: (Clock & { reads: number })[]; expectedReads: number[] } {
  const clocks: (Clock & { reads: number })[] = [];
  const expectedReads: number[] = [];
  const walk = (v: unknown): unknown => {
    if (isClockTag(v)) {
      const c = replayClock(v.$clock);
      clocks.push(c);
      expectedReads.push(v.$clock.length);
      return c;
    }
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(walk);
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0]!.startsWith("$")) return decodeTee(v);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
  };
  return { args: args.map(walk), clocks, expectedReads };
}

function shapeOk(call: TeeCall): string | null {
  if (call.v !== 1 || typeof call.method !== "string" || !Array.isArray(call.args) || !Array.isArray(call.seqs) || typeof call.atMs !== "number") return "malformed call";
  if (call.outcome === null || typeof call.outcome !== "object" || !("ok" in call.outcome || "error" in call.outcome)) return "malformed outcome";
  if (!isMirrorWrite(call.method)) return `method ${call.method} is not a mirrored write`;
  return null;
}

type Step = { kind: "applied" } | { kind: "skipped" } | { kind: "later"; reason: string } | { kind: "halt"; halt: Halt; divergent: unknown };

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

export async function runApplier(deps: ApplyDeps): Promise<ApplyReport> {
  const { queue, store } = deps;
  const settleMs = deps.settleMs ?? 1500;
  const gapTimeoutMs = deps.gapTimeoutMs ?? 10 * 60_000;
  const leaseMs = deps.leaseMs ?? 60_000;
  const maxCalls = deps.maxCalls ?? 500;
  const maxRunMs = deps.maxRunMs ?? 10 * 60_000;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log: MirrorEventLog = deps.log ?? ((line) => console.log(JSON.stringify(line)));
  const token = crypto.randomUUID();
  const startMs = deps.nowMs();
  const report: ApplyReport = { busy: false, applied: 0, skipped: 0, halted: null, gap: null, paused: false, idle: false, lagsMs: [], appliedSeq: 0 };

  // Take the lease. A live lease held by someone else means another invocation is applying.
  let st = await updateState(queue, (s) => {
    if (s.halted !== null) return false;
    if (s.lease !== null && s.lease.untilMs > deps.nowMs()) return false;
    s.lease = { token, untilMs: deps.nowMs() + leaseMs };
  });
  report.appliedSeq = st.appliedSeq;
  if (st.halted !== null) {
    report.halted = st.halted;
    report.idle = true;
    return report;
  }
  if (st.lease?.token !== token) {
    report.busy = true;
    return report;
  }

  const halt = async (h: Halt, divergent: unknown): Promise<void> => {
    await queue.keepDivergent(divergent);
    await updateState(queue, (s) => {
      s.halted = h;
      if (s.lease?.token === token) s.lease = null;
    });
    report.halted = h;
    log({ code: h.code, direction: queue.direction, reason: h.reason, callKey: h.callKey, appliedSeq: st.appliedSeq });
  };

  try {
    // A crash left a call in flight. An event call whose seqs the target already holds was applied; anything else is simply re-run
    // (the outcome check below catches a re-run that is not idempotent).
    if (st.inflight !== null) {
      const stuck = (await queue.pending(8)).find((c) => c.key === st.inflight);
      if (stuck !== undefined && stuck.lastSeq !== null) {
        const head = await store.head.headSeq();
        if (head === stuck.lastSeq) {
          st = await updateState(queue, (s) => {
            s.appliedSeq = head;
            s.appliedCalls++;
            s.unverifiedCalls++;
            s.inflight = null;
            s.lastApplied = stuck.key;
          });
          await queue.remove(stuck);
          log({ code: "MIRROR_INFLIGHT_RECOVERED", direction: queue.direction, callKey: stuck.key, headSeq: head });
        } else if (head !== st.appliedSeq) {
          await halt({ code: "MIRROR_AMBIGUOUS", reason: `crash left ${stuck.key} half applied: target head ${head}, applied ${st.appliedSeq}, call seqs ${stuck.call.seqs.join(",")}`, atMs: deps.nowMs(), callKey: stuck.key }, { stuck });
          return report;
        }
      }
    }

    for (let n = 0; n < maxCalls && deps.nowMs() - startMs < maxRunMs; n++) {
      const now = deps.nowMs();
      let ev = await queue.nextEvent();
      let ot = await queue.nextOther();

      // Reseed overlap and the crash window between "state written" and "call removed": drop what is already in.
      while (ev !== null && ev.firstSeq !== null && (ev.key === st.lastApplied || ev.firstSeq <= st.seedSeq)) {
        await queue.remove(ev);
        ev = await queue.nextEvent();
      }
      while (ot !== null && (ot.key === st.lastApplied || ot.atMs <= st.seedAtMs)) {
        await queue.remove(ot);
        ot = await queue.nextOther();
      }
      if (ev !== null && ev.firstSeq !== null && ev.firstSeq <= st.appliedSeq) {
        await halt({ code: "MIRROR_DIVERGED", reason: `event call ${ev.key} (seqs ${ev.call.seqs.join(",")}) is at or below the applied seq ${st.appliedSeq}`, atMs: now, callKey: ev.key }, { call: ev, appliedSeq: st.appliedSeq });
        return report;
      }

      // Candidates: the next event call only if it is exactly next in seq; the oldest other call; both subject to the pause point.
      const pause = st.pause;
      let evCand = ev !== null && ev.firstSeq === st.appliedSeq + 1 && (pause === null || ev.lastSeq! <= pause.seq) ? ev : null;
      const otCand = ot !== null && (pause === null || ot.atMs <= pause.atMs) ? ot : null;

      // Gap bookkeeping: the next event call in line is further ahead than applied+1.
      const gapped = ev !== null && ev.firstSeq !== null && ev.firstSeq > st.appliedSeq + 1 && (pause === null || ev.firstSeq <= pause.seq);
      if (gapped) {
        const since = st.gapSinceMs ?? now;
        if (st.gapSinceMs === null || st.gapSeq !== st.appliedSeq + 1) {
          st = await updateState(queue, (s) => {
            s.gapSinceMs = now;
            s.gapSeq = s.appliedSeq + 1;
          });
        }
        report.gap = { seq: st.appliedSeq + 1, sinceMs: now - (st.gapSinceMs ?? since) };
        if (now - (st.gapSinceMs ?? since) > gapTimeoutMs) {
          await halt({ code: "MIRROR_GAP", reason: `event seq ${st.appliedSeq + 1} never arrived (next queued is ${ev!.firstSeq}); reseed`, atMs: now, callKey: ev!.key }, { appliedSeq: st.appliedSeq, next: ev });
          return report;
        }
        evCand = null;
      } else if (st.gapSinceMs !== null) {
        st = await updateState(queue, (s) => {
          s.gapSinceMs = null;
          s.gapSeq = null;
        });
      }

      let pick: QueuedCall | null = null;
      if (evCand !== null && otCand !== null) pick = otCand.atMs < evCand.atMs ? otCand : evCand;
      else pick = evCand ?? otCand;
      if (pick === null) {
        report.paused = pause !== null && st.appliedSeq >= pause.seq && evCand === null && otCand === null;
        report.idle = true;
        break;
      }
      if (now - pick.atMs < settleMs) {
        report.idle = true;
        break;
      }

      const step = await applyOne(deps, st, pick, token, leaseMs);
      if (step.kind === "halt") {
        await halt(step.halt, step.divergent);
        return report;
      }
      if (step.kind === "later") {
        await updateState(queue, (s) => {
          if (s.lease?.token !== token) return false;
          s.inflight = null;
        });
        log({ code: "MIRROR_TARGET_RETRY", direction: queue.direction, callKey: pick.key, reason: step.reason });
        report.idle = true;
        break;
      }
      if (step.kind === "applied") {
        report.applied++;
        report.lagsMs.push(Math.max(0, deps.nowMs() - pick.atMs));
      } else report.skipped++;
      st = await queue.readState();
      if (st.lease?.token !== token) break; // someone took the lease over (it expired); stop at once
    }
  } finally {
    const final = await queue.readState();
    if (final.lease?.token === token) {
      try {
        await updateState(queue, (s) => {
          if (s.lease?.token === token) s.lease = null;
          else return false;
        });
      } catch {
        // the lease just expires
      }
    }
    report.appliedSeq = final.appliedSeq;
    if (final.halted !== null) report.halted = final.halted;
    const sorted = [...report.lagsMs].sort((a, b) => a - b);
    const oldest = (await queue.pending(1))[0];
    deps.metrics?.({
      lagP50Ms: pct(sorted, 50), lagP99Ms: pct(sorted, 99), lagMaxMs: sorted[sorted.length - 1] ?? 0, applied: report.applied,
      queueAgeMs: oldest === undefined ? null : Math.max(0, deps.nowMs() - oldest.atMs), pendingEvents: (await queue.nextEvent()) !== null, halted: final.halted !== null,
    });
  }
  return report;
}

async function applyOne(deps: ApplyDeps, st: MirrorState, c: QueuedCall, token: string, leaseMs: number): Promise<Step> {
  const { queue, store } = deps;
  const call = c.call;
  const now = (): number => deps.nowMs();
  const bad = shapeOk(call);
  if (bad !== null) return { kind: "halt", halt: { code: "MIRROR_BAD_RECORD", reason: bad, atMs: now(), callKey: c.key }, divergent: { call: c } };

  // Prod's outcome was an infrastructure error or a lost race: it committed nothing there, and the same call run alone here may
  // well succeed, so it is not replayed -- except a `sequence` method, which may have left a prefix in prod that we cannot see.
  if ("error" in call.outcome) {
    const name = call.outcome.error.name;
    if (isInfraError(call.outcome.error)) {
      if (SEQUENCE_METHODS.has(call.method) && call.seqs.length === 0) {
        return { kind: "halt", halt: { code: "MIRROR_UNREPLAYABLE", reason: `${call.method} failed in prod with ${name} (a sequence of writes may have left a prefix); reseed`, atMs: now(), callKey: c.key }, divergent: { call: c } };
      }
      await finish(deps, c, token, leaseMs, null, true);
      return { kind: "skipped" };
    }
  }

  const [area, method] = call.method.split(".") as [string, string];
  const target = (store as unknown as Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>>)[area]?.[method];
  if (typeof target !== "function") return { kind: "halt", halt: { code: "MIRROR_BAD_RECORD", reason: `store has no ${call.method}`, atMs: now(), callKey: c.key }, divergent: { call: c } };

  // Mark in flight (and renew the lease) before touching the target; a crash leaves this behind.
  const marked = await updateState(queue, (s) => {
    if (s.lease?.token !== token) return false;
    s.inflight = c.key;
    s.lease = { token, untilMs: now() + leaseMs };
  });
  if (marked.lease?.token !== token) return { kind: "skipped" };

  const retries = deps.targetRetries ?? 3;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let actual: ReturnType<typeof outcomeOfResult> | undefined;
  let decoded: ReturnType<typeof decodeArgs> | undefined;
  let clockExhausted = false;
  for (let attempt = 0; ; attempt++) {
    decoded = decodeArgs(call.args);
    try {
      actual = outcomeOfResult(await target.apply((store as unknown as Record<string, unknown>)[area], decoded.args));
      break;
    } catch (e) {
      if (e instanceof ClockExhausted) {
        clockExhausted = true;
        actual = outcomeOfError(e);
        break;
      }
      const o = outcomeOfError(e);
      const infra = "error" in o && isInfraError(o.error);
      if (infra && !SEQUENCE_METHODS.has(call.method)) {
        if (attempt < retries) {
          await sleep(50 * 2 ** attempt);
          continue;
        }
        return { kind: "later", reason: `${call.method} failed on the mirror's store: ${o.error.name}` };
      }
      if (infra && SEQUENCE_METHODS.has(call.method)) {
        return { kind: "halt", halt: { code: "MIRROR_TARGET_ERROR", reason: `${call.method} failed on the mirror's store (${"error" in o ? o.error.name : "?"}); a sequence may have left a prefix`, atMs: now(), callKey: c.key }, divergent: { call: c, actual: o } };
      }
      actual = o;
      break;
    }
  }

  const after = await store.head.headSeq();
  const mismatch: Mismatch | null =
    (clockExhausted ? { kind: "clock", detail: "the call read a Clock that was recorded with no values", expected: decoded!.expectedReads, actual: "read" } : null) ??
    compareOutcome(call.outcome, actual!) ??
    compareSeqs(call.seqs, seqsBetween(st.appliedSeq, after));
  const drift = compareClockReads(decoded!.expectedReads, decoded!.clocks.map((k) => k.reads)) !== null;
  if (mismatch !== null) {
    return {
      kind: "halt",
      halt: { code: "MIRROR_DIVERGED", reason: `${call.method} @${call.atMs}: ${mismatch.kind}: ${mismatch.detail}`, atMs: now(), callKey: c.key },
      divergent: { call: c, mismatch, appliedSeq: st.appliedSeq, headAfter: after },
    };
  }
  await finish(deps, c, token, leaseMs, after, false, drift);
  return { kind: "applied" };
}

/** State first (applied seq, clear in-flight), then drop the call: a crash between the two is covered by `lastApplied`. */
async function finish(deps: ApplyDeps, c: QueuedCall, token: string, leaseMs: number, headAfter: number | null, skipped: boolean, drift = false): Promise<void> {
  const after = await updateState(deps.queue, (s) => {
    if (s.lease?.token !== token) return false;
    if (headAfter !== null) s.appliedSeq = headAfter;
    if (drift) s.clockDrift++;
    if (skipped) s.skippedCalls++;
    else s.appliedCalls++;
    s.inflight = null;
    s.lastApplied = c.key;
    s.lastAppliedAtMs = c.atMs;
    s.lease = { token, untilMs: deps.nowMs() + leaseMs };
  });
  // Lease lost: the call stays queued and in flight for whoever holds the lease now (recovery decides).
  if (after.lease?.token === token) await deps.queue.remove(c);
}

/** CloudWatch Embedded Metric Format line for the applier's lag and queue age. */
export function emfMetrics(direction: Direction, write: (line: string) => void = (l) => console.log(l)): NonNullable<ApplyDeps["metrics"]> {
  return (m) => {
    write(
      JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: "akldb/mirror",
              Dimensions: [["Direction"]],
              Metrics: [
                { Name: "ApplierLagP99Ms", Unit: "Milliseconds" }, { Name: "ApplierLagMaxMs", Unit: "Milliseconds" }, { Name: "Applied", Unit: "Count" },
                { Name: "QueueAgeMs", Unit: "Milliseconds" }, { Name: "Halted", Unit: "Count" },
              ],
            },
          ],
        },
        Direction: direction,
        ApplierLagP99Ms: m.lagP99Ms,
        ApplierLagMaxMs: m.lagMaxMs,
        Applied: m.applied,
        QueueAgeMs: m.queueAgeMs ?? 0,
        Halted: m.halted ? 1 : 0,
      }),
    );
  };
}
