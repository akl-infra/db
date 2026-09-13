// Per-client destructive-write auto-suspend budget (saltorbit 2026-09-13,
// "rogue trusted client" hardening -- db/README.md's "Rogue trusted
// client" runbook, db/docs/adoption.md §2.1 (sentence pending sign-off,
// see the slice's report)). A registered client (10 C1) is trusted to
// assert ANY Discord user's identity (`act-as-user`) -- this module is the
// automatic backstop for when that trust is abused or the client simply
// crashes out and starts misbehaving.
//
// A DESTRUCTIVE write is one a human can't undo by just retrying: delete,
// rename, transfer, or replacing an EXISTING format's payload
// (putFormat/patchFormat -- never a format ADD, never a create). Clearing
// an approved link (`core/links.ts`'s `clearLink`) is destructive the same
// way; approving one is not. Likes, creates and restores are exempt --
// `core/write.ts`/`core/links.ts` are what decide "is THIS call
// destructive", by only ever passing a `clientId` into `commitWrite`/
// `appendLinkChange` for the kinds below.
//
// Kept as its OWN leaf module (no dependency on `core/events.ts` or
// `core/clients.ts`) so both can depend on it without an import cycle:
// `core/events.ts` needs the statement builder (folded into `commitWrite`'s
// own batch, LDB-L8's own "one .batch() call, whatever its statement
// count" accounting -- zero extra D1 round trips on the hot path), and
// `core/clients.ts` needs the threshold function for its `suspendClient`/
// `clientsHealth` (GET /v1/meta's `health.clients`).
import type { Bindings } from "../env";
import type { Clock } from "./time";

export const DESTRUCTIVE_WINDOW_SECONDS = 3600; // 1h, matching the requirement's own wording

// Real usage measured 2026-09-13 against the live akldb.org `/v1/changes`
// feed, filtered to destructive kinds and grouped by `source.client`
// (spark's own registered client id, `client:01M238GM2C681B74PGZFA4J79F`):
// its peak was 10 destructive writes in a single clock hour (a batch of
// PATCH fingermap edits). At the same time the live catalog held 4,177
// layouts. BASE=200 / PCT=5% leaves >=20x headroom over that observed
// peak (so a legitimate bulk operation run through the client lane, e.g.
// a scripted cleanup, doesn't trip a false positive) while still bounding
// a rogue client's worst case to a small slice of the catalog per hour --
// contrast CLIENT_LIMIT (auth/ratelimit.ts, 5000 writes/10min), which on
// its own would let a rogue client rewrite the WHOLE 4,177-layout catalog
// in about ten minutes (the exact scenario saltorbit asked about, 2026-09-13).
// `PCT` (not just a flat `BASE`) keeps the bound proportional as the
// catalog grows; `BASE` keeps it meaningful while the catalog is small.
export const DESTRUCTIVE_BUDGET_BASE = 200; // N
export const DESTRUCTIVE_BUDGET_PCT = 0.05; // p (5%)

export function destructiveThreshold(liveLayoutCount: number): number {
  return Math.max(DESTRUCTIVE_BUDGET_BASE, Math.ceil(liveLayoutCount * DESTRUCTIVE_BUDGET_PCT));
}

// Exported so `core/clients.ts`'s `reactivateClient` can clear a
// reactivated client's own counter row (a fresh slate, rather than
// instantly re-tripping on the very next destructive write within the
// SAME clock-hour it was reactivated in).
export function destructiveBudgetKey(clientId: string): string {
  return `destructive:${clientId}`;
}

export interface DestructiveBudgetRow {
  n: number;
  window_start: number;
  live_layouts: number;
}

// One statement, meant to be pushed into a CALLER's OWN `db.batch()` array
// -- never run standalone. Reuses the exact fixed-window upsert+RETURNING
// shape `core/ratelimit.ts`'s `take()` already proved race-safe under
// concurrency, keyed apart from the write-rate limiter's own rows (a
// distinct `key` prefix in the SAME `ratelimit` table -- no new table, no
// migration). The `live_layouts` scalar subquery rides in the SAME
// statement so the caller never needs a second read to compute the
// percentage half of the threshold.
export function destructiveBudgetStatement(db: Bindings["DB"], now: Clock, clientId: string, windowSeconds: number = DESTRUCTIVE_WINDOW_SECONDS): D1PreparedStatement {
  const nowSeconds = Math.floor(new Date(now()).getTime() / 1000);
  const windowStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
  return db
    .prepare(
      `INSERT INTO ratelimit (key, window_start, n) VALUES (?1, ?2, 1)
       ON CONFLICT(key) DO UPDATE SET
         n = CASE WHEN window_start = excluded.window_start THEN n + 1 ELSE 1 END,
         window_start = excluded.window_start
       RETURNING n, window_start, (SELECT COUNT(*) FROM layouts WHERE deleted = 0) AS live_layouts`,
    )
    .bind(destructiveBudgetKey(clientId), windowStart);
}

// Decodes the `D1Result` at whatever index the caller pushed the
// statement above into its own batch.
export function readDestructiveBudgetRow(result: { results?: unknown[] } | undefined): DestructiveBudgetRow | null {
  const row = result?.results?.[0] as DestructiveBudgetRow | undefined;
  return row ?? null;
}

// GET /v1/meta's `health.clients.budget` -- `liveLayoutCount` is passed in
// from `readMetaCore`'s own `layout_count` (already read that request),
// never a second query just for this.
export interface BudgetSummary {
  base: number;
  pct: number;
  window_seconds: number;
  live_layouts: number;
  effective: number;
}

export function budgetSummary(liveLayoutCount: number): BudgetSummary {
  return {
    base: DESTRUCTIVE_BUDGET_BASE,
    pct: DESTRUCTIVE_BUDGET_PCT,
    window_seconds: DESTRUCTIVE_WINDOW_SECONDS,
    live_layouts: liveLayoutCount,
    effective: destructiveThreshold(liveLayoutCount),
  };
}

// The exact `WriteKind` values (core/events.ts) that count as destructive,
// per scope -- `core/write.ts`'s verb functions are what actually gate on
// these (only THEY know whether a given call is an add vs. a replace), but
// the sets live here so a test can enumerate them structurally rather than
// re-typing the list.
export const DESTRUCTIVE_LAYOUT_KINDS: ReadonlySet<string> = new Set(["deleted", "renamed", "transferred"]);
export const DESTRUCTIVE_FORMAT_KINDS: ReadonlySet<string> = new Set(["updated", "fingermap"]);

export function clientIdFromVia(via: string): string | undefined {
  return via.startsWith("client:") ? via.slice("client:".length) : undefined;
}
