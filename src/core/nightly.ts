// The nightly job set (07 §6 S7's dump + 09 §3 T1's three prunes): run
// together at the `hour=3, minute=0` slot of the one `*/5 * * * *` cron
// trigger (`src/index.ts`'s `scheduled()`) AND, since Cloudflare's cron
// dispatch is not currently firing for this account and `wrangler dev
// --test-scheduled` ignores `?time=` (so there is no way to drive this slot
// locally either), from `POST /v1/admin/nightly/tick`
// (`src/routes/admin.ts`) -- same X4-follow-up reasoning `import/tick`/
// `diff/tick` already give for their own crons. `runNightly` is the ONE
// place either caller reaches: no second copy of the four-job list exists
// anywhere else (LDB-A5 extended: "the manual tick and the cron write
// byte-identical dumps for the same state", `tests/api/admin.test.ts`).
// Each job is guarded by `core/jobs.ts`'s `runJob` so one failing (a D1
// hiccup pruning `auth_cache`, say) never skips the ones queued after it --
// in particular, a prune failure must never stop `writeDump` from running.
import { pruneNonces } from "../auth/client";
import { pruneAuthCache } from "../auth/discord";
import type { Bindings } from "../env";
import { writeDump } from "../dump/write";
import { pruneIdempotency } from "./idempotency";
import { runJob } from "./jobs";
import { pruneRateLimits } from "./ratelimit";
import type { Clock } from "./time";

export type NightlyJobName = "prune-auth-cache" | "prune-rate-limits" | "prune-nonces" | "prune-idempotency" | "write-dump";
export type NightlyJobStatus = "ok" | "error";

export interface NightlyResult {
  ran: true;
  at: string;
  jobs: Record<NightlyJobName, NightlyJobStatus>;
  dump: Awaited<ReturnType<typeof writeDump>> | null;
}

export async function runNightly(env: Bindings, now: Clock): Promise<NightlyResult> {
  const at = now();
  const jobs: Record<NightlyJobName, NightlyJobStatus> = {
    "prune-auth-cache": "ok",
    "prune-rate-limits": "ok",
    "prune-nonces": "ok",
    "prune-idempotency": "ok",
    "write-dump": "ok",
  };
  let dump: Awaited<ReturnType<typeof writeDump>> | null = null;

  if (!(await runJob("prune-auth-cache", () => pruneAuthCache(env.DB, now)))) jobs["prune-auth-cache"] = "error";
  if (!(await runJob("prune-rate-limits", () => pruneRateLimits(env.DB, now)))) jobs["prune-rate-limits"] = "error";
  if (!(await runJob("prune-nonces", () => pruneNonces(env.DB, now)))) jobs["prune-nonces"] = "error";
  // L3: idempotency rows past their 24h window (`core/idempotency.ts`'s own
  // `IDEMPOTENCY_WINDOW_MS`) -- housekeeping only, correctness never
  // depends on this job having run (see that module's own comment).
  if (!(await runJob("prune-idempotency", () => pruneIdempotency(env.DB, now)))) jobs["prune-idempotency"] = "error";
  if (
    !(await runJob("write-dump", async () => {
      dump = await writeDump(env, now);
    }))
  ) {
    jobs["write-dump"] = "error";
  }

  return { ran: true, at, jobs, dump };
}
