// A local stand-in for the two production sides (D1 behind the Worker, the AWS `prod` stage) and everything the orchestrator touches
// (design/aws-port.md §5.2), on a fake clock. It models what matters to the cutover's safety: which side serves a write in each mode
// (src/core/cutover.ts), that the mirror carries committed rows from the primary to the other side, and that the ephemeral tables are
// copied. A writer runs on every sleep, so a write accepted by the wrong side, or lost, shows up in `accepted`.
// No network, no AWS, no Cloudflare.
// @ts-expect-error -- plain script, no .d.ts (like tests/tools/codeowners.test.ts)
import { proveRows } from "../../scripts/cutover/proof.mjs";

export type Mode = "read_only" | "proxy" | null;
export type Fault = Error | ((n: number) => Error | undefined);

export interface World {
  now: number;
  d1: { mode: Mode; rows: Record<string, object[]>; seq: number };
  aws: { mode: Mode; rows: Record<string, object[]>; seq: number; mirrorMode: "apply" | "record" | "off"; jobsOn: boolean };
  cron: boolean;
  calls: string[];
  /** Writes by outcome: accepted on a side, or refused 503. */
  writes: { at: number; side: "d1" | "aws" | null; id: number }[];
  /** Method name -> an error to throw when it is called (a function gets the call count and may return undefined). */
  faults: Record<string, Fault>;
  /** Fake durations of the slow operations (ms). */
  cost: Record<string, number>;
  mirror: { diverged: boolean; lagS: number; stuck: boolean };
  proofLie: boolean;
  discordReady: boolean;
  smokeOk: boolean;
  ports: Record<string, any>;
  log: object[];
}

export function makeWorld(init: Partial<Pick<World, "faults" | "cost" | "mirror" | "discordReady" | "smokeOk" | "proofLie">> & { d1Mode?: Mode; awsMode?: Mode; direction?: "d1" | "aws" } = {}): World {
  const onAws = init.direction === "aws";
  const w: World = {
    now: 1_000_000,
    d1: { mode: init.d1Mode ?? (onAws ? "proxy" : null), rows: { layouts: [{ id: "a" }], events: [{ seq: 1 }], import_state: [] }, seq: 1 },
    aws: { mode: init.awsMode ?? null, rows: { layouts: [{ id: "a" }], events: [{ seq: 1 }] }, seq: 1, mirrorMode: onAws ? "record" : "apply", jobsOn: onAws },
    cron: !onAws,
    calls: [],
    writes: [],
    faults: init.faults ?? {},
    cost: { "d1.setMode": 300, "aws.setMode": 400, "mirror.waitApplied": 1500, "ephemeral.copy": 600, "proof.run": 2000, "aws.setMirrorMode": 100, "aws.setJobsEnabled": 100, "cloudflare.setCron": 500, "smoke.run": 1500, ...init.cost },
    mirror: init.mirror ?? { diverged: false, lagS: 1, stuck: false },
    proofLie: init.proofLie ?? false,
    discordReady: init.discordReady ?? true,
    smokeOk: init.smokeOk ?? true,
    ports: {},
    log: [],
  };
  let writeId = 0;
  const counts: Record<string, number> = {};

  /** One writer request: served by whoever the modes say. */
  function writeOnce(): void {
    const id = ++writeId;
    let side: "d1" | "aws" | null = null;
    if (w.d1.mode === null) side = "d1";
    else if (w.d1.mode === "proxy") side = w.aws.mode === null ? "aws" : null;
    const t = side === "d1" ? w.d1 : side === "aws" ? w.aws : null;
    if (t) {
      t.seq += 1;
      (t.rows.events ??= []).push({ seq: t.seq });
      (t.rows.layouts ??= []).push({ id: `w${id}` });
    }
    w.writes.push({ at: w.now, side, id });
    // The mirror carries every committed row from the serving side to the other, except while it is stuck.
    if (t && !w.mirror.stuck) {
      const other = side === "d1" ? w.aws : w.d1;
      other.seq = t.seq;
      other.rows = JSON.parse(JSON.stringify(t.rows));
    }
  }

  const clock = {
    now: () => w.now,
    async sleep(ms: number) {
      for (let t = 0; t < ms; t += 100) {
        w.now += Math.min(100, ms - t);
        writeOnce();
      }
    },
  };
  const advance = async (name: string) => {
    w.calls.push(name);
    counts[name] = (counts[name] ?? 0) + 1;
    const f = w.faults[name];
    const err = typeof f === "function" ? f(counts[name]!) : f;
    const ms = w.cost[name] ?? 0;
    if (ms > 0) await clock.sleep(ms);
    if (err) throw err;
  };

  w.ports = {
    clock,
    log: (e: object) => w.log.push(e),
    d1: {
      async getMode() {
        return w.d1.mode;
      },
      async setMode(m: Mode) {
        await advance(`d1.setMode(${m})`.replace(/\(.*\)/, "") + "");
        w.calls[w.calls.length - 1] = `d1.setMode(${m})`;
        w.d1.mode = m;
      },
      async maxSeq() {
        w.calls.push("d1.maxSeq");
        return w.d1.seq;
      },
    },
    aws: {
      async getMode() {
        return w.aws.mode;
      },
      async setMode(m: Mode) {
        await advance("aws.setMode");
        w.calls[w.calls.length - 1] = `aws.setMode(${m})`;
        w.aws.mode = m;
      },
      async maxSeq() {
        w.calls.push("aws.maxSeq");
        return w.aws.seq;
      },
      async setMirrorMode(m: "apply" | "record" | "off") {
        await advance("aws.setMirrorMode");
        w.calls[w.calls.length - 1] = `aws.setMirrorMode(${m})`;
        w.aws.mirrorMode = m;
      },
      async setJobsEnabled(on: boolean) {
        await advance("aws.setJobsEnabled");
        w.calls[w.calls.length - 1] = `aws.setJobsEnabled(${on})`;
        w.aws.jobsOn = on;
      },
      async discordReady() {
        w.calls.push("aws.discordReady");
        return w.discordReady;
      },
    },
    cloudflare: {
      async setCron(on: boolean) {
        await advance("cloudflare.setCron");
        w.calls[w.calls.length - 1] = `cloudflare.setCron(${on})`;
        w.cron = on;
      },
    },
    mirror: {
      async status() {
        w.calls.push("mirror.status");
        return { diverged: w.mirror.diverged, lagS: w.mirror.lagS };
      },
      async waitApplied({ direction, seq }: { direction: string; seq: number; timeoutMs: number }) {
        await advance("mirror.waitApplied");
        w.calls[w.calls.length - 1] = `mirror.waitApplied(${direction})`;
        if (w.mirror.stuck) return { ok: false, seq: seq - 1, reason: "stuck" };
        return { ok: true, seq };
      },
    },
    ephemeral: {
      async copy({ from, to }: { from: string; to: string }) {
        await advance("ephemeral.copy");
        w.calls[w.calls.length - 1] = `ephemeral.copy(${from}->${to})`;
        return { tables: { nonces: 3, auth_cache: 1, ratelimit: 2 } };
      },
    },
    proof: {
      async run() {
        await advance("proof.run");
        const p = proveRows(w.d1.rows, w.proofLie ? { ...w.aws.rows, layouts: [{ id: "tampered" }] } : w.aws.rows);
        return p;
      },
    },
    smoke: {
      async run({ target }: { target: string }) {
        await advance("smoke.run");
        w.calls[w.calls.length - 1] = `smoke.run(${target})`;
        return { ok: w.smokeOk, checks: [{ name: "meta", ok: w.smokeOk }] };
      },
    },
  };
  return w;
}

export const boom = (m: string) => new Error(m);
