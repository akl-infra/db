// A resumable step machine (LDB-CV11), shared by the cutover (run.mjs) and the rollback (rollback.mjs).
//
//  - A plan is a list of steps: { id, title, commands(c) -> string[], precondition?(c), run(c) -> result, skip?(c) -> reason|null }.
//  - State lives in one JSON file (--state): per step its status, start/end, duration, message and proof, plus a `data` bag the
//    steps share (bookmark, final seq, image hash ...). It is written after every step, so a crashed run resumes where it stopped.
//  - Without --execute NOTHING runs and nothing is written: every step prints the commands it would run.
//  - With --execute a step runs its precondition (always, even on resume: each step re-checks what it needs), then run(). A step the
//    state already marks done is skipped on a plain resume; --from <id> re-runs from that step on; --only <id> runs that one.
//  - A failing step stops the run with the reason and the exact command that resumes it. Nothing is rolled back automatically.
import fs from "node:fs";
import path from "node:path";

export class StepFailure extends Error {
  constructor(message, { hint } = {}) {
    super(message);
    this.name = "StepFailure";
    this.hint = hint;
  }
}
export const fail = (message, opts) => {
  throw new StepFailure(message, opts);
};
export const need = (ok, message, opts) => {
  if (!ok) fail(message, opts);
};

export function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(`state file ${file} is unreadable: ${e.message}`);
  }
}

export function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

export const newState = (machine, params, now) => ({ machine, version: 1, createdAt: new Date(now).toISOString(), params, steps: {}, data: {} });

/**
 * Run a plan. Returns { ok, exit, state, ran: [ids], failed?: {id, message} }.
 * `ctx` is { ports, o (options), out(line), clock }. `args`: { statePath, execute, from, only }.
 */
export async function runPlan(name, steps, ctx, args) {
  const { clock } = ctx;
  const ids = steps.map((s) => s.id);
  for (const k of ["from", "only"]) if (args[k] !== undefined && !ids.includes(args[k])) return { ok: false, exit: 2, message: `--${k} ${args[k]}: no such step (${ids.join(", ")})`, ran: [] };
  if (args.from !== undefined && args.only !== undefined) return { ok: false, exit: 2, message: "--from and --only are exclusive", ran: [] };

  let state = args.statePath === undefined ? null : readState(args.statePath);
  if (state !== null && state.machine !== name) return { ok: false, exit: 2, message: `${args.statePath} belongs to the ${state.machine} machine, not ${name}`, ran: [] };
  state ??= newState(name, ctx.o.params ?? {}, clock.now());
  ctx.state = state;
  ctx.data = state.data;

  const selected = args.only !== undefined ? [args.only] : ids.slice(args.from !== undefined ? ids.indexOf(args.from) : 0);
  const ran = [];

  if (!args.execute) {
    ctx.out(`${name}: DRY RUN (nothing is executed or written; add --execute). Steps ${args.only ? `[${args.only}]` : args.from ? `from ${args.from}` : "in order"}:`);
    for (const s of steps.filter((x) => selected.includes(x.id))) {
      const done = state.steps[s.id]?.status === "done";
      ctx.out(`\n  [${s.id}] ${s.title}${done ? "  (already done in the state file)" : ""}`);
      for (const cmd of s.commands(ctx)) ctx.out(`      $ ${cmd}`);
    }
    return { ok: true, exit: 0, state, ran: [], dryRun: true };
  }

  for (const s of steps.filter((x) => selected.includes(x.id))) {
    const prior = state.steps[s.id];
    if (prior?.status === "done" && args.from === undefined && args.only === undefined) {
      ctx.out(`[${s.id}] already done (${prior.ms} ms), skipped`);
      continue;
    }
    const why = s.skip?.(ctx) ?? null;
    if (why !== null) {
      state.steps[s.id] = { status: "skipped", message: why, at: new Date(clock.now()).toISOString() };
      persist(args, state);
      ctx.out(`[${s.id}] skipped: ${why}`);
      continue;
    }
    const startedAt = clock.now();
    state.steps[s.id] = { status: "running", startedAt: new Date(startedAt).toISOString(), startedMs: startedAt };
    persist(args, state);
    ctx.out(`[${s.id}] ${s.title}`);
    for (const cmd of s.commands(ctx)) ctx.out(`      $ ${cmd}`);
    try {
      await s.precondition?.(ctx);
      const result = (await s.run(ctx)) ?? {};
      const endedAt = clock.now();
      state.steps[s.id] = { status: "done", startedAt: new Date(startedAt).toISOString(), endedAt: new Date(endedAt).toISOString(), startedMs: startedAt, endedMs: endedAt, ms: endedAt - startedAt, message: result.message ?? "ok", proof: result.proof ?? null };
      persist(args, state);
      ran.push(s.id);
      ctx.out(`      ok (${endedAt - startedAt} ms)${result.message ? `: ${result.message}` : ""}`);
    } catch (e) {
      const endedAt = clock.now();
      const message = e instanceof Error ? e.message : String(e);
      state.steps[s.id] = { status: "failed", startedAt: new Date(startedAt).toISOString(), endedAt: new Date(endedAt).toISOString(), startedMs: startedAt, endedMs: endedAt, ms: endedAt - startedAt, message, proof: e.proof ?? null };
      persist(args, state);
      ctx.out(`      FAILED: ${message}`);
      if (e instanceof StepFailure && e.hint) ctx.out(`      ${e.hint}`);
      ctx.out(`      resume with: ${ctx.o.resumeCommand?.(s.id) ?? `--from ${s.id}`}`);
      return { ok: false, exit: 1, state, ran, failed: { id: s.id, message } };
    }
  }
  return { ok: true, exit: 0, state, ran };
}

function persist(args, state) {
  if (args.statePath !== undefined) writeState(args.statePath, state);
}

/** A step's duration in ms from the state (0 when it has not run). */
export const stepMs = (state, id) => state.steps[id]?.ms ?? 0;
