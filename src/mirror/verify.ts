// The mirror's checks (design/aws-port.md §5.2 items 2-3; lane Z). Pure: no I/O, no clock.
//   - which port methods the mirror replays (MIRROR_WRITES), and the exact list it never does;
//   - per-call: the outcome, the committed seqs and the clock-read counts equal prod's;
//   - daily proof: two sets of D1-shaped rows equal, row for row, over every non-ephemeral table.
// Any mismatch is a divergence: the applier halts (apply.ts), it never applies past one.
import { ApiError } from "../core/errors";
import { RevConflictError } from "../core/events";
import { DuplicateInteractionError } from "../store/port";
import { encodeTee, type TeeCall } from "./record";

/** The write methods of the port that the mirror records and replays, by `Store` area (src/store/port.ts). */
export const MIRROR_WRITES: Readonly<Record<string, readonly string[]>> = {
  state: ["put", "delete"],
  events: ["commitWrite", "appendInfo", "appendAdmin", "appendModeration", "appendLinkChange", "appendLike", "appendInheritedLikes"],
  auth: ["touchClientAuthor", "cacheAuthSuccess", "pruneRateLimits", "reserveIdempotency", "takeOverIdempotency", "completeIdempotency", "deleteIdempotency", "pruneIdempotency"],
  admin: ["insertAdmin", "removeAdmin", "upsertBan", "deleteBan", "setAuthorNameByAdmin", "insertClient", "revokeClient", "suspendClient", "reactivateClient"],
  links: ["submit", "reject"],
  wpm: ["bindSourceMessage", "insertApproved", "submit", "approve", "reject"],
  comments: ["submit", "deleteOwn", "approve", "reject", "remove", "like", "unlike"],
  review: ["reopen"],
  modqueue: [
    "bumpFailedAttempts", "leaseNotification", "deleteNotification", "markShown", "releaseNotificationLease", "insertNotification",
    "claimAnnounce", "releaseAnnounce", "claimDeliveryGate", "deferDeliveryGate", "releaseDeliveryGate",
  ],
  discord: [
    "claimAction", "expireActions", "disableActions", "expireLeasedAction", "releaseAction", "completeAction", "clearCallbackToken",
    "bumpCallbackAttempts", "deleteExpiredConfirmations", "consumeConfirmation", "consumeConfirmationAndQueueReopen", "insertDenyModal",
    "consumeModalAndQueueDeny", "insertAction",
  ],
  outbox: ["lease", "beginMessage", "markSent", "clearAmbiguous", "retry", "deferAllPending", "terminal"],
};

// auth.pruneRateLimits is replayed although it only touches the ephemeral table: it deletes the destructive-budget counters
// (`RL#destructive:*`, one-hour windows) once they are 20 minutes old, and those counters decide commitWrite's `budgetProbe` and so
// client suspension. Skipping it makes the mirror's counters outlive prod's (found by LDB-MIR20).

/** Write methods of the port the mirror never replays: the ephemeral tables (§5.2 item 1, "out of scope") and the dump restore. */
export const MIRROR_NEVER: readonly string[] = [
  "auth.insertNonce", "auth.pruneNonces", "auth.cacheAuthFailure", "auth.pruneAuthCache", "auth.hitWindow",
  "holds.takeHold", "holds.releaseHold", "dump.restore",
];

const WRITE_SET = new Set(Object.entries(MIRROR_WRITES).flatMap(([a, ms]) => ms.map((m) => `${a}.${m}`)));

/** True when `method` ("<area>.<name>") is one the mirror replays. */
export function isMirrorWrite(method: string): boolean {
  return WRITE_SET.has(method);
}

/** The D1 tables that live in the ephemeral DynamoDB table and are copied at the cutover, not mirrored. */
export const EPHEMERAL_TABLES: readonly string[] = ["nonces", "auth_cache", "ratelimit"];

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export type Outcome = TeeCall["outcome"];
export type ErrorOutcome = Extract<Outcome, { error: unknown }>["error"];

/**
 * The class name an error is recorded under. `instanceof` on the classes the port's stores throw, never
 * `constructor.name` (a bundler may rename a class); anything else falls back to `name`. Lane T's recorder must use this
 * function so both sides agree.
 */
export function teeErrorName(e: unknown): string {
  if (e instanceof ApiError) return "ApiError";
  if (e instanceof RevConflictError) return "RevConflictError";
  if (e instanceof DuplicateInteractionError) return "DuplicateInteractionError";
  if (e instanceof Error) return e.name;
  return typeof e;
}

/** A call's outcome in the recorded shape: `{ok}` (encoded) or `{error}` (class name, status and body when it has them). */
export function outcomeOfResult(result: unknown): Outcome {
  return { ok: encodeTee(result) };
}

export function outcomeOfError(e: unknown): Outcome {
  const err = e as { status?: unknown; body?: unknown; message?: unknown } | null;
  const out: ErrorOutcome = { name: teeErrorName(e), message: typeof err?.message === "string" ? err.message : String(e) };
  if (typeof err?.status === "number") out.status = err.status;
  if (err?.body !== undefined) out.body = encodeTee(err.body);
  return { error: out };
}

/** Deterministic JSON: object keys sorted, so two equal values always print identically. `undefined` object members are dropped like JSON.stringify does. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map((x) => canonical(x === undefined ? null : x)).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}

export type Mismatch = { kind: "outcome" | "seqs" | "clock" | "head"; detail: string; expected: unknown; actual: unknown };

/** The result must deep-equal prod's; an error must have the same class, status and body (the message is not compared). */
export function compareOutcome(expected: Outcome, actual: Outcome): Mismatch | null {
  const eOk = "ok" in expected;
  const aOk = "ok" in actual;
  if (eOk !== aOk) return { kind: "outcome", detail: eOk ? "prod returned, mirror threw" : "prod threw, mirror returned", expected, actual };
  if (eOk && aOk) {
    // A result the tee codec could not encode ships as {$unencodable: 1}: only the seqs (checked separately) can be compared.
    const e = expected.ok as { $unencodable?: unknown } | null;
    if (e !== null && typeof e === "object" && Object.keys(e).length === 1 && e.$unencodable === 1) return null;
    return canonical(expected.ok) === canonical(actual.ok) ? null : { kind: "outcome", detail: "results differ", expected: expected.ok, actual: actual.ok };
  }
  const e = (expected as { error: ErrorOutcome }).error;
  const a = (actual as { error: ErrorOutcome }).error;
  const pick = (x: ErrorOutcome): unknown => ({ name: x.name, status: x.status ?? null, body: x.body ?? null });
  return canonical(pick(e)) === canonical(pick(a)) ? null : { kind: "outcome", detail: "errors differ", expected: pick(e), actual: pick(a) };
}

/** The seqs the mirror's store committed during the call equal prod's. */
export function compareSeqs(expected: readonly number[], actual: readonly number[]): Mismatch | null {
  return canonical(expected) === canonical(actual) ? null : { kind: "seqs", detail: "committed event seqs differ", expected, actual };
}

/** The seqs a call committed, from the store's head before and after it (the applier is the only writer). */
export function seqsBetween(headBefore: number, headAfter: number): number[] {
  const out: number[] = [];
  for (let s = headBefore + 1; s <= headAfter; s++) out.push(s);
  return out;
}

/** The recorded clock reads (arg values) must have been consumed exactly: same count, in order. */
export function compareClockReads(expected: readonly number[], actual: readonly number[]): Mismatch | null {
  return canonical(expected) === canonical(actual) ? null : { kind: "clock", detail: "clock reads per Clock argument differ", expected, actual };
}

// ---------------------------------------------------------------------------
// Row-for-row comparison (the daily proof, reseed verification, the cutover proof)
// ---------------------------------------------------------------------------

export type RowsByTable = Record<string, Record<string, unknown>[]>;

export interface TableDiff {
  table: string;
  rows: [number, number];
  onlyLeft: string[];
  onlyRight: string[];
}

export interface CompareOptions {
  /** Tables left out. Default: the ephemeral ones. */
  ignore?: readonly string[];
  /** At most this many differing rows are listed per side per table. */
  sample?: number;
}

function rowKey(r: Record<string, unknown>): string {
  return canonical(r);
}

/**
 * Multiset comparison of two D1-shaped row sets over every table either side has, except the ignored ones. Row order is
 * not compared (the two sides order by different keys); content is, column for column.
 */
export function compareTables(left: RowsByTable, right: RowsByTable, opts: CompareOptions = {}): TableDiff[] {
  const ignore = new Set(opts.ignore ?? EPHEMERAL_TABLES);
  const sample = opts.sample ?? 3;
  const out: TableDiff[] = [];
  for (const table of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
    if (ignore.has(table) || /^(sqlite_|_cf_|d1_migrations$|mirror_queue$)/.test(table)) continue;
    const a = (left[table] ?? []).map(rowKey).sort();
    const b = (right[table] ?? []).map(rowKey).sort();
    if (a.length === b.length && a.every((x, i) => x === b[i])) continue;
    const sa = new Set(a);
    const sb = new Set(b);
    out.push({
      table,
      rows: [a.length, b.length],
      onlyLeft: a.filter((x) => !sb.has(x)).slice(0, sample),
      onlyRight: b.filter((x) => !sa.has(x)).slice(0, sample),
    });
  }
  return out;
}
