// The cutover plan and its runner (design/aws-port.md §5.2: the one-PR cutover, steps 1-7, and the rollback). Pure orchestration over
// injected `ports`: nothing here knows Cloudflare or AWS, so the same code runs against the real ports (run.mjs), the rehearsal Worker
// and the local stand-ins of tests/cutover. LDB-CUT13..CUT19.
//
// ports = {
//   clock:      { now(): ms, sleep(ms): Promise }
//   log(event)                                   one JSON line per event
//   d1, aws:    { getMode(), setMode(mode|null), maxSeq() }   the Worker's `import_state['cutover.mode']`, prod's `STATE/cutover.mode`
//   aws:        + setMirrorMode('apply'|'record'), setSchedules(bool), reconcileStack({mirrorMode, scheduleEnabled}), discordReady()
//   cloudflare: { setCron(bool) }                the Worker's `*/5` trigger
//   mirror:     { status() -> {diverged, lagS}, waitApplied({direction, seq, timeoutMs}) -> {ok, seq, reason?} }
//   ephemeral:  { copy({from, to}) -> {tables} } nonces, auth_cache, ratelimit
//   proof:      { run({seq}) -> {ok, diffs} }    every non-ephemeral table, row for row
//   smoke:      { run({target}) -> {ok, checks} }
// }
//
// Failure policy, per design: before step 4 (the handover) nothing on production has changed beyond the freeze, so a failure ABORTS
// (D1 back to normal). From step 4 on a failure ROLLS BACK: while AWS has taken no write that is just D1 back to normal; once step 6
// opened AWS it is the reverse path (freeze AWS, reverse mirror, copy, prove, D1 normal). The reverse direction undoes by reopening
// AWS until its last step has flipped D1, after which there is nothing to undo and the run only reports.

export const CACHE_MS = 1100; // `cutover.mode` is cached 1 s per isolate (src/core/cutover.ts); a flip is visible after this
export const DEFAULTS = Object.freeze({ maxPauseMs: 30_000, inflightMs: 2_000, mirrorTimeoutMs: 20_000, maxLagS: 5 });

export class StepFailure extends Error {
  constructor(step, message) {
    super(`step ${step}: ${message}`);
    this.step = step;
  }
}

const need = (ok, step, message) => {
  if (!ok) throw new StepFailure(step, message);
};

async function setAndVerify(side, name, mode, step) {
  await side.setMode(mode);
  const got = await side.getMode();
  need(got === mode, step, `${name} mode reads ${got}, expected ${mode}`);
}

// ---- the plans -----------------------------------------------------------------------------------------------------------------

/** @returns {{ direction: string, steps: {n:number, id:string, title:string, effects:string[], policy:string, run:Function}[] }} */
export function planFor(direction) {
  if (direction === "aws") return { direction, steps: forwardSteps() };
  if (direction === "d1") return { direction, steps: reverseSteps() };
  throw new Error(`--to must be aws or d1, got ${direction}`);
}

function forwardSteps() {
  return [
    {
      n: 0,
      id: "preflight",
      title: "check D1 is primary and normal, the mirror is clean and close, prod's secrets are in place",
      effects: ["d1.getMode", "aws.getMode", "mirror.status", "aws.discordReady"],
      policy: "abort (nothing changed)",
      async run(c) {
        const d1 = await c.ports.d1.getMode();
        const aws = await c.ports.aws.getMode();
        if (d1 === "proxy" && aws === null) return (c.state.noop = "already on aws");
        need(d1 === null, 0, `D1 cutover.mode is ${d1}; a cutover is in progress or half done: run --status`);
        need(aws === null || aws === "read_only", 0, `prod cutover.mode is ${aws}`);
        c.state.awsInitial = aws;
        const m = await c.ports.mirror.status();
        need(!m.diverged, 0, "the mirror has diverged (MIRROR_DIVERGED)");
        need(m.lagS <= c.o.maxLagS, 0, `the mirror is ${m.lagS}s behind (limit ${c.o.maxLagS}s)`);
        need(await c.ports.aws.discordReady(), 0, "prod's Discord parameters are not all set");
      },
    },
    {
      n: 1,
      id: "freeze",
      title: "D1 cutover.mode=read_only: writes get 503 read_only, reads continue",
      effects: ["d1.setMode(read_only)"],
      policy: "abort",
      async run(c) {
        c.state.frozenAt = c.ports.clock.now();
        c.state.d1Touched = true;
        await setAndVerify(c.ports.d1, "D1", "read_only", 1);
        await c.ports.clock.sleep(CACHE_MS);
      },
    },
    {
      n: 2,
      id: "settle",
      title: "wait for in-flight writes, then for the applier to report D1's final seq applied and verified",
      effects: ["clock.sleep(inflight)", "d1.maxSeq", "mirror.waitApplied(d1->aws)"],
      policy: "abort",
      async run(c) {
        await c.ports.clock.sleep(c.o.inflightMs);
        c.state.finalSeq = await c.ports.d1.maxSeq();
        const r = await c.ports.mirror.waitApplied({ direction: "d1->aws", seq: c.state.finalSeq, timeoutMs: c.o.mirrorTimeoutMs });
        need(r.ok && r.seq >= c.state.finalSeq, 2, `the applier did not reach seq ${c.state.finalSeq}: ${r.reason ?? `at ${r.seq}`}`);
      },
    },
    {
      n: 3,
      id: "copy-and-prove",
      title: "copy the ephemeral tables into prod and prove every other table row for row at the final seq",
      effects: ["ephemeral.copy(d1->aws)", "proof.run"],
      policy: "abort",
      async run(c) {
        c.state.copied = await c.ports.ephemeral.copy({ from: "d1", to: "aws" });
        const p = await c.ports.proof.run({ seq: c.state.finalSeq });
        need(p.ok, 3, `the row-for-row proof found differences: ${JSON.stringify(p.diffs).slice(0, 400)}`);
      },
    },
    {
      n: 4,
      id: "handover",
      title: "prod cutover.mode=read_only, then D1 cutover.mode=proxy: the Worker forwards everything to prod",
      effects: ["clock (pause budget)", "aws.setMode(read_only)", "d1.setMode(proxy)"],
      policy: "abort until prod is frozen, rollback after",
      async run(c) {
        const paused = c.ports.clock.now() - c.state.frozenAt;
        need(paused <= c.o.maxPauseMs, 4, `${paused} ms of write pause already spent (limit ${c.o.maxPauseMs} ms); aborting while that is cheap`);
        c.state.awsTouched = true;
        await setAndVerify(c.ports.aws, "prod", "read_only", 4);
        c.state.handedOver = true;
        await setAndVerify(c.ports.d1, "D1", "proxy", 4);
      },
    },
    {
      n: 5,
      id: "copy-nonces-again",
      title: "copy the nonces again for the requests that reached D1 during steps 1-4",
      effects: ["ephemeral.copy(d1->aws)"],
      policy: "rollback",
      async run(c) {
        await c.ports.ephemeral.copy({ from: "d1", to: "aws" });
      },
    },
    {
      n: 6,
      id: "open-aws",
      title: "prod's recorder on and writes open; its schedule on; the Cloudflare cron off",
      effects: ["aws.setMirrorMode(record)", "aws.setMode(null)", "aws.setSchedules(true)", "cloudflare.setCron(false)"],
      policy: "rollback (the reverse path once prod is open)",
      async run(c) {
        // Recorder first: the instant writes open, the reverse mirror must see them.
        c.state.mirrorTouched = true;
        await c.ports.aws.setMirrorMode("record");
        c.state.awsOpened = true; // set before the call that opens: if it half-worked, the rollback must freeze AWS again
        await setAndVerify(c.ports.aws, "prod", null, 6);
        c.state.reopenedAt = c.ports.clock.now();
        await c.ports.aws.setSchedules(true);
        await c.ports.cloudflare.setCron(false);
      },
    },
    {
      n: 7,
      id: "smoke",
      title: "post-switch smoke (meta seq, a signed write through the proxy, a long-poll, an ETag 304), then reconcile the stack",
      effects: ["smoke.run(aws)", "aws.reconcileStack(record, true)"],
      policy: "rollback; a failed reconcile only fails the job (traffic is already right)",
      async run(c) {
        const s = await c.ports.smoke.run({ target: "aws" });
        need(s.ok, 7, `the smoke failed: ${JSON.stringify(s.checks).slice(0, 400)}`);
        c.state.smokeOk = true;
        try {
          await c.ports.aws.reconcileStack({ mirrorMode: "record", scheduleEnabled: "true" });
        } catch (e) {
          c.state.reconcileError = String(e?.message ?? e);
        }
      },
    },
  ];
}

function reverseSteps() {
  return [
    {
      n: 0,
      id: "preflight",
      title: "check D1 is proxying to a normal prod and the reverse mirror is clean and close",
      effects: ["d1.getMode", "aws.getMode", "mirror.status"],
      policy: "abort (nothing changed)",
      async run(c) {
        const d1 = await c.ports.d1.getMode();
        const aws = await c.ports.aws.getMode();
        if (d1 === null && aws === "read_only") return (c.state.noop = "already on d1");
        need(d1 === "proxy", 0, `D1 cutover.mode is ${d1}, expected proxy`);
        need(aws === null, 0, `prod cutover.mode is ${aws}, expected normal`);
        const m = await c.ports.mirror.status();
        need(!m.diverged, 0, "the reverse mirror has diverged (MIRROR_DIVERGED)");
        need(m.lagS <= c.o.maxLagS, 0, `the reverse mirror is ${m.lagS}s behind (limit ${c.o.maxLagS}s)`);
      },
    },
    {
      n: 1,
      id: "freeze",
      title: "prod cutover.mode=read_only",
      effects: ["aws.setMode(read_only)"],
      policy: "abort (reopen prod)",
      async run(c) {
        c.state.frozenAt = c.ports.clock.now();
        c.state.awsTouched = true;
        await setAndVerify(c.ports.aws, "prod", "read_only", 1);
        await c.ports.clock.sleep(CACHE_MS);
      },
    },
    {
      n: 2,
      id: "settle",
      title: "wait for in-flight writes, then for the reverse mirror to reach prod's final seq",
      effects: ["clock.sleep(inflight)", "aws.maxSeq", "mirror.waitApplied(aws->d1)"],
      policy: "abort (reopen prod)",
      async run(c) {
        await c.ports.clock.sleep(c.o.inflightMs);
        c.state.finalSeq = await c.ports.aws.maxSeq();
        const r = await c.ports.mirror.waitApplied({ direction: "aws->d1", seq: c.state.finalSeq, timeoutMs: c.o.mirrorTimeoutMs });
        need(r.ok && r.seq >= c.state.finalSeq, 2, `the reverse mirror did not reach seq ${c.state.finalSeq}: ${r.reason ?? `at ${r.seq}`}`);
      },
    },
    {
      n: 3,
      id: "copy-ephemeral",
      title: "copy the ephemeral tables from prod into D1",
      effects: ["ephemeral.copy(aws->d1)"],
      policy: "abort (reopen prod)",
      async run(c) {
        c.state.copied = await c.ports.ephemeral.copy({ from: "aws", to: "d1" });
      },
    },
    {
      n: 4,
      id: "prove",
      title: "prove every non-ephemeral table row for row at the final seq",
      effects: ["proof.run"],
      policy: "abort (reopen prod)",
      async run(c) {
        const p = await c.ports.proof.run({ seq: c.state.finalSeq });
        need(p.ok, 4, `the row-for-row proof found differences: ${JSON.stringify(p.diffs).slice(0, 400)}`);
      },
    },
    {
      n: 5,
      id: "d1-normal",
      title: "D1 cutover.mode back to normal: the Worker serves from D1 again (prod stays frozen)",
      effects: ["clock (pause budget)", "d1.setMode(null)"],
      policy: "abort until D1 is flipped; nothing to undo after",
      async run(c) {
        const paused = c.ports.clock.now() - c.state.frozenAt;
        need(paused <= c.o.maxPauseMs, 5, `${paused} ms of write pause already spent (limit ${c.o.maxPauseMs} ms); aborting while that is cheap`);
        c.state.d1Flipped = true;
        await setAndVerify(c.ports.d1, "D1", null, 5);
        c.state.reopenedAt = c.ports.clock.now();
      },
    },
    {
      n: 6,
      id: "restore-d1-side",
      title: "the Cloudflare cron on; prod's forward mirror mode back, its schedule off; reconcile the stack",
      effects: ["cloudflare.setCron(true)", "aws.setMirrorMode(apply)", "aws.setSchedules(false)", "aws.reconcileStack(apply, false)"],
      policy: "report only (D1 already serves)",
      async run(c) {
        await c.ports.cloudflare.setCron(true);
        await c.ports.aws.setMirrorMode("apply");
        await c.ports.aws.setSchedules(false);
        try {
          await c.ports.aws.reconcileStack({ mirrorMode: "apply", scheduleEnabled: "false" });
        } catch (e) {
          c.state.reconcileError = String(e?.message ?? e);
        }
      },
    },
    {
      n: 7,
      id: "smoke",
      title: "post-switch smoke against D1",
      effects: ["smoke.run(d1)"],
      policy: "report only",
      async run(c) {
        const s = await c.ports.smoke.run({ target: "d1" });
        need(s.ok, 7, `the smoke failed: ${JSON.stringify(s.checks).slice(0, 400)}`);
        c.state.smokeOk = true;
      },
    },
  ];
}

// ---- recovery ------------------------------------------------------------------------------------------------------------------

/** What a failure at the current state does. Returns the name of the action taken. */
async function recover(c, direction) {
  const { ports, state } = c;
  if (direction === "aws") {
    if (state.awsOpened) return fullRollback(c);
    if (state.handedOver || state.awsTouched) {
      // Prod took no write: D1 serves again, prod goes back to where it was.
      await retry(() => setAndVerify(ports.d1, "D1", null, "rollback"));
      // Only what changed is put back: when the call that failed was the one that sets prod's mode, there is nothing to restore.
      if ((await ports.aws.getMode()) !== (state.awsInitial ?? null)) await retry(() => setAndVerify(ports.aws, "prod", state.awsInitial ?? null, "rollback"));
      if (state.mirrorTouched) await retry(() => ports.aws.setMirrorMode("apply"));
      return state.handedOver ? "rollback" : "abort";
    }
    if (state.d1Touched) {
      await retry(() => setAndVerify(ports.d1, "D1", null, "abort"));
      return "abort";
    }
    return "abort";
  }
  // Reverse direction: reopen prod while D1 has not been flipped; after that there is nothing to undo.
  if (state.d1Flipped) return "report";
  if (state.awsTouched) {
    await retry(() => setAndVerify(ports.aws, "prod", null, "abort"));
    return "abort";
  }
  return "abort";
}

/** Prod already took writes: the reverse path, with the proof, back to D1. Throws if it cannot finish; the state is then frozen and safe. */
async function fullRollback(c) {
  const { ports, state } = c;
  c.log({ event: "rollback", detail: "prod is open: freezing it and following the reverse path" });
  await retry(() => setAndVerify(ports.aws, "prod", "read_only", "rollback"));
  await ports.clock.sleep(CACHE_MS + c.o.inflightMs);
  const seq = await ports.aws.maxSeq();
  const r = await ports.mirror.waitApplied({ direction: "aws->d1", seq, timeoutMs: c.o.mirrorTimeoutMs });
  need(r.ok && r.seq >= seq, "rollback", `the reverse mirror did not reach seq ${seq}: ${r.reason ?? `at ${r.seq}`}`);
  await ports.ephemeral.copy({ from: "aws", to: "d1" });
  const p = await ports.proof.run({ seq });
  need(p.ok, "rollback", `the row-for-row proof found differences: ${JSON.stringify(p.diffs).slice(0, 400)}`);
  await retry(() => setAndVerify(ports.d1, "D1", null, "rollback"));
  await ports.cloudflare.setCron(true);
  await ports.aws.setMirrorMode("apply");
  await ports.aws.setSchedules(false);
  state.rolledBackFullSeq = seq;
  return "rollback-full";
}

async function retry(fn, times = 3) {
  let last;
  for (let i = 0; i < times; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

// ---- the runner ----------------------------------------------------------------------------------------------------------------

/**
 * @returns {Promise<{ ok: boolean, direction: string, noop?: string, steps: object[], pauseMs: number|null, recovery?: string, failedStep?: number, error?: string }>}
 */
export async function runPlan(direction, ports, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const plan = planFor(direction);
  const log = (e) => ports.log({ t: ports.clock.now(), direction, ...e });
  const c = { ports, o, state: {}, log };
  const result = { ok: false, direction, steps: [], pauseMs: null };
  for (const step of plan.steps) {
    const t0 = ports.clock.now();
    log({ event: "step", step: step.n, id: step.id, status: "start", title: step.title });
    try {
      await step.run(c);
      const ms = ports.clock.now() - t0;
      result.steps.push({ n: step.n, id: step.id, ok: true, ms });
      log({ event: "step", step: step.n, id: step.id, status: "ok", ms });
      if (c.state.noop) {
        result.ok = true;
        result.noop = c.state.noop;
        log({ event: "noop", detail: c.state.noop });
        return result;
      }
    } catch (e) {
      const ms = ports.clock.now() - t0;
      result.steps.push({ n: step.n, id: step.id, ok: false, ms, error: String(e?.message ?? e) });
      result.failedStep = step.n;
      result.error = String(e?.message ?? e);
      log({ event: "step", step: step.n, id: step.id, status: "fail", ms, error: result.error });
      try {
        result.recovery = await recover(c, direction);
        log({ event: "recovered", action: result.recovery });
      } catch (re) {
        result.recovery = "failed";
        result.recoveryError = String(re?.message ?? re);
        log({ event: "recovery-failed", error: result.recoveryError, note: "the mode is left as it stands" });
      }
      result.pauseMs = pauseOf(c, ports);
      if (c.state.reconcileError) result.reconcileError = c.state.reconcileError;
      log({ event: "result", ok: false, pauseMs: result.pauseMs });
      return result;
    }
  }
  result.pauseMs = pauseOf(c, ports);
  if (c.state.reconcileError) result.reconcileError = c.state.reconcileError;
  result.ok = true;
  log({ event: "result", ok: true, pauseMs: result.pauseMs, reconcileError: result.reconcileError ?? null });
  return result;
}

function pauseOf(c, ports) {
  const { frozenAt, reopenedAt } = c.state;
  if (frozenAt === undefined) return null;
  return (reopenedAt ?? ports.clock.now()) - frozenAt;
}

/** The plan as text, for --dry-run: what would run and what each failure does. No port is touched. */
export function describePlan(direction, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const plan = planFor(direction);
  const lines = [`cutover plan: --to ${direction}${options.rehearse ? ` (rehearsal on ${options.rehearse})` : ""}`];
  lines.push(`write pause budget ${o.maxPauseMs} ms; in-flight wait ${o.inflightMs} ms; mirror wait ${o.mirrorTimeoutMs} ms; max mirror lag ${o.maxLagS} s`);
  for (const s of plan.steps) {
    lines.push(`  ${s.n}. ${s.title}`);
    lines.push(`       calls: ${s.effects.join(", ")}`);
    lines.push(`       on failure: ${s.policy}`);
  }
  if (direction === "aws") lines.push("  rollback once prod is open: freeze prod, reverse mirror to prod's final seq, copy ephemeral tables, row-for-row proof, D1 normal, cron on");
  return lines.join("\n");
}
