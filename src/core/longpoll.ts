// The long-poll feed (design/layout-db/review/LEDGER.md L4; replaces the
// deleted SSE stream and webhooks as spark's keep-warm): `GET
// /v1/changes?since=&wait=<seconds>` holds the request open, checking the
// event head about once a second, until either `since` is exceeded or the
// wait budget is spent -- then the caller (`routes/changes.ts`) answers
// with the normal `/v1/changes` page. Gated to the client lane's
// `feed:wait` capability (`routes/changes.ts`), rate-limited like any
// other client-lane activity; this module only knows about the wait loop
// itself, never auth.
import type { Bindings } from "../env";
import { headSeq } from "./etag";

// saltorbit, 2026-09-12: "GET /v1/changes?since=&wait=25s ... capped at 25s,
// clamp larger values". Anything <= 0 (including a caller sending
// `wait=0`) is treated as "check once, don't hold" -- never a negative
// sleep, never an infinite one.
export const MAX_WAIT_SECONDS = 25;

export function clampWaitSeconds(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  return Math.min(Math.max(raw, 0), MAX_WAIT_SECONDS);
}

export type SleepImpl = (ms: number) => Promise<void>;

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polls `headSeq` once, and once per second thereafter, until either the
// head exceeds `since` or the read budget (`ceil(waitSeconds) + 1` reads,
// invariant (e): "the number of D1 reads during a hold is <= wait+1") is
// exhausted -- whichever comes first. Never throws; the caller re-reads
// `/v1/changes` itself once this returns (so the response it builds is
// always current, whether or not anything actually changed).
export async function waitForChanges(
  db: Bindings["DB"],
  since: number,
  waitSeconds: number,
  sleepImpl: SleepImpl = realSleep,
): Promise<void> {
  const clamped = clampWaitSeconds(waitSeconds);
  const maxReads = Math.ceil(clamped) + 1;
  for (let i = 0; i < maxReads; i++) {
    const seq = await headSeq(db);
    if (seq > since) return;
    if (i < maxReads - 1) await sleepImpl(1000);
  }
}
